import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, type Harness } from '../harness/engine.js';

/**
 * Run-history hygiene — the engine half of DnD's prReviewRunHygiene.
 *
 * From the 2026-08-22 audit: 47 success / 35 cancelled / 10 failure / 7 skipped
 * in the last 100 runs, while every recent success actually merged. The noise
 * was entirely self-inflicted.
 *
 * TWO OF THE FOUR FIXES ARE THIS ENGINE'S, and are ported here:
 *
 *   2. Every `blocked` exited 1, so PR-caused blocks painted the review red.
 *      Only infra and reviewer faults exit 1 now. merge-hold.test.ts covers the
 *      behaviour; this file pins the CALL-SITE CLASSIFICATION — which summary is
 *      passed with which result — because the two drift independently.
 *   3. "ALL CHECKS PASSED" followed by `gh pr merge` refusing (#2338, #2357).
 *      The engine polls GitHub's own mergeStateStatus before merging.
 *
 * THE OTHER TWO DID NOT COME WITH IT:
 *
 *   1. "the review job does not run on its own pushes" asserts DnD's
 *      pr-auto-review.yml — repo configuration, not engine behaviour, and each
 *      consumer's caller is its own file.
 *   4. "npm ci retry budget is bounded and prefers IPv4" is OBSOLETE here.
 *      npm_ci_resilient does not exist in this engine: that knowledge moved into
 *      each consumer's .cicd/quality-gates.sh, which is the entire point of that
 *      seam. It becomes a DnD hook test at Stage 5, not a port.
 */

const script = readFileSync(enginePath, 'utf8');

describe('finish() exit map: PR-caused blocks are green, reviewer faults are red', () => {
  it('exits 1 only for blocked_infra / review_failed / the two failed-closed lookups', () => {
    // \r?\n: a Windows checkout with autocrlf hands us CRLF.
    expect(script).toMatch(
      /case "\$result" in\r?\n\s*blocked_infra\|review_failed\|held_label_lookup_failed\|held_lookup_failed\) exit 1 ;;\r?\n\s*\*\) exit 0 ;;/,
    );
  });

  it('keeps every stacked-PR hold GREEN — they are PR-caused, not reviewer faults', () => {
    // The reviewer DID its job when it declines to merge a stacked PR; only a
    // failed LOOKUP (an infra fault that holds every PR) is red. Reddening these
    // would re-create the confusion the audit removed, where a PR-caused block
    // looked like a broken reviewer.
    const redResults = script.match(/\n\s*(blocked_infra\|[a-z_|]+)\) exit 1 ;;/)?.[1] ?? '';
    for (const green of [
      'held_stacked_base',
      'held_unmet_dependency',
      'held_would_orphan_children',
    ]) {
      expect(script).toContain(`result="${green}"`);
      expect(redResults).not.toContain(green);
    }
  });

  const finishCalls = (script.match(/finish "[^"]*" "[a-z_]+"/g) ?? []).map((call) => {
    const m = call.match(/finish "([^"]*)" "([a-z_]+)"/)!;
    return { summary: m[1], result: m[2] };
  });

  it('finds the finish call sites it means to classify', () => {
    // Guards the parser: a regex that matched nothing would make both
    // classification cases below pass vacuously.
    expect(finishCalls.length).toBeGreaterThanOrEqual(8);
  });

  it('classifies the "review could not run" outcomes as blocked_infra', () => {
    const infra = finishCalls.filter((c) => c.result === 'blocked_infra').map((c) => c.summary);
    expect(infra.some((s) => /Quality gates could not run/.test(s))).toBe(true);
    expect(infra.some((s) => /CI never started/.test(s))).toBe(true);
    expect(infra.some((s) => /polling timed out/.test(s))).toBe(true);
    expect(infra.some((s) => /Could not read the live branch tip/.test(s))).toBe(true);
  });

  it('classifies the PR-caused outcomes as blocked (green)', () => {
    const blocked = finishCalls.filter((c) => c.result === 'blocked').map((c) => c.summary);
    // The CI-failure summary lives in failed_ci_message() so both call sites
    // share one text — the same anti-drift shape unresolved_ci_message has. What
    // this asserts is the CLASSIFICATION it is called with, not where the words
    // live, so the helper name counts as the summary.
    expect(blocked.some((s) => /CI checks (have failures|failing)|failed_ci_message/.test(s))).toBe(
      true,
    );
    expect(blocked.some((s) => /Merge conflicts/.test(s))).toBe(true);
    expect(blocked.some((s) => /concurrent push/.test(s))).toBe(true);
    // And none of the infra phrasings leaked back into the green bucket.
    expect(blocked.some((s) => /could not run|never started|timed out/.test(s))).toBe(false);
  });
});

describe('merge_pr asks GitHub for mergeability before merging', () => {
  it('calls wait_for_mergeable ahead of gh pr merge, inside merge_pr', () => {
    const body = script.slice(script.indexOf('merge_pr() {'));
    const merge = body.indexOf('pr merge "$PR_NUMBER" --repo "$REPO" --squash');
    const wait = body.indexOf('wait_for_mergeable || return 1');
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(merge);
  });
});

describe('wait_for_mergeable behaviour', () => {
  let h: Harness;
  let callsDir: string;

  beforeAll(() => {
    callsDir = mkdtempSync(path.join(tmpdir(), 'cicd-mergeable-'));
    h = createEngineHarness({
      prNumber: 8431,
      // Returns a sequence of mergeStateStatus values from $STUB_STATES, one per
      // call, repeating the last forever. An EMPTY element models a failed read.
      ghScript: `
n=$(( $(cat "$STUB_STATE_DIR/mcalls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_STATE_DIR/mcalls"
IFS=, read -r -a states <<< "$STUB_STATES"
idx=$(( n - 1 )); [ "$idx" -ge "\${#states[@]}" ] && idx=$(( \${#states[@]} - 1 ))
echo "\${states[$idx]}"
`,
    });
  });
  afterAll(() => {
    h.cleanup();
    rmSync(callsDir, { recursive: true, force: true });
  });

  function run(states: string): string {
    const calls = path.join(h.dir, 'state', 'mcalls');
    if (existsSync(calls)) rmSync(calls);
    const out = h.run({
      env: {
        STUB_STATES: states,
        MERGEABLE_POLL_INTERVAL: '1',
        MERGEABLE_POLL_TIMEOUT: '3',
      },
      body: `
rc=0
wait_for_mergeable >/dev/null 2>&1 || rc=$?
echo "rc=$rc calls=$(cat "$STUB_STATE_DIR/mcalls" 2>/dev/null || echo 0)"
`,
    }).stdout;
    return out.trim().split('\n').filter(Boolean).pop() ?? '';
  }

  it('proceeds immediately on CLEAN', () => {
    expect(run('CLEAN')).toBe('rc=0 calls=1');
  });

  it('accepts UNSTABLE (a non-required check red) and HAS_HOOKS', () => {
    // UNSTABLE means the REQUIRED checks are green and something optional is
    // not, which is exactly the bar branch protection sets. Refusing it would
    // block every PR with a flaky advisory check.
    expect(run('UNSTABLE')).toBe('rc=0 calls=1');
    expect(run('HAS_HOOKS')).toBe('rc=0 calls=1');
  });

  it('waits through BLOCKED/BEHIND until GitHub settles — the #2338 race', () => {
    expect(run('BLOCKED,BEHIND,CLEAN')).toBe('rc=0 calls=3');
  });

  it('refuses DIRTY without waiting — the #2357 conflict', () => {
    // A genuine conflict is terminal and is never retried, including one the
    // base move just created.
    expect(run('DIRTY')).toBe('rc=1 calls=1');
  });

  it('gives up after the budget when the verdict never settles', () => {
    expect(run('BLOCKED')).toMatch(/^rc=1 calls=4$/);
  });

  it('treats a failed read as "still computing", not a refusal', () => {
    // Transient read failures count against the budget rather than aborting, so
    // one flaky API call does not cost the merge.
    expect(run(',CLEAN')).toBe('rc=0 calls=2');
  });
});

/**
 * The post-merge block dispatches beads and stage, and NOT e2e.
 *
 * The engine-relevant assertion out of DnD's prReviewE2eDispatch. The rest of
 * that spec is about DnD's own `e2e-main-dispatcher.yml` — its schedule, its
 * runner, its docs-only globs, its shell logic — which is a DnD workflow and
 * stays there.
 *
 * WHY IT MATTERS HERE. A per-merge dispatch of the full post-merge suite once
 * cost ~$47/month (393 runs in one August at ~20 hosted minutes each, one full
 * 4-shard suite per merge, bursts included). It was replaced by a debounced
 * scheduler, so regrowing it in the engine hands that bill back to every
 * consumer at once — silently, and doubled up with whatever scheduler they run.
 *
 * The two things that MUST survive the removal, and are asserted alongside it,
 * because "remove the e2e dispatch" is one careless grep away from taking them:
 *
 *   dispatch_e2e_gate  fires PRE-merge, once, only on a SHA that would otherwise
 *                      have no gate at all — a GITHUB_TOKEN push fires no
 *                      pull_request event, so the required context never appears
 *                      on it. A different mechanism from the per-merge dispatch,
 *                      not a survival of it.
 *   dispatch_stage_deploy  deliberately INVERTED from the e2e economics: the
 *                      stage build runs on a self-hosted runner and costs about
 *                      nothing, and a bot merge fires no push event, so without
 *                      it stage sits at the previous commit until a human merges.
 */
describe('the post-merge dispatch block', () => {
  it('has no per-merge e2e dispatch', () => {
    // Definition-shaped match: the engine legitimately NAMES the old function in
    // a history comment explaining where the per-merge dispatch went, and a bare
    // substring test would read that comment as a reintroduction.
    expect(script).not.toMatch(/^dispatch_e2e\(\) \{/m);

    const start = script.indexOf('  if [ "$merged" = "true" ]; then');
    expect(start).toBeGreaterThan(-1);
    const end = script.indexOf('# Call one LLM endpoint.', start);
    expect(end).toBeGreaterThan(start);
    const mergeBlock = script.slice(start, end);

    expect(mergeBlock).toContain('dispatch_close_beads');
    expect(mergeBlock).not.toMatch(/\bdispatch_e2e\b(?!_gate)/);
  });

  it('keeps the PR-side e2e gate, which is a different mechanism', () => {
    expect(script).toContain('dispatch_e2e_gate()');
    expect(script).toContain('pr_touches_e2e_paths()');
  });

  it('keeps the stage dispatch, whose economics are deliberately inverted', () => {
    expect(script).toContain('dispatch_stage_deploy');
  });
});
