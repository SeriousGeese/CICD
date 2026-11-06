// Shared helper: detect a `AGENT_HOOKS_ALLOW_X=1` env assignment written INLINE on the
// same shell segment a guard is judging.
//
// Why: the guards in the `guards` set (block-uncommitted-restore.mjs,
// block-bare-claim.mjs, block-npx-unlisted.mjs,
// block-worktree-branch-switch.mjs) read their escape hatch from
// `process.env` of the PreToolUse HOOK process only. An agent cannot set
// that: `AGENT_HOOKS_ALLOW_X=1 cmd` inside a Bash tool command string is a per-command
// assignment scoped to the CHILD process the shell launches when it actually
// runs — it never reaches the hook that inspected the command text and
// decided whether to allow it BEFORE that shell ever started. Every one of
// these guards' refusal messages told the agent to "set AGENT_HOOKS_ALLOW_X=1",
// which reads as an instruction the agent can follow inline, and cannot.
//
// This module makes that inline form actually work: a guard passes it the
// SPECIFIC segment under judgment (one command in a `&&`/`;`/`|`/newline
// chain — exactly what each guard already isolates before deciding whether it
// matches) and the hatch variable name, and gets back whether that one
// segment carries a leading `VAR=1` for it. The check is deliberately scoped
// to a single segment, never the whole command line: honouring the hatch
// command-wide would let an assignment on an unrelated, harmless segment
// silence a real guard on a completely different, dangerous one in the same
// chain (e.g. `AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 echo hi && git checkout -- dirty.ts`
// must NOT allow the checkout). process.env is still honoured by callers too
// — this only adds the inline form, it does not replace the session/harness
// env var.
//
// Recognised leading forms, matching each guard's own wrapper-skipping:
//   VAR=1 cmd
//   env VAR=1 cmd
//   sudo/nice/command/time/nohup/exec VAR=1 cmd   (and combinations of these)
//   rtk [proxy] VAR=1 cmd
// Only ASSIGNMENTS BEFORE THE COMMAND WORD count — `git checkout -- x VAR=1`
// is an argument to git, not an env assignment, and is correctly ignored.

const WRAPPER_WORDS = new Set([
  'sudo',
  'nice',
  'command',
  'time',
  'nohup',
  'exec',
  // Loop / conditional / grouping keywords that can lead a segment once a
  // command is split on `;` — `for id in A; do AGENT_HOOKS_ALLOW_X=1 bd …; done`
  // yields a segment beginning `do AGENT_HOOKS_ALLOW_X=1 bd …`, mirroring
  // wrapper-strip.mjs's skipCommandPrefix().
  'do',
  'then',
  'else',
  '{',
  '(',
  '!',
]);
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Whether `segmentToks` — the tokens of ONE shell segment, in order, exactly as
 * a guard's own (whitespace or quote-aware) tokenizer produced them, NOT
 * unquoted — carries a leading `varName=1` assignment scoped to that
 * segment's own command.
 * @param {string[]} segmentToks
 * @param {string} varName
 * @returns {boolean}
 */
export function hasInlineHatch(segmentToks, varName) {
  const toks = Array.isArray(segmentToks) ? segmentToks : [];
  let i = 0;
  while (i < toks.length) {
    const t = String(toks[i]);
    const m = ASSIGNMENT_RE.exec(t);
    if (m) {
      if (m[1] === varName && isTruthy(m[2])) return true;
      i++;
      continue;
    }
    if (WRAPPER_WORDS.has(t)) {
      i++;
      continue;
    }
    if (t === 'rtk') {
      i++;
      if (toks[i] === 'proxy') i++;
      continue;
    }
    if (t === 'env') {
      i++;
      while (i < toks.length) {
        const e = String(toks[i]);
        if (e === '-u' || e === '--unset') {
          i += 2;
          continue;
        }
        if (e === '-i' || e === '--ignore-environment' || e === '-') {
          i++;
          continue;
        }
        const em = ASSIGNMENT_RE.exec(e);
        if (em) {
          if (em[1] === varName && isTruthy(em[2])) return true;
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    break; // first real command word — stop; only LEADING assignments count
  }
  return false;
}

/**
 * Same check, given the raw segment TEXT rather than pre-split tokens — a
 * convenience for callers that have not already tokenized. Splits on plain
 * whitespace, matching how block-uncommitted-restore.mjs,
 * block-worktree-branch-switch.mjs and block-npx-unlisted.mjs already split
 * their own segments (none of them need quote-aware splitting for the tokens
 * that precede the command word — an assignment value containing whitespace
 * would need quoting the guards themselves do not attempt to parse either).
 * @param {string} segmentText
 * @param {string} varName
 * @returns {boolean}
 */
export function segmentHasInlineHatch(segmentText, varName) {
  const toks = String(segmentText ?? '').trim().split(/\s+/).filter(Boolean);
  return hasInlineHatch(toks, varName);
}

function isTruthy(rawValue) {
  return unquote(rawValue) === '1';
}

function unquote(s) {
  return String(s).replace(/^['"]/, '').replace(/['"]$/, '');
}
