// PreToolUse(Bash) hook: block heredocs that die in the Bash-tool handoff —
// any `gh pr create` / `gh pr edit` fed by a heredoc, and ANY command over
// ~4 KB that carries one.
//
// Why: a long quoted heredoc (`<<'EOF'`) passed through the Claude Code Bash tool on
// Windows has been measured to die intermittently with
// `unexpected EOF while looking for matching '` — correct quoting does not save it.
// The first recorded occurrences were all PR bodies, so the guard started by
// matching `gh pr create`/`gh pr edit`. The identical failure then hit a plain
// `cat >> file <<'EOF'` with no `gh` anywhere: the class is the SIZE of the command
// text carrying the heredoc, not the command consuming it. Measured:
//   - a ~10 KB plain-ASCII heredoc (no quotes, no backticks) failed identically;
//   - a 7-line heredoc with apostrophes, quotes and a fenced block passed;
//   - feeding the failing command through `rtk hook claude` produced NO rewrite,
//     exonerating rtk — the mangling is in the harness→bash handoff itself.
// Observed failures start around 9–11 KB of command text and are intermittent, so
// the size gate triggers well below the observed floor.
//
// Rule 1 (any size): a command segment that invokes `gh pr create` or `gh pr
// edit` (through the usual wrappers — env/rtk/etc.) AND carries a heredoc
// operator (`<<` / `<<-`, but not the `<<<` herestring). The operator always
// sits on the command line itself (`--body "$(cat <<'EOF'` …), so segment-level
// detection is sufficient; a heredoc in a DIFFERENT segment of the same command
// (e.g. writing a file first, then `gh pr create --body-file` on it) is allowed.
// Escape hatch: AGENT_HOOKS_ALLOW_PR_BODY_HEREDOC=1.
//
// Rule 2: any command whose total text exceeds LARGE_COMMAND_BYTES and contains
// a heredoc operator followed by a word-shaped delimiter (so `1<<2` bit-shifts
// in an inline `node -e` do not match). Escape hatch: AGENT_HOOKS_ALLOW_LARGE_HEREDOC=1.
//
// The fix in both cases is the same and worked first try in every recorded
// occurrence: write the content to a file with the Write tool, then consume the
// FILE (`--body-file <path>`, `cat <path> >> <target>`, `bash <path>`, …).
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything
// unexpected fails OPEN (exit 0) — this guard must never break Bash.
import { readFileSync } from 'node:fs';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';

// Well below the ~9–11 KB command sizes observed to fail (intermittently), and
// well above any heredoc worth writing inline instead of via the Write tool.
const LARGE_COMMAND_BYTES = 4000;

// `<<` or `<<-` (not the `<<<` herestring), followed by an optional quote/escape
// and a word-shaped delimiter — the shape a real heredoc has and a bit-shift
// (`1<<2`, `x << 3`) does not.
const HEREDOC_RE = /(?<!<)<<-?\s*(?:'[A-Za-z_]\w*'|"[A-Za-z_]\w*"|\\?[A-Za-z_]\w*)/;

try {
  const cmd = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
  if (!cmd) process.exit(0);

  if (
    process.env.AGENT_HOOKS_ALLOW_LARGE_HEREDOC !== '1' &&
    Buffer.byteLength(cmd, 'utf8') > LARGE_COMMAND_BYTES &&
    HEREDOC_RE.test(cmd)
  ) {
    process.stderr.write(
      `Blocked: this command is ${Buffer.byteLength(cmd, 'utf8')} bytes and carries a heredoc. Large ` +
        'heredocs through the Bash tool die intermittently with ' +
        "`unexpected EOF while looking for matching '` REGARDLESS of the consuming command — a plain " +
        '`cat >> file` heredoc reproduced it, and rtk was ruled out. Write the content to a file with the ' +
        'Write tool and consume the FILE instead (`cat <path> >> <target>`, `--body-file <path>`, …) — that ' +
        'worked first try in every recorded case. If you genuinely need the inline heredoc, set ' +
        `AGENT_HOOKS_ALLOW_LARGE_HEREDOC=1. ${NOTHING_RAN_NOTICE}${consumerHint(import.meta.url)}`,
    );
    process.exit(2);
  }

  if (process.env.AGENT_HOOKS_ALLOW_PR_BODY_HEREDOC === '1') process.exit(0);

  const segments = cmd.split(/&&|\|\||;|\n/);

  for (const rawSeg of segments) {
    const toks = rawSeg.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) continue;

    const ghArgs = ghArgsAfterWrappers(toks);
    if (!ghArgs) continue;
    if (!isPrCreateOrEdit(ghArgs)) continue;

    // Heredoc operator in this segment: `<<` or `<<-`, but not the `<<<`
    // herestring (which is a different mechanism and has not failed).
    if (!/(?<!<)<<(?!<)/.test(rawSeg)) continue;

    process.stderr.write(
      'Blocked: a heredoc feeding `gh pr create`/`gh pr edit` dies intermittently in the Bash tool with ' +
        "`unexpected EOF while looking for matching '` — correct quoting does not save it, and PR bodies are " +
        'where it has hit most. Write the body with the Write tool to a temp file and pass `--body-file <path>` ' +
        '(delete the file after) — that worked first try in every recorded case. If you genuinely need the ' +
        `heredoc, set AGENT_HOOKS_ALLOW_PR_BODY_HEREDOC=1. ${NOTHING_RAN_NOTICE}${consumerHint(import.meta.url)}`,
    );
    process.exit(2);
  }
} catch {
  process.exit(0);
}
process.exit(0);

// Strip leading command wrappers (VAR=val assignments, `env [..]`, `rtk [proxy]`,
// sudo/nice/time/command/nohup/exec) and return the tokens AFTER `gh`, or null
// when the segment is not a gh invocation.
function ghArgsAfterWrappers(toks) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (t === 'sudo' || t === 'nice' || t === 'command' || t === 'time' || t === 'nohup' || t === 'exec') {
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
        const e = toks[i];
        if (e === '-u' || e === '--unset') {
          i += 2;
          continue;
        }
        if (e === '-i' || e === '--ignore-environment' || e === '-') {
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return toks[i] === 'gh' ? toks.slice(i + 1) : null;
}

// True when the first two non-flag tokens after `gh` are `pr create` or `pr edit`.
// Global flags that take a separate value (`-R <repo>`, `--repo <repo>`) skip both
// tokens; `--flag=value` and bare flags skip one.
function isPrCreateOrEdit(ghArgs) {
  const words = [];
  for (let i = 0; i < ghArgs.length && words.length < 2; i++) {
    const a = ghArgs[i];
    if (a === '-R' || a === '--repo' || a === '--hostname') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    words.push(a);
  }
  return words[0] === 'pr' && (words[1] === 'create' || words[1] === 'edit');
}
