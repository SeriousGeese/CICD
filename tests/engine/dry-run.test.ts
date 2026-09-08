import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CICD_DRY_RUN must make the engine incapable of writing anything.
 *
 * This is the property the entire rollout plan rests on: each consumer runs this
 * engine in shadow beside its incumbent reviewer on real PRs and diffs the two
 * comments, so divergence is found on live traffic before anything can act on it.
 * That is only safe if shadow mode provably cannot push, cannot merge, and cannot
 * apply a fix — and "provably" has to mean tested, because the failure mode is a
 * shadow run silently merging someone's PR.
 *
 * Guarded at three independent points, and each is asserted separately so that
 * removing any one of them fails a test rather than narrowing the guarantee:
 *   review_may_apply_fixes()  no fixes written to the working tree
 *   push_review_commits()     no push to the author's branch
 *   merge_pr()                no merge
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(here, '..', '..', 'engine', 'pr-review.sh');
const posix = (p: string) => p.split(path.sep).join('/');

/**
 * Clear all four merge holds. They are real API calls, and merge_pr re-reads
 * every one of them on every attempt by design, so without stubs they fail
 * closed on a 401 and the test never reaches the behaviour under test. Each
 * returns 1 = "this hold does not apply" (they return 0, and echo, when they DO
 * apply — the same inverted convention pr-review.sh uses throughout).
 */
const NO_HOLDS = `has_do_not_merge_label() { return 1; }
stacked_base_violation() { return 1; }
unmet_dependencies() { return 1; }
would_orphan_children() { return 1; }
MERGEABLE_POLL_TIMEOUT=1
MERGEABLE_POLL_INTERVAL=1`;

/**
 * The mergeability poll is deliberately NOT stubbed out — the "does not poll in
 * dry-run" case has to be able to observe it happening. Its budget is squeezed
 * to one second instead, so a regression that lets a dry run fall through to it
 * FAILS rather than hanging the suite for 300s. (That is not hypothetical: it is
 * what this file did on the first run after the guard moved.)
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cicd-dryrun-'));
  mkdirSync(path.join(dir, 'work'), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function callInDryRun(body: string, dryRun: string): string {
  const harness = path.join(dir, `h-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
export PR_NUMBER=7 PR_HEAD_REF=feat/x PR_BASE_REF=main PR_AUTHOR=tester
export PR_TITLE=t PR_BODY=""
export REPO=SeriousGeese/CICD WORK_DIR="${posix(path.join(dir, 'work'))}"
export GH_TOKEN=fake GITHUB_OUTPUT=/dev/null
export HEAD_SHA=aaaaaaaaaaaa BASE_SHA=bbbbbbbbbbbb GITHUB_RUN_ID=1
export PR_REVIEW_LIBRARY_MODE=1
export CICD_DRY_RUN="${dryRun}"
# shellcheck source=/dev/null
source "${posix(engine)}"
cleanup() { :; }
# Any real write would go through one of these; make them loud instead. GH_CLI
# expands to \`gh\`, so a shell function by that name intercepts every API call
# the engine makes — including the \`gh pr merge\` this file exists to prove
# unreachable.
git() { echo "GIT_CALLED: $*"; return 0; }
gh() { echo "GH_CALLED: $*"; return 0; }
${body}
`,
    'utf8',
  );
  chmodSync(harness, 0o755);
  const r = spawnSync('bash', ['-c', `"${posix(harness)}" 2>&1`], { encoding: 'utf8' });
  return r.stdout ?? '';
}

describe('CICD_DRY_RUN', () => {
  it('refuses to apply fixes even for an allowlisted author on a paid tier', () => {
    // Both of the normal preconditions are satisfied here on purpose: the point
    // is that dry-run overrides them rather than merely coinciding with them.
    const body = `LLM_USED_TIER=openrouter
LLM_USED_MODEL=some/paid-model
if review_may_apply_fixes true; then echo "WOULD_APPLY"; else echo "REFUSED"; fi`;
    expect(callInDryRun(body, 'true')).toContain('REFUSED');
    expect(callInDryRun(body, 'false')).toContain('WOULD_APPLY');
  });

  it('refuses to push to the author branch', () => {
    const out = callInDryRun('push_review_commits 1', 'true');
    expect(out).toMatch(/DRY RUN: would push/);
    expect(out).not.toContain('GIT_CALLED: push');
  });

  it('refuses to merge', () => {
    const out = callInDryRun(`${NO_HOLDS}\nmerge_pr || true`, 'true');
    expect(out).toMatch(/DRY RUN: no hold is in force/);
    // The assertion that matters. `gh pr merge` is the only mutation in
    // merge_pr, and moving the dry-run guard downward past the hold checks put
    // more of the function in reach of a shadow run — so this pins the one line
    // that must still be unreachable, rather than pinning where the guard sits.
    expect(out).not.toMatch(/GH_CALLED: pr merge/);
  });

  it('does not poll mergeability in dry-run', () => {
    // wait_for_mergeable is read-only, so it is not a safety question — it is a
    // cost one. A shadow shares a single self-hosted runner with the reviewer it
    // shadows, and this polls for up to 300s for an answer the shadow cannot act
    // on.
    const out = callInDryRun(`${NO_HOLDS}\nmerge_pr || true`, 'true');
    expect(out).not.toMatch(/Mergeability:/);
    expect(out).not.toMatch(/GH_CALLED: pr view .*mergeStateStatus/);
  });

  it('still evaluates the merge holds in dry-run, and reports the one in force', () => {
    // The reason the guard is below the holds rather than at the top of
    // merge_pr. A shadow whose every comment says only "would have merged"
    // cannot be compared against a real reviewer that held the PR — the two
    // diverge on every held PR for a reason that is in neither implementation.
    const out = callInDryRun(
      `has_do_not_merge_label() { echo "do-not-merge"; return 0; }
stacked_base_violation() { return 1; }
unmet_dependencies() { return 1; }
would_orphan_children() { return 1; }
merge_pr || true
echo "HOLD_LABEL=$HOLD_LABEL"`,
      'true',
    );
    expect(out).toMatch(/MERGE BLOCKED.*do-not-merge/);
    expect(out).toContain('HOLD_LABEL=do-not-merge');
    expect(out).not.toMatch(/GH_CALLED: pr merge/);
  });

  it('reports a dry run as `would_merge`, and never claims GitHub refused', () => {
    // `blocked` is a verdict about the PR. Reporting it for a shadow run puts a
    // red-looking result on every PR the shadow sees, including every one the
    // real reviewer merged — and the accompanying sentence said "the merge was
    // refused ... GitHub reported:", which is a fabrication: GitHub was never
    // asked.
    const out = callInDryRun(
      `${NO_HOLDS}\nmerge_pr || true\necho "RESULT=$(merge_refused_result)"\nmerge_refused_message`,
      'true',
    );
    expect(out).toContain('RESULT=would_merge');
    expect(out).toContain('nothing was merged, and nothing was refused');
    expect(out).not.toContain('the merge was refused after');
    // And it does not overstate what a shadow run establishes.
    expect(out).toContain('does NOT establish that the merge would have succeeded');
  });

  it('reports a real refusal as `blocked`, unchanged', () => {
    const out = callInDryRun(
      `MERGE_ATTEMPTS_MADE=2\nMERGE_ERROR="mergeStateStatus=BLOCKED"\necho "RESULT=$(merge_refused_result)"\nmerge_refused_message`,
      'false',
    );
    expect(out).toContain('RESULT=blocked');
    expect(out).toContain('the merge was refused after 2 merge attempt(s)');
    expect(out).toContain('mergeStateStatus=BLOCKED');
  });

  it('dispatches NO workflow — the shadow must not cause runs', () => {
    // A shadow that dispatches CI is CAUSING a run, which is the one thing
    // "advisory only, decides nothing" promises it does not do. On a repo with a
    // sharded Playwright matrix the e2e one is ~20 hosted minutes per PR that
    // nobody asked for.
    //
    // Two of these four are unreachable today — merge_pr returns 1 in dry-run, so
    // the post-merge block never runs — and they are guarded anyway, because
    // "unreachable" is a CONSEQUENCE, not a guarantee. The comment-path bug was
    // exactly this shape: a step nothing could reach, until a step above it
    // failed and it was reached after all.
    const out = callInDryRun(
      `${NO_HOLDS}
CICD_FEATURE_E2E_GATE=true
CICD_FEATURE_STAGE_DEPLOY=true
CICD_FEATURE_BEADS=true
dispatch_ci || true
dispatch_e2e_gate || true
dispatch_stage_deploy || true
dispatch_close_beads || true`,
      'true',
    );
    // Asserted on the ENGINE's own success lines, not on the gh stub's marker:
    // each dispatch captures the stub's stdout into a variable, so the marker
    // never reaches the log either way and a check for it would pass vacuously.
    expect(out).not.toMatch(/Dispatched CI on/);
    expect(out).not.toMatch(/Dispatched (e2e|the stage deploy|close-beads)/i);
    // And each says what it would have done, so the divergence is explained in
    // the log rather than looking like the dispatch silently doing nothing.
    for (const what of ['ci.yml', 'e2e.yml', 'deploy-stage.yml', 'close-beads.yml']) {
      expect(out, `no DRY RUN line for ${what}`).toContain(what);
    }
  });

  it('DOES dispatch when dry-run is off', () => {
    // The other direction, so the guard cannot be satisfied by a dispatch that
    // stopped working for an unrelated reason.
    const out = callInDryRun(`${NO_HOLDS}\ndispatch_ci || true`, 'false');
    expect(out).toMatch(/Dispatched CI on/);
    expect(out).not.toMatch(/DRY RUN: would dispatch/);
  });

  it('accepts the usual truthy spellings and defaults to OFF', () => {
    // A config file written by hand will say `1` or `yes` sooner or later, and a
    // silently-ignored dry-run flag is the worst possible way to find that out.
    for (const v of ['true', 'TRUE', '1', 'yes']) {
      expect(
        callInDryRun(`${NO_HOLDS}\nmerge_pr || true`, v),
        `dry-run should be ON for "${v}"`,
      ).toMatch(/DRY RUN/);
    }
    // Anything else is off — including an empty value, so an unset variable in a
    // real run can never accidentally disable merging.
    expect(callInDryRun(`${NO_HOLDS}\nmerge_pr || true`, '')).not.toMatch(/DRY RUN/);
  });
});

describe('review prompt location', () => {
  it('reads the prompt from SYSTEM_PROMPT_FILE so it can stay per-repo', () => {
    // review-prompt.md is product knowledge (DnD names Adventure Packs; PromptCI
    // names detector determinism) and is deliberately not shipped in engine/.
    const source = readFileSync(engine, 'utf8');
    expect(source).toMatch(/PROMPT_FILE="\$\{SYSTEM_PROMPT_FILE:-/);
  });
});
