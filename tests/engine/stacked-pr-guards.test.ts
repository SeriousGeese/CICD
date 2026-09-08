import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, forEachProfile, type Harness } from '../harness/engine.js';

/**
 * The stacked-PR merge guards — ported from DnD's prReviewStackedPr.
 *
 * THE INCIDENT, 2026-08-30. PRs #2694 → #2696 → #2699 were a deliberate stack.
 * Merging #2696 into its feature-branch base deleted that branch, and GitHub
 * CLOSED #2699 rather than retargeting it — its event log shows
 * `base_ref_deleted` and `closed` in the same second. The replacement PR #2701
 * then died the same way when #2694 merged. Three PR numbers, one bead, every
 * rebuild manual: GitHub refuses both `gh pr edit --base` and `gh pr reopen` on a
 * closed PR whose base is gone.
 *
 * A `do-not-merge` label is no defence — #2701 carried one. It stops the bot
 * merging the CHILD; nothing stopped the PARENT deleting the base underneath it.
 *
 * THE THREE GUARDS DO NOT FAIL THE SAME WAY, AND THAT IS THE DESIGN:
 *   stacked_base_violation  fails CLOSED — one deferred merge the next run
 *                           retries, versus merging a stacked PR because a
 *                           transient API error made it look fine.
 *   unmet_dependencies      fails CLOSED, same trade.
 *   would_orphan_children   fails OPEN — it is a safety net over a stack the
 *                           base guard should have prevented, so a read outage
 *                           must not block every merge in the repo.
 * A port that levelled those would look tidier and be wrong in both directions.
 *
 * WHAT THE PORT ADDS: the CICD_FEATURE_STACKED_PRS matrix. All three guards sit
 * behind one flag, and "off" is the dangerous direction for every one of them —
 * a hold that stops holding is silent.
 *
 * WHAT STAYED IN DnD: the `git-maintenance.sh` block. That nightly branch-hygiene
 * script is DnD's own, not the engine's, and it covers the other half of the same
 * incident — it deleted stale merged branches while checking only PRs FROM a
 * branch, never PRs BASED ON it, reproducing the orphaning nightly.
 */

const script = readFileSync(enginePath, 'utf8');

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({
    prNumber: 8331,
    // Scripted per call SHAPE. Like the real gh it fails without --repo, so a
    // call that forgets it is caught here rather than in production.
    //   STUB_BASE      baseRefName for the PR under review
    //   STUB_BODY      the PR body
    //   STUB_STATES    "2694=MERGED 2695=OPEN" — state per PR number
    //   STUB_CHILDREN  newline-joined "#N" refs `pr list --base` returns
    //   STUB_DEFAULT   the repo default branch
    //   STUB_FAIL_*    force that call to fail
    ghScript: `
case " $* " in
  *" --repo "*) ;;
  *"repos/"*) ;;
  *) echo "failed to run git: fatal: not a git repository" >&2; exit 1 ;;
esac

if [ "$1" = "api" ]; then
  printf '%s' "\${STUB_DEFAULT:-main}"
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  [ "\${STUB_FAIL_CHILDREN:-0}" = "1" ] && { echo "gh: API error" >&2; exit 1; }
  printf '%s' "\${STUB_CHILDREN:-}"
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  num="$3"
  field=""
  prev=""
  for a in "$@"; do
    [ "$prev" = "--json" ] && field="$a"
    prev="$a"
  done
  case "$field" in
    baseRefName)
      [ "\${STUB_FAIL_BASE:-0}" = "1" ] && { echo "gh: API error" >&2; exit 1; }
      printf '%s' "\${STUB_BASE:-main}" ;;
    body)
      [ "\${STUB_FAIL_BODY:-0}" = "1" ] && { echo "gh: API error" >&2; exit 1; }
      printf '%s' "\${STUB_BODY:-}" ;;
    state)
      # An unknown PR number FAILS, exactly as gh does for a typo or an issue.
      hit=""
      for pair in \${STUB_STATES:-}; do
        case "$pair" in
          "\${num}="*) hit="\${pair#*=}" ;;
        esac
      done
      if [ -z "$hit" ]; then
        echo "GraphQL: Could not resolve to a PullRequest with the number of \${num}." >&2
        exit 1
      fi
      printf '%s' "$hit" ;;
  esac
  exit 0
fi
exit 0
`,
  });
});

afterAll(() => h.cleanup());

const BODIES = {
  base: 'if b="$(stacked_base_violation)"; then echo "BLOCK:${b}"; else echo ALLOW; fi',
  deps: 'if d="$(unmet_dependencies)"; then echo "HOLD:${d}"; else echo ALLOW; fi',
  orphans: 'if o="$(would_orphan_children)"; then echo "BLOCK:${o}"; else echo ALLOW; fi',
  defaultBranch: 'default_branch; echo',
};

/** PR_NUMBER in the harness is 8331, so self-reference cases use that number. */
const SELF = 8331;

/**
 * The guard's VERDICT — the last non-empty line.
 *
 * Not the whole output: the harness folds stderr into stdout so that specs can
 * assert on log lines, and these guards log before they echo ("base ref lookup
 * FAILED (rc=1) — failing closed"). Comparing the full buffer would make every
 * fail-closed case depend on log wording it has no business owning.
 */
function run(body: string, env: Record<string, string> = {}) {
  const out = h.run({
    body,
    env: { CICD_FEATURE_STACKED_PRS: 'true', AUTOMERGE_AUTHORS: 'tester', ...env },
  }).stdout;
  return out.split('\n').filter((l) => l.trim() !== '').pop()?.trim() ?? '';
}

describe('stacked_base_violation', () => {
  it('allows a PR based on the default branch', () => {
    expect(run(BODIES.base, { STUB_BASE: 'main' })).toBe('ALLOW');
  });

  it('blocks a PR based on a feature branch — the #2699 shape', () => {
    expect(run(BODIES.base, { STUB_BASE: 'feat/multi-tab' })).toBe('BLOCK:feat/multi-tab');
  });

  it('honours a renamed default branch rather than hardcoding main', () => {
    expect(run(BODIES.base, { STUB_BASE: 'trunk', STUB_DEFAULT: 'trunk' })).toBe('ALLOW');
    expect(run(BODIES.base, { STUB_BASE: 'main', STUB_DEFAULT: 'trunk' })).toBe('BLOCK:main');
  });

  it('fails CLOSED when the base ref cannot be read', () => {
    expect(run(BODIES.base, { STUB_FAIL_BASE: '1' })).toBe('BLOCK:<label lookup failed>');
  });

  it('falls back to main when the default-branch lookup itself fails', () => {
    // A lookup failure must not make every base look wrong.
    expect(run(BODIES.defaultBranch, { STUB_DEFAULT: '' })).toBe('main');
  });

  it('primes the default-branch cache with a bare call in the parent shell', () => {
    // Every other call site invokes default_branch inside a $( ) substitution,
    // whose subshell copy of DEFAULT_BRANCH_CACHE is discarded on exit; only a
    // bare statement makes "resolved once and cached" actually true.
    expect(script).toMatch(/^\s*default_branch > \/dev\/null$/m);
  });
});

describe('unmet_dependencies', () => {
  it('allows a body with no Depends-on line', () => {
    expect(run(BODIES.deps, { STUB_BODY: 'Fixes: pcic-aaaaa\n' })).toBe('ALLOW');
  });

  it('allows when every declared dependency is merged', () => {
    expect(run(BODIES.deps, { STUB_BODY: 'Depends-on: #2694\n', STUB_STATES: '2694=MERGED' })).toBe(
      'ALLOW',
    );
  });

  it('holds while a dependency is still open', () => {
    expect(run(BODIES.deps, { STUB_BODY: 'Depends-on: #2694\n', STUB_STATES: '2694=OPEN' })).toBe(
      'HOLD:#2694(OPEN)',
    );
  });

  it('treats a CLOSED-but-unmerged dependency as unmet', () => {
    // It may itself have been orphaned by this very bug; merging past it would
    // compound the damage rather than resolve it.
    expect(run(BODIES.deps, { STUB_BODY: 'Depends-on: #2699\n', STUB_STATES: '2699=CLOSED' })).toBe(
      'HOLD:#2699(CLOSED)',
    );
  });

  it('accepts Blocked-by: as a synonym', () => {
    expect(run(BODIES.deps, { STUB_BODY: 'Blocked-by: #2694\n', STUB_STATES: '2694=OPEN' })).toBe(
      'HOLD:#2694(OPEN)',
    );
  });

  it('ignores a #ref in prose — only anchored lines count', () => {
    expect(run(BODIES.deps, { STUB_BODY: 'This is related to #2694 somehow.\n' })).toBe('ALLOW');
  });

  it('holds — never silently passes — on an unresolvable ref', () => {
    // A typo, an issue number and a deleted PR all fail identically. Reporting
    // "satisfied" would be the wrong-direction failure; reddening the run would
    // make one typo redden every future review.
    expect(run(BODIES.deps, { STUB_BODY: 'Depends-on: #276\n', STUB_STATES: '2761=MERGED' })).toBe(
      'HOLD:#276(unresolvable)',
    );
  });

  it('holds on a cross-repo ref instead of resolving it against this repo', () => {
    // Two ways to get this wrong, both wrong-direction: a loose #[0-9]+ match
    // reads `Other#12` as THIS repo's PR 12 — some ancient merged PR — and
    // reports the dependency satisfied; anchoring alone extracts nothing and
    // ignores a dependency the author deliberately wrote down. Hold instead.
    expect(
      run(BODIES.deps, { STUB_BODY: 'Depends-on: SeriousGeese/Other#12\n', STUB_STATES: '12=MERGED' }),
    ).toMatch(/^HOLD:.*unparseable/);
  });

  it('ignores a self-reference rather than deadlocking', () => {
    expect(run(BODIES.deps, { STUB_BODY: `Depends-on: #${SELF}\n` })).toBe('ALLOW');
  });

  it('fails CLOSED when the body cannot be read', () => {
    expect(run(BODIES.deps, { STUB_FAIL_BODY: '1' })).toBe('HOLD:<label lookup failed>');
  });
});

describe('would_orphan_children', () => {
  it('allows when nothing is based on this head', () => {
    expect(run(BODIES.orphans, { STUB_CHILDREN: '' })).toBe('ALLOW');
  });

  it('blocks when an open PR targets this head — the #2694 shape', () => {
    expect(run(BODIES.orphans, { STUB_CHILDREN: '#2701' })).toBe('BLOCK:#2701');
  });

  it('fails OPEN on an API error, so a read outage cannot wedge the queue', () => {
    // Deliberately unlike the base guard: this is a safety net over a stack the
    // base guard should have prevented, so a transient failure must not block
    // every merge in the repo.
    expect(run(BODIES.orphans, { STUB_FAIL_CHILDREN: '1' })).toBe('ALLOW');
  });
});

describe('CICD_FEATURE_STACKED_PRS', () => {
  // All three guards sit behind one flag, and OFF is the dangerous direction for
  // every one of them: a hold that stops holding produces no error, no log line
  // and no failed run — just a merge that should not have happened.
  const cases: Array<[string, string, Record<string, string>]> = [
    ['stacked_base_violation', BODIES.base, { STUB_BASE: 'feat/multi-tab' }],
    ['unmet_dependencies', BODIES.deps, { STUB_BODY: 'Depends-on: #2694\n', STUB_STATES: '2694=OPEN' }],
    ['would_orphan_children', BODIES.orphans, { STUB_CHILDREN: '#2701' }],
  ];

  for (const [name, body, env] of cases) {
    it(`${name}: holds when on, and is INERT when off`, () => {
      expect(run(body, { ...env, CICD_FEATURE_STACKED_PRS: 'true' })).not.toBe('ALLOW');
      expect(run(body, { ...env, CICD_FEATURE_STACKED_PRS: 'false' })).toBe('ALLOW');
    });
  }

  forEachProfile((name, settings) => {
    it(`${name}: matches what that profile configures`, () => {
      // Against the profile's own value, not a hard-coded one: the profiles
      // mirror the live consumer configs, so hard-coding would keep passing
      // after a consumer changed the flag.
      const on = settings.CICD_FEATURE_STACKED_PRS === 'true';
      const out = h
        .run({ profile: name, body: BODIES.base, env: { STUB_BASE: 'feat/multi-tab' } })
        .stdout.split('\n')
        .filter((l) => l.trim() !== '')
        .pop()
        ?.trim();
      expect(out).toBe(on ? 'BLOCK:feat/multi-tab' : 'ALLOW');
    });
  });
});

describe('post-merge branch cleanup never closes a dependent PR', () => {
  // Proven live on throwaway branches, 2026-08-30:
  //   raw `gh api -X DELETE` of a branch that is an open PR's base
  //     -> that PR gets `base_ref_deleted` + `closed`, same second. No retarget.
  //   merge-time auto-delete (delete_branch_on_merge, no explicit delete)
  //     -> that PR STAYS OPEN, retargeted. Event `automatic_base_change_succeeded`.
  // The explicit delete was the CAUSE of the orphaning, not a redundant sibling.
  //
  // Anchored FORWARD from the block start: `dispatch_close_beads` also appears
  // earlier in the file (its own definition), so a bare indexOf for the end
  // marker slices backwards and yields nothing.
  const start = script.indexOf('if [ "$merged" = "true" ]');
  const postMerge = script.slice(start, script.indexOf('dispatch_close_beads', start));

  it('finds the post-merge block it means to check', () => {
    expect(postMerge.length).toBeGreaterThan(100);
    expect(postMerge).toContain('-X DELETE');
  });

  it('checks whether the ref still exists before deleting anything', () => {
    // If the merge already removed it, GitHub has retargeted the children and
    // there is nothing left to do.
    expect(postMerge).toMatch(
      /if ! \$GH_CLI api "repos\/\$\{REPO\}\/git\/refs\/heads\/\$\{PR_HEAD_REF\}"/,
    );
  });

  it('re-checks for children and refuses to delete when any exist', () => {
    expect(postMerge).toContain('would_orphan_children');
    expect(postMerge).toMatch(/NOT deleting/);
  });

  it('never calls the raw delete unconditionally', () => {
    const deleteAt = postMerge.indexOf('-X DELETE');
    const guardAt = postMerge.indexOf('would_orphan_children');
    expect(guardAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(guardAt);
  });
});

describe('merge_pr wiring', () => {
  // Comment-stripped: these assertions are about the order code EXECUTES in, and
  // the surrounding comments legitimately mention the same identifiers (the
  // guard block's own comment names wait_for_mergeable). Matching prose would
  // make every ordering check meaningless.
  const mergeFn = script
    .slice(script.indexOf('merge_pr() {'), script.indexOf('$GH_CLI pr merge'))
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('finds the guard calls it means to order', () => {
    // Guards the parser itself — a slice that matched nothing would make every
    // ordering assertion below vacuously pass.
    expect(mergeFn).toContain('has_do_not_merge_label');
    expect(mergeFn).toContain('wait_for_mergeable');
  });

  it('runs all three guards before the merge, not after', () => {
    for (const guard of ['stacked_base_violation', 'unmet_dependencies', 'would_orphan_children']) {
      expect(mergeFn).toContain(guard);
    }
  });

  it('guards the merge before wait_for_mergeable, so a blocked PR skips the poll', () => {
    expect(mergeFn.indexOf('would_orphan_children')).toBeLessThan(
      mergeFn.indexOf('wait_for_mergeable'),
    );
  });
});
