import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, type Harness } from '../harness/engine.js';

/**
 * "The reviewer saw a red and never looked again" — ported from DnD's
 * prReviewCiRepoll.
 *
 * THE BEAD'S OWN STATED MECHANISM WAS WRONG, and this file exists partly to stop
 * it being re-implemented. It said the bot counted superseded check runs while
 * `gh pr checks` reads the latest attempt per check, and proposed deduping by
 * name — which the reduction has done since the earlier fix
 * (`group_by(.name) | map(max_by(.id))`). Re-doing that is a no-op that verifies
 * green against a SHA which reads green today.
 *
 * WHAT ACTUALLY HAPPENED on PR #2879, from the API (head 83267ea2):
 *
 *   23:47:14Z  e2e.yml run 33696663685 starts (check suite 91319622374)
 *   23:53:16Z  ...and FAILS `e2e (Playwright)` + `e2e (Playwright) shard 4/4`
 *   00:11:40Z  e2e.yml run 33698446576 (suite 91324293028) is created — the
 *              rerun — and the review run is created alongside it
 *   00:13:50Z  the review exits having logged "FAILURES DETECTED (2 of 11)"
 *   00:19:38Z  the rerun completes SUCCESSFULLY, republishing both names green
 *
 * The dedupe WAS working. At 00:13 the newest check run of each failing NAME was
 * still the failure, because a workflow's dependent jobs publish their check runs
 * only as they start — for those ~8 minutes the check-runs API could not see the
 * rerun at all. The WORKFLOW RUN could: it existed, on that SHA, from 00:11:40.
 *
 * The fix reads that second key, treats the red as non-terminal while a strictly
 * later run of the same workflow is in flight, and keeps polling.
 *
 * THE INVARIANT THAT MUST SURVIVE EVERY FUTURE EDIT HERE: this can only make the
 * poller WAIT longer. A failure is never dropped, downgraded or resolved, so no
 * path this added can merge a SHA the poller has not seen green. Most of the
 * cases below are that invariant from a different angle.
 */

const script = readFileSync(enginePath, 'utf8');

const SHA = '83267ea212ee25a5084fdb6303aa408c1a05cae3';

/** Real ids from PR #2879, so the fixtures are the incident rather than a sketch. */
const CI_SUITE = 91317428968;
const E2E_FAILED_SUITE = 91319622374;
const E2E_RERUN_SUITE = 91324293028;
const E2E_FAILED_RUN = 33696663685;
const E2E_RERUN_RUN = 33698446576;
const CI_RUN = 33695809088;
const E2E_PATH = '.github/workflows/e2e.yml';
const CI_PATH = '.github/workflows/ci.yml';

type Check = {
  name: string;
  id: number;
  suite: number;
  status?: string;
  conclusion?: string | null;
};
type Run = { id: number; path: string; suite: number; status?: string; conclusion?: string | null };

const checkRuns = (checks: Check[]) =>
  JSON.stringify({
    total_count: checks.length,
    check_runs: checks.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status ?? 'completed',
      conclusion: c.conclusion === undefined ? 'success' : c.conclusion,
      check_suite: { id: c.suite },
    })),
  });

const workflowRuns = (runs: Run[]) =>
  JSON.stringify({
    workflow_runs: runs.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.path,
      status: r.status ?? 'completed',
      conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
      check_suite_id: r.suite,
    })),
  });

/** ci.yml's green checks — present and passing in every fixture below. */
const greenCi = (): Check[] => [
  { name: 'lint', id: 100464293800, suite: CI_SUITE },
  { name: 'type-check', id: 100464293801, suite: CI_SUITE },
  { name: 'test (1/1)', id: 100464293802, suite: CI_SUITE },
];

/** The two names that were red at 00:13, plus the shard that was green. */
const e2eFailed = (): Check[] => [
  { name: 'e2e (Playwright)', id: 100468218474, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
  {
    name: 'e2e (Playwright) shard 4/4',
    id: 100467445582,
    suite: E2E_FAILED_SUITE,
    conclusion: 'failure',
  },
  { name: 'e2e (Playwright) shard 1/4', id: 100467445567, suite: E2E_FAILED_SUITE },
];

/** The rerun's own check runs, higher ids, as they appear once its jobs start. */
const e2eRerun = (conclusion: string | null, status = 'completed'): Check[] => [
  { name: 'e2e (Playwright)', id: 100474018878, suite: E2E_RERUN_SUITE, status, conclusion },
  {
    name: 'e2e (Playwright) shard 4/4',
    id: 100472928229,
    suite: E2E_RERUN_SUITE,
    status,
    conclusion,
  },
  {
    name: 'e2e (Playwright) shard 1/4',
    id: 100472928171,
    suite: E2E_RERUN_SUITE,
    status,
    conclusion,
  },
];

/** The workflow runs as they stood at 00:13 — the rerun created but unfinished. */
const RERUN_IN_FLIGHT = workflowRuns([
  { id: CI_RUN, path: CI_PATH, suite: CI_SUITE },
  { id: E2E_FAILED_RUN, path: E2E_PATH, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
  {
    id: E2E_RERUN_RUN,
    path: E2E_PATH,
    suite: E2E_RERUN_SUITE,
    status: 'in_progress',
    conclusion: null,
  },
]);

/** No rerun: only the run that failed. */
const NO_RERUN = workflowRuns([
  { id: CI_RUN, path: CI_PATH, suite: CI_SUITE },
  { id: E2E_FAILED_RUN, path: E2E_PATH, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
]);

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({
    prNumber: 8441,
    // Two endpoints matter, and the POLL INDEX is what makes a multi-poll
    // scenario expressible: the check-runs handler bumps a counter BEFORE
    // serving, so poll k serves checks.k, and the workflow-runs lookup the
    // failure branch makes later in the SAME poll reads runs.k. Each file falls
    // back to the highest-numbered one already written, so a scenario supplies
    // only the polls where something changes.
    //
    // approve_held_runs() also hits actions/runs, but with --jq; that call is
    // answered through the real jq off the same fixture, so a fixture with no
    // waiting/action_required run correctly reports nothing held.
    ghScript: `
state="\${STUB_STATE_DIR}"
serve() {
  local prefix="$1" i="$2" f
  while [ "$i" -gt 0 ]; do
    f="\${state}/\${prefix}.\${i}"
    if [ -f "$f" ]; then cat "$f"; return 0; fi
    i=$((i - 1))
  done
  return 0
}
poll=1
[ -f "\${state}/poll" ] && poll="$(cat "\${state}/poll")"
jqexpr=""
prev=""
for a in "$@"; do
  case "$prev" in --jq) jqexpr="$a" ;; esac
  prev="$a"
done
case " $* " in
  *"/check-runs"*)
    echo "check-runs poll=\${poll}" >> "\${state}/calls"
    serve checks "$poll"
    echo $((poll + 1)) > "\${state}/poll"
    exit 0
    ;;
  *"actions/runs"*)
    echo "actions/runs poll=\${poll} jq=\${jqexpr:+yes}" >> "\${state}/calls"
    if [ "\${STUB_RUNS_RC:-0}" != "0" ]; then
      echo "gh: Internal Server Error (HTTP 500)" >&2
      exit "$STUB_RUNS_RC"
    fi
    if [ -n "$jqexpr" ]; then
      serve runs "$poll" | jq -r "$jqexpr"
    else
      serve runs "$poll"
    fi
    exit 0
    ;;
  *)
    echo "gh-stub: unexpected call: $*" >&2
    exit 1
    ;;
esac
`,
  });
});

afterAll(() => h.cleanup());

/**
 * `checks`/`runs` are indexed from poll 1. A shorter list simply means "and
 * unchanged from then on".
 */
function run(
  fixtures: { checks: string[]; runs: string[] },
  env: Record<string, string> = {},
): { out: string; stateDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'cicd-repoll-'));
  fixtures.checks.forEach((c, i) =>
    writeFileSync(path.join(stateDir, `checks.${i + 1}`), c, 'utf8'),
  );
  fixtures.runs.forEach((r, i) => writeFileSync(path.join(stateDir, `runs.${i + 1}`), r, 'utf8'));

  const out = h.run({
    env: {
      // A fresh state dir per run: the poll index and the call log are files.
      STUB_STATE_DIR: stateDir,
      POLL_INTERVAL: '1',
      ZERO_CHECKS_GRACE: '2',
      POLL_TIMEOUT: '6',
      ...env,
    },
    // Two arguments, not three. DnD's harness passed `false true` — the third
    // was ci_relevant, which went with the docs-only grace.
    body: `rc=0\nwait_for_ci "${SHA}" false || rc=$?\necho "rc=$rc"`,
  }).stdout;

  return { out, stateDir };
}

const callLog = (stateDir: string) => {
  const f = path.join(stateDir, 'calls');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};

describe('the PR #2879 shape', () => {
  // Poll 1: the rerun exists as a workflow run but has published no check run of
  // either failing name yet — exactly 00:13:50Z.
  // Poll 2: its jobs have started, so the newest run per name is in_progress.
  // Poll 3: they finish green.
  const REPOLL_TO_GREEN = {
    checks: [
      checkRuns([...greenCi(), ...e2eFailed()]),
      checkRuns([...greenCi(), ...e2eFailed(), ...e2eRerun(null, 'in_progress')]),
      checkRuns([...greenCi(), ...e2eFailed(), ...e2eRerun('success')]),
    ],
    runs: [RERUN_IN_FLIGHT],
  };

  it('ends in a PASS instead of a terminal block', () => {
    // The acceptance criterion, stated as a test: no new SHA, no human
    // re-running the review.
    const { out } = run(REPOLL_TO_GREEN);
    expect(out).toContain('rc=0');
    expect(out).toContain('CI: ALL CHECKS PASSED');
    // And it never took the fail-fast exit on the way there.
    expect(out).not.toContain('FAILURES DETECTED');
  });

  it('says WHY it is still waiting, naming the failing checks and the rerunning workflow', () => {
    const { out } = run(REPOLL_TO_GREEN);
    expect(out).toContain('e2e (Playwright); e2e (Playwright) shard 4/4');
    expect(out).toContain(E2E_PATH);
    expect(out).toContain('rerun is under way');
  });

  it('polls more than once — the whole defect was that it looked exactly once', () => {
    const { stateDir } = run(REPOLL_TO_GREEN);
    expect(callLog(stateDir).filter((l) => l.startsWith('check-runs')).length).toBeGreaterThanOrEqual(3);
  });

  it('never reports the SHA as passing while the red still stands', () => {
    // The safety direction. Both polls carry a live failure; only the poll where
    // the rerun republished both names green may return 0.
    const { out } = run({
      checks: [
        checkRuns([...greenCi(), ...e2eFailed()]),
        checkRuns([...greenCi(), ...e2eFailed(), ...e2eRerun(null, 'in_progress')]),
      ],
      runs: [RERUN_IN_FLIGHT],
    });
    // Nothing ever went green, so this is the timeout — a WAIT, never a pass.
    expect(out).toContain('rc=2');
    expect(out).not.toContain('ALL CHECKS PASSED');
  });
});

describe('a red with no rerun behind it is still terminal on the first poll', () => {
  it('fails fast when no later run of that workflow exists', () => {
    // The fail-fast exit is not softened: it exists so a lint failure at ~40s is
    // not sat on behind a 20-minute Playwright matrix.
    const { out, stateDir } = run({
      checks: [checkRuns([...greenCi(), ...e2eFailed()])],
      runs: [NO_RERUN],
    });
    expect(out).toContain('rc=1');
    expect(out).toContain('FAILURES DETECTED');
    expect(callLog(stateDir).filter((l) => l.startsWith('check-runs'))).toHaveLength(1);
  });

  it('NAMES the failing checks rather than reporting a bare count', () => {
    // "2 of 11 checks" with no names cost a diagnosis cycle on #2879.
    const { out } = run({
      checks: [checkRuns([...greenCi(), ...e2eFailed()])],
      runs: [NO_RERUN],
    });
    expect(out).toMatch(
      /FAILURES DETECTED \(2 of 6 checks: e2e \(Playwright\); e2e \(Playwright\) shard 4\/4\)/,
    );
  });

  it('does not treat a later run of a DIFFERENT workflow as a rerun', () => {
    // e2e.yml failed; ci.yml re-running says nothing about it.
    const { out } = run({
      checks: [checkRuns([...greenCi(), ...e2eFailed()])],
      runs: [
        workflowRuns([
          { id: CI_RUN, path: CI_PATH, suite: CI_SUITE },
          { id: E2E_FAILED_RUN, path: E2E_PATH, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
          { id: E2E_RERUN_RUN, path: CI_PATH, suite: 99999, status: 'in_progress', conclusion: null },
        ]),
      ],
    });
    expect(out).toContain('rc=1');
  });

  it('does not treat an EARLIER in-flight run as a rerun', () => {
    // Strictly later BY ID, for the same reason the name reduction uses id: it is
    // monotonic at creation and never null.
    const { out } = run({
      checks: [checkRuns([...greenCi(), ...e2eFailed()])],
      runs: [
        workflowRuns([
          { id: E2E_FAILED_RUN, path: E2E_PATH, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
          {
            id: E2E_FAILED_RUN - 1,
            path: E2E_PATH,
            suite: 88888,
            status: 'in_progress',
            conclusion: null,
          },
        ]),
      ],
    });
    expect(out).toContain('rc=1');
  });

  it('does not wait on a later run of the same workflow that has already COMPLETED', () => {
    // A finished rerun that did not clear the red is a verdict, not a wait.
    //
    // This is also the guard that keeps a failure UN-DROPPABLE: a later
    // SUCCESSFUL run does not resolve the red here — only a check run of the
    // same name with a higher id does, through the existing reduction.
    const { out } = run({
      checks: [checkRuns([...greenCi(), ...e2eFailed()])],
      runs: [
        workflowRuns([
          { id: E2E_FAILED_RUN, path: E2E_PATH, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
          { id: E2E_RERUN_RUN, path: E2E_PATH, suite: E2E_RERUN_SUITE, conclusion: 'success' },
        ]),
      ],
    });
    expect(out).toContain('rc=1');
  });

  it('falls back to the terminal verdict when the workflow-runs lookup fails', () => {
    // Never a silent extra 30 minutes off a broken lookup: an unreadable API
    // means today's behaviour, said out loud.
    const { out } = run(
      { checks: [checkRuns([...greenCi(), ...e2eFailed()])], runs: [RERUN_IN_FLIGHT] },
      { STUB_RUNS_RC: '1' },
    );
    expect(out).toContain('rc=1');
    expect(out).toContain('could not list workflow runs');
  });

  it('blocks as soon as the rerun itself goes red', () => {
    // Poll 1 waits on the in-flight rerun; poll 2 has its verdict, and it is a
    // failure with nothing further in flight.
    const { out } = run({
      checks: [
        checkRuns([...greenCi(), ...e2eFailed()]),
        checkRuns([...greenCi(), ...e2eFailed(), ...e2eRerun('failure')]),
      ],
      runs: [
        RERUN_IN_FLIGHT,
        workflowRuns([
          { id: E2E_FAILED_RUN, path: E2E_PATH, suite: E2E_FAILED_SUITE, conclusion: 'failure' },
          { id: E2E_RERUN_RUN, path: E2E_PATH, suite: E2E_RERUN_SUITE, conclusion: 'failure' },
        ]),
      ],
    });
    expect(out).toContain('rc=1');
    expect(out).toContain('FAILURES DETECTED');
  });

  it('pays for the workflow-runs lookup only when something is red', () => {
    // It runs inside the poll loop of every PR; an all-green poll must not add
    // an API call. The rerun lookup is the actions/runs call WITHOUT a --jq;
    // approve_held_runs' own call carries one and runs every poll regardless.
    const { out, stateDir } = run({
      checks: [checkRuns([...greenCi(), ...e2eRerun('success')])],
      runs: [NO_RERUN],
    });
    expect(out).toContain('rc=0');
    expect(
      callLog(stateDir).filter((l) => l.startsWith('actions/runs') && l.endsWith('jq=')),
    ).toHaveLength(0);
  });
});

describe('static guards', () => {
  it('keeps the failure branch fail-toward-waiting, never toward merging', () => {
    // rc=1 is the only exit this branch may add, and the rerun path must not
    // touch `failures`, `all_success` or the merge codes.
    const loop = script.slice(script.indexOf('wait_for_ci() {'));
    const branch = loop.slice(
      loop.indexOf('elif [ "$failures" -gt 0 ]'),
      loop.indexOf('elif [ "$all_completed" = "true" ] && [ "$unresolved" -gt 0 ]'),
    );
    expect(branch).toContain('rerunning_workflows_for_suites');
    expect(branch).toContain('return 1');
    expect(branch).not.toContain('return 0');
  });

  it('resolves the rerun by WORKFLOW, and only for a strictly later, unfinished run', () => {
    const fn = script.slice(
      script.indexOf('rerunning_workflows_for_suites() {'),
      script.indexOf('check_ci_status() {'),
    );
    expect(fn).toContain('.path == $r.path');
    expect(fn).toContain('$r.id > .id');
    expect(fn).toContain('$r.status != "completed"');
  });

  it('shares ONE failure message between both call sites', () => {
    // The same anti-drift contract unresolved_ci_message carries.
    expect(script.match(/\$\(failed_ci_message/g) ?? []).toHaveLength(2);
    expect(script.match(/^failed_ci_message\(\) \{$/gm) ?? []).toHaveLength(1);
    // And it stays `blocked` — a red PR is the PR's condition, correctly
    // evaluated, so it must never paint the reviewer's own check red.
    const sites = script
      .split('\n')
      .filter((l) => l.includes('failed_ci_message') && l.includes('finish '));
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain('"blocked"');
      expect(site).not.toContain('blocked_infra');
    }
  });
});
