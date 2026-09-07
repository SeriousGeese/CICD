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
# Any real write would go through one of these; make them loud instead.
git() { echo "GIT_CALLED: $*"; return 0; }
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
    const out = callInDryRun('merge_pr || true', 'true');
    expect(out).toMatch(/DRY RUN: would merge/);
  });

  it('accepts the usual truthy spellings and defaults to OFF', () => {
    // A config file written by hand will say `1` or `yes` sooner or later, and a
    // silently-ignored dry-run flag is the worst possible way to find that out.
    for (const v of ['true', 'TRUE', '1', 'yes']) {
      expect(callInDryRun('merge_pr || true', v), `dry-run should be ON for "${v}"`).toMatch(
        /DRY RUN/,
      );
    }
    // Anything else is off — including an empty value, so an unset variable in a
    // real run can never accidentally disable merging.
    expect(callInDryRun('merge_pr || true', '')).not.toMatch(/DRY RUN/);
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
