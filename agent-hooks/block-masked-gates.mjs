// PreToolUse(Bash|PowerShell) hook: reject gate commands (test/lint/build/
// type-check) whose output is piped into a filter — tail/head/grep/rg/wc under
// Bash, Select-Object/Select-String/Out-Null/… under PowerShell.
//
// Why: Git Bash (and most interactive shells) do not set pipefail, so
// `npm test 2>&1 | tail -8` reports the FILTER's exit code — a failing gate
// looks green. Run gates bare, or capture the real exit explicitly:
//   npm test > /dev/null 2>&1; echo EXIT:$?
//
// PRECISION: only EXECUTABLE text is scanned. Quoted arguments and heredoc bodies
// are data, not commands — an issue description that happens to mention
// `npm run lint`, in a command that also pipes to `tail`, is not a masked gate.
// That false positive is the common one: `bd create` / `bd note` / `gh` commands
// whose DESCRIPTION quotes a gate name while the command pipes to `tail`. Heredoc
// bodies are stripped for the same reason, though the trigger there is narrower
// than it looks: an ordinary markdown table (`| pass |`) never matched the filter
// list — it takes prose containing an actual `| wc` / `| tail` to trip it.
//
// Stripping is SKIPPED when the command hands its quoted text or heredoc to a
// nested shell, because there the text really does execute — a false negative
// would defeat the whole guard.
//
// POWERSHELL: the same masked exit exists on the PowerShell tool, and for a WORSE
// reason — PowerShell has no `pipefail` at all. `$LASTEXITCODE` is set by the last
// NATIVE command and survives a downstream cmdlet, but the pipeline's own success
// (`$?`, and therefore what the tool reports) is the last CMDLET's, so
// `npx jest … | Select-Object -Last 5` reads GREEN on a failing gate. PS 7's
// `&&`/`||` chain operators do not fix this. The hook is registered under both
// tool matchers and branches on `tool_name`; everything below the Bash/PowerShell
// split is shared.
//
// Blocking contract: exit 2 + stderr message (fed back to the agent).
// Anything unexpected fails open (exit 0) — this guard must never break a shell.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NOTHING_RAN_NOTICE, consumerHint } from "./refusal-notice.mjs";

// `bd dolt push|pull` (the beads issue tracker's sync) are gates: their exit code is
// the ONLY signal that the issue DB actually synced, and `bd dolt push 2>&1 | tail -1`
// turns a rejected push into a green "Push complete"-looking line. A
// `bd-dolt-sync.mjs push|pull` wrapper is the same gate, and a worse one to mask,
// because a wrapper like that exists precisely so its exit code can be trusted.
// `status` is a read and is deliberately NOT matched: masking it costs nothing.
//
// pnpm takes workspace-selection flags BEFORE the script name
// (`pnpm --filter @scope/web lint`, `pnpm -r run typecheck`), runs a package bin
// directly (`pnpm vitest run`, `pnpm exec tsc`), and projects spell the type-check
// script both `type-check` and `typecheck`, so all of those shapes are matched.
// `pnpm dev` / `pnpm install` stay non-gates. ESLint run directly (`eslint src`,
// `npx eslint`, `pnpm exec eslint`) is a lint gate. A runner name that is only the
// PREFIX of a package (`tsc-alias`, `jest-environment-jsdom`, `eslint-config-*`) is
// not the runner.
const PNPM_SELECTORS = String.raw`(?:(?:-r|--recursive|-w|--workspace-root|(?:--filter|-F|-C|--dir)(?:=|\s+)\S+)\s+)*`;
const DIRECT_RUNNERS = String.raw`(?:(?:jest|vitest|tsc|eslint)(?![-\w])|playwright\s+test)`;

// `node <path>/node_modules/<runner>` — the node ENTRYPOINT form. Not an exotic
// shape: on Windows it is the standard workaround when a jest pattern contains a
// `|`, because a `.cmd` shim re-parses the line through cmd.exe and eats the
// alternation. So `node node_modules/jest/bin/jest.js … | tail` must block too.
//
// The stage starts with `node`, which is not a runner name, so `GATE_AT_START` never
// matched and `stripLeadingWrappers` does not treat `node <script>` as a wrapper — nor
// should it, since `node scripts/whatever.mjs` is ordinary work.
//
// Matched on the PACKAGE under `node_modules`, not on the bin filename, so every layout
// works: `jest/bin/jest.js`, `.bin/jest`, `vitest/vitest.mjs`, `typescript/bin/tsc`.
// `playwright` and `next` keep their subcommand requirement — `playwright test` and
// `next build` are gates, `playwright show-report` and `next dev` are not, exactly as in
// `DIRECT_RUNNERS` above. Interpreter flags (`node --experimental-vm-modules …`, the form
// jest's ESM docs prescribe) are consumed before the path.
const NODE_FLAGS = String.raw`(?:--[\w-]+(?:=\S+)?\s+)*`;
const NODE_MODULES_PATH = String.raw`\S*node_modules[\\/]`;
const NODE_ENTRY_RUNNERS = String.raw`(?:\.bin[\\/](?:(?:jest|vitest|tsc|eslint)(?![-\w])|playwright\s+test|next\s+build)|(?:jest|vitest|eslint|typescript)[\\/]\S*|@playwright[\\/]test[\\/]\S*\s+test|next[\\/]\S*\s+build)`;
const NODE_ENTRY = String.raw`node\s+${NODE_FLAGS}${NODE_MODULES_PATH}${NODE_ENTRY_RUNNERS}`;

// Unity and .NET gates. A Unity project's agents run tests and compiles through three shapes,
// and without them this guard guards nothing there:
//   - the unity CLI's command channel: `unity command run_tests --mode editor`,
//     `unity command recompile` (the compile gate);
//   - the Editor in batch mode: `Unity.exe -batchmode -projectPath . -runTests …`. The executable
//     path is usually quoted (it lives under Program Files), and quoted text is blanked before
//     matching, so the stage can reach here as bare flags — hence the second, flag-led form. It
//     still requires `-runTests`, so `-batchmode -buildTarget …` builds are not matched;
//   - `dotnet test` / `dotnet build` against the generated solution.
// Flags may carry a value (`--format json`), and the command name may itself be a flag's value
// (`--query run_tests`), so a value is anything that is neither a flag nor a gate command.
const UNITY_CLI = String.raw`unity\s+command\s+(?:--[\w-]+(?:=\S+|\s+(?!run_tests\b|recompile\b)[^-\s]\S*)?\s+)*(?:run_tests|recompile)`;
// An unquoted `/c/Program\ Files/...` path reaches here split at the escaped space, so leading
// path FRAGMENTS (tokens with a slash) may precede the executable.
const UNITY_BATCH = String.raw`(?:(?:\S*[\\/]\S*\s+)*(?:\S*[\\/])?Unity(?:\.exe)?\s+|-(?:batchmode|projectPath|nographics|quit)\b\s+)(?:\S+\s+)*?-runTests`;
const DOTNET = String.raw`dotnet\s+(?:test|build)`;
export const GATE = new RegExp(
  String.raw`\b(?:npm\s+(?:run\s+)?(?:test|lint|build|type-?check)|npx\s+${DIRECT_RUNNERS}|yarn\s+(?:test|lint|build|type-?check)|pnpm\s+` +
    PNPM_SELECTORS +
    String.raw`(?:(?:run\s+)?(?:test|lint|build|type-?check)|(?:exec\s+|dlx\s+)?${DIRECT_RUNNERS})|pnpx\s+${DIRECT_RUNNERS}|${NODE_ENTRY}|${UNITY_CLI}|${UNITY_BATCH}|${DOTNET}|(?:jest|vitest|eslint)(?![-\w])|tsc\s+--noEmit|next\s+build|bd\s+dolt\s+(?:push|pull)|(?:node\s+)?\S*bd-dolt-sync\.mjs\s+(?:push|pull))\b`,
);
export const MASK = /\|\s*(?:tail|head|grep|rg|wc)\b/;

// A nested shell EXECUTES the text it is handed, so quoted/heredoc content is
// live code there and must keep being scanned: `bash -c "npm test | tail"`,
// `sh <<'EOF' … EOF`, `… | bash`. Matching `bash scripts/foo.sh` is deliberately
// avoided — that runs a FILE, and its contents are not in this command string.
const NESTED_SHELL =
  /\b(?:ba|z|da|k)?sh\b(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c\b|\b(?:ba|z|da|k)?sh\b\s*<<|\|\s*(?:ba|z|da|k)?sh\b/;

/**
 * Blank out heredoc BODIES, keeping the surrounding command intact. A heredoc is
 * how PR/bead bodies reach `gh`/`bd`, and those bodies routinely contain both
 * gate names and `|` (markdown tables).
 */
export function stripHeredocs(cmd) {
  // <<TAG | <<-TAG | <<'TAG' | <<"TAG"
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let out = cmd;
  let m;
  while ((m = re.exec(out)) !== null) {
    const tag = m[2];
    const bodyStart = out.indexOf("\n", m.index + m[0].length);
    if (bodyStart === -1) break;
    // Terminator: a line consisting solely of the tag (optionally indented, which
    // <<- allows). Anchor to line starts so a tag mentioned mid-body is ignored.
    const endRe = new RegExp(`\\n[ \\t]*${tag}[ \\t]*(?=\\n|$)`);
    const rest = out.slice(bodyStart);
    const endMatch = endRe.exec(rest);
    const bodyEnd = endMatch ? bodyStart + endMatch.index + endMatch[0].length : out.length;
    out = out.slice(0, bodyStart) + out.slice(bodyEnd);
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}

/**
 * Blank out single- and double-quoted runs, preserving everything outside them.
 * Content becomes a space so tokens either side stay separated and any `|` that
 * lived inside the quotes stops looking like a pipe.
 */
export function stripQuoted(cmd) {
  let out = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += " ";
        continue;
      }
      // A backslash escape outside quotes hides the next char from the shell.
      if (ch === "\\" && i + 1 < cmd.length) {
        out += "  ";
        i++;
        continue;
      }
      out += ch;
    } else {
      // Only double quotes honour backslash escapes; inside '' a backslash is literal.
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      // Newlines are kept so heredoc/line structure elsewhere is not merged.
      else if (ch === "\n") out += "\n";
    }
  }
  return out;
}

/** Reduce a command to just the text a shell would EXECUTE from this string. */
export function executableText(cmd) {
  if (NESTED_SHELL.test(cmd)) return cmd; // the quoted text is itself code — scan it all
  return stripQuoted(stripHeredocs(cmd));
}

// A gate is a COMMAND, and commands start a pipeline stage. Matching the gate
// token only at stage start (after leading wrappers) is what stops a path, glob,
// grep pattern, branch slug or filename that merely CONTAINS a runner's name from
// counting as a gate — `ls node_modules/.bin/<runner>* | head -1` is a plain ls.
// A substring match blocked worktree slugs, probe filenames and search terms that
// merely contained a runner's name.
const GATE_AT_START = new RegExp("^(?:" + GATE.source.slice(2) + ")");
const FILTER_STAGE = /^\s*(?:tail|head|grep|rg|wc)\b/;

// `timeout [opts] N`: `timeout 900 npm run lint | tail -4` printed
// two ESLint errors and a green EXIT:0. `timeout` is coreutils, not `time` (a
// bash builtin/keyword) — the old LEADING_WRAPPERS regex had `time` but not
// `timeout`, and the two are NOT prefix-compatible for a plain alternation: any
// attempt to add "timeout" as another bare alternative still leaves its
// mandatory DURATION argument (`900`) sitting in front of the gate word, so
// `isGateStage` would still see "900 npm run lint" and refuse to match. A
// value-bearing option set (`-s SIG`/`--signal SIG`, `-k DUR`/`--kill-after
// DUR`) plus a required duration token is exactly the shape a single regex
// alternation cannot express without exploding, so `timeout` gets a dedicated
// token-consuming step instead of one more `LEADING_WRAPPERS` alternative.
const TIMEOUT_OPTION =
  /^(?:-[sk]\s+\S+|--signal(?:=|\s+)\S+|--kill-after(?:=|\s+)\S+|--foreground|--preserve-status|-v|--verbose)\s+/;

// ── Consumer capture wrappers (`bash scripts/gate.sh <gate…>`) ───────────────
//
// A consuming repo often owns a small script whose whole job is to run the gate
// it is handed, tee its output to a log and re-emit the gate's own exit code —
// the sanctioned way to KEEP gate output without a pipe. That script is a
// wrapper in exactly the sense of `timeout`/`env`/`rtk` above: the gate is still
// the thing whose exit code a downstream filter would mask. But the stage starts
// with `bash` (or the script path), which is no runner name, so `GATE_AT_START`
// never matched and `bash scripts/gate.sh npm test | tail -30` sailed through —
// the precise shape the guard exists to refuse. Two workers in one consuming
// repo hit it on the same day, both while correctly following that repo's own
// documented advice to capture gates with its wrapper.
//
// This is matched as a PATTERN, not a path: any `[bash|sh] [<dir>/]gate.sh`, so
// no consumer's directory layout is baked into the shared source. `gate.sh` is a
// generic enough name for "re-exec my argument as a gate" to hardcode, and a
// consumer whose wrapper is spelled differently names it in
// `AGENT_HOOKS_GATE_WRAPPERS` (comma/space separated BASENAMES) instead of
// forking this file — `sync.mjs --env-prefix` rewrites the neutral prefix on
// vendoring, exactly as it does for the escape hatches.
//
// NOTE the deliberate asymmetry with `NESTED_SHELL`, which avoids matching
// `bash scripts/foo.sh` because that runs a FILE whose contents are not in this
// command string. Here the opposite holds: the gate is an ARGUMENT, right there
// in the string, and stripping the wrapper hands it to the existing matcher.
const DEFAULT_GATE_WRAPPERS = ["gate.sh"];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let wrapperCache = { key: null, re: null };

/** `^[bash|sh] [<path>/]<wrapper>\s+` for the configured wrapper basenames. */
function gateWrapperPrefix() {
  const key = process.env.AGENT_HOOKS_GATE_WRAPPERS ?? "";
  if (wrapperCache.key === key) return wrapperCache.re;
  const configured = key
    .split(/[,\s]+/)
    .filter(Boolean)
    // A configured entry is a BASENAME; anything with a separator is a path and
    // is ignored rather than silently matching nothing.
    .filter((n) => !/[\\/]/.test(n));
  const names = configured.length ? configured : DEFAULT_GATE_WRAPPERS;
  const re = new RegExp(
    String.raw`^(?:(?:ba|z|da|k)?sh\s+)?(?:\S*[\\/])?(?:${names.map(escapeRe).join("|")})\s+`,
  );
  wrapperCache = { key, re };
  return re;
}

// ── …and the wrapper's OWN options ───────────────────────────────────────────
//
// Stripping the wrapper NAME alone is half a fix, and the other half reopened
// the hole one day later. A capture wrapper takes options of its own before the
// gate — the consuming repo that reported the original bug documents
// `gate.sh --name <slug> <gate…>` for naming the log file — so
// `bash scripts/gate.sh --name probe npm run lint | tail` left `--name probe npm
// run lint`, whose command word is `--name`. `isGateStage` read that as no gate
// at all and let the pipe through. The flag is not an exotic spelling either: it
// is what a fan-out wave reaches for, several gates in one worktree each wanting
// a readable log, so the guard went quiet for exactly the workflow that needs it
// most. This is the same shape as `timeout`'s value-bearing options, which have
// a dedicated token-consuming step directly below for precisely this reason.
//
// The arity of a CONSUMER's flag is unknowable from here, so it is not guessed:
// a flag's value token is consumed only when the remainder after the flag is not
// already a gate. `--name probe npm test` consumes the pair; a boolean
// `--quiet npm test` keeps `npm test`. Ties go to the gate — over-consuming
// would hand back the silent pass this exists to close, while over-blocking is
// visible, arguable, and has `set -o pipefail;` as its documented hatch.
const WRAPPER_OPTION = /^--?[A-Za-z][^\s]*(?=\s|$)/;
const WRAPPER_END_OF_OPTIONS = /^--(?=\s|$)/;

/**
 * Consume a capture wrapper's own leading options — `--name <slug>`, `-q`,
 * `--name=<slug>`, and a bare `--` end-of-options marker — from the text
 * following the wrapper name.
 */
function stripWrapperOptions(rest) {
  let s = rest.trimStart();
  for (;;) {
    if (WRAPPER_END_OF_OPTIONS.test(s)) return s.slice(2).trimStart();
    const om = WRAPPER_OPTION.exec(s);
    if (!om) return s;
    const after = s.slice(om[0].length).trimStart();
    // `--opt=value` carries its value in the one token; a flag standing directly
    // in front of a gate, or in front of another option, is boolean as far as
    // anything here can tell.
    if (
      om[0].includes("=") ||
      GATE_AT_START.test(after) ||
      WRAPPER_OPTION.test(after) ||
      WRAPPER_END_OF_OPTIONS.test(after)
    ) {
      s = after;
      continue;
    }
    const vm = /^\S+/.exec(after);
    if (!vm) return after;
    s = after.slice(vm[0].length).trimStart();
  }
}

/**
 * Strip leading command wrappers — VAR=val, `env […]`, `rtk [proxy]`, `sudo`,
 * `nice [-n N]`, `command`, `time`, `nohup`, `exec`, `timeout [opts] N`, and a
 * consumer's capture wrapper with its own options (`bash scripts/gate.sh
 * --name probe …`) — off the front of a pipeline stage, in any combination, so
 * `isGateStage` sees the real command word. Token-based rather than one
 * monolithic regex specifically so `timeout`'s value-bearing options and
 * mandatory duration argument — and a capture wrapper's own flags — are
 * consumed correctly instead of being mistaken for the gate itself.
 */
export function stripLeadingWrappers(stage) {
  let s = stage.trim();
  for (;;) {
    const before = s;

    let m = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      continue;
    }

    m = /^(?:sudo|command|time|nohup|exec)\s+/.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      continue;
    }

    // `nice [-n N] cmd` — the priority value is optional and, when present, is
    // itself a token the gate-position check must not trip over.
    m = /^nice\s+/.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      const nm = /^-n\s+\S+\s+/.exec(s);
      if (nm) s = s.slice(nm[0].length);
      continue;
    }

    m = gateWrapperPrefix().exec(s);
    if (m) {
      s = stripWrapperOptions(s.slice(m[0].length));
      continue;
    }

    m = /^rtk(?:\s+proxy)?\s+/.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      continue;
    }

    m = /^env\s+/.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      for (;;) {
        const em = /^(?:-[iu](?:\s+\S+)?|--(?:unset|ignore-environment)(?:\s+\S+)?|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+/.exec(
          s,
        );
        if (!em) break;
        s = s.slice(em[0].length);
      }
      continue;
    }

    m = /^timeout\s+/.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      for (;;) {
        const om = TIMEOUT_OPTION.exec(s);
        if (!om) break;
        s = s.slice(om[0].length);
      }
      // The mandatory duration token itself (`900`, `90s`, `0.5m`, …).
      const dm = /^\S+\s+/.exec(s);
      if (dm) s = s.slice(dm[0].length);
      continue;
    }

    if (s === before) break;
  }
  return s;
}

/** True when this pipeline stage, once its wrappers are stripped, IS a gate invocation. */
export function isGateStage(stage) {
  const command = stripLeadingWrappers(stage);
  // A help lookup (`bd dolt push --help | head`, `dotnet test -h | grep filter`) prints usage and
  // exits without running anything, so there is no verdict for the pipe to mask.
  if (HELP_FLAG.test(command)) return false;
  return GATE_AT_START.test(command);
}

const HELP_FLAG = /(?:^|\s)(?:--help|-h|-\?|\/\?)(?=\s|$)/;

/**
 * The original, pre-stage-start behaviour: gate token ANYWHERE, filter pipe anywhere in
 * the same ;/&&/|| segment. Kept only for nested shells, where the quoted text is
 * itself executed and cannot be split into stages from out here.
 */
function legacyScan(cmd) {
  for (const m of cmd.matchAll(new RegExp(GATE.source, "g"))) {
    const segment = cmd.slice(m.index).split(/;|&&|\|\|/)[0];
    if (MASK.test(segment)) return true;
  }
  return false;
}

/** True when a gate's exit code would be masked by a filter later in its own pipeline. */
export function isMaskedGate(rawCmd) {
  // Explicit escape hatches: the author is already handling pipeline exits.
  if (/pipefail|PIPESTATUS/.test(rawCmd)) return false;

  if (NESTED_SHELL.test(rawCmd)) return legacyScan(rawCmd);

  const cmd = executableText(rawCmd);

  // Only a filter DOWNSTREAM of a gate in the SAME pipeline masks its exit code —
  // `npm test > log; grep foo log | tail` is fine (the gate's exit was already
  // observable at the `;`). Split into ;/&&/|| segments, then each into `|` stages.
  for (const segment of cmd.split(/;|&&|\|\|/)) {
    const stages = segment.split("|");
    for (let i = 0; i < stages.length; i++) {
      if (!isGateStage(stages[i])) continue;
      if (stages.slice(i + 1).some((s) => FILTER_STAGE.test(s))) return true;
    }
  }
  return false;
}

// ── PowerShell ──────────────────────────────────────────────────────────────
//
// WHAT COUNTS AS A FILTER HERE. In PowerShell the masking mechanism is not a
// property of the downstream command's own exit code (cmdlets have none) — it is
// that the pipeline's success becomes the LAST CMDLET's. So *every* cmdlet that
// can terminate a pipeline masks a native gate upstream of it, and the list below
// is the vocabulary that actually shows up in agent transcripts rather than an
// attempt to enumerate all of PowerShell:
//
//   Select-Object   the head/tail analogue, and the most common peek
//   Select-String   the grep analogue
//   Measure-Object  the wc analogue
//   Where-Object    a filtered peek, same masking
//   ForEach-Object  ditto, and the `%` form is common in one-liners
//   Sort-Object     ditto
//   Tee-Object      NOT the Bash `tee` case: Bash `tee` passes the gate's status
//                   through the pipeline unchanged, PowerShell's does not
//   Out-Null        the `| Out-Null` discard. `> $null` is redirection, not a
//                   pipe, and stays allowed — it is half of the sanctioned shape
//   Out-String / Out-File / Out-Host   all terminate the pipeline in a cmdlet
//
// Deliberately NOT listed: Format-Table/Format-List and friends (they mask too,
// but nobody reaches for them to peek at gate output, and every extra entry is
// extra false-block surface), and any attempt at a generic `Verb-Noun` rule —
// that would block `npm test | ConvertFrom-Json`-shaped legitimate work with no
// message that fits. Add to this list when a real transcript needs it.
//
// Unix filter names are matched on the PowerShell side too: Git-Bash's tools are
// commonly on PATH on Windows, so `npx jest | head -5` runs — and masks — from the
// PowerShell tool exactly as it would from Bash.
const PS_FILTER_NAMES =
  "Select-Object|Select-String|Where-Object|ForEach-Object|Sort-Object|Measure-Object|Tee-Object|" +
  "Out-Null|Out-String|Out-File|Out-Host|" +
  // Aliases that matter. `select`/`sls`/`measure`/`tee`/`where`/`sort`/`foreach`
  // are the built-in aliases for the cmdlets above; `%` and `?` are the
  // ForEach-Object / Where-Object symbol aliases and are what a terse one-liner
  // actually uses.
  "select|sls|where|foreach|sort|measure|tee";
// PowerShell is case-INSENSITIVE for command names, hence the `i` flag on both.
export const PS_FILTER_STAGE = new RegExp(
  "^\\s*(?:(?:" + PS_FILTER_NAMES + ")\\b|[%?](?=\\s|\\{|$))",
  "i",
);
export const PS_MASK = new RegExp(
  "\\|\\s*(?:(?:" + PS_FILTER_NAMES + ")\\b|[%?](?=\\s|\\{|$))",
  "i",
);

// A nested PowerShell that is handed its code as a STRING executes that string,
// so the quoting-stripper must not blank it away. Same contract as NESTED_SHELL.
const PS_NESTED_SHELL = /\b(?:powershell|pwsh)(?:\.exe)?\b[^;]*?\s-(?:c|command|encodedcommand)\b/i;

/**
 * Blank out PowerShell quoted runs: '…' (literal, '' escapes a quote), "…"
 * (expandable, backtick escapes), and both here-string forms `@'…'@` / `@"…"@`.
 * Newlines inside a run are preserved so statement structure outside survives.
 */
export function stripPowerShellQuoted(cmd) {
  let out = "";
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    // Here-strings first: @' … '@ — the terminator is the ONLY thing that ends
    // them, so an inner quote of the same kind is ordinary text.
    if (ch === "@" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      const q = cmd[i + 1];
      const end = cmd.indexOf(q + "@", i + 2);
      const body = end === -1 ? cmd.slice(i + 2) : cmd.slice(i + 2, end);
      out += " " + body.replace(/[^\n]/g, " ");
      i = end === -1 ? cmd.length : end + 2;
      continue;
    }
    // A backtick outside quotes escapes the next character from the parser.
    if (ch === "`" && i + 1 < cmd.length) {
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < cmd.length) {
        if (q === '"' && cmd[i] === "`" && i + 1 < cmd.length) {
          i += 2;
          continue;
        }
        if (cmd[i] === q) {
          // A doubled quote inside a quoted run is an escaped literal quote.
          if (cmd[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (cmd[i] === "\n") out += "\n";
        i++;
      }
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split off balanced top-level `{ … }` script blocks. A `|` INSIDE a block is a
 * pipeline of that block, never a separator of the outer one — but the block's
 * own body is live code, so it is returned for scanning rather than discarded.
 * `ForEach-Object { npm test | Select-Object -First 1 }` must still block.
 */
export function splitScriptBlocks(cmd) {
  let outer = "";
  let buf = "";
  let depth = 0;
  const blocks = [];
  for (const ch of cmd) {
    if (ch === "{") {
      if (depth === 0) {
        depth = 1;
        buf = "";
        outer += " ";
      } else {
        depth++;
        buf += ch;
      }
      continue;
    }
    if (ch === "}") {
      if (depth === 1) {
        depth = 0;
        blocks.push(buf);
        buf = "";
        outer += " ";
      } else if (depth > 1) {
        depth--;
        buf += ch;
      } else {
        outer += ch;
      }
      continue;
    }
    if (depth > 0) buf += ch;
    else outer += ch;
  }
  // An unbalanced `{` still carries live code; scan what there is.
  if (depth > 0 && buf) blocks.push(buf);
  return { outer, blocks };
}

/** Pipeline stages of one PowerShell statement, script blocks handled separately. */
function psChunks(cmd) {
  const { outer, blocks } = splitScriptBlocks(cmd);
  return [outer, ...blocks];
}

/** Nested-shell fallback, mirroring legacyScan: gate anywhere + filter in the same statement. */
function legacyScanPs(cmd) {
  for (const m of cmd.matchAll(new RegExp(GATE.source, "g"))) {
    const segment = cmd.slice(m.index).split(/;|&&|\|\||\n/)[0];
    if (MASK.test(segment) || PS_MASK.test(segment)) return true;
  }
  return false;
}

/**
 * True when a gate's exit code would be masked by a PowerShell filter later in
 * its own pipeline.
 *
 * ESCAPE HATCH — and why it is not `pipefail`. PowerShell has no pipefail and no
 * PIPESTATUS; there is nothing to turn on. What DOES survive a cmdlet is
 * `$LASTEXITCODE`, which the native gate sets directly. So the sanctioned peek is
 * the pipeline plus an explicit read of it:
 *   npx jest 2>&1 | Select-Object -Last 20; "EXIT:$LASTEXITCODE"
 * A command that mentions `$LASTEXITCODE` is taken as "the author is handling the
 * exit themselves", exactly as `pipefail` is on the Bash side.
 *
 * `$?` is deliberately NOT accepted: after a pipeline it reports the last
 * CMDLET's success, which is the very thing that masks the gate — accepting it
 * would hand callers a hatch that does not work.
 */
export function isMaskedGatePowerShell(rawCmd) {
  if (/\$LASTEXITCODE/i.test(rawCmd)) return false;

  if (PS_NESTED_SHELL.test(rawCmd) || NESTED_SHELL.test(rawCmd)) return legacyScanPs(rawCmd);

  for (const chunk of psChunks(stripPowerShellQuoted(rawCmd))) {
    // `;` separates statements; `&&`/`||` are PS 7 pipeline-chain operators and
    // end a pipeline just as they do in Bash; a newline ends a statement too.
    for (const segment of chunk.split(/;|&&|\|\||\n/)) {
      const stages = segment.split("|");
      for (let i = 0; i < stages.length; i++) {
        if (!isGateStage(stages[i].replace(/^\s*&\s+/, ""))) continue;
        if (stages.slice(i + 1).some((s) => PS_FILTER_STAGE.test(s) || FILTER_STAGE.test(s))) return true;
      }
    }
  }
  return false;
}

// Agents hitting this guard have asked "how do I take a quick filtered peek?" and
// "why did the file write before my gate get discarded too?". Both have answers —
// the pipefail escape hatch, and the fact that a PreToolUse hook rejects the whole
// call — so the message says both. A consumer that has a capture wrapper of its own
// names it in `block-masked-gates.hint.txt` (see refusal-notice.mjs).
export const MESSAGE =
  "Blocked: gate command piped into a filter masks its exit code (no pipefail by default) — a failing gate reads as success. " +
  "This holds even behind a `timeout`/`env`/`nice`/`rtk`/`time` prefix, or a capture wrapper that re-runs the gate it is handed " +
  "(`bash scripts/gate.sh <gate>`), or any combination of them — the gate is still what the pipe is masking. " +
  NOTHING_RAN_NOTICE + " Keep file writes and other side effects in a separate call from gates. " +
  "Run the gate bare and let it stream, or capture the exit explicitly: `<gate> > /dev/null 2>&1; echo EXIT:$?`. " +
  "A trailing `; echo \"X:$?\"` typed straight after the pipeline is NOT that capture — `$?` there is always the last " +
  "pipeline stage's status (tail's, head's, grep's, …), never the gate's, so `timeout 900 npm run lint 2>&1 | tail -4; echo \"LINT:$?\"` " +
  "reads green on a real failure. The `> /dev/null 2>&1; echo EXIT:$?` form works because there is no pipe left to mask anything. " +
  "For a filtered PEEK at the output, prefix the command with `set -o pipefail;` — then the pipeline exits with the gate's status and this hook allows it " +
  "(e.g. `set -o pipefail; npx tsc --noEmit 2>&1 | head -20`). " +
  "To KEEP the output, redirect into an existing directory in the worktree and read the exit on the same line: " +
  "`<gate> > gate.log 2>&1; echo EXIT:$?` (a redirect into a missing directory fails before the gate runs).";

// The Bash message's advice is Unix-shaped and would be actively misleading to a
// PowerShell caller: `set -o pipefail` is a syntax error there, `/dev/null` is
// not a path, and `$?` looks like the obvious substitute while being exactly the
// thing that masks the gate. So the PowerShell block gets its own text, naming
// the hatch that does work.
export const PS_MESSAGE =
  "Blocked: gate command piped into a PowerShell filter masks its exit code — a pipeline ending in a cmdlet " +
  "(Select-Object, Select-String, Where-Object, Measure-Object, Tee-Object, Out-Null, …) reports the CMDLET's " +
  "success, so a failing gate reads as green. PowerShell has NO `pipefail`, and PS 7's `&&`/`||` do not fix it. " +
  NOTHING_RAN_NOTICE + " Keep file writes and other side effects in a separate call from gates. " +
  "Run the gate bare and let it stream, or capture the real exit explicitly: `<gate> > $null 2>&1; \"EXIT:$LASTEXITCODE\"`. " +
  "For a filtered PEEK, keep the pipeline and READ `$LASTEXITCODE` after it — the native command sets it and it " +
  "survives the cmdlet, and this hook allows any command that mentions it " +
  "(e.g. `npx jest 2>&1 | Select-Object -Last 20; \"EXIT:$LASTEXITCODE\"`). " +
  "Do NOT use `$?` instead: after a pipeline it reports the last cmdlet, not the gate.";

function main() {
  let toolName;
  let cmd;
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    toolName = payload?.tool_name ?? "";
    cmd = payload?.tool_input?.command ?? "";
  } catch {
    return 0;
  }
  try {
    // Default to the Bash analysis: the payload may omit tool_name (the ritual
    // smoke's runHook does), and Bash is the shape this guard has always had.
    if (/^powershell$/i.test(String(toolName))) {
      if (isMaskedGatePowerShell(cmd)) {
        process.stderr.write(PS_MESSAGE + consumerHint(import.meta.url));
        return 2;
      }
      return 0;
    }
    if (isMaskedGate(cmd)) {
      process.stderr.write(MESSAGE + consumerHint(import.meta.url));
      return 2;
    }
  } catch {
    return 0;
  }
  return 0;
}

// Only act when run as the hook; importing for tests must not touch the process.
if (isMain()) process.exit(main());

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
