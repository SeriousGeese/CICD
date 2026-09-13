// PreToolUse(Bash) hook: block an UNESCAPED backtick in a `bd` or `gh` command, where
// the arguments are prose rather than shell.
//
// Why: a backtick inside a double-quoted (or unquoted) bash word is command
// substitution. That is ordinary, correct bash — the problem is where it fires. Issue
// descriptions and PR bodies are written in MARKDOWN, where the backtick is the single
// most common punctuation mark: every `file.ts:123`, every identifier, every flag name
// in a well-written body wants one. So the house style actively encourages the exact
// character that silently rewrites the payload.
//
// What it cost, the first time: `bd create ... -d "… its own \`mod\` variable."` stored
// "… its own  variable." — bash ran `mod`, it failed, and its empty stdout was
// substituted. bd reported success. The only signal was one stray `bash: line 1: mod:
// command not found` line above a green `✓ Created issue:`.
//
// And a FAILING command is the lucky case. A backticked word that IS a command —
// `date`, `pwd`, `time`, `true` — substitutes its OUTPUT into the middle of the prose
// with no diagnostic whatsoever. The corruption is durable and authoritative: an issue
// description is what a future session implements from, and a sentence missing one word
// still parses, so it survives review.
//
// This is NOT the `\\`-collapsing class (block-bash-double-backslash.mjs), the
// heredoc-size class (block-pr-body-heredoc.mjs), or MSYS path mangling. Those are
// harness-level mangling; this is plain shell semantics reaching a place where the
// payload is prose rather than a command.
//
// Scope is deliberately narrow — `bd` and `gh` segments only. Every other command
// takes shell arguments, where a backtick may well be meant.
//
// ALLOWED, and each is a real fix rather than a workaround:
//   - a SINGLE-quoted argument: backticks are literal there, so the payload arrives intact
//   - a BACKSLASH-escaped backtick inside double quotes: likewise literal
//   - `$(…)`: substitution that is not ambiguous with prose, e.g. the
//     `--actor "$(node scripts/agent-actor-id.mjs)"` idiom a per-session claim uses
//   - `--body-file` / `--file`: what gh and bd both accept, and what the large-payload
//     guard already steers callers to
//
// Escape hatch: AGENT_HOOKS_ALLOW_PROSE_BACKTICK=1. (sync.mjs --env-prefix rewrites the
// AGENT_HOOKS_ prefix to the consumer's own.)
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything
// unexpected fails OPEN (exit 0) — this guard must never break Bash.
import { readFileSync } from 'node:fs';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';

/** Commands whose arguments are prose, so a backtick is a mistake rather than an intent. */
const PROSE_COMMANDS = new Set(['bd', 'gh']);

/**
 * Prefixes that wrap another command without changing what it is. `timeout` takes a
 * duration argument, `env` takes VAR=VAL pairs — both are skipped below.
 */
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'time', 'rtk', 'command', 'nohup', 'sudo']);

/**
 * Splits a command into segments on UNQUOTED separators, so `cd x && bd create "…"`
 * is judged as the `bd` segment it is. Quote state is tracked exactly as bash does:
 * a backslash escapes inside double quotes and outside quotes, but never inside
 * single quotes.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
export function splitSegments(cmd) {
  const segments = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (!inSingle && ch === '\\') {
      current += ch + (cmd[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") { inSingle = !inSingle; current += ch; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; current += ch; continue; }
    if (!inSingle && !inDouble && (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '(' || ch === ')')) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * The command a segment actually runs, with wrappers and leading VAR=VAL assignments
 * stripped, reduced to a basename so `/usr/bin/gh` and `./bd` are recognised.
 *
 * @param {string} segment
 * @returns {string}
 */
export function segmentCommand(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;      // VAR=VAL
    const base = token.split('/').pop() ?? token;
    if (WRAPPERS.has(base)) {
      // `timeout 120 bd …` — swallow a bare duration so the next token is the command.
      if (base === 'timeout' && /^[\d.]+[smhd]?$/.test(tokens[i + 1] ?? '')) i += 1;
      continue;
    }
    if (base.startsWith('-')) continue;                        // a wrapper's own flag
    return base;
  }
  return '';
}

/**
 * Counts backticks that bash would treat as command substitution: not inside single
 * quotes, and not backslash-escaped.
 *
 * @param {string} segment
 * @returns {number}
 */
export function liveBacktickCount(segment) {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (!inSingle && ch === '\\') { i += 1; continue; }
    if (!inDouble && ch === "'") { inSingle = !inSingle; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; continue; }
    if (!inSingle && ch === '`') count += 1;
  }
  return count;
}

/**
 * @param {string} cmd
 * @returns {{command: string, count: number} | null}
 */
export function decide(cmd) {
  for (const segment of splitSegments(cmd)) {
    const command = segmentCommand(segment);
    if (!PROSE_COMMANDS.has(command)) continue;
    const count = liveBacktickCount(segment);
    if (count > 0) return { command, count };
  }
  return null;
}

/**
 * @param {{command: string, count: number}} hit
 * @returns {string}
 */
export function blockMessage(hit) {
  const plural = hit.count === 1 ? '' : 's';
  return (
    `Blocked: this \`${hit.command}\` command contains ${hit.count} unescaped backtick${plural} outside single ` +
    'quotes, where bash reads it as COMMAND SUBSTITUTION rather than as the markdown you meant. The word ' +
    'between the backticks is replaced by the output of running it, the command still succeeds, and the ' +
    'corrupted prose is what every later reader gets. A backticked word that is not a real ' +
    'command leaves one stray "command not found" line above a green result; one that IS a command (`date`, ' +
    '`pwd`, `time`, `true`) injects its output silently, with no diagnostic at all. ' +
    'Fix it by making the payload literal: SINGLE-quote the argument, backslash-escape each backtick inside ' +
    'double quotes, or — best for anything long — write the text with the Write tool and pass it as a file ' +
    '(`--body-file <path>`, `--description-file <path>`). For substitution you actually want, use `$(…)`, ' +
    `which this guard does not touch. Escape hatch: AGENT_HOOKS_ALLOW_PROSE_BACKTICK=1. ${NOTHING_RAN_NOTICE}` +
    consumerHint(import.meta.url)
  );
}

// Executed as a hook (not imported by the node-test).
if (process.argv[1] && process.argv[1].endsWith('block-prose-backtick-substitution.mjs')) {
  try {
    if (process.env.AGENT_HOOKS_ALLOW_PROSE_BACKTICK === '1') process.exit(0);

    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (input?.tool_name && input.tool_name !== 'Bash') process.exit(0);

    const hit = decide(input?.tool_input?.command ?? '');
    if (!hit) process.exit(0);

    process.stderr.write(blockMessage(hit));
    process.exit(2);
  } catch {
    process.exit(0);
  }
}
