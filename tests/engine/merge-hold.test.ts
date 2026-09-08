import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, type Harness } from '../harness/engine.js';

/**
 * The merge-hold path — ported from DnD's prReviewMergeHold.
 *
 * has_do_not_merge_label() fails CLOSED: if it cannot read a PR's labels it
 * reports a hold rather than risk merging work a human parked. That is correct,
 * and it is exactly why a broken lookup was so dangerous — it silently held
 * EVERY PR in the repo while the posted comment still said
 * `do_not_merge_label: none`, because the metadata line re-queried later in the
 * run, from a directory where the call happened to work.
 *
 * ROOT CAUSE, and the reason the stub is shaped the way it is: `gh pr view` with
 * no `--repo` resolves the repository from the git remote of the CURRENT WORKING
 * DIRECTORY. The review workflow deliberately runs no actions/checkout, so the
 * step's cwd is not a git repo — every gh call before the script's first `cd`
 * failed and every one after it succeeded. Run 29692359992: HOLD at 15:12:22
 * (pre-cd), a clean `pr view --json commits` at 15:12:25 (post-cd), same binary
 * and same token.
 *
 * So the stub FAILS unless `--repo` is passed. Drop `--repo` from the engine and
 * these cases reproduce the outage rather than mocking it away.
 *
 * THE EXIT-STATUS CONTRACT is the other half of this file, and it is not
 * obvious: the run's status means "did the REVIEWER do its job", not "is this PR
 * fine". 10 of 10 red runs in the 2026-08-22 audit were PR-caused blocks — the
 * PR's own CI red, a do-not-merge label, a conflict, a merge race — none a
 * reviewer fault. Those stay GREEN, because the PR's own check is already red
 * and a second red says nothing new. A failed label lookup is the opposite: the
 * reviewer could not evaluate the PR, so the run must go red or the outage stays
 * invisible, which is precisely how it survived a whole batch of releases.
 */

const script = readFileSync(enginePath, 'utf8');

/** Every `$GH_CLI ...` command in the engine, with line continuations joined. */
function ghInvocations(src: string): string[] {
  const lines = src.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('$GH_CLI') || lines[i].trimStart().startsWith('#')) continue;
    let cmd = lines[i];
    while (cmd.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      cmd = `${cmd.trimEnd().slice(0, -1)} ${lines[++i].trim()}`;
    }
    found.push(cmd.trim());
  }
  return found;
}

describe('gh invocations are cwd-independent', () => {
  it('finds the gh calls it means to check', () => {
    // Guards the parser itself: a regex that silently matched nothing would make
    // the assertion below vacuously pass.
    expect(ghInvocations(script).length).toBeGreaterThanOrEqual(10);
  });

  it('passes an explicit repository to every gh call', () => {
    const offenders = ghInvocations(script).filter(
      // `gh api repos/${REPO}/...` already names the repo in the path.
      (cmd) => !cmd.includes('--repo "$REPO"') && !cmd.includes('repos/${REPO}'),
    );
    expect(offenders).toEqual([]);
  });
});

let h: Harness;
let commentFile: string;

beforeAll(() => {
  h = createEngineHarness({
    prNumber: 8351,
    // Fails without --repo exactly as the real gh does from a cwd with no git
    // remote, so the regression is reproduced rather than mocked away.
    // STUB_RC forces an unrelated hard failure (auth, network, rate limit).
    ghScript: `
case " $* " in
  *" --repo "*) ;;
  *) echo "failed to run git: fatal: not a git repository (or any of the parent directories): .git" >&2; exit 1 ;;
esac
if [ "\${STUB_RC:-0}" != "0" ]; then
  echo "\${STUB_STDERR:-gh: Bad credentials (HTTP 401)}" >&2
  exit "$STUB_RC"
fi
printf '%s' "\${STUB_LABELS:-}"
exit 0
`,
  });
  commentFile = path.join(h.dir, 'comment.md');
});

afterAll(() => h.cleanup());

const withComment = (body: string) => `COMMENT_FILE="${commentFile.split(path.sep).join('/')}"\n${body}`;

function lookup(env: Record<string, string> = {}) {
  return h.run({
    body: 'if label="$(has_do_not_merge_label)"; then echo "HOLD:${label}"; else echo NOHOLD; fi',
    env,
  }).stdout;
}

/** The verdict is the LAST line: the harness folds stderr in, and this path logs. */
const verdict = (out: string) => out.split('\n').filter((l) => l.trim() !== '').pop()?.trim() ?? '';

function comment(hold: string, result = 'commented') {
  return h.run({
    body: withComment(
      `HOLD_LABEL=${JSON.stringify(hold)}\ngenerate_comment "Review complete." ${result} 1 >/dev/null\ncat "$COMMENT_FILE"`,
    ),
  }).stdout;
}

function finish(hold: string, result = 'commented') {
  // finish() exits, so run it in a subshell — and capture its status explicitly
  // because the sourced engine leaves `set -e` on.
  return h.run({
    body: withComment(
      `HOLD_LABEL=${JSON.stringify(hold)}\nrc=0\n( finish "Review complete." ${result} 1 ) >/dev/null 2>&1 || rc=$?\necho "exit=$rc"\ngrep -E '^  (result|do_not_merge_label):' "$COMMENT_FILE"`,
    ),
  }).stdout;
}

describe('has_do_not_merge_label', () => {
  it('reports no hold when the PR has no labels', () => {
    expect(verdict(lookup({ STUB_LABELS: '' }))).toBe('NOHOLD');
  });

  it('does NOT hold a normally-labelled PR — the regression that broke auto-merge', () => {
    // Pre-fix this returned the sentinel for every PR in the repo, because the
    // lookup itself failed rather than because any hold label was present.
    expect(verdict(lookup({ STUB_LABELS: 'enhancement,size/M' }))).toBe('NOHOLD');
  });

  it('still holds on a real do-not-merge label', () => {
    expect(verdict(lookup({ STUB_LABELS: 'enhancement,hold' }))).toBe('HOLD:hold');
  });

  it('matches hold labels case-insensitively', () => {
    expect(verdict(lookup({ STUB_LABELS: 'Do-Not-Merge' }))).toBe('HOLD:do-not-merge');
  });

  it('still fails closed when the lookup genuinely errors', () => {
    // The fail-closed contract is load-bearing and had to survive the fix: a PR
    // whose labels cannot be read is never merged on the assumption it is clean.
    expect(verdict(lookup({ STUB_RC: '4', STUB_STDERR: 'gh: API rate limit exceeded' }))).toBe(
      'HOLD:<label lookup failed>',
    );
  });

  it('logs the underlying gh error instead of swallowing it', () => {
    // `2>/dev/null` on the gh call is what turned a one-line diagnosis into a
    // multi-PR investigation: the run log named the sentinel but never the cause.
    const out = lookup({ STUB_RC: '4', STUB_STDERR: 'gh: API rate limit exceeded' });
    expect(out).toContain('label lookup FAILED (rc=4)');
    expect(out).toContain('gh: API rate limit exceeded');
  });
});

describe('the posted comment', () => {
  it('surfaces a failed lookup, not just the run log', () => {
    const out = comment('<label lookup failed>');
    expect(out).toContain('Auto-merge held');
    expect(out).toContain('labels could not be read');
    // The metadata must agree with the decision that was actually made — the
    // original bug was precisely that it did not.
    expect(out).toContain('do_not_merge_label: <label lookup failed>');
    // And it must tell a human how to get unstuck.
    expect(out).toContain('gh pr merge 8351 --squash');
  });

  it('surfaces a deliberate label hold distinctly from a failed lookup', () => {
    const out = comment('do-not-merge');
    expect(out).toContain('held by the `do-not-merge` label');
    expect(out).not.toContain('labels could not be read');
    expect(out).toContain('do_not_merge_label: do-not-merge');
  });

  it('leaves an unheld run reporting no hold at all', () => {
    const out = comment('');
    expect(out).toContain('do_not_merge_label: none');
    expect(out).not.toContain('Auto-merge held');
  });

  it('gives every non-merge result the how-to-proceed footer', () => {
    for (const result of ['blocked', 'blocked_infra', 'review_failed']) {
      expect(comment('', result)).toContain('Action required — auto-merge did not happen');
    }
    expect(comment('', 'merged')).not.toContain('Action required');
  });
});

describe('the exit-status contract — "did the reviewer do its job"', () => {
  it('fails the run when a failed lookup cost a merge, so the outage is loud', () => {
    // A green check on every PR is exactly how this stayed invisible for a whole
    // batch of releases.
    const out = finish('<label lookup failed>');
    expect(out).toContain('exit=1');
    expect(out).toContain('result: held_label_lookup_failed');
  });

  it('keeps a deliberate hold green — a human parked it on purpose', () => {
    const out = finish('hold');
    expect(out).toContain('exit=0');
    expect(out).toContain('result: held_do_not_merge_label');
  });

  it('does not rewrite results that already describe a real failure', () => {
    const out = finish('<label lookup failed>', 'review_failed');
    expect(out).toContain('result: review_failed');
    expect(out).toContain('exit=1');
  });

  it('keeps a PR-caused block green', () => {
    // The PR's own check is already red; a second red says nothing new.
    const out = finish('', 'blocked');
    expect(out).toContain('result: blocked');
    expect(out).toContain('exit=0');
  });

  it('fails the run when the review could not evaluate the PR at all', () => {
    const out = finish('', 'blocked_infra');
    expect(out).toContain('result: blocked_infra');
    expect(out).toContain('exit=1');
  });

  it('still fails the run when the reviewer itself failed', () => {
    expect(finish('', 'review_failed')).toContain('exit=1');
  });
});
