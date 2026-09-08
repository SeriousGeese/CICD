import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, type Harness } from '../harness/engine.js';

/**
 * The `.github/workflows/` push restriction — ported from DnD's
 * prReviewWorkflowPushRestriction.
 *
 * GitHub REFUSES a push made with an Actions GITHUB_TOKEN when the pushed ref
 * creates or updates any file under `.github/workflows/`, unless the App holds
 * the `workflows` permission — which GITHUB_TOKEN cannot be granted. It is
 * DETERMINISTIC (verified by retriggering run 33276283197 four hours later on an
 * unmoved branch: identical rejection), and it keys off the CONTENTS OF THE
 * PUSHED REF, not off what the PR author changed — so a base-sync merge that
 * brings main's workflow edits onto the branch trips it too.
 *
 * Before the fix, the rejection was caught by the generic non-fast-forward arm
 * and reported as a concurrent push. Both halves of that were wrong: there was
 * no concurrent writer (local == remote == a9dbcd92 for six hours), and no later
 * run could ever succeed. PR #2637 looped `result: blocked` / `merge_sha: none`
 * for ~6h with every check green, while an operator hunted for a writer that did
 * not exist.
 *
 * THE ISOLATING EVIDENCE: after a human levelled the branch by hand, the very
 * next auto-review run MERGED #2637 — same PR, same branch, the same workflow
 * file still in the diff, same permissions. The only difference was that the bot
 * had nothing to push. It is the PUSH that is impossible, not the merge.
 *
 * Hence two halves, and they are not alternatives:
 *   1. SKIP the base-sync push when branch protection does not require an
 *      up-to-date head. The merge stays LOCAL, so the review and the quality
 *      gates still see the merged tree.
 *   2. When a push IS genuinely required — a real auto-fix commit — name THAT
 *      restriction and say a human must push. Never claim a concurrent push.
 */

const script = readFileSync(enginePath, 'utf8');

/** Verbatim stderr from run 33276283197 (PR #2637), backticks and all. */
const WORKFLOW_REJECTION = [
  ' ! [remote rejected]   HEAD -> feat/DnD-ybuft-baseline-drift-report',
  '   (refusing to allow a GitHub App to create or update workflow',
  '    `.github/workflows/e2e-baselines.yml` without `workflows` permission)',
  "error: failed to push some refs to 'https://github.com/SeriousGeese/DnD.git'",
].join('\n');

/** The genuine race this arm was originally written for — must not regress. */
const NON_FAST_FORWARD = [
  ' ! [rejected]        HEAD -> feat/x (fetch first)',
  "error: failed to push some refs to 'https://github.com/SeriousGeese/DnD.git'",
  'hint: Updates were rejected because the remote contains work that you do not have locally.',
].join('\n');

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8451 });
});
afterAll(() => h.cleanup());

/**
 * `git push` is stubbed as a SHELL FUNCTION — bash resolves functions before
 * PATH — so the real push logic runs against a scripted rejection. finish() is
 * replaced so the terminal comment is observable instead of being posted.
 */
function push(env: Record<string, string> = {}) {
  return h.run({
    env,
    body: `
git() {
  if [ "$1" = "push" ]; then
    printf '%s' "\${STUB_PUSH_STDERR:-}" >&2
    return "\${STUB_PUSH_RC:-0}"
  fi
  command git "$@"
}
finish() { printf 'FINISH_RESULT=%s\\n' "$2"; printf 'FINISH_SUMMARY=%s\\n' "$1"; exit 0; }
push_review_commits 2
printf 'FIXES_PUSHED=%s\\n' "$FIXES_PUSHED"
`,
  }).stdout;
}

/** BASE_REQUIRES_UP_TO_DATE_HEAD is overridable so the strict branch runs for real. */
function skip(fixesCommitted: string, syncedWithBase: string, env: Record<string, string> = {}) {
  const out = h.run({
    env,
    body: `
BASE_REQUIRES_UP_TO_DATE_HEAD="\${STUB_STRICT:-$BASE_REQUIRES_UP_TO_DATE_HEAD}"
if should_skip_base_sync_push "${fixesCommitted}" "${syncedWithBase}"; then echo SKIP; else echo PUSH; fi
`,
  }).stdout;
  return out.trim().split('\n').filter(Boolean).pop()?.trim() ?? '';
}

describe('half two — an honest hold when the push is genuinely required', () => {
  it('never says "concurrent push" for the workflow-permission rejection', () => {
    // The acceptance criterion, stated exactly: this string must not appear for a
    // rejection whose stderr names the workflows permission.
    const out = push({ STUB_PUSH_RC: '1', STUB_PUSH_STDERR: WORKFLOW_REJECTION });
    expect(out).not.toContain('concurrent push');
  });

  it('names the workflow-permission restriction and says a human must push', () => {
    const out = push({ STUB_PUSH_RC: '1', STUB_PUSH_STDERR: WORKFLOW_REJECTION });
    expect(out).toContain('FINISH_RESULT=blocked');
    expect(out).toContain('.github/workflows/');
    expect(out).toMatch(/permission/i);
    // "a human must push", in whatever wording — the operator has to be told the
    // bot cannot resolve this, or they go hunting for a phantom writer again.
    expect(out).toMatch(/human/i);
    expect(out).toMatch(/force-with-lease|push these commits|human has to push/i);
    // And it must be explicit that re-running is pointless.
    expect(out).toMatch(/cannot clear it|re-running this review/i);
  });

  it('does not mark the commits as pushed', () => {
    const out = push({ STUB_PUSH_RC: '1', STUB_PUSH_STDERR: WORKFLOW_REJECTION });
    expect(out).not.toContain('FIXES_PUSHED=true');
  });

  it('KEEPS the concurrent-push message for a real non-fast-forward', () => {
    // The genuine race is what this arm was written for; classifying the workflow
    // rejection must not swallow it.
    const out = push({ STUB_PUSH_RC: '1', STUB_PUSH_STDERR: NON_FAST_FORWARD });
    expect(out).toContain('FINISH_RESULT=blocked');
    expect(out).toContain('concurrent push to the branch');
    expect(out).not.toContain('.github/workflows/');
  });

  it('still reports a successful push as a success', () => {
    const out = push({ STUB_PUSH_RC: '0' });
    expect(out).toContain('FIXES_PUSHED=true');
    expect(out).not.toContain('FINISH_RESULT=');
  });

  it('classifies the OAuth-App wording of the same restriction too', () => {
    // Same server-side rule, different actor wording. Both must land on the
    // honest arm rather than the race arm.
    const oauth =
      ' ! [remote rejected] HEAD -> feat/x (refusing to allow an OAuth App to create' +
      ' or update workflow `.github/workflows/ci.yml` without `workflow` scope)';
    const out = push({ STUB_PUSH_RC: '1', STUB_PUSH_STDERR: oauth });
    expect(out).not.toContain('concurrent push');
    expect(out).toContain('FINISH_RESULT=blocked');
  });
});

describe('half one — skipping a base-sync push protection does not require', () => {
  it('skips the push when the base needs no up-to-date head and nothing was fixed', () => {
    // The whole point: with nothing pushed, the workflows restriction never
    // fires, and the PR merges from the author's own SHA — the shape that
    // eventually merged #2637.
    expect(skip('false', 'true')).toBe('SKIP');
  });

  it('does NOT skip when an auto-fix commit has to land', () => {
    // A real fix must reach the branch or the review did nothing. Skipping cannot
    // avoid that push, which is exactly why half two exists.
    expect(skip('true', 'true')).toBe('PUSH');
  });

  it('does NOT skip when the base sync was not what put us ahead', () => {
    expect(skip('false', 'false')).toBe('PUSH');
  });

  it('does NOT skip when the base branch DOES require an up-to-date head', () => {
    // Flipping BASE_REQUIRES_UP_TO_DATE_HEAD to true must restore the push for
    // every PR — that is the single edit someone makes if protection goes strict.
    expect(skip('false', 'true', { STUB_STRICT: 'true' })).toBe('PUSH');
    expect(skip('true', 'true', { STUB_STRICT: 'true' })).toBe('PUSH');
  });

  it('carries the constant, its verification recipe, and its failure mode', () => {
    // The constant is only defensible while the next reader can CHECK it and
    // knows what breaks if it goes stale. Pin all three, or the comment rots and
    // the value becomes folklore.
    const at = script.indexOf('BASE_REQUIRES_UP_TO_DATE_HEAD=false');
    const from = script.indexOf('# Half one:');
    expect(at).toBeGreaterThan(-1);
    expect(from).toBeGreaterThan(-1);
    expect(from).toBeLessThan(at);
    const comment = script.slice(from, at);
    // …the verification command, which needs an ADMIN credential…
    expect(comment).toContain('branches/main/protection');
    expect(comment).toContain('.required_status_checks.strict');
    expect(comment).toMatch(/ADMIN/);
    // …why it is not read at runtime…
    expect(comment).toMatch(/not an Actions permission|no `?permissions:`? key/i);
    // …and what happens if protection goes strict and nobody updates this.
    expect(comment).toMatch(/FAILURE MODE/);
    expect(comment).toMatch(/blocked/);
  });

  it('does not attempt a runtime protection read that could only ever 403', () => {
    // Dead code that always takes its fallback is worse than no code: it reads as
    // working. GITHUB_TOKEN cannot hold repo-admin, so that endpoint is off-limits
    // from the runner, full stop. It may appear only as a COMMENTED verification
    // recipe a human runs with their own credential — never on an executed line.
    const executable = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(executable).not.toContain('/protection');
    expect(executable).not.toContain('required_status_checks');
  });

  it('still performs the base-sync merge locally, so the gates see the merged tree', () => {
    // Only the PUSH is skipped. Dropping the merge would review the un-synced
    // tree and lose the merged-tree guardrails.
    const mergeAt = script.indexOf('(auto-review sync)"');
    const skipAt = script.indexOf('Skipping the base-sync push');
    expect(mergeAt).toBeGreaterThan(-1);
    expect(skipAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeLessThan(skipAt);
  });
});

/**
 * DnD's spec closed with a block asserting that pr-auto-review.yml names only
 * real Actions `permissions:` keys. That one is NOT ported here — CICD ships
 * composite actions, which have no permissions block, and each consumer's caller
 * is its own file.
 *
 * It went to the consumers instead, where the workflow actually lives, because
 * the failure it catches is severe and silent: an unrecognised `permissions:`
 * key does not warn, it INVALIDATES the workflow file. The run then fails with
 * ZERO jobs and no annotation. A first cut of this very fix put
 * `administration: read` there — a GitHub App scope, not an Actions permission —
 * and killed two runs that way.
 */
