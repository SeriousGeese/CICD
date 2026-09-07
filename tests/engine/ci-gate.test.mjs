import { describe, expect, it } from 'vitest';

import { decideGate, runGate } from '../../engine/ci-gate.mjs';

/**
 * The gate is the ONLY thing standing between a broken CI run and a merge, so
 * these tests are written against the two silent failure modes it exists to
 * close, not just the happy path:
 *
 *   1. `skipped` counts as PASSING to a GitHub ruleset. A dependency that is
 *      skipped does not fail a job with `if: always()` either — so without an
 *      explicit check, "e2e never ran" reads as "e2e passed".
 *   2. A required job that disappears from `needs` (renamed, deleted, dropped
 *      from the gate's `needs:` list) reads as `undefined`, which is likewise
 *      not a failure unless we make it one.
 */

/** `toJSON(needs)` shape: { <job>: { result, outputs } }. */
function needs(results) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }])),
  );
}

const REQUIRED = 'ci,e2e,audit';

describe('decideGate', () => {
  it('passes when every required job succeeded', () => {
    const decision = decideGate({
      needsJson: needs({ ci: 'success', e2e: 'success', audit: 'success' }),
      requiredJobs: REQUIRED,
    });

    expect(decision.errors).toEqual([]);
    expect(decision.ok).toBe(true);
  });

  // The needs-skip rubber stamp: this is the case that would otherwise let a PR
  // merge with no e2e while every visible check is green.
  it.each(['skipped', 'cancelled', 'failure'])('fails when a required job is %s', (result) => {
    const decision = decideGate({
      needsJson: needs({ ci: 'success', e2e: result, audit: 'success' }),
      requiredJobs: REQUIRED,
    });

    expect(decision.ok).toBe(false);
    expect(decision.errors).toEqual([`::error title=gate::job 'e2e' concluded '${result}'`]);
  });

  it('fails when a required job key is missing from needs entirely', () => {
    const decision = decideGate({
      needsJson: needs({ ci: 'success', e2e: 'success' }),
      requiredJobs: REQUIRED,
    });

    expect(decision.ok).toBe(false);
    expect(decision.errors).toEqual(["::error title=gate::job 'audit' concluded 'absent'"]);
  });

  it('fails when a required job is present but carries no result', () => {
    const decision = decideGate({
      needsJson: JSON.stringify({ ci: { result: 'success' }, e2e: { result: 'success' }, audit: {} }),
      requiredJobs: REQUIRED,
    });

    expect(decision.ok).toBe(false);
    expect(decision.errors).toEqual(["::error title=gate::job 'audit' concluded 'absent'"]);
  });

  it('reports every failing job, not just the first', () => {
    const decision = decideGate({
      needsJson: needs({ ci: 'failure', e2e: 'skipped', audit: 'success' }),
      requiredJobs: REQUIRED,
    });

    expect(decision.errors).toEqual([
      "::error title=gate::job 'ci' concluded 'failure'",
      "::error title=gate::job 'e2e' concluded 'skipped'",
    ]);
  });

  it('ignores extra jobs in needs that are not required', () => {
    const decision = decideGate({
      needsJson: needs({ ci: 'success', e2e: 'success', audit: 'success', advisory: 'failure' }),
      requiredJobs: REQUIRED,
    });

    expect(decision.ok).toBe(true);
  });

  it('fails when GATE_REQUIRED_JOBS is empty — a gate requiring nothing is a rubber stamp', () => {
    for (const requiredJobs of [undefined, '', '  ', ',,']) {
      const decision = decideGate({ needsJson: needs({ ci: 'success' }), requiredJobs });
      expect(decision.ok, `requiredJobs=${JSON.stringify(requiredJobs)}`).toBe(false);
    }
  });

  it('fails when GATE_NEEDS is missing or unparseable', () => {
    for (const needsJson of [undefined, '', 'not json', '${{ toJSON(needs) }}']) {
      const decision = decideGate({ needsJson, requiredJobs: REQUIRED });
      expect(decision.ok, `needsJson=${JSON.stringify(needsJson)}`).toBe(false);
    }
  });

  it('fails when GATE_NEEDS parses to something that is not an object', () => {
    for (const needsJson of ['null', '[]', '"success"', '3']) {
      const decision = decideGate({ needsJson, requiredJobs: REQUIRED });
      expect(decision.ok, `needsJson=${needsJson}`).toBe(false);
    }
  });

  it('tolerates whitespace in GATE_REQUIRED_JOBS', () => {
    const decision = decideGate({
      needsJson: needs({ ci: 'success', e2e: 'success', audit: 'success' }),
      requiredJobs: ' ci , e2e , audit ',
    });

    expect(decision.ok).toBe(true);
  });
});

describe('runGate', () => {
  function capture(env) {
    const lines = [];
    const code = runGate(env, (line) => lines.push(line));
    return { code, lines };
  }

  it('exits 0 when every required job succeeded', () => {
    const { code } = capture({
      GATE_NEEDS: needs({ ci: 'success', e2e: 'success', audit: 'success' }),
      GATE_REQUIRED_JOBS: REQUIRED,
    });

    expect(code).toBe(0);
  });

  it('exits 1 and names the offending job on a skip', () => {
    const { code, lines } = capture({
      GATE_NEEDS: needs({ ci: 'success', e2e: 'skipped', audit: 'success' }),
      GATE_REQUIRED_JOBS: REQUIRED,
    });

    expect(code).toBe(1);
    expect(lines).toContain("::error title=gate::job 'e2e' concluded 'skipped'");
  });

  it('exits 1 when a required job is absent from needs', () => {
    const { code, lines } = capture({
      GATE_NEEDS: needs({ ci: 'success', e2e: 'success' }),
      GATE_REQUIRED_JOBS: REQUIRED,
    });

    expect(code).toBe(1);
    expect(lines).toContain("::error title=gate::job 'audit' concluded 'absent'");
  });
});
