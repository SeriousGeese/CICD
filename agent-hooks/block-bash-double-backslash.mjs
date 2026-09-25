// PreToolUse(Bash|Monitor) hook: block a command that contains a doubled backslash (`\\`).
//
// Why: on Windows hosts the Claude Code Bash tool's handoff has been measured to
// collapse EVERY `\\` in the command text to `\` before bash runs it, and only that:
//
//   written in the command        what bash received
//   ------------------------      -------------------
//   'a\\b'  (quoted heredoc)      a\b
//   'a\\b'  (unquoted heredoc)    a\b
//   'a\\b'  (single-quoted echo)  a\b
//   'a\\\\b'                      a\\b        (4 → 2: each pair collapses)
//   '\$HOME'  '\"'  '\`'  '\n'    unchanged   (so this is NOT shell double-quote
//                                             processing, which would eat \$ too)
//
// Where the collapse does NOT happen pins it to the Bash tool channel itself: the
// Write and Edit tools put `\\` on disk byte-for-byte, the PowerShell tool prints
// `a\\b` intact, `rtk hook claude` returns the command unmodified, and a bash.exe
// spawned from Node with a `-c` string containing `\\` receives `\\` intact, so it
// is not MSYS/libuv argv quoting either.
//
// The Monitor tool's `command` field is the SAME channel, empirically: fed the
// identical probe (`printf '%s\n' 'a\\b' 'a\\\\b' '\$HOME' '\"' '\`' '\n-literal'`)
// through Monitor instead of Bash, the observed output was `a\b`, `a\\b`,
// `\$HOME`, `\"`, `` \` ``, `\n-literal` — byte-for-byte the same collapse table
// as the Bash tool's (2→1, 4→2, everything else unchanged), confirming Monitor
// really does hand the command to a shell through the same collapsing handoff
// rather than a distinct one that happens to look similar. So Monitor is covered
// here alongside Bash; a channel that had NOT reproduced the collapse would stay
// uncovered, the same way PowerShell (which preserves `\\` intact, per the table
// above) stays uncovered.
//
// The consequence is the dangerous shape: a `sed`/`grep`/`printf`/JSON payload
// written with `\\` executes as a DIFFERENT string and reports success — a
// `case *\\*)` pattern silently becomes `*\*)`. No error is ever raised, so the
// only defence is to make the shape unreachable: put backslash-bearing content in
// a file with the Write tool and run/consume the file, or use the Grep tool.
//
// Escape hatch: AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH=1 — for a command that has been
// deliberately pre-doubled to survive the collapse. (sync.mjs --env-prefix rewrites
// the AGENT_HOOKS_ prefix to the consumer's own.)
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything
// unexpected fails OPEN (exit 0) — this guard must never break Bash.
import { readFileSync } from 'node:fs';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';

try {
  if (process.env.AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH === '1') process.exit(0);

  const input = JSON.parse(readFileSync(0, 'utf8'));
  // Registered on the Bash and Monitor matchers — both channels measured to collapse
  // `\\` identically (see the comment block above). PowerShell preserves `\\` intact
  // and must never be blocked; any other/unknown tool_name is left alone too.
  if (input?.tool_name && input.tool_name !== 'Bash' && input.tool_name !== 'Monitor') process.exit(0);

  const cmd = input?.tool_input?.command ?? '';
  const hits = (cmd.match(/\\\\/g) || []).length;
  if (hits === 0) process.exit(0);

  const channel = input?.tool_name === 'Monitor' ? 'Monitor' : 'Bash';
  process.stderr.write(
    `Blocked: this command contains \`\\\\\` (${hits} occurrence${hits === 1 ? '' : 's'}). The ${channel} tool's ` +
      'handoff collapses every `\\\\` to `\\` before bash runs the command — and ONLY that ' +
      '(`\\$`, `\\"` and `\\n` survive), so the command executes as a different string than you wrote and ' +
      'reports success. Verified: rtk passes the command through unchanged, a Node-spawned bash.exe ' +
      'receives `\\\\` intact, and the Write, Edit and PowerShell tools all preserve it — the collapse is this ' +
      'channel alone (measured identically on both Bash and Monitor). Put the content in a file with the ' +
      'Write tool and run or consume the FILE (`bash <path>`, `node <path>`, `sed -f <path>`), use the Grep ' +
      'tool for regex searches, or write a single `\\` when a single one is what you mean. If you have ' +
      'deliberately pre-doubled for the collapse, set ' +
      `AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH=1. ${NOTHING_RAN_NOTICE}${consumerHint(import.meta.url)}`,
  );
  process.exit(2);
} catch {
  process.exit(0);
}
