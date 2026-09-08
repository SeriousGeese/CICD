/**
 * SPECIFICATION, NOT COVERAGE — every case here is SKIPPED on purpose.
 *
 * This is promptci-cloud's wait_for_ci suite, ported verbatim. It does not pass
 * against the current engine and is not meant to yet: it describes the wait_for_ci
 * this repo is migrating TOWARD, and un-skipping it is the first step of that
 * graft. It is committed skipped rather than deleted because it is the most
 * precise statement of the delta anyone will write, and rewriting it later from
 * memory would lose the incidents encoded in it.
 *
 * Running it against the DnD-derived engine currently in engine/ fails all 14
 * cases, and the failures enumerate the gap exactly:
 *
 *   1. `wait_for_ci` takes (sha, bot_pushed, ci_relevant) here; Cloud's takes
 *      (sha, bot_pushed). The third parameter went when Cloud removed the
 *      docs-only grace.
 *   2. No `missing_required_message`, and no return 6 for "a required context
 *      never registered" — the engine reads ci-status.jq's `required_missing`
 *      zero times.
 *   3. `ZERO_CHECKS_GRACE` is structured differently.
 *
 * THE BLOCKER, and it changes the plan's stage ordering:
 *
 * Cloud can fail closed on zero checks because its ci.yml `changes` job gates job
 * STEPS rather than jobs, so the `gate` check ALWAYS registers and zero-checks is
 * never legitimate. DnD's ci.yml uses `paths-ignore` on `content/**` and
 * `.beads/**`, so a PR touching only those produces zero checks legitimately and
 * relies on return 3 to merge at all.
 *
 * Adopting this wait_for_ci in DnD without first adopting the gate pattern would
 * block every content-only PR there, permanently. So Stage 6's gate normalization
 * is a PRECONDITION of Stage 5 for DnD, not an optional later cleanup — the
 * reverse of how the plan sequenced them.
 *
 * The graft therefore needs one of: DnD adopts the gate job first, or the
 * docs-only grace survives behind a flag the way CICD_STRICT_SKIPPED did.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BEHAVIOURAL tests for wait_for_ci() in engine/pr-review.sh.
 *
 * Ported from promptci-cloud (pcic-pa8.3), which is the only one of the three
 * forks that made this function testable at all.
 *
 * This is the function that decides whether a PR merges, and until now nothing
 * executed it — the other pr-review tests are static (does the workflow list
 * this file?) or exercise the jq program alone. Neither can see the poll loop's
 * BRANCH ORDER or its return codes, which is precisely where the merge decision
 * lives: a green PR that the loop never classifies is blocked just as hard as a
 * red one, and it takes POLL_TIMEOUT to find out.
 *
 * HOW IT RUNS. A `gh` stand-in is written to a temp dir and put on PATH; the
 * harness sources the REAL engine/pr-review.sh in library mode
 * (PR_REVIEW_LIBRARY_MODE=1 suppresses `main "$@"`), points GH_CLI at the stub,
 * calls ONE function, and prints a machine-readable block on stdout. It is the
 * script in place, not a copy: pr-review.sh resolves sanitize-secret.sh and
 * ci-lib.sh from its own directory, so a copy in a temp dir could not source
 * them at all.
 *
 * `sleep` is shadowed with a no-op in the harness. Every clock in the loop —
 * `waited`, the zero-checks grace, the missing-required grace — is arithmetic
 * in POLL_INTERVAL units, so the whole suite runs at zero wall time while the
 * counting stays exactly what production does.
 *
 * THE RETURN-CODE CONTRACT UNDER TEST:
 *   0  all completed and passed, every required context green
 *   1  a check is RED (fail fast, first poll)          LAST_FAILED_CHECKS
 *   2  POLL_TIMEOUT with CI still non-terminal
 *   4  zero check runs after ZERO_CHECKS_GRACE — fail closed
 *   5  all completed, none failed, something has no verdict  LAST_UNRESOLVED_CHECKS
 *   6  all completed, a REQUIRED context never registered    LAST_MISSING_REQUIRED
 * There is deliberately no 3.
 */

// Ported from promptci-cloud tests/repo/pr-review-wait-for-ci.test.ts. There the
// subject was scripts/pr-review.sh; here the shared engine lives in engine/.
const repoRoot = join(import.meta.dirname, "..", "..");
const scriptPath = join(repoRoot, "engine", "pr-review.sh");
const script = readFileSync(scriptPath, "utf8").replace(/\r\n/g, "\n");

const SHA = "98a70d4a98a70d4a98a70d4a98a70d4a98a70d4a";

type Run = {
  name: string;
  status?: string;
  conclusion?: string | null;
  id?: number;
  suite?: number;
};

let nextId = 100_000_000_000;
const checkRuns = (runs: Run[]) =>
  JSON.stringify({
    check_runs: runs.map((r) => ({
      id: r.id ?? nextId++,
      name: r.name,
      status: r.status ?? "completed",
      conclusion: r.conclusion === undefined ? "success" : r.conclusion,
      check_suite: { id: r.suite ?? 1 },
    })),
  });

const green = (name: string, extra: Partial<Run> = {}): Run => ({ name, ...extra });

/** The three green non-gate checks every fixture carries. */
const baseChecks = (): Run[] => [green("ci"), green("e2e"), green("audit")];

type Result = {
  exit: number;
  failed: string;
  unresolved: string;
  missingRequired: string;
  message: string;
  calls: string[];
};

// Every case shells out once per poll — bash plus a handful of jq processes —
// which is ~0.5s per poll on a Windows runner. The default 5s test timeout is
// not enough for a case that polls to POLL_TIMEOUT, and it fails as an
// unattributed STACK_TRACE_ERROR rather than as anything you could diagnose.
describe.skip("wait_for_ci return-code contract", { timeout: 60_000 }, () => {
  let dir: string;
  let stateDir: string;
  let harness: string;
  let stub: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-review-wait-for-ci-"));
    stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(dir, "work"), { recursive: true });

    // gh stand-in for the three endpoints this path touches. EVERY call is
    // logged, so a test can assert not only the verdict but how it was reached
    // — that ci.yml was dispatched exactly once, or that a red PR cost exactly
    // one poll rather than a full POLL_TIMEOUT of them.
    stub = join(dir, "gh-stub.sh");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "$*" >> "\${STUB_STATE_DIR}/calls"
case " $* " in
  *"/check-runs"*)
    n=0
    [ -f "\${STUB_STATE_DIR}/checkcount" ] && n="$(cat "\${STUB_STATE_DIR}/checkcount")"
    n=$((n + 1))
    echo "$n" > "\${STUB_STATE_DIR}/checkcount"
    # The first STUB_FAIL_CHECKS_FIRST calls simulate "we could not ask GitHub",
    # which ci-lib.sh turns into its api_failed sentinel.
    if [ "$n" -le "\${STUB_FAIL_CHECKS_FIRST:-0}" ]; then
      echo "gh: Internal Server Error (HTTP 500)" >&2
      exit 1
    fi
    printf '%s' "\${STUB_CHECKS}"
    exit 0
    ;;
  *"actions/runs"*)
    # Two lines, not a \${VAR:-default}: a default containing '}' closes the
    # parameter expansion early, and the leftover brace appends itself to the
    # payload — which is valid bash producing invalid JSON, i.e. a silently
    # "unavailable" workflow-runs API rather than an empty one.
    runs="\${STUB_RUNS:-}"
    [ -n "$runs" ] || runs='{"workflow_runs":[]}'
    printf '%s' "$runs"
    exit 0
    ;;
  *"workflow run"*)
    echo "dispatched"
    exit 0
    ;;
  *)
    echo "gh-stub: unexpected call: $*" >&2
    exit 1
    ;;
esac
`,
      "utf8",
    );
    chmodSync(stub, 0o755);

    // PR_NUMBER must be unique among the pr-review suites: the sourced script
    // derives its /tmp scratch paths from it and vitest runs files in parallel.
    harness = join(dir, "harness.sh");
    writeFileSync(
      harness,
      `#!/usr/bin/env bash
export PR_NUMBER=8311 PR_HEAD_REF=feat/wsb1 PR_BASE_REF=main PR_AUTHOR=tester
export PR_TITLE="test" PR_BODY=""
export REPO=SeriousGeese/promptci-cloud
export WORK_DIR="${dir.replace(/\\/g, "/")}/work"
export GH_TOKEN=fake GITHUB_OUTPUT=/dev/null
export HEAD_SHA=${SHA} BASE_SHA=bbbbbbbbbbbb GITHUB_RUN_ID=123456
export PR_REVIEW_LIBRARY_MODE=1
# shellcheck source=/dev/null
source "${scriptPath.replace(/\\/g, "/")}"
GH_CLI="${stub.replace(/\\/g, "/")}"
# Every clock in wait_for_ci is arithmetic in POLL_INTERVAL units, so removing
# the wall-clock wait changes nothing it counts — only how long the suite takes.
sleep() { :; }
rc=0
wait_for_ci "${SHA}" "\${BOT_PUSHED:-false}" || rc=$?
echo "EXIT=\${rc}"
echo "LAST_FAILED_CHECKS=\${LAST_FAILED_CHECKS}"
echo "LAST_UNRESOLVED_CHECKS=\${LAST_UNRESOLVED_CHECKS}"
echo "LAST_MISSING_REQUIRED=\${LAST_MISSING_REQUIRED}"
echo "---MESSAGE---"
case "$rc" in
  1) failed_ci_message ;;
  5) unresolved_ci_message ;;
  6) missing_required_message ;;
esac
echo
echo "---END---"
`,
      "utf8",
    );
    chmodSync(harness, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(env: Record<string, string>): Result {
    for (const f of ["calls", "checkcount"]) {
      const p = join(stateDir, f);
      if (existsSync(p)) rmSync(p);
    }
    const out = execFileSync("bash", [harness], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        STUB_STATE_DIR: stateDir,
        // Fast but faithful: one "second" per poll, three per grace, and a
        // timeout far enough away that no test reaches it by accident.
        POLL_INTERVAL: "1",
        ZERO_CHECKS_GRACE: "3",
        // Separate clock from ZERO_CHECKS_GRACE, and deliberately longer in
        // production (300s vs 120s) — see the constants' comment. Held equal
        // here only so the two graces stay comparable in these fixtures; the
        // independence itself is asserted below.
        MISSING_REQUIRED_GRACE: "3",
        // Ten polls, not thirty minutes. Kept small on purpose: each poll spawns
        // the stub plus several jq processes, which on Windows costs ~0.5s, so a
        // generous POLL_TIMEOUT here is measured in test-suite minutes.
        POLL_TIMEOUT: "10",
        REQUIRED_CONTEXTS_JSON: "[]",
        ...env,
      },
    });
    const pick = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(out)?.[1] ?? "";
    const callsFile = join(stateDir, "calls");
    return {
      exit: Number(pick("EXIT")),
      failed: pick("LAST_FAILED_CHECKS"),
      unresolved: pick("LAST_UNRESOLVED_CHECKS"),
      missingRequired: pick("LAST_MISSING_REQUIRED"),
      message: out.slice(out.indexOf("---MESSAGE---") + 14, out.lastIndexOf("---END---")),
      calls: existsSync(callsFile)
        ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
        : [],
    };
  }

  const checkRunCalls = (r: Result) => r.calls.filter((c) => c.includes("/check-runs")).length;
  const dispatchCalls = (r: Result) => r.calls.filter((c) => c.includes("workflow run ci.yml"));

  it("returns 0 on the PR #155 shape — superseded cancels plus a later success", () => {
    // The bug this workstream removes. auto-merge.yml has cancel-in-progress:
    // true, so labelling PR #155 twice in quick succession left TWO cancelled
    // `auto-merge` check runs and one successful one, all on head 98a70d4.
    // Without the per-name reduction the cancels are unresolvable forever —
    // not a failure (nothing fails fast) and not a success (all_success can
    // never be true) — so a green PR is blocked until POLL_TIMEOUT.
    const r = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: "auto-merge", conclusion: "cancelled", id: 101508518115, suite: 92230698661 },
        { name: "auto-merge", conclusion: "cancelled", id: 101508521301, suite: 92230700324 },
        { name: "auto-merge", conclusion: "success", id: 101508523940, suite: 92230701261 },
      ]),
    });

    expect(r.exit, "a SHA whose only oddity is superseded cancels is GREEN").toBe(0);
    expect(checkRunCalls(r), "and it says so on the first poll").toBe(1);
  });

  it("returns 6 after the grace when a required context never registered, and names it", () => {
    // `gate` has needs: [ci, e2e, audit] and a check run appears only when its
    // job STARTS, so "everything green, gate absent" is a real intermediate
    // state. GitHub does not read absent as passed, so this cannot be a merge —
    // but it also cannot be reported on the first poll without racing the gate
    // job's own start.
    const r = run({
      STUB_CHECKS: checkRuns(baseChecks()),
      REQUIRED_CONTEXTS_JSON: '["gate"]',
    });

    expect(r.exit).toBe(6);
    expect(r.missingRequired).toBe("gate");
    expect(r.message).toContain("gate");
    expect(r.message).toContain("required status check never registered");
    // Reported after the grace, not on the first poll and not at POLL_TIMEOUT.
    expect(checkRunCalls(r)).toBe(3);
  });

  it("uses its own grace for a missing required context, not the zero-checks one", () => {
    // These two clocks measure different things and must be tunable apart. The
    // missing-required window is bounded by GitHub scheduling `gate` after its
    // needs have already finished, which can outlast the 120s that is plenty for
    // "a dispatched workflow has not registered at all". Sharing one constant
    // means tightening the zero-checks grace silently starts returning 6 on
    // healthy PRs — and return 6 tells the operator their branch predates the
    // gate job, sending them to merge `main` into a branch that never needed it.
    const r = run({
      STUB_CHECKS: checkRuns(baseChecks()),
      REQUIRED_CONTEXTS_JSON: '["gate"]',
      ZERO_CHECKS_GRACE: "1",
      MISSING_REQUIRED_GRACE: "6",
    });

    expect(r.exit, "still terminal, just later").toBe(6);
    expect(
      checkRunCalls(r),
      "waited on MISSING_REQUIRED_GRACE (6), not ZERO_CHECKS_GRACE (1) — if these " +
        "are wired to the same constant this polls ~1 time instead of ~6",
    ).toBeGreaterThan(3);
  });

  it("production defaults give the missing-required clock the longer grace", () => {
    // Pins the asymmetry itself, not just that two names exist: expiring late on
    // a genuine fault costs minutes once; expiring early falsely blocks a good
    // merge and misdirects the fix.
    const zero = /:\s*"\$\{ZERO_CHECKS_GRACE:=(\d+)\}"/.exec(script);
    const missing = /:\s*"\$\{MISSING_REQUIRED_GRACE:=(\d+)\}"/.exec(script);

    expect(zero, "ZERO_CHECKS_GRACE default not found").toBeTruthy();
    expect(missing, "MISSING_REQUIRED_GRACE default not found").toBeTruthy();
    expect(
      Number(missing![1]),
      "the missing-required grace must be strictly longer than the zero-checks grace",
    ).toBeGreaterThan(Number(zero![1]));
  });

  it("returns 5 when a REQUIRED context is skipped", () => {
    // A skipped check is an ordinary pass — but never for a required context:
    // GitHub refuses to merge on one, so neither may the poller. This is the
    // difference between the two `skipped` rows in this file.
    const r = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: "gate", conclusion: "skipped" },
      ]),
      REQUIRED_CONTEXTS_JSON: '["gate"]',
    });

    expect(r.exit).toBe(5);
    expect(r.unresolved).toContain("gate");
    expect(r.message).toContain("without a verdict");
    expect(checkRunCalls(r), "terminal on the first poll").toBe(1);
  });

  it("returns 0 when an UNrequired check is skipped", () => {
    // The shape that hung PR #143: `Close beads for merged PR` reports skipped
    // on every unmerged PR. Nothing required is skipped, so this is green.
    const r = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: "Close beads for merged PR", conclusion: "skipped" },
      ]),
      REQUIRED_CONTEXTS_JSON: '["ci"]',
    });

    expect(r.exit).toBe(0);
    expect(checkRunCalls(r)).toBe(1);
  });

  it("returns 1 on the FIRST poll for a failure, names it, and puts it in the comment", () => {
    // Fail fast, deliberately not gated on all_completed: a lint failure at
    // ~40s used to sit silent behind the rest of the matrix up to POLL_TIMEOUT,
    // and the run then reported a timeout rather than the real failure.
    const r = run({
      STUB_CHECKS: checkRuns([
        green("ci"),
        { name: "e2e", conclusion: "failure", suite: 4242 },
        { name: "audit", status: "in_progress", conclusion: null },
      ]),
    });

    expect(r.exit).toBe(1);
    expect(checkRunCalls(r), "reported on the first poll, not at POLL_TIMEOUT").toBe(1);
    expect(r.failed, "the names are the entire clue — a bare count costs a diagnosis cycle").toBe(
      "e2e",
    );
    expect(r.message).toContain("e2e");
    expect(r.message).toContain("failing checks");
  });

  it("keeps waiting on a red check while a rerun of that workflow is in flight", () => {
    // A rerun that turns the SHA green after the fail-fast return cannot
    // unblock the merge, because nobody is looking any more. The check-run API
    // cannot see the rerun yet (dependent jobs register only as they START);
    // the workflow-runs API can.
    const r = run({
      STUB_CHECKS: checkRuns([green("ci"), { name: "e2e", conclusion: "failure", suite: 4242 }]),
      STUB_RUNS: JSON.stringify({
        workflow_runs: [
          { id: 10, path: ".github/workflows/ci.yml", status: "completed", check_suite_id: 4242 },
          { id: 20, path: ".github/workflows/ci.yml", status: "in_progress", check_suite_id: 5151 },
        ],
      }),
    });

    expect(r.exit, "a provisional red must not be reported as terminal").toBe(2);
    expect(r.failed, "and nothing is named, because nothing was concluded").toBe("");
  });

  it("dispatches ci.yml exactly ONCE and returns 4 for a bot-pushed SHA with zero checks", () => {
    const r = run({ STUB_CHECKS: JSON.stringify({ check_runs: [] }), BOT_PUSHED: "true" });

    expect(r.exit).toBe(4);
    expect(
      dispatchCalls(r).length,
      "re-dispatching every poll would queue a run per interval and cancel its own predecessor",
    ).toBe(1);
    expect(dispatchCalls(r)[0]).toContain("--ref feat/wsb1");
  });

  it("returns 4 for an AUTHOR-pushed SHA with zero checks too — the docs-only pass (return 3) is gone", () => {
    // Once `gate` is required, zero check runs can never end in a successful
    // merge: `gh pr merge` is refused for a required context that never
    // reported. A "no CI applies, merge it" verdict could only reach that
    // refusal more slowly and under the wrong label.
    const r = run({ STUB_CHECKS: JSON.stringify({ check_runs: [] }), BOT_PUSHED: "false" });

    expect(r.exit, "must be 4, and must never again be 3").toBe(4);
    expect(dispatchCalls(r).length).toBe(1);
  });

  it("does not let api_failed polls advance the zero-checks clock", () => {
    // "We could not ask GitHub" is not "GitHub says there are no checks". If a
    // failed lookup counted toward the grace, a minute of API flakiness would
    // read as a terminal verdict on a PR whose CI is fine.
    //
    // Three failing polls, then zero checks: dispatch on poll 4, grace from
    // there, so return 4 on poll 6. If api_failed advanced the clock it would
    // land on poll 3 or 4 instead.
    const r = run({
      STUB_CHECKS: JSON.stringify({ check_runs: [] }),
      STUB_FAIL_CHECKS_FIRST: "3",
      BOT_PUSHED: "true",
    });

    expect(r.exit).toBe(4);
    expect(checkRunCalls(r)).toBe(6);
    expect(dispatchCalls(r).length, "and nothing is dispatched off a failed lookup").toBe(1);
  });
});

/**
 * Static assertions on the two call sites. Behavioural tests can prove
 * wait_for_ci returns 6; only these can prove both callers do something sane
 * with it. A caller that silently falls through its `else` branch turns a
 * precise verdict into "polling timed out", which is how the §2 short-circuit
 * and the §7 poll drifted apart in the first place.
 */
describe.skip("wait_for_ci call sites", () => {
  const lines = script.split("\n");
  const callIndexes = lines
    .map((l, i) => (/^\s*wait_for_ci "/.test(l) ? i : -1))
    .filter((i) => i >= 0);

  /** The if/elif chain that handles one call site's return code. */
  function handlerBlock(callLine: number): string {
    const ifAt = lines.findIndex((l, i) => i > callLine && /^\s*if \[ "[$]ci_exit"/.test(l));
    expect(ifAt, `no ci_exit if-chain follows the wait_for_ci call at line ${callLine + 1}`).toBeGreaterThan(callLine);
    const indent = /^(\s*)/.exec(lines[ifAt])![1];
    const endAt = lines.findIndex((l, i) => i > ifAt && l === `${indent}fi`);
    expect(endAt, "the ci_exit if-chain is never closed").toBeGreaterThan(ifAt);
    return lines.slice(ifAt, endAt + 1).join("\n");
  }

  it("has exactly two call sites, each passing exactly two positionals", () => {
    expect(
      callIndexes.length,
      "the §2 bot-commit short-circuit and the §7 post-review poll. A third " +
        "would need the same six-branch handling and is a drift risk, not a feature.",
    ).toBe(2);

    for (const i of callIndexes) {
      // Strip the `|| ci_exit=$?` tail — the positionals are what matter.
      const args = lines[i]
        .trim()
        .replace(/\s*\|\|.*$/, "")
        .replace(/^wait_for_ci\s+/, "")
        .split(/\s+/);
      expect(
        args,
        `wait_for_ci at line ${i + 1} takes <sha> and <bot_pushed> only — the third ` +
          "ci_relevant parameter was removed with the docs-only grace (pci-pa8.3).",
      ).toHaveLength(2);
    }
  });

  it("handles 5 and 6 at both call sites, and 3 at neither", () => {
    for (const i of callIndexes) {
      const block = handlerBlock(i);
      expect(block, `call site at line ${i + 1} does not handle return 5 (unresolved)`).toContain(
        '"$ci_exit" -eq 5',
      );
      expect(block, `call site at line ${i + 1} does not handle return 6 (required missing)`).toContain(
        '"$ci_exit" -eq 6',
      );
      expect(
        block.includes('"$ci_exit" -eq 3'),
        `call site at line ${i + 1} still handles return 3. wait_for_ci never returns it: ` +
          "the docs-only grace was removed because zero check runs can never end in a " +
          "successful merge once `gate` is required.",
      ).toBe(false);
    }
  });

  it("routes every non-zero verdict through a shared message helper, defined once and used twice", () => {
    for (const helper of ["failed_ci_message", "unresolved_ci_message", "missing_required_message"]) {
      const defs = script.match(new RegExp(`^${helper}\\(\\) \\{`, "gm")) ?? [];
      expect(defs, `${helper} must be defined exactly once`).toHaveLength(1);

      // Counts `$(helper …)` invocations only, so the prose above each helper
      // — which names it — is not mistaken for a call site.
      const calls = script.match(new RegExp(`[$]\\(${helper}[^)]*\\)`, "g")) ?? [];
      expect(
        calls,
        `${helper} must be called from BOTH call sites. Two literal strings is how ` +
          "the §2 copy ended up a paragraph behind the §7 one.",
      ).toHaveLength(2);
    }
  });
});
