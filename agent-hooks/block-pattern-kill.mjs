#!/usr/bin/env node
// PreToolUse(Bash|PowerShell|Monitor) hook: block killing processes by NAME or PATTERN
// (the recurrence of an earlier incident of the same kind).
//
// This machine is shared: peer sessions, parallel worker sessions and their gates all run `node`,
// `jest` and `npm` at the same time. A kill by name or pattern reaches every one of them. The
// first incident was a subagent's `taskkill /IM node.exe` taking out other sessions; it was answered with a
// rule in AGENTS.md ("Never kill processes by image name ... Kill only the PIDs you started"),
// and on 2026-10-25 a parallel worker ran `pkill -f "jest --coverage"` to clear its own stuck
// run. That pattern matched both sibling workers' gates, which were running exactly that command,
// and the worker's own shell. Nothing was lost only because the siblings had just finished. A
// rule is text a worker under pressure does not re-read; this is the enforcement.
//
// Refused, as the command word of a segment (quote-aware, so a search or a message that merely
// MENTIONS them passes), also inside `bash -c` / `pwsh -Command` / `cmd /c` and path-qualified:
//  - `pkill`, `killall`, `killall5`: by name or pattern by definition;
//  - `taskkill` with `/IM` (`//IM` under Git Bash) or a `/FI` filter (by `/PID` is fine);
//  - `Stop-Process`/`spps` by `-Name` (any prefix, `-Name:x` too), or fed by `Get-Process`;
//  - `kill` fed PIDs by a pattern: `kill $(pgrep ...)`, `kill $(pidof ...)`, `pgrep ... | xargs
//    kill`, `ps aux | grep ... | xargs kill`, and PowerShell's `kill -Name` / `gps x | kill`.
// Allowed: `kill <pid>`, `taskkill /PID <pid>`, `Stop-Process -Id <pid>`, a look-only `pgrep`.
//
// Escape hatch: AGENT_HOOKS_ALLOW_PATTERN_KILL=1 for a kill you have checked reaches only your own
// processes: inline on the segment (bash), `$env:AGENT_HOOKS_ALLOW_PATTERN_KILL = '1'` in the same
// PowerShell command, or in the environment.
//
// Blocking contract: exit 2 + stderr message. Anything unexpected fails OPEN (exit 0).
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { readHookInput } from './hook-input.mjs';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';
import { segmentHasInlineHatch } from './inline-hatch.mjs';
import { pathToFileURL } from 'node:url';

const HATCH_VAR = 'AGENT_HOOKS_ALLOW_PATTERN_KILL';
// PowerShell's call operator is a bare wrapper token there.
const EXTRA_WRAPPERS = ['&'];
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell']);
const PID_SELECTORS = new Set(['pgrep', 'pidof', 'ps', 'grep', 'egrep', 'awk', 'get-process', 'gps']);

/** A command word as written: no quotes, no directory, no `.exe`, lower case. */
export function commandWord(token) {
  return String(token ?? '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
}

/**
 * Split a command into pipeline-aware segments, honouring quotes: a `|`, `;`, `&&`, `||` or newline
 * inside '...' or "..." separates nothing. Each segment carries its tokens (quotes removed), its
 * raw text, and whether it was PIPED from the previous one.
 */
export function segments(command) {
  const out = [];
  let tokens = [];
  let token = '';
  let inToken = false;
  let raw = '';
  let quote = null;
  let pipedIn = false;
  const endToken = () => {
    if (inToken) tokens.push(token);
    token = '';
    inToken = false;
  };
  const endSegment = (nextPiped) => {
    endToken();
    if (tokens.length) out.push({ tokens, raw: raw.trim(), pipedIn });
    tokens = [];
    raw = '';
    pipedIn = nextPiped;
  };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      raw += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) {
        token += s[++i];
        raw += s[i];
      } else token += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      raw += c;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      endSegment(false);
      i++;
      continue;
    }
    if (c === '|') {
      endSegment(true);
      continue;
    }
    if (c === ';' || c === '\n') {
      endSegment(false);
      continue;
    }
    raw += c;
    if (/\s/.test(c)) {
      endToken();
      continue;
    }
    token += c;
    inToken = true;
  }
  endSegment(false);
  return out;
}

const NAME_PARAM = /^-(processname|n(a(m(e)?)?)?)(:.*)?$/i;
const PATTERN_SUBSTITUTION = /(\$\(|`)\s*(pgrep|pidof)\b/;

/**
 * Why a segment kills by name or pattern, or null. `prev` is the segment piped into this one,
 * `pipeline` every segment of the same pipeline up to this one. Pure, exported for the test.
 */
export function patternKillReason(segment, { prev = null, pipeline = [] } = {}) {
  const toks = stripGroupingParens(segment.tokens);
  const i = skipCommandPrefix(toks, { extraWrappers: EXTRA_WRAPPERS });
  const cmd = commandWord(toks[i]);
  const args = toks.slice(i + 1);
  const lower = args.map((a) => a.toLowerCase());
  const prevCmd = prev ? commandWord(stripGroupingParens(prev.tokens)[skipCommandPrefix(stripGroupingParens(prev.tokens), { extraWrappers: EXTRA_WRAPPERS })]) : null;

  // A nested shell: judge the command it runs.
  if (SHELLS.has(cmd)) {
    const at = lower.findIndex((a) => a === '-c' || a === '-command' || a === '-cmd' || a === '/c');
    if (at !== -1 && args[at + 1]) return firstReason(args.slice(at + 1).join(' '));
  }
  if (cmd === 'cmd') {
    const at = lower.findIndex((a) => a === '/c' || a === '/k');
    if (at !== -1) return firstReason(args.slice(at + 1).join(' '));
  }

  if (cmd === 'pkill' || cmd === 'killall' || cmd === 'killall5') return `\`${cmd}\` kills every process whose name or command line matches`;
  if (cmd === 'taskkill') {
    if (lower.some((a) => /^(\/{1,2}|-)im$/.test(a))) return '`taskkill /IM` kills every process with that image name';
    if (lower.some((a) => /^(\/{1,2}|-)fi$/.test(a))) return '`taskkill /FI` kills every process its filter matches';
  }
  if (cmd === 'stop-process' || cmd === 'spps') {
    if (args.some((a) => NAME_PARAM.test(a))) return '`Stop-Process -Name` stops every process with that name';
    const byPid = lower.some((a) => /^-(id|inputobject)(:.*)?$/.test(a) || /^-i(d|n)?$/.test(a));
    if (!byPid && (prevCmd === 'get-process' || prevCmd === 'gps' || prevCmd === 'ps')) return '`Get-Process <name> | Stop-Process` stops every process with that name';
  }
  if (cmd === 'kill') {
    if (args.some((a) => /^-(process)?name(:.*)?$/i.test(a))) return '`kill -Name` (PowerShell) stops every process with that name';
    if (prevCmd === 'get-process' || prevCmd === 'gps') return '`Get-Process <name> | kill` stops every process with that name';
    if (PATTERN_SUBSTITUTION.test(segment.raw)) return '`kill $(pgrep ...)` kills the PIDs a pattern picked';
  }
  if (cmd === 'xargs' && lower.includes('kill')) {
    const selectors = pipeline.slice(0, -1).map((seg) => commandWord(stripGroupingParens(seg.tokens)[skipCommandPrefix(stripGroupingParens(seg.tokens), { extraWrappers: EXTRA_WRAPPERS })]));
    if (selectors.some((c) => PID_SELECTORS.has(c))) return '`... | xargs kill` kills the PIDs a pattern picked';
  }
  return null;
}

/** The first reason any segment of `command` gives, honouring an inline hatch per segment. */
export function firstReason(command) {
  const segs = segments(command);
  let pipeline = [];
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    pipeline = seg.pipedIn ? [...pipeline, seg] : [seg];
    const why = patternKillReason(seg, { prev: seg.pipedIn ? segs[k - 1] : null, pipeline });
    if (why && !segmentHasInlineHatch(seg.raw, HATCH_VAR)) return why;
  }
  return null;
}

function main() {
  if (process.env[HATCH_VAR] === '1') return 0;
  const input = readHookInput();
  const toolName = String(input?.tool_name ?? '');
  if (toolName && !/^(bash|powershell|monitor)$/i.test(toolName)) return 0;
  const command = String(input?.tool_input?.command ?? '');
  if (!/(pkill|killall|taskkill|stop-process|spps|kill|pgrep|pidof)/i.test(command)) return 0;
  // PowerShell has no `VAR=1 cmd` prefix: an assignment in the same command is its inline form.
  if (new RegExp(`\\$env:${HATCH_VAR}\\s*=\\s*['"]?1['"]?`, 'i').test(command)) return 0;

  const reason = firstReason(command);
  if (!reason) return 0;
  process.stderr.write(
    `Blocked: ${reason}, on a machine where peer sessions and parallel workers run the same node, ` +
      'jest and npm processes as you. On 2026-10-25 a worker\'s `pkill -f "jest --coverage"` ' +
      "matched both sibling workers' gates and its own shell; earlier, `taskkill /IM node.exe` took out " +
      'other sessions. Kill only the PIDs you started: `$!` right after you ' +
      'background a command, the pid a tool printed for its own process, or one you read from ' +
      "`ps -o pid,args` and checked is yours, then `kill <pid>` / `taskkill /PID <pid>` / `Stop-Process -Id <pid>`. " +
      'If you have checked that the pattern reaches only your own processes: in bash prefix the SAME ' +
      `command with \`${HATCH_VAR}=1\`; in PowerShell start it with \`$env:${HATCH_VAR} = '1';\`. ` +
      `${NOTHING_RAN_NOTICE}${consumerHint(import.meta.url)}`,
  );
  return 2;
}

// Windows-safe entry guard (a bare path comparison fails on Windows).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let code;
  try {
    code = main();
  } catch {
    code = 0; // fail open
  }
  process.exit(code);
}
