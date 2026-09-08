import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, type Harness } from '../harness/engine.js';

/**
 * Resolving a cancelled check by WORKFLOW + SHA — ported from DnD's
 * prReviewSupersededSuite.
 *
 * This is the residual of a two-PR lineage, and the narrow slice both of those
 * deliberately left:
 *
 *   PR #2713  reduce the check-run set to the most recent run per check NAME.
 *             Fixes the common draft-to-ready cancel.
 *   PR #2737  give wait_for_ci a terminal-but-unresolved verdict, so an
 *             unresolvable cancelled check is reported in minutes instead of
 *             burning the full 1800s poll.
 *
 * WHAT DEFEATS THE NAME KEY: a matrix job cancelled BEFORE its matrix expands
 * publishes the literal, unexpanded name
 *
 *     e2e (Playwright) shard ${{ matrix.shard }}/4        conclusion=cancelled
 *
 * which no later run can ever republish, because every run that gets as far as
 * expanding emits `shard 1/4`…`shard 4/4`. The successor exists, is green, and
 * is simply unreachable by name. Hit on PR #2760 (cancelled run 33435279304) and
 * PR #2815 (33571835270), each needing two manual reruns.
 *
 * Keying on workflow + SHA is a DIFFERENT KEY, not a softer rule, and the cases
 * below pin that distinction hard: a cancelled check is still never a pass and
 * still never a failure, a cancelled-only PR is still not mergeable, and a
 * failure inside a superseded suite still survives. The whole hazard of this
 * feature is that a "resolve it" rule is one small generalisation away from
 * turning a red PR green.
 */

const SHA = 'f'.repeat(40);
const UNEXPANDED = 'e2e (Playwright) shard ${{ matrix.shard }}/4';

type Run = { name: string; status?: string; conclusion?: string | null; id: number; suite: number };

let nextId = 100_000_000_000;
const checkRuns = (runs: Run[]) =>
  JSON.stringify({
    check_runs: runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status ?? 'completed',
      conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
      check_suite: { id: r.suite },
    })),
  });

const workflowRuns = (
  runs: { id: number; path: string; conclusion: string | null; suite: number }[],
) =>
  JSON.stringify({
    workflow_runs: runs.map((r) => ({
      id: r.id,
      path: r.path,
      conclusion: r.conclusion,
      check_suite_id: r.suite,
      status: 'completed',
      name: r.path,
    })),
  });

/** The green non-e2e checks every fixture carries, in the ci.yml suite. */
const CI_SUITE = 1;
const baseChecks = (): Run[] => [
  { name: 'lint', id: nextId++, suite: CI_SUITE },
  { name: 'type-check', id: nextId++, suite: CI_SUITE },
  { name: 'test (1/1)', id: nextId++, suite: CI_SUITE },
];

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({
    prNumber: 8391,
    ghArms: `
  *"actions/runs"*)
    if [ "\${STUB_RUNS_RC:-0}" != "0" ]; then
      echo "gh: Internal Server Error (HTTP 500)" >&2
      exit "$STUB_RUNS_RC"
    fi
    printf '%s' "\${STUB_RUNS:-}"
    exit 0
    ;;
  *"/check-runs"*)
    printf '%s' "\${STUB_CHECKS}"
    exit 0
    ;;
`,
  });
});
afterAll(() => h.cleanup());

function run(env: Record<string, string>) {
  const r = h.run({ body: `check_ci_status "${SHA}" 2>/dev/null`, env });
  // The verdict is PRETTY-PRINTED JSON spanning many lines, so it is sliced from
  // the first `{` rather than read line-wise — taking the last line yields the
  // closing brace, which parses as nothing and fails every case identically.
  const start = r.stdout.indexOf('{');
  expect(start, `no JSON in check_ci_status output:\n${r.stdout}`).toBeGreaterThan(-1);
  return { status: JSON.parse(r.stdout.slice(start)), calls: r.calls };
}

describe('check_ci_status: superseded-suite resolution', () => {
  it('resolves an UNEXPANDED-matrix cancelled check a later successful run supersedes', () => {
    // The exact PR #2760 / #2815 shape: the draft-era e2e run (suite 2) was
    // cancelled before its matrix expanded, so its one check run carries a name
    // no later run can republish. The ready_for_review run (suite 3) is green.
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
        { name: 'e2e (Playwright) shard 1/4', id: nextId++, suite: 3 },
        { name: 'e2e (Playwright)', id: nextId++, suite: 3 },
      ]),
      STUB_RUNS: workflowRuns([
        { id: 10, path: '.github/workflows/e2e.yml', conclusion: 'cancelled', suite: 2 },
        { id: 20, path: '.github/workflows/e2e.yml', conclusion: 'success', suite: 3 },
        { id: 11, path: '.github/workflows/ci.yml', conclusion: 'success', suite: CI_SUITE },
      ]),
    });

    expect(status.unresolved).toBe(0);
    expect(status.all_success).toBe(true);
    expect(status.all_completed).toBe(true);
    expect(status.unresolved_names).toBe('');
    // Only the orphan is gone; nothing else was dropped.
    expect(status.total).toBe(5);
  });

  it('does NOT resolve it when the later run did not succeed', () => {
    // A cancelled-only PR is still not passing.
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
      ]),
      STUB_RUNS: workflowRuns([
        { id: 10, path: '.github/workflows/e2e.yml', conclusion: 'cancelled', suite: 2 },
        { id: 20, path: '.github/workflows/e2e.yml', conclusion: 'failure', suite: 3 },
      ]),
    });

    expect(status.unresolved).toBe(1);
    expect(status.all_success).toBe(false);
    expect(status.unresolved_names).toContain('matrix.shard');
  });

  it('does NOT resolve it when no later run of that workflow exists at all', () => {
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
      ]),
      STUB_RUNS: workflowRuns([
        { id: 10, path: '.github/workflows/e2e.yml', conclusion: 'cancelled', suite: 2 },
      ]),
    });

    expect(status.unresolved).toBe(1);
    expect(status.all_success).toBe(false);
  });

  it('never drops a FAILURE from a superseded suite — this cannot turn a red into a green', () => {
    // The most important guard in the file. A superseded suite is dropped only
    // for checks that reached NO verdict; a real failure inside it survives.
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: 'e2e boom', conclusion: 'failure', id: nextId++, suite: 2 },
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
      ]),
      STUB_RUNS: workflowRuns([
        { id: 10, path: '.github/workflows/e2e.yml', conclusion: 'cancelled', suite: 2 },
        { id: 20, path: '.github/workflows/e2e.yml', conclusion: 'success', suite: 3 },
      ]),
    });

    expect(status.failures).toBe(1);
    expect(status.all_success).toBe(false);
    expect(status.unresolved).toBe(0);
  });

  it('never drops an in-progress check from a superseded suite', () => {
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: 'e2e still going', status: 'in_progress', conclusion: null, id: nextId++, suite: 2 },
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
      ]),
      STUB_RUNS: workflowRuns([
        { id: 10, path: '.github/workflows/e2e.yml', conclusion: 'cancelled', suite: 2 },
        { id: 20, path: '.github/workflows/e2e.yml', conclusion: 'success', suite: 3 },
      ]),
    });

    expect(status.all_completed).toBe(false);
    expect(status.pending).toContain('e2e still going');
  });

  it('a later successful run of a DIFFERENT workflow does not resolve it', () => {
    // The key is workflow + SHA. ci.yml going green says nothing about e2e.yml,
    // and treating "some run succeeded" as sufficient is the generalisation that
    // would turn this from a fix into a false-green machine.
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
      ]),
      STUB_RUNS: workflowRuns([
        { id: 10, path: '.github/workflows/e2e.yml', conclusion: 'cancelled', suite: 2 },
        { id: 20, path: '.github/workflows/ci.yml', conclusion: 'success', suite: CI_SUITE },
      ]),
    });

    expect(status.unresolved).toBe(1);
    expect(status.all_success).toBe(false);
  });

  it('falls back to the unresolved verdict when the workflow-runs call fails', () => {
    // Never a false green off a failed lookup: the worst case is the old
    // behaviour, which is honest.
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: UNEXPANDED, conclusion: 'cancelled', id: nextId++, suite: 2 },
      ]),
      STUB_RUNS: workflowRuns([]),
      STUB_RUNS_RC: '1',
    });

    expect(status.unresolved).toBe(1);
    expect(status.all_success).toBe(false);
    expect(status.api_failed).toBe(false);
  });

  it('does not pay for the workflow-runs call on a normal all-green poll', () => {
    // This runs on every poll of every PR; the extra call must be reserved for
    // the case that actually needs it.
    const { status, calls } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: 'e2e (Playwright)', id: nextId++, suite: 3 },
      ]),
      STUB_RUNS: workflowRuns([]),
    });

    expect(status.all_success).toBe(true);
    expect(status.unresolved).toBe(0);
    expect(calls.filter((c) => c.includes('actions/runs'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('check-runs'))).toHaveLength(1);
  });

  it('still prefers the newest run per NAME — the earlier reduction is intact', () => {
    const { status } = run({
      STUB_CHECKS: checkRuns([
        ...baseChecks(),
        { name: 'e2e (Playwright)', conclusion: 'cancelled', id: 1, suite: 2 },
        { name: 'e2e (Playwright)', conclusion: 'success', id: 2, suite: 3 },
      ]),
      STUB_RUNS: workflowRuns([]),
    });

    expect(status.all_success).toBe(true);
    expect(status.unresolved).toBe(0);
    // The name reduction alone resolved it, so no workflow lookup was needed.
    expect(status.total).toBe(4);
  });
});
