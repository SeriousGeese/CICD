import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, forEachProfile, type Harness } from '../harness/engine.js';

/**
 * approve_held_runs() — ported from DnD's prReviewHeldRuns.
 *
 * A GITHUB_TOKEN push does not START pull_request-triggered workflows, but
 * GitHub still CREATES their runs and parks them as
 * `status: completed, conclusion: action_required`. A parked run publishes no
 * check run at all, so `gh pr checks` reports "no checks reported on the branch"
 * — identical to "CI hasn't started" — and the PR sits BLOCKED on required checks
 * that will never appear. Seen twice within 15 minutes on 2026-08-22 (PR #2298
 * head 9e38b683, then #2312); both cleared instantly once the runs were approved.
 *
 * The gh stub applies the engine's OWN `--jq` expression with the real jq binary
 * rather than returning a pre-filtered answer, so the selector deciding which
 * runs count as held is genuinely under test. A port that returned canned
 * already-filtered ids would test the fixture.
 *
 * THE SECURITY BOUNDARY IS THE POINT. Approving a held run is exactly the gate
 * that stops untrusted PR code executing on a self-hosted runner, so the
 * AUTOMERGE_AUTHORS check is not a convenience — the cases below pin it in both
 * directions and it must never be widened casually.
 *
 * WHAT THE PORT ADDS: the CICD_FEATURE_APPROVE_HELD_RUNS matrix, and the
 * disabled-direction case in particular. This function's contract is "did I
 * approve something" rather than "did I succeed", and its only caller is
 *     if approve_held_runs "$sha"; then zero_checks_elapsed=0; fi
 * so a disabled version returning 0 would reset the zero-checks grace on EVERY
 * poll and make the fail-closed that stops a checkless SHA merging unreachable.
 * That bug shipped once here and is now a case.
 */

const script = readFileSync(enginePath, 'utf8');
const SHA = 'a'.repeat(40);
const REPO = 'SeriousGeese/example';

type Run = { id: number; name: string; status: string; conclusion: string | null };
const runsPayload = (runs: Run[]) => JSON.stringify({ workflow_runs: runs });

/** The exact shape seen on PR #2298: three parked pull_request runs. */
const HELD_TRIO = runsPayload([
  { id: 32543429313, name: 'CI', status: 'completed', conclusion: 'action_required' },
  { id: 32543429359, name: 'E2E (Playwright)', status: 'completed', conclusion: 'action_required' },
  { id: 32543429312, name: 'PR Auto-Review', status: 'completed', conclusion: 'action_required' },
]);

let h: Harness;
let approveLog: string;

beforeAll(() => {
  h = createEngineHarness({
    prNumber: 8341,
    // Emulates `gh api <path> [-X METHOD] [--jq EXPR]`, piping the fixture
    // through the REAL jq using the engine's own expression.
    ghScript: `
[ "$1" = "api" ] || { echo "unexpected gh subcommand: $1" >&2; exit 1; }
shift
apipath=""; jqexpr=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) shift 2 ;;
    --jq) jqexpr="$2"; shift 2 ;;
    *) apipath="$1"; shift ;;
  esac
done
case "$apipath" in
  */approve)
    printf '%s\\n' "$apipath" >> "\${STUB_STATE_DIR}/approved"
    if [ "\${STUB_APPROVE_RC:-0}" != "0" ]; then
      echo "\${STUB_APPROVE_ERR:-gh: Resource not accessible by integration (HTTP 403)}" >&2
      exit "$STUB_APPROVE_RC"
    fi
    echo '{}'
    ;;
  *actions/runs*)
    if [ "\${STUB_RUNS_RC:-0}" != "0" ]; then
      echo "\${STUB_RUNS_ERR:-gh: API rate limit exceeded}" >&2
      exit "$STUB_RUNS_RC"
    fi
    empty='{"workflow_runs":[]}'
    payload="\${STUB_RUNS_JSON:-$empty}"
    if [ -n "$jqexpr" ]; then printf '%s' "$payload" | jq -r "$jqexpr"; else printf '%s' "$payload"; fi
    ;;
  *) echo "unexpected path: $apipath" >&2; exit 1 ;;
esac
exit 0
`,
  });
  approveLog = path.join(h.dir, 'state', 'approved');
});

afterAll(() => h.cleanup());

function approve(env: Record<string, string> = {}) {
  if (existsSync(approveLog)) rmSync(approveLog);
  // log() writes to stderr; the harness folds both streams together.
  const r = h.run({
    body: `rc=0\napprove_held_runs "${SHA}" || rc=$?\necho "rc=$rc"`,
    env: {
      CICD_FEATURE_APPROVE_HELD_RUNS: 'true',
      PR_AUTHOR: 'tester',
      AUTOMERGE_AUTHORS: 'tester,dependabot[bot]',
      ...env,
    },
  });
  const approved = existsSync(approveLog)
    ? readFileSync(approveLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { out: r.stdout, approved };
}

const approveUrl = (id: number) => `repos/${REPO}/actions/runs/${id}/approve`;

describe('approve_held_runs', () => {
  it('approves every run parked as action_required and reports success', () => {
    const { out, approved } = approve({ STUB_RUNS_JSON: HELD_TRIO });
    expect(approved).toEqual([
      approveUrl(32543429313),
      approveUrl(32543429359),
      approveUrl(32543429312),
    ]);
    // rc 0 is what tells wait_for_ci to restart its zero-checks grace.
    expect(out).toContain('rc=0');

    // The id and the REASON are asserted separately, tolerating whitespace
    // inside the parenthesised workflow name. Pinning the exact spacing owned a
    // log line this spec has no business dictating: on a Windows Git Bash host
    // the same line arrives as `(CI    )`, so the original was green on Linux
    // CI and red on a local Windows run.
    expect(out).toMatch(/approved held run 32543429313 \(CI\s*\)/);
    expect(out).toMatch(/approved held run 32543429313\b[^\n]*action_required/);
  });

  it('tolerates a workflow name carrying trailing whitespace', () => {
    // Reproduces on Linux what only showed up on Windows. The engine does not
    // pad — the log line interpolates ${run_name} straight in and there are no
    // printf width specifiers anywhere in it — so the whitespace arrives with
    // the VALUE, not from the formatting. Whatever the host-specific cause, the
    // assertions must not care.
    const { out, approved } = approve({
      STUB_RUNS_JSON: runsPayload([
        { id: 32543429313, name: 'CI    ', status: 'completed', conclusion: 'action_required' },
      ]),
    });
    expect(approved).toEqual([approveUrl(32543429313)]);
    expect(out).toMatch(/approved held run 32543429313 \(CI\s*\)/);
    expect(out).toContain('rc=0');
  });

  it('also approves a run still in the waiting state', () => {
    const { approved } = approve({
      STUB_RUNS_JSON: runsPayload([{ id: 777, name: 'CI', status: 'waiting', conclusion: null }]),
    });
    expect(approved).toEqual([approveUrl(777)]);
  });

  it('leaves healthy runs alone and reports nothing to do', () => {
    const { out, approved } = approve({
      STUB_RUNS_JSON: runsPayload([
        { id: 1, name: 'CI', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'E2E (Playwright)', status: 'in_progress', conclusion: null },
        { id: 3, name: 'CI', status: 'completed', conclusion: 'failure' },
        { id: 4, name: 'PR Auto-Review', status: 'completed', conclusion: 'cancelled' },
      ]),
    });
    expect(approved).toEqual([]);
    expect(out).toContain('rc=1');
  });

  it('approves only the held run when healthy runs sit alongside it', () => {
    const { approved } = approve({
      STUB_RUNS_JSON: runsPayload([
        { id: 1, name: 'CI', status: 'completed', conclusion: 'success' },
        { id: 99, name: 'E2E (Playwright)', status: 'completed', conclusion: 'action_required' },
        { id: 3, name: 'CI', status: 'in_progress', conclusion: null },
      ]),
    });
    expect(approved).toEqual([approveUrl(99)]);
  });

  it('reports zero held runs without calling approve', () => {
    const { out, approved } = approve({ STUB_RUNS_JSON: runsPayload([]) });
    expect(approved).toEqual([]);
    expect(out).toContain('rc=1');
  });
});

describe('security boundary — untrusted authors', () => {
  it('does NOT approve for an author outside AUTOMERGE_AUTHORS', () => {
    // Approving is the very gate that stops untrusted PR code from running on a
    // self-hosted runner. Never widen this without a deliberate decision.
    const { out, approved } = approve({
      STUB_RUNS_JSON: HELD_TRIO,
      PR_AUTHOR: 'some-outside-contributor',
    });
    expect(approved).toEqual([]);
    expect(out).toContain('HELD FOR APPROVAL');
    expect(out).toContain("author 'some-outside-contributor' is not in AUTOMERGE_AUTHORS");
    expect(out).toContain('rc=1');
  });

  it('names every held run so a human can approve them by hand', () => {
    const { out } = approve({ STUB_RUNS_JSON: HELD_TRIO, PR_AUTHOR: 'some-outside-contributor' });
    for (const id of [32543429313, 32543429359, 32543429312]) {
      expect(out).toContain(`actions/runs/${id}/approve`);
    }
  });

  it('still approves when AUTOMERGE_AUTHORS is the "*" wildcard', () => {
    const { approved } = approve({
      STUB_RUNS_JSON: runsPayload([
        { id: 55, name: 'CI', status: 'completed', conclusion: 'action_required' },
      ]),
      PR_AUTHOR: 'anyone-at-all',
      AUTOMERGE_AUTHORS: '*',
    });
    expect(approved).toEqual([approveUrl(55)]);
  });
});

describe('failure handling — never takes the review down', () => {
  it('treats an unreachable Actions API as "nothing held"', () => {
    const { out, approved } = approve({
      STUB_RUNS_RC: '4',
      STUB_RUNS_ERR: 'gh: API rate limit exceeded',
    });
    expect(approved).toEqual([]);
    expect(out).toContain('could not list workflow runs');
    expect(out).toContain('rc=1');
  });

  it('warns loudly when the approve call itself is rejected', () => {
    // The realistic cause is a missing `actions: write` permission. The check
    // will never appear, so the log has to name why rather than go quiet.
    const { out, approved } = approve({
      STUB_RUNS_JSON: runsPayload([
        { id: 4242, name: 'CI', status: 'completed', conclusion: 'action_required' },
      ]),
      STUB_APPROVE_RC: '1',
      STUB_APPROVE_ERR: 'gh: Resource not accessible by integration (HTTP 403)',
    });
    expect(approved).toEqual([approveUrl(4242)]);
    expect(out).toContain('could not approve held run 4242');
    expect(out).toContain('Resource not accessible by integration');
    // Reported as "nothing approved", so the grace is not reset in a loop.
    expect(out).toContain('rc=1');
  });
});

describe('CICD_FEATURE_APPROVE_HELD_RUNS', () => {
  it('is INERT when off — and reports NOTHING APPROVED, not success', () => {
    // The direction is the whole case. The contract is "did I approve
    // something", not "did I succeed", and the only caller is
    //     if approve_held_runs "$sha"; then zero_checks_elapsed=0; fi
    // so returning 0 here would reset the zero-checks grace on every poll and
    // make the fail-closed that stops a checkless SHA merging unreachable. The
    // disabled path shipped returning 0 once; this is that bug, pinned.
    const { out, approved } = approve({
      STUB_RUNS_JSON: HELD_TRIO,
      CICD_FEATURE_APPROVE_HELD_RUNS: 'false',
    });
    expect(approved).toEqual([]);
    expect(out).toContain('rc=1');
  });

  forEachProfile((name, settings) => {
    it(`${name}: matches what that profile configures`, () => {
      const on = settings.CICD_FEATURE_APPROVE_HELD_RUNS === 'true';
      if (existsSync(approveLog)) rmSync(approveLog);
      h.run({
        profile: name,
        body: `approve_held_runs "${SHA}" || true`,
        env: {
          STUB_RUNS_JSON: HELD_TRIO,
          PR_AUTHOR: 'tester',
          AUTOMERGE_AUTHORS: 'tester',
        },
      });
      const approved = existsSync(approveLog)
        ? readFileSync(approveLog, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      expect(approved.length).toBe(on ? 3 : 0);
    });
  });
});

describe('wiring into wait_for_ci', () => {
  it('is called from the poll loop before check_ci_status', () => {
    // A held run publishes no check run, so the approval has to happen before
    // the poll reads them — otherwise the grace expires against a phantom "CI
    // never started" and the PR is blocked for the wrong reason.
    const loop = script.slice(script.indexOf('wait_for_ci() {'));
    const approveAt = loop.indexOf('approve_held_runs "$sha"');
    const statusAt = loop.indexOf('raw_status="$(check_ci_status "$sha")"');
    expect(approveAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(-1);
    expect(approveAt).toBeLessThan(statusAt);
  });

  it('resets the zero-checks grace after approving', () => {
    // A newly started run needs the FULL grace to register its first check;
    // without the reset it inherits an almost-expired clock.
    const loop = script.slice(script.indexOf('wait_for_ci() {'));
    const guard = loop.slice(loop.indexOf('approve_held_runs "$sha"'));
    expect(guard.slice(0, 120)).toContain('zero_checks_elapsed=0');
  });
});
