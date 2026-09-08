import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, type Harness } from '../harness/engine.js';

/**
 * Per-run scratch files are isolated per PROCESS — ported from DnD's
 * prReviewScratchIsolation.
 *
 * RESPONSE_FILE, FIXES_FILE, APPLIED_FIXES_FILE and DROPPED_FIXES_FILE used to
 * be named from PR_NUMBER alone, under a single machine-global /tmp. That is
 * fine on a runner — one PR, one process — and wrong everywhere else:
 *
 *  - many spec files source this engine and vitest runs them in parallel;
 *  - several agent sessions run the suite concurrently on one machine, sharing
 *    /tmp even though they do not share a worktree.
 *
 * `cleanup()` `rm -f`s those four files on EXIT, so one harness finishing
 * deletes another's scratch mid-read; and review_llm writes the API body to
 * RESPONSE_FILE and parses it back, so a concurrent writer substitutes a
 * DIFFERENT review body under it. Reproduced on 2026-09-06 by running two full
 * suites at once: the LLM-validity spec reported `rc=1 tier=none` for a valid
 * review, and the log showed it parsing the other run's stub body.
 *
 * COMMENT_FILE is deliberately NOT isolated: the consuming workflow reads
 * /tmp/pr-review-comment-<n>.md back in a SEPARATE step, so its name is a
 * cross-process contract. That asymmetry is the thing this file pins, both
 * halves of it — isolate what is private, keep stable what is a contract.
 *
 * THIS PORT IS ALSO WHY the shared harness requires a unique prNumber per spec
 * file: the isolation makes collisions harmless, and the harness does not lean
 * on that.
 */

const script = readFileSync(enginePath, 'utf8');

/** Deliberately collides with nothing — the isolation is what is under test. */
const PR = 8411;

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({ prNumber: PR });
});
afterAll(() => h.cleanup());

const INTERNAL = ['RESPONSE_FILE', 'FIXES_FILE', 'APPLIED_FIXES_FILE', 'DROPPED_FIXES_FILE'];

/** One harness run, as a field map. Each run is a separate shell process. */
function paths(): Record<string, string> {
  const out = h.run({
    body: ['COMMENT_FILE', ...INTERNAL].map((f) => `echo "${f}=\${${f}}"`).join('\n'),
  }).stdout;
  return Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l.trim()))
      .map((line) => line.trim().split('='))
      .map(([k, ...v]) => [k, v.join('=')]),
  );
}

describe('scratch-file isolation', () => {
  it.each(INTERNAL)('%s differs between two runs that share a PR_NUMBER', (field) => {
    const [first, second] = [paths(), paths()];
    expect(first[field]).toBeTruthy();
    expect(second[field]).toBeTruthy();
    // Two concurrent suites at the same PR_NUMBER must not name the same file:
    // the EXIT trap of either would delete it under the other.
    expect(first[field]).not.toBe(second[field]);
  });

  it('keeps COMMENT_FILE keyed on PR_NUMBER alone — the workflow reads it back', () => {
    const [first, second] = [paths(), paths()];
    const expected = `/tmp/pr-review-comment-${PR}.md`;
    expect(first.COMMENT_FILE).toBe(expected);
    expect(second.COMMENT_FILE).toBe(expected);
  });

  it('still names the PR in every scratch path, so a stray file is attributable', () => {
    const p = paths();
    for (const field of INTERNAL) {
      expect(p[field]).toContain(`-${PR}-`);
    }
  });

  it('deletes exactly the internal scratch on exit, and never the comment file', () => {
    // The cleanup trap is what made the shared names actively DESTRUCTIVE
    // rather than merely shared.
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup'));
    for (const field of INTERNAL) expect(cleanup).toContain(`$${field}`);
    expect(cleanup).not.toContain('$COMMENT_FILE');
  });
});
