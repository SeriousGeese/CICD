// Tests for the masked-gate guard. The hook had NO test file at first —
// which is part of why the quoted-argument false positive went unnoticed.
//
// Two halves that must both hold:
//   * BLOCK every real masked gate (the guard's whole purpose — PR #1181).
//   * ALLOW gate names that appear only as DATA (quoted args, heredoc bodies).
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  isMaskedGate,
  isMaskedGatePowerShell,
  isGateStage,
  stripQuoted,
  stripHeredocs,
  stripPowerShellQuoted,
  stripLeadingWrappers,
  splitScriptBlocks,
  executableText,
  MESSAGE,
  PS_MESSAGE,
} from "./block-masked-gates.mjs";

const hook = fileURLToPath(new URL("./block-masked-gates.mjs", import.meta.url));

function runHook(command, toolName) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(toolName ? { tool_name: toolName, tool_input: { command } } : { tool_input: { command } }),
    encoding: "utf8",
  });
}

// ── Must BLOCK: real masked gates ───────────────────────────────────────────

// ── Unity and .NET gates ────────────────────────────────────────────────────
test("blocks Unity CLI, Unity batch-mode and dotnet gates piped into a filter", () => {
  const bad = [
    "unity command run_tests --mode editor | tail -20",
    "unity command run_tests --mode editor --filter SceneBootstrap 2>&1 | grep -i fail",
    "unity command recompile | head",
    "unity command --format json run_tests | tail",
    "unity command --query run_tests | tail",
    "unity command --format=json recompile | head",
    "timeout 600 unity command run_tests --mode play | tail -5",
    "Unity.exe -batchmode -projectPath . -runTests -testPlatform EditMode | tail",
    "/c/Program\\ Files/Unity/Hub/Editor/6000.6.0f1/Editor/Unity.exe -batchmode -runTests | tail",
    '"C:/Program Files/Unity/Hub/Editor/6000.6.0f1/Editor/Unity.exe" -batchmode -projectPath . -runTests -testResults r.xml | tail',
    "dotnet test Tests.csproj | tail -30",
    "dotnet build Aftermath.slnx 2>&1 | grep -E 'error|warn'",
  ];
  for (const c of bad) assert.equal(isMaskedGate(c), true, c);
  for (const c of [
    "unity command run_tests --mode editor | Select-Object -Last 20",
    '& "C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.0f1\\Editor\\Unity.exe" -batchmode -projectPath . -runTests | Select-String Failed',
    "dotnet build | Measure-Object -Line",
  ]) {
    assert.equal(isMaskedGatePowerShell(c), true, c);
  }
});

test("Unity and .NET commands that are not test or compile gates stay allowed", () => {
  for (const c of [
    "unity command find_gameobjects --name Cop --format json | head",
    "unity command editor_status | tail -3",
    "unity status | grep ready",
    "unity pipeline list | head",
    "Unity.exe -batchmode -projectPath . -buildTarget Win64 -quit | tail",
    "dotnet --info | head",
    "dotnet list package | grep Netcode",
    "unity command run_tests --mode editor",
    "set -o pipefail; dotnet test | tail -30",
    "grep -n runTests Logs/Editor.log | tail",
    "echo Unity.exe -batchmode -runTests | tail",
    "cat docs/unity-cli/run_tests.md | head",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("a help lookup on a gate command is not a gate", () => {
  for (const c of [
    "bd dolt push --help | head",
    "bd dolt pull -h | grep remote",
    "dotnet test --help | grep filter",
    "npx vitest --help | head -40",
    "unity command run_tests --help | tail",
    "rtk npm test -- --help | head",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
  assert.equal(isMaskedGatePowerShell("dotnet build -? | Select-String verbosity"), false);
  // ...but a flag that merely CONTAINS "help" is still a real run, and so is a later gate.
  for (const c of ["npm test -- --helpers-dir x | tail", "jest --testNamePattern help | tail", "bd dolt push --help; bd dolt push | tail -1"]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("blocks the canonical masked gates", () => {
  const bad = [
    "npm test | tail -8",
    "npm test 2>&1 | tail -8",
    "npm run lint | grep error",
    "npm run type-check | head -20",
    "npm run build | wc -l",
    "npx jest | tail -3",
    "npx tsc --noEmit | grep TS",
    "yarn test | tail",
    "next build | rg error",
  ];
  for (const c of bad) assert.equal(isMaskedGate(c), true, c);
});

test("blocks pnpm and vitest gates, the shapes a pnpm monorepo actually runs", () => {
  const bad = [
    "pnpm test | head",
    "pnpm test 2>&1 | tail -5",
    "pnpm run lint | grep error",
    "pnpm typecheck | head -20",
    "pnpm run type-check | wc -l",
    "pnpm build | tail",
    "pnpm -r run typecheck | tail -3",
    "pnpm --recursive build | tail",
    "pnpm --filter @scope/web lint | grep warn",
    "pnpm --filter=@scope/web build | tail",
    "pnpm -F @scope/web test | head",
    "pnpm -C apps/web test | head",
    "pnpm -w test | tail",
    "pnpm vitest run | tail",
    "pnpm exec vitest run scripts | head",
    "pnpm exec tsc -p tsconfig.tools.json | grep TS",
    "pnpm dlx vitest | tail",
    "pnpx vitest run | tail",
    "npx vitest run | head",
    "vitest run | tail -4",
    "npm run typecheck | head",
    "yarn typecheck | tail",
    "rtk pnpm test | tail",
    "timeout 600 pnpm test | tail -4",
    "npm run test:hooks | tail",
    "pnpm run test:hooks | tail",
    "eslint scripts tests | tail",
    "npx eslint . | head",
    "pnpm exec eslint scripts | grep error",
  ];
  for (const c of bad) assert.equal(isMaskedGate(c), true, c);
  for (const c of bad) assert.equal(isMaskedGatePowerShell(c.replace(/\| (?:tail|head|grep|wc).*$/, "| Select-Object -Last 5")), true, c);
});

test("non-gate pnpm commands and data mentions stay allowed", () => {
  for (const c of [
    "pnpm install | tail -3",
    "pnpm list --depth 0 | grep vitest",
    "pnpm dev | head",
    "pnpm why vitest | head",
    "ls node_modules/.bin/vitest* | head -1",
    "ls node_modules/.bin/eslint-config* | head -1",
    "eslint-config-inspector --help | head",
    "npx tsc-alias | tail",
    "pnpm exec tsc-alias -p tsconfig.json | tail",
    "pnpm dlx vitest-environment-jsdom | tail",
    "pnpx jest-environment-jsdom | tail",
    "jest-codemods --help | head",
    `bd note ABC-1 "pnpm test | head is blocked now" | tail -1`,
    "pnpm test",
    "set -o pipefail; pnpm test | tail -20",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("blocks through the common wrappers", () => {
  for (const c of [
    "cd /c/git/example/app && npm test | tail -5",
    "rtk npm run lint | grep -i warn",
    "env -u GITHUB_TOKEN npm run build | head",
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("STILL blocks a masked gate inside a nested shell — stripping must not create a hole", () => {
  for (const c of [
    `bash -c "npm test | tail -5"`,
    `sh -c 'npm run lint | grep error'`,
    `bash -lc "npx jest | head -3"`,
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("blocks the second of two gates when only that one is masked", () => {
  assert.equal(isMaskedGate("npm run lint; npm test | tail -3"), true);
});

// ── Must ALLOW: quoted-data false positives ───────────────────────────────

test("THE BUG: a gate name inside a quoted argument is data, not a gate", () => {
  // Reproduces the real blocks hit on 2026-08-22 while filing beads.
  const cases = [
    `bd note ABC-x "acceptance: npm run lint and npm test pass" | tail -1`,
    `bd create "t" -d "Verify by running npm run test:scripts first." | tail -3`,
    `git commit -m "chore: make npm run build quieter" | head -2`,
  ];
  for (const c of cases) assert.equal(isMaskedGate(c), false, c);
});

test("THE BUG: a gate name inside a heredoc body is data too", () => {
  // Verified a genuine false positive under the pre-fix hook: the body mentions a
  // gate AND contains `| wc`, which the old whole-string scan read as a pipeline.
  const cmd = [
    "gh pr create --body-file - <<'EOF'",
    "Ran npm test, then counted the failures | wc -l to summarise.",
    "EOF",
  ].join("\n");
  assert.equal(isMaskedGate(cmd), false);
});

test("regression guard: a markdown table in a heredoc stays allowed", () => {
  // NOT a false positive before the fix — `| pass |` never matched the filter list.
  // Kept so the stripping cannot start blocking ordinary PR bodies.
  const cmd = [
    "gh pr create --body-file - <<'EOF'",
    "| Gate | Result |",
    "|---|---|",
    "| `npm run lint` | pass |",
    "EOF",
  ].join("\n");
  assert.equal(isMaskedGate(cmd), false);
});

test("a quoted pipe is not a pipe", () => {
  assert.equal(isMaskedGate(`npm test && bd note X "see output | tail"`), false);
});

test("single and double quotes both count as data", () => {
  assert.equal(isMaskedGate(`bd note X 'npm test | tail'`), false);
  assert.equal(isMaskedGate(`bd note X "npm test | tail"`), false);
});

// ── Must ALLOW: a gate NAME inside a path/pattern/argument is not a gate ───────
// (the substring false positive reported by a fresh session.)

test("THE BUG: a runner name inside a glob path, piped to head, is a plain ls", () => {
  assert.equal(isMaskedGate("ls node_modules/.bin/jest* | head -1"), false);
});

test("a gate word as a grep PATTERN or echo ARGUMENT is data", () => {
  for (const c of [
    "grep jest package.json | head -3",
    "echo jest | wc -l",
    "git log --oneline --grep=jest | head -5",
    "rg 'npm test' docs/ | wc -l",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("a gate word inside a branch slug or filename is data", () => {
  for (const c of [
    "bash scripts/worktree-new.sh gate-jest-fp fix/x --no-install 2>&1 | grep -E 'Path:|ERROR'",
    "node hook.mjs < probe-jest.json | head -1",
    "bd search 'jest glob' | head -2",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("isGateStage keys on command position after wrappers", () => {
  assert.equal(isGateStage("npm test"), true);
  assert.equal(isGateStage("  rtk npm run lint"), true);
  assert.equal(isGateStage("env -u GITHUB_TOKEN npm run build"), true);
  assert.equal(isGateStage("FOO=bar jest --ci"), true);
  assert.equal(isGateStage("ls node_modules/.bin/jest*"), false);
  assert.equal(isGateStage("grep jest file"), false);
});

test("a gate as a LATER pipeline stage, followed by a filter, still blocks", () => {
  assert.equal(isMaskedGate("cat tests.txt | npx jest | tail -3"), true);
});

test("a gate followed by a NON-filter stage is not masked", () => {
  assert.equal(isMaskedGate("npm test | cat"), false);
  assert.equal(isMaskedGate("npm test | tee out.log"), false);
});

// ── a `timeout` prefix defeated the guard entirely ──────────────
// Reported: `timeout 900 npm run lint 2>&1 | tail -4; echo "LINT:$?"` printed
// two real ESLint errors and LINT:0. Root cause: `time` (a bash builtin) was in
// LEADING_WRAPPERS, but `timeout` (coreutils, takes a mandatory duration and
// optional value-bearing options) was not, and is not prefix-compatible with a
// bare alternation — stripping just the word "timeout" still leaves its
// duration argument (`900`) sitting where the gate word needs to be.

test("THE BUG, exact reported command: a `timeout N` prefix no longer defeats the guard", () => {
  assert.equal(isMaskedGate('timeout 900 npm run lint 2>&1 | tail -4; echo "LINT:$?"'), true);
});

test("blocks `timeout [opts] N` in front of every gate shape", () => {
  for (const c of [
    "timeout 900 npm run lint | tail -4",
    "timeout 30 npm test | tail -5",
    "timeout -k 5 90s npm test | tail -3",
    "timeout --signal=TERM 30 npm run build | head -5",
    "timeout --kill-after=10s 120 npx jest | tail -3",
    "timeout -s TERM -k 5 90 npm run type-check | grep TS",
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("`timeout` combines with the other wrapper prefixes, in either order", () => {
  for (const c of [
    "env -u GITHUB_TOKEN timeout 900 npm test | tail -5",
    "rtk timeout 900 npm run lint | grep error",
    "cd /c/git/example/app && timeout 900 npm test | tail -3",
    "timeout 900 rtk npm run lint | tail -4",
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("a bare `timeout N <gate>` with no pipe stays allowed — only the mask is the bug", () => {
  for (const c of ["timeout 900 npm run lint", "timeout -k 5 90s npm test"]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("`nice [-n N]` and `time`/`command`/`nohup`/`exec` also strip their arguments correctly", () => {
  assert.equal(isMaskedGate("nice -n 10 npm test | tail -5"), true);
  assert.equal(isMaskedGate("nice npm test | tail -5"), true);
  assert.equal(isMaskedGate("time npm test | tail -5"), true);
  assert.equal(isMaskedGate("nice -n 10 npm test"), false);
});

test("isGateStage recognises every timeout/nice shape, and stripLeadingWrappers leaves only the command", () => {
  assert.equal(isGateStage("timeout 900 npm run lint"), true);
  assert.equal(isGateStage("timeout -k 5 90s npm test"), true);
  assert.equal(isGateStage("nice -n 10 npm test"), true);
  assert.equal(stripLeadingWrappers("timeout 900 npm run lint"), "npm run lint");
  assert.equal(stripLeadingWrappers("timeout -k 5 90s npm test"), "npm test");
  assert.equal(stripLeadingWrappers("nice -n 10 npm test"), "npm test");
  assert.equal(stripLeadingWrappers("env -u GITHUB_TOKEN timeout 900 npm test"), "npm test");
  // Non-wrapper text is left alone (no false "gate" reading).
  assert.equal(stripLeadingWrappers("ls node_modules/.bin/jest*"), "ls node_modules/.bin/jest*");
});

// ── a consumer's capture wrapper defeated the guard entirely ────
// Reported: `bash scripts/gate.sh npm test | tail -30`. A `gate.sh` wrapper
// exists precisely so a gate's output can be kept WITH its real exit code, so it
// is the shape an agent reaches for — and the stage starts with `bash`, which is
// no runner name, so the underlying `npm test` was never seen. Two workers hit it
// on the same day, each following their own repo's documented advice.

test("THE BUG: a `bash scripts/gate.sh` capture wrapper no longer defeats the guard", () => {
  assert.equal(isMaskedGate("bash scripts/gate.sh npm test | tail -5"), true);
});

test("blocks the capture wrapper in every invocation shape", () => {
  for (const c of [
    "bash scripts/gate.sh npm test | tail -5",
    "scripts/gate.sh npm test | head -20",
    "./scripts/gate.sh npm run lint | grep error",
    "sh scripts/gate.sh npx jest | wc -l",
    "bash gate.sh npm run type-check | tail -3",
    "bash scripts/gate.sh timeout 900 npm run lint | tail -4",
    "timeout 900 bash scripts/gate.sh npm test | tail -4",
    "cd /c/git/example/app && bash scripts/gate.sh npm test 2>&1 | tail -30",
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("a bare capture-wrapper run with no pipe stays allowed — only the mask is the bug", () => {
  for (const c of [
    "bash scripts/gate.sh npm test",
    "scripts/gate.sh npm run lint",
    "bash scripts/gate.sh npm test > gate.log 2>&1; echo EXIT:$?",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("the pipefail hatch keeps working through the wrapper stripping", () => {
  assert.equal(isMaskedGate("set -o pipefail; bash scripts/gate.sh npm test | tail -5"), false);
  assert.equal(isMaskedGate("set -o pipefail; scripts/gate.sh npm run lint | head -20"), false);
});

test("the wrapper is stripped as a prefix, and non-wrapper `bash`/`gate.sh` text is left alone", () => {
  assert.equal(stripLeadingWrappers("bash scripts/gate.sh npm test"), "npm test");
  assert.equal(stripLeadingWrappers("sh ./tools/gate.sh npm run lint"), "npm run lint");
  assert.equal(stripLeadingWrappers("bash scripts/gate.sh timeout 900 npm test"), "npm test");
  assert.equal(isGateStage("bash scripts/gate.sh npm test"), true);
  // Not a wrapper invocation: the script is DATA here, not a command re-running a gate.
  assert.equal(stripLeadingWrappers("cat scripts/gate.sh"), "cat scripts/gate.sh");
  assert.equal(isMaskedGate("cat scripts/gate.sh | head -20"), false);
  assert.equal(isMaskedGate("ls scripts/gate.sh | wc -l"), false);
  // A wrapper wrapping something that is not a gate is still not a gate.
  assert.equal(isMaskedGate("bash scripts/gate.sh ls | tail -5"), false);
});

// ── …and then the wrapper's OWN option reopened it ─────────────────────────
// Reported one day after the fix above: `bash scripts/gate.sh --name probe npm
// run lint | tail -0` sailed through while the same command without `--name`
// was refused. Stripping the wrapper name left `--name probe npm run lint`,
// whose command word is `--name`. The flag is the documented way to name a
// captured run's log file, so the shape an agent reaches for during a fan-out
// wave — many gates, one worktree — was the one shape unguarded.

test("THE BUG: a capture wrapper's own `--name <slug>` no longer defeats the guard", () => {
  assert.equal(isMaskedGate("bash scripts/gate.sh --name probe npm run lint | tail -0"), true);
});

test("a wrapper's leading options are consumed whatever their shape", () => {
  for (const c of [
    "bash scripts/gate.sh --name probe npm run lint | tail -0",
    "scripts/gate.sh --name jest-guardrails npm test | head -20",
    // `--opt=value` carries its value in one token. No arity to guess.
    "bash scripts/gate.sh --name=probe npm test | tail -5",
    // A boolean flag: the value token must NOT be eaten, or the gate goes with it.
    "bash scripts/gate.sh -q npm test | tail -5",
    "bash scripts/gate.sh --quiet --name probe npm run type-check | grep error",
    // An explicit end-of-options marker.
    "bash scripts/gate.sh -- npm test | wc -l",
    // Composed with the other wrappers, in both orders.
    "bash scripts/gate.sh --name probe timeout 900 npm test | tail -4",
    "timeout 900 bash scripts/gate.sh --name probe npm test | tail -4",
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("consuming wrapper options changes nothing about the unpiped and hatch cases", () => {
  assert.equal(isMaskedGate("bash scripts/gate.sh --name probe npm run lint"), false);
  assert.equal(isMaskedGate("bash scripts/gate.sh --name probe npm test > gate.log 2>&1; echo EXIT:$?"), false);
  assert.equal(
    isMaskedGate("set -o pipefail; bash scripts/gate.sh --name probe npm test | tail -5"),
    false,
  );
  // A wrapper option in front of something that is not a gate is still not a gate.
  assert.equal(isMaskedGate("bash scripts/gate.sh --name probe ls | tail -5"), false);
  // A help lookup runs no gate, so there is still no verdict for the pipe to mask.
  assert.equal(isMaskedGate("bash scripts/gate.sh --help | head -20"), false);
});

test("option stripping is scoped to the wrapper — a bare leading option is not a gate", () => {
  assert.equal(stripLeadingWrappers("bash scripts/gate.sh --name probe npm test"), "npm test");
  assert.equal(stripLeadingWrappers("bash scripts/gate.sh --name=probe npm test"), "npm test");
  assert.equal(stripLeadingWrappers("bash scripts/gate.sh -q npm test"), "npm test");
  assert.equal(stripLeadingWrappers("bash scripts/gate.sh -- npm test"), "npm test");
  assert.equal(isGateStage("bash scripts/gate.sh --name probe npm test"), true);
  // Not a wrapper invocation: nothing here strips a leading option off a bare command.
  assert.equal(stripLeadingWrappers("--name probe npm test"), "--name probe npm test");
  assert.equal(isGateStage("--name probe npm test"), false);
  assert.equal(isMaskedGate("--name probe npm test | tail -5"), false);
});

test("a consumer can name a differently-spelled wrapper without forking the guard", () => {
  const prev = process.env.AGENT_HOOKS_GATE_WRAPPERS;
  try {
    process.env.AGENT_HOOKS_GATE_WRAPPERS = "run-gate.sh, gate.sh";
    assert.equal(isMaskedGate("bash tools/run-gate.sh npm test | tail -5"), true);
    assert.equal(isMaskedGate("bash scripts/gate.sh npm test | tail -5"), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HOOKS_GATE_WRAPPERS;
    else process.env.AGENT_HOOKS_GATE_WRAPPERS = prev;
  }
});

test("the PowerShell branch sees the wrapper too", () => {
  assert.equal(isMaskedGatePowerShell("bash scripts/gate.sh npm test | Select-Object -Last 5"), true);
  assert.equal(isMaskedGatePowerShell("bash scripts/gate.sh npm test"), false);
});

test("the PowerShell branch has the identical timeout gap, and the fix covers it too", () => {
  assert.equal(isMaskedGatePowerShell("timeout 900 npm test | Select-Object -Last 5"), true);
  assert.equal(isMaskedGatePowerShell("timeout 900 npm run lint | tail -4"), true);
  assert.equal(isMaskedGatePowerShell("timeout 900 npm test"), false);
});

test("the block message spells out the exact bare-capture replacement and the echo-after-pipe trap", () => {
  assert.match(MESSAGE, /<gate> > \/dev\/null 2>&1; echo EXIT:\$\?/);
  assert.match(MESSAGE, /echo "X:\$\?"/);
  assert.match(MESSAGE, /never the gate's/);
  assert.match(MESSAGE, /timeout.*npm run lint 2>&1 \| tail -4/);
});

// ── the bd-dolt-sync.mjs WRAPPER is the same gate, and the form a sync wrapper exists to make trustworthy ──
// Hit live: `node scripts/bd-dolt-sync.mjs push 2>&1 | tail -2; echo "EXIT:$?"`
// printed EXIT:0 over a push that had genuinely failed after 4 retries.
test("THE BLIND SPOT: the bd-dolt-sync wrapper piped to tail masks a failed push", () => {
  for (const cmd of [
    'node scripts/bd-dolt-sync.mjs push 2>&1 | tail -2',
    'node scripts/bd-dolt-sync.mjs pull 2>&1 | tail -1',
    'cd /home/user/src/app && node scripts/bd-dolt-sync.mjs push | tail -3',
    'node ./scripts/bd-dolt-sync.mjs push | grep verified',
    'scripts/bd-dolt-sync.mjs push | head -1',
  ]) {
    assert.equal(isMaskedGate(cmd), true, `should be BLOCKED: ${cmd}`);
  }
});

test("the wrapper's read-only `status` is not a gate — masking it costs nothing", () => {
  assert.equal(isMaskedGate('node scripts/bd-dolt-sync.mjs status | tail -1'), false);
});

test("the wrapper run BARE, or with its exit captured, is allowed", () => {
  for (const cmd of [
    'node scripts/bd-dolt-sync.mjs push',
    'node scripts/bd-dolt-sync.mjs push > /dev/null 2>&1; echo EXIT:$?',
    'set -o pipefail; node scripts/bd-dolt-sync.mjs push 2>&1 | tail -2',
  ]) {
    assert.equal(isMaskedGate(cmd), false, `should be ALLOWED: ${cmd}`);
  }
});

// ── bd dolt push/pull are gates: their exit is the only proof of a sync ──────

test("THE BLIND SPOT: bd dolt push piped to tail masks a rejected push", () => {
  for (const c of [
    "bd dolt push 2>&1 | tail -1 && echo synced",
    "bd dolt pull 2>&1 | tail -2",
    "cd /c/git/example/app && bd dolt push 2>&1 | tail -1",
    "bd dolt pull | tail -1; bd dolt push | tail -1",
  ]) {
    assert.equal(isMaskedGate(c), true, c);
  }
});

test("read-only bd commands piped to filters are fine", () => {
  for (const c of [
    "bd show ABC-x --json | head -20",
    "bd ready -n 100 | head -40",
    "bd search 'dolt push' | head -3",
    "bd dolt status | head -3",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("bd dolt push with its exit captured explicitly is fine", () => {
  assert.equal(isMaskedGate("bd dolt push > /dev/null 2>&1; echo EXIT:$?"), false);
  assert.equal(isMaskedGate("bd dolt push"), false);
});

// ── The sanctioned PEEK: pipefail makes the pipeline exit the gate's ─

test("a pipefail-prefixed filtered peek is allowed for every gate kind", () => {
  for (const c of [
    "set -o pipefail; npx tsc --noEmit 2>&1 | head -20",
    "set -o pipefail; npm test 2>&1 | tail -30",
    "set -o pipefail; bd dolt push 2>&1 | tail -1",
    "set -o pipefail && npm run lint | grep -i warn",
  ]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("the same peek WITHOUT pipefail is still blocked", () => {
  assert.equal(isMaskedGate("npx tsc --noEmit 2>&1 | head -20"), true);
});

test("the block message tells the agent about the peek and that nothing ran", () => {
  assert.match(MESSAGE, /set -o pipefail/);
  assert.match(MESSAGE, /NOTHING in this command ran/);
  assert.match(MESSAGE, /separate call/);
});

// ── Must ALLOW: pre-existing correct behaviour, unchanged ───────────────────

test("bare gates are fine", () => {
  for (const c of ["npm test", "npm run lint", "npm run build", "npm test > /dev/null 2>&1; echo EXIT:$?"]) {
    assert.equal(isMaskedGate(c), false, c);
  }
});

test("a filter in a LATER segment does not mask the gate", () => {
  assert.equal(isMaskedGate("npm test > log 2>&1; grep -c FAIL log | tail -1"), false);
});

test("the pipefail / PIPESTATUS escape hatches still apply", () => {
  assert.equal(isMaskedGate("set -o pipefail; npm test | tail -5"), false);
  assert.equal(isMaskedGate("npm test | tail -5; echo ${PIPESTATUS[0]}"), false);
});

test("non-gate commands piped to filters are untouched", () => {
  assert.equal(isMaskedGate("git log --oneline | head -20"), false);
  assert.equal(isMaskedGate("ls -la | grep node_modules"), false);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

test("stripQuoted blanks quoted runs and keeps the rest", () => {
  assert.match(stripQuoted(`bd note X "npm test | tail" -q`), /^bd note X\s+-q$/);
  assert.match(stripQuoted(`echo 'a | b' done`), /^echo\s+done$/);
});

test("stripQuoted survives an unterminated quote without throwing", () => {
  assert.doesNotThrow(() => stripQuoted(`bd note X "unterminated`));
});

test("stripHeredocs removes the body but keeps the command line", () => {
  const out = stripHeredocs("gh pr create --body-file - <<'EOF'\nnpm test | tail\nEOF\necho done");
  assert.doesNotMatch(out, /npm test/);
  assert.match(out, /gh pr create/);
  assert.match(out, /echo done/);
});

test("stripHeredocs handles an indented <<- terminator", () => {
  const out = stripHeredocs("cat <<-TAG\n\tnpm run lint | grep x\n\tTAG\necho after");
  assert.doesNotMatch(out, /npm run lint/);
  assert.match(out, /echo after/);
});

test("executableText leaves a nested-shell command completely intact", () => {
  const cmd = `bash -c "npm test | tail -5"`;
  assert.equal(executableText(cmd), cmd);
});

test("bash running a FILE is not a nested shell — its quoted args are still data", () => {
  // `bash scripts/foo.sh` executes a file whose contents are not in this string.
  assert.equal(isMaskedGate(`bash scripts/claim.sh ABC-x "npm test | tail"`), false);
});

// ── Hook process behaviour ──────────────────────────────────────────────────

test("hook exits 2 and explains itself on a real masked gate", () => {
  const r = runHook("npm test | tail -5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /masks its exit code/);
});

test("hook exits 0 on the quoted-argument case", () => {
  const r = runHook(`bd note ABC-x "npm run lint must pass" | tail -1`);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("hook exits 0 on malformed input rather than breaking Bash", () => {
  const r = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});

// ── PowerShell tool ──────────────────────────────────────────
//
// The hook was registered under the Bash matcher only, so the identical masked
// exit was completely unguarded on the PowerShell tool — and worse there, since
// PowerShell has no pipefail to reach for. This is the most plausible route to
// the false green recorded as a recorded case.

test("THE BEAD: a gate piped into a PowerShell filter is masked", () => {
  for (const c of [
    "npx jest src/__tests__/foo.test.ts | Select-Object -Last 5",
    "npm test 2>&1 | Select-Object -Last 20",
    "npm run lint | Select-String error",
    "npm run build | Measure-Object -Line",
    "npm run type-check | Out-Null",
    "npx tsc --noEmit | Out-String",
    "npm test | Out-File test.log",
    "npm test | Out-Host",
    "npm test | Tee-Object -FilePath out.log",
    "npm test | Where-Object { $_ -match 'FAIL' }",
    "npm test | ForEach-Object { $_ }",
    "npm test | Sort-Object",
    "bd dolt push | Select-Object -Last 1",
  ]) {
    assert.equal(isMaskedGatePowerShell(c), true, c);
  }
});

test("PowerShell command names are case-insensitive, and the aliases mask too", () => {
  for (const c of [
    "npm test | select-object -Last 5",
    "npm test | SELECT-OBJECT -Last 5",
    "npm test | select -Last 5",
    "npm run lint | sls error",
    "npm run build | measure",
    "npm test | tee out.log",
    "npm test | sort",
    "npm test | where { $_ }",
    "npm test | % { $_ }",
    "npm test | ? { $_ -match 'FAIL' }",
  ]) {
    assert.equal(isMaskedGatePowerShell(c), true, c);
  }
});

test("Unix filters run from the PowerShell tool mask just as hard", () => {
  // Git-Bash's tools are commonly on PATH on Windows, so these really do run.
  assert.equal(isMaskedGatePowerShell("npx jest | head -5"), true);
  assert.equal(isMaskedGatePowerShell("npm test 2>&1 | tail -8"), true);
});

test("the PowerShell escape hatch is an explicit $LASTEXITCODE read", () => {
  for (const c of [
    'npx jest 2>&1 | Select-Object -Last 20; "EXIT:$LASTEXITCODE"',
    "npm test > $null 2>&1; echo EXIT:$LASTEXITCODE",
    "npm run lint | Select-String warn; if ($LASTEXITCODE -ne 0) { throw }",
    // Case-insensitive, like everything else in the language.
    'npm test | Select-Object -Last 3; "$lastexitcode"',
  ]) {
    assert.equal(isMaskedGatePowerShell(c), false, c);
  }
});

test("`$?` is NOT a hatch — after a pipeline it reports the cmdlet, not the gate", () => {
  // Accepting it would hand callers a hatch that silently does not work, which
  // is the same false green in a costume.
  assert.equal(isMaskedGatePowerShell("npm test | Select-Object -Last 5; if (-not $?) { throw }"), true);
});

test("`set -o pipefail` does nothing in PowerShell and is not accepted there", () => {
  // It is a syntax error in PS. Honouring it would let the Bash muscle memory
  // walk straight past this guard.
  assert.equal(isMaskedGatePowerShell("set -o pipefail; npm test | Select-Object -Last 5"), true);
});

test("bare gates and redirection-only captures pass on PowerShell", () => {
  for (const c of [
    "npm test",
    "npx jest src/__tests__/foo.test.ts",
    // `> $null` is redirection, not a pipe — it never touched the exit code.
    "npm test > $null 2>&1",
    "npm run lint 2>&1 > lint.log",
  ]) {
    assert.equal(isMaskedGatePowerShell(c), false, c);
  }
});

test("a filter in a LATER PowerShell statement does not mask the gate", () => {
  assert.equal(
    isMaskedGatePowerShell("npm test > log.txt 2>&1; Get-Content log.txt | Select-Object -Last 5"),
    false,
  );
});

test("non-gate PowerShell pipelines are untouched", () => {
  for (const c of [
    "git log --oneline | Select-Object -First 20",
    "Get-ChildItem | Where-Object { $_.Name -like '*.md' }",
    "gh pr list | Select-String app",
  ]) {
    assert.equal(isMaskedGatePowerShell(c), false, c);
  }
});

test("a gate NAME inside a PowerShell quoted argument is data, not a gate", () => {
  for (const c of [
    `bd note ABC-x "acceptance: npm run lint and npm test pass" | Select-Object -Last 1`,
    `bd create 't' -d 'Verify by running npm run test:scripts first.' | Select-Object -First 3`,
    `git commit -m "chore: make npm run build quieter" | Select-Object -First 2`,
  ]) {
    assert.equal(isMaskedGatePowerShell(c), false, c);
  }
});

test("a here-string body is data too", () => {
  const cmd = ["gh pr create --body-file - @'", "Ran npm test, then piped it | Select-Object -Last 5.", "'@"].join("\n");
  assert.equal(isMaskedGatePowerShell(cmd), false);
});

test("a `|` inside a quoted PowerShell string is not a pipeline separator", () => {
  assert.equal(isMaskedGatePowerShell(`npm test; bd note X "see output | Select-Object"`), false);
});

test("a `|` inside a script block is that block's pipeline, not the outer one", () => {
  // The outer statement is `Get-ChildItem | ForEach-Object { … }` — the gate
  // inside the block is bare, so nothing is masked.
  assert.equal(
    isMaskedGatePowerShell("Get-ChildItem *.json | ForEach-Object { npm test }"),
    false,
  );
  // …but a gate masked INSIDE the block is still a masked gate.
  assert.equal(
    isMaskedGatePowerShell("Get-ChildItem *.json | ForEach-Object { npm test | Select-Object -Last 1 }"),
    true,
  );
});

test("STILL blocks a masked gate handed to a nested shell as a string", () => {
  for (const c of [
    `powershell -NoProfile -Command "npm test | Select-Object -Last 5"`,
    `pwsh -c 'npm run lint | Select-String error'`,
    `rtk powershell -NoProfile -Command "npx jest | Select-Object -Last 3"`,
    `bash -c "npm test | tail -5"`,
  ]) {
    assert.equal(isMaskedGatePowerShell(c), true, c);
  }
});

test("stripPowerShellQuoted blanks quoted runs, here-strings and backtick escapes", () => {
  assert.match(stripPowerShellQuoted(`bd note X "npm test | Select-Object" -q`), /^bd note X\s+-q$/);
  assert.match(stripPowerShellQuoted(`echo 'a | b' done`), /^echo\s+done$/);
  // '' and "" are escaped literal quotes inside a run, not terminators.
  assert.doesNotMatch(stripPowerShellQuoted(`echo 'it''s | fine' after`), /\|/);
  assert.doesNotThrow(() => stripPowerShellQuoted(`bd note X "unterminated`));
});

test("splitScriptBlocks separates block bodies from the outer statement", () => {
  const { outer, blocks } = splitScriptBlocks("gci | % { npm test | select -Last 1 }");
  assert.doesNotMatch(outer, /npm test/);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /npm test \| select -Last 1/);
});

test("splitScriptBlocks keeps nested braces with their block", () => {
  const { blocks } = splitScriptBlocks("% { if ($x) { npm test | select } }");
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /if \(\$x\) \{ npm test \| select \}/);
});

// ── Tool routing: PowerShell analysis only for the PowerShell tool ───────────

test("the hook blocks a PowerShell-shaped mask ONLY when tool_name says PowerShell", () => {
  const cmd = "npx jest | Select-Object -Last 5";
  const blocked = runHook(cmd, "PowerShell");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /PowerShell filter masks its exit code/);

  // The same string under Bash is not a masked gate — `Select-Object` is not a
  // Unix filter — and must not be blocked with PowerShell advice.
  assert.equal(runHook(cmd, "Bash").status, 0);
});

test("existing Bash behaviour is unchanged, with or without tool_name", () => {
  for (const tool of [undefined, "Bash"]) {
    const blocked = runHook("npm test | tail -5", tool);
    assert.equal(blocked.status, 2, `blocked for tool_name=${tool}`);
    assert.match(blocked.stderr, /set -o pipefail/);
    assert.equal(runHook("npm test", tool).status, 0);
    assert.equal(runHook("set -o pipefail; npm test 2>&1 | tail -5", tool).status, 0);
  }
});

test("the PowerShell message gives PowerShell advice, not Unix advice", () => {
  assert.match(PS_MESSAGE, /\$LASTEXITCODE/);
  assert.match(PS_MESSAGE, /NOTHING in this command ran/);
  assert.match(PS_MESSAGE, /separate call/);
  assert.match(PS_MESSAGE, /NO `pipefail`/);
  assert.match(PS_MESSAGE, /\$\?/);
  // The Unix-shaped advice would be actively misleading here.
  assert.doesNotMatch(PS_MESSAGE, /set -o pipefail`/);
  assert.doesNotMatch(PS_MESSAGE, /\/dev\/null/);
});

test("the PowerShell hook exits 0 on a clean command and says nothing", () => {
  const r = runHook("npm test", "PowerShell");
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

// ── the `node <path>/node_modules/<runner>` entrypoint form ────────
//
// Windows guidance prescribes this invocation whenever a jest pattern contains a `|`, because a
// `.cmd` shim re-parses the line through cmd.exe and eats the alternation (archive entry
// 53). The stage starts with `node`, which is not a runner name, so GATE_AT_START never
// matched it and the recommended form was the one the guard could not see.

test("blocks the node entrypoint forms of every runner", () => {
  const bad = [
    "node node_modules/jest/bin/jest.js --testPathPatterns 'a|b' | tail -8",
    "node ./node_modules/jest/bin/jest.js | grep FAIL",
    "node /abs/path/node_modules/jest/bin/jest.js | wc -l",
    "node node_modules/.bin/jest | tail -3",
    "node node_modules/.bin/tsc -p tsconfig.json | head -20",
    "node node_modules/typescript/bin/tsc --noEmit | head -20",
    "node node_modules/vitest/vitest.mjs run | tail -5",
    "node node_modules/eslint/bin/eslint.js . | tail -5",
    // jest's own ESM docs prescribe this flag, so it must not hide the gate.
    "node --experimental-vm-modules node_modules/jest/bin/jest.js | tail -2",
    "node node_modules/@playwright/test/cli.js test | tail -5",
    "node node_modules/next/dist/bin/next build | tail -5",
    "node node_modules/.bin/playwright test | tail -5",
    "node node_modules/.bin/next build | tail -5",
    "cd /tmp && node node_modules/jest/bin/jest.js | tail -1",
  ];
  for (const cmd of bad) assert.equal(isMaskedGate(cmd), true, cmd);
});

test("the node entrypoint form is blocked on the PowerShell path too", () => {
  assert.equal(isMaskedGatePowerShell("node node_modules/jest/bin/jest.js | Select-Object -Last 20"), true);
  assert.equal(isMaskedGatePowerShell("node node_modules/.bin/tsc -p tsconfig.json | Select-String error"), true);
});

test("a node entrypoint that is NOT a masked gate stays allowed", () => {
  const ok = [
    // Not masked at all.
    "node node_modules/jest/bin/jest.js --testPathPatterns a",
    "node node_modules/jest/bin/jest.js > /dev/null 2>&1; echo EXIT:$?",
    // The documented filtered-peek hatch.
    "set -o pipefail; node node_modules/jest/bin/jest.js | head -20",
    // An ordinary repo script is not a gate.
    "node scripts/report.mjs list | head -5",
    // Subcommand-gated runners keep their subcommand requirement, as in DIRECT_RUNNERS.
    "node node_modules/.bin/next dev | tail -5",
    "node node_modules/@playwright/test/cli.js show-report | tail -5",
    // A runner name that is only a package PREFIX is not the runner.
    "node node_modules/jest-environment-jsdom/build/index.js | head -1",
    // Merely NAMING a bin is not running it.
    "ls node_modules/.bin/jest* | head -1",
  ];
  for (const cmd of ok) assert.equal(isMaskedGate(cmd), false, cmd);
});

test("isGateStage recognises the node entrypoint at stage start", () => {
  assert.equal(isGateStage("node node_modules/jest/bin/jest.js --ci"), true);
  assert.equal(isGateStage("timeout 900 node node_modules/jest/bin/jest.js"), true);
  assert.equal(isGateStage("node scripts/run-node-tests.mjs"), false);
});

// ── `node --test`: Node's built-in test runner ──────────────────────────────
//
// `node --test x | tail` was allowed while the equivalent `npx jest x | tail`
// was refused — the flag never appeared anywhere in GATE, and it carries no
// `node_modules` package name for NODE_ENTRY to match either.

test("THE BUG: `node --test` piped into a filter is now blocked", () => {
  const bad = [
    "node --test scripts/foo.node-test.mjs | tail -5",
    "node --test | tail -5",
    "node --test scripts/hooks/*.node-test.mjs | grep FAIL",
    // The flag may sit anywhere among node's own leading flags.
    "node --test-reporter=tap --test scripts/foo.node-test.mjs | tail -5",
    "node --test --test-reporter tap scripts/foo.node-test.mjs | tail -5",
    "node --test-reporter=tap --test-reporter-destination stdout --test scripts/foo.node-test.mjs | tail",
    // `--test-reporter=…` alone, with no separate bare `--test` token, is still
    // recognised — the guard would rather over-recognise than miss one.
    "node --test-reporter=tap scripts/foo.node-test.mjs | tail -5",
    // Interpreter flags in front, same as the NODE_ENTRY case.
    "node --experimental-vm-modules --test scripts/foo.node-test.mjs | tail -2",
    "timeout 900 node --test scripts/foo.node-test.mjs | tail -5",
  ];
  for (const cmd of bad) assert.equal(isMaskedGate(cmd), true, cmd);
});

test("bare `node --test` (no pipe) stays allowed — only the mask is the bug", () => {
  assert.equal(isMaskedGate("node --test scripts/foo.node-test.mjs"), false);
  assert.equal(isMaskedGate("node --test scripts/foo.node-test.mjs > /dev/null 2>&1; echo EXIT:$?"), false);
});

test("`set -o pipefail; node --test x | tail` is allowed — the documented hatch", () => {
  assert.equal(isMaskedGate("set -o pipefail; node --test scripts/foo.node-test.mjs | tail -5"), false);
});

test("`node --test` is blocked on the PowerShell path too", () => {
  assert.equal(isMaskedGatePowerShell("node --test scripts/foo.node-test.mjs | Select-Object -Last 20"), true);
  assert.equal(isMaskedGatePowerShell("node --test scripts/foo.node-test.mjs"), false);
});

test("an unrelated node script with no --test-shaped flag stays allowed", () => {
  const ok = [
    "node scripts/report.mjs | tail -5",
    // Without a registered wrapper, run-node-tests.mjs carries no `--test` flag of its own
    // (the flag lives inside the CHILD process it spawns), so it is not recognised here either.
    "node scripts/run-node-tests.mjs test:scripts scripts/*.node-test.mjs | tail -5",
    // "--testing", not "--test": no word boundary right after "--test".
    "node scripts/foo.mjs --testing-mode | tail -5",
  ];
  for (const cmd of ok) assert.equal(isMaskedGate(cmd), false, cmd);
});

test("a `--test`-PREFIXED flag among node's own leading flags is still recognised — the guard over-recognises rather than misses a real one", () => {
  // "--test-runner-ui" is "--test" plus a "-[\w-]+" suffix, matching the same
  // prefix shape as node's real "--test-reporter"/"--test-only"/etc. This is the
  // same tradeoff NODE_TEST_FLAG accepts for `--test-reporter=…` above: an
  // unrelated `--test-*`-named flag sitting among node's leading flags is a false
  // positive, and the guard would rather over-recognise a test-runner invocation
  // than under-recognise a real `node --test-reporter=…` one that never carries a
  // bare `--test` token. (A `--test`-shaped flag AFTER a positional script-path
  // argument does not match, the same as any other node flag — node's own CLI
  // flags always precede positional arguments.)
  assert.equal(isMaskedGate("node --test-runner-ui scripts/foo.mjs | grep x"), true);
  assert.equal(isMaskedGate("node scripts/foo.mjs --test-runner-ui | grep x"), false);
});

// ── Registered wrapper scripts reached via `node` ───────────────────────────
//
// `run-node-tests.mjs` is the shape AGENTS.md mandates for `test:scripts`,
// `test:hooks` and `test:ritual`: `node scripts/run-node-tests.mjs <label>
// <glob>...`. It carries no `--test` flag itself (that is spawned internally),
// and it is not a `gate.sh`-style capture wrapper (its arguments are a label and
// a glob, not a nested gate command) — so it can only be recognised by name, via
// the same wrapper-registration env var the `gate.sh` capture wrapper uses.

test("THE BUG: a registered node-invoked wrapper piped into a filter is now blocked", () => {
  const prev = process.env.AGENT_HOOKS_GATE_WRAPPERS;
  try {
    process.env.AGENT_HOOKS_GATE_WRAPPERS = "gate.sh, run-node-tests.mjs";
    const bad = [
      "node scripts/run-node-tests.mjs test:scripts scripts/*.node-test.mjs | tail -5",
      "node scripts/run-node-tests.mjs test:hooks scripts/hooks/*.node-test.mjs | grep FAIL",
      "node ./scripts/run-node-tests.mjs test:ritual scripts/ritual/*.node-test.mjs | wc -l",
      "node /abs/path/scripts/run-node-tests.mjs test:scripts scripts/*.node-test.mjs | tail",
      // Interpreter flags in front are still consumed correctly.
      "node --experimental-vm-modules scripts/run-node-tests.mjs test:scripts x | tail -2",
      "timeout 900 node scripts/run-node-tests.mjs test:scripts x | tail -5",
    ];
    for (const cmd of bad) assert.equal(isMaskedGate(cmd), true, cmd);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HOOKS_GATE_WRAPPERS;
    else process.env.AGENT_HOOKS_GATE_WRAPPERS = prev;
  }
});

test("a registered node-invoked wrapper, bare or with the pipefail hatch, stays allowed", () => {
  const prev = process.env.AGENT_HOOKS_GATE_WRAPPERS;
  try {
    process.env.AGENT_HOOKS_GATE_WRAPPERS = "gate.sh, run-node-tests.mjs";
    assert.equal(isMaskedGate("node scripts/run-node-tests.mjs test:scripts scripts/*.node-test.mjs"), false);
    assert.equal(
      isMaskedGate("set -o pipefail; node scripts/run-node-tests.mjs test:scripts x | tail -5"),
      false,
    );
    // The unregistered default name ("gate.sh") is still recognised too — registering one
    // name does not drop the other, since the consumer lists both.
    assert.equal(isMaskedGate("node scripts/gate.sh npm test | tail -5"), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HOOKS_GATE_WRAPPERS;
    else process.env.AGENT_HOOKS_GATE_WRAPPERS = prev;
  }
});

test("an UNregistered wrapper basename reached via node stays allowed — registration is required", () => {
  const prev = process.env.AGENT_HOOKS_GATE_WRAPPERS;
  try {
    delete process.env.AGENT_HOOKS_GATE_WRAPPERS;
    // The default list is just ["gate.sh"], so run-node-tests.mjs is not
    // recognised until a consumer registers it. This is the existing "isGateStage
    // recognises the node entrypoint at stage start" assertion's sibling, stated
    // for isMaskedGate directly.
    assert.equal(isMaskedGate("node scripts/run-node-tests.mjs test:scripts x | tail -5"), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HOOKS_GATE_WRAPPERS;
    else process.env.AGENT_HOOKS_GATE_WRAPPERS = prev;
  }
});

test("a registered node-invoked wrapper is blocked on the PowerShell path too", () => {
  const prev = process.env.AGENT_HOOKS_GATE_WRAPPERS;
  try {
    process.env.AGENT_HOOKS_GATE_WRAPPERS = "gate.sh, run-node-tests.mjs";
    assert.equal(
      isMaskedGatePowerShell("node scripts/run-node-tests.mjs test:scripts x | Select-Object -Last 20"),
      true,
    );
    assert.equal(isMaskedGatePowerShell("node scripts/run-node-tests.mjs test:scripts x"), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HOOKS_GATE_WRAPPERS;
    else process.env.AGENT_HOOKS_GATE_WRAPPERS = prev;
  }
});
