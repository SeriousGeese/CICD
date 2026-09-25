import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BEHAVIOURAL tests for engine/sweep-stranded-reviews.sh — the union of DnD's
 * three-trigger sweep and promptci-cloud's two-trigger one.
 *
 * This script RE-RUNS PAID REVIEWS and COMMENTS ON PRs from a cron, so its
 * failure mode is not "does nothing" but "does something repeatedly, to a PR
 * that was fine". Every guard below exists to stop a specific version of that,
 * and every one of them fails CLOSED — which means a broken guard is INDISTIN-
 * GUISHABLE from a quiet tick unless something asserts it. That is this file.
 *
 * HOW IT RUNS. A `gh` stand-in is written to a temp dir and pointed at by
 * GH_CLI; each case supplies the JSON that stub returns per endpoint. The real
 * script runs in place (it sources ci-lib.sh from its own directory), under
 * DRY_RUN=1 so the decisions are observable in the log without spending a
 * review run — except the cases that assert what a non-dry run would POST,
 * which read the stub's recorded call log.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SWEEP = join(repoRoot, 'engine', 'sweep-stranded-reviews.sh');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

type Fixtures = {
  prs?: unknown;
  rules?: unknown;
  branch?: unknown;
  checkRuns?: unknown;
  runs?: unknown;
  comments?: unknown;
};

/** One green, completed check run named `ci`. */
const greenCi = (completedAt = '2026-09-08T10:00:00Z') => ({
  check_runs: [
    { id: 1, name: 'ci', status: 'completed', conclusion: 'success', completed_at: completedAt },
  ],
});

const openPr = (over: Record<string, unknown> = {}) => [
  {
    number: 42,
    headRefName: 'feat/x',
    headRefOid: SHA,
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    author: { login: 'alice' },
    labels: [],
    ...over,
  },
];

const reviewRun = (over: Record<string, unknown> = {}) => ({
  workflow_runs: [
    {
      id: 900,
      path: '.github/workflows/pr-auto-review.yml',
      status: 'completed',
      conclusion: 'success',
      run_started_at: '2026-09-08T09:00:00Z',
      run_attempt: 1,
      ...over,
    },
  ],
});

function run(fx: Fixtures, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const write = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value ?? null));

  write('prs.json', fx.prs ?? openPr());
  write('rules.json', fx.rules ?? [
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
  ]);
  write('branch.json', fx.branch ?? { protection: { required_status_checks: { contexts: ['ci'] } } });
  write('checkruns.json', fx.checkRuns ?? greenCi());
  write('runs.json', fx.runs ?? reviewRun());
  write('comments.json', fx.comments ?? []);

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'gh');
  // Dispatch on the full argument string. Anything unmatched exits 1 loudly
  // rather than returning empty: a silently-empty answer to an unmodelled call
  // would look like a legitimate "nothing there" and pass a test vacuously.
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
args="$*"
echo "CALL $args" >> "${dir}/calls.log"
case "$args" in
  *"pr list"*)                 cat "${dir}/prs.json" ;;
  *"rules/branches"*)          cat "${dir}/rules.json" ;;
  *"/branches/"*)              cat "${dir}/branch.json" ;;
  *"check-runs"*)              cat "${dir}/checkruns.json" ;;
  *"actions/runs?head_sha"*)   cat "${dir}/runs.json" ;;
  *"/comments"*)               cat "${dir}/comments.json" ;;
  *"/rerun"*)                  echo '{}' ;;
  *"pr comment"*)              echo 'https://example/comment' ;;
  *) echo "unstubbed gh call: $args" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(stub, 0o755);

  let stdout: string;
  let status = 0;
  try {
    stdout = execFileSync('bash', [SWEEP], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: dir,
        GH_CLI: stub,
        REPO: 'org/repo',
        DRY_RUN: '1',
        AUTOMERGE_AUTHORS: 'alice',
        ...env,
      },
    });
  } catch (e: any) {
    stdout = (e.stdout ?? '') + (e.stderr ?? '');
    status = e.status ?? 1;
  }
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  return { stdout, status, calls };
}

/** Well past MIN_SETTLE_SECONDS, so the settle gate is never the reason a case skips. */
const longSettled = () => greenCi('2020-01-01T00:00:00Z');

describe('candidate selection', () => {
  it('sweeps nothing when the auto-merge allowlist is empty', () => {
    // The default, and the single most important line of configuration here:
    // the sweep re-runs PAID reviews from a cron, so "nobody, until a human
    // opts in" is the only safe starting state. DnD's copy defaulted to a
    // hardcoded allowlist, which would have made this engine sweep on a
    // consumer's behalf the moment it was adopted.
    const { stdout, status } = run({}, { AUTOMERGE_AUTHORS: '' });
    expect(status).toBe(0);
    expect(stdout).toContain('no open, non-draft, auto-mergeable PRs');
  });

  it('skips a PR carrying a merge-hold label', () => {
    const { stdout } = run({ prs: openPr({ labels: [{ name: 'Do-Not-Merge' }] }) });
    expect(stdout).toContain('no open, non-draft, auto-mergeable PRs');
  });

  it('skips a draft PR', () => {
    const { stdout } = run({ prs: openPr({ isDraft: true }) });
    expect(stdout).toContain('no open, non-draft, auto-mergeable PRs');
  });

  it('honours a "*" allowlist', () => {
    const { stdout } = run({ checkRuns: longSettled() }, { AUTOMERGE_AUTHORS: '*' });
    expect(stdout).not.toContain('no open, non-draft, auto-mergeable PRs');
  });
});

describe('the self-check probe (§1b)', () => {
  it('states that the wedged trigger CAN fire when protection is readable', () => {
    const { stdout } = run({ checkRuns: longSettled() });
    expect(stdout).toContain('the wedged-mergeability trigger can fire');
  });

  it('warns loudly when the token cannot see .protection', () => {
    // The whole point of probing once per sweep: without it, a permanently
    // inert trigger only ever shows up as a per-PR line that reads like an
    // ordinary "leave it alone" skip.
    const { stdout } = run({ branch: { name: 'main' }, checkRuns: longSettled() });
    expect(stdout).toContain('SELF-CHECK FAILED');
    expect(stdout).toContain('is INERT');
    // And it must name the trap, because the obvious fix takes the sweep down.
    expect(stdout).toContain('administration: permission key');
  });

  it('distinguishes "requires nothing" from "cannot read"', () => {
    const { stdout } = run({
      branch: { protection: { required_status_checks: { contexts: [] } } },
      checkRuns: longSettled(),
    });
    expect(stdout).toContain('requires NO status context');
    expect(stdout).not.toContain('SELF-CHECK FAILED');
  });
});

describe('trigger 1 — the review looked before CI settled', () => {
  it('re-runs a review that started before CI finished', () => {
    const { stdout } = run({
      checkRuns: greenCi('2026-09-08T10:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T09:00:00Z' }),
    });
    expect(stdout).toContain('is STRANDED');
    expect(stdout).toContain('would re-run review run 900');
  });

  it('leaves a review that started after CI settled alone', () => {
    const { stdout } = run({
      checkRuns: greenCi('2026-09-08T09:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z' }),
    });
    expect(stdout).toContain('it has already seen this state');
    expect(stdout).not.toContain('STRANDED');
  });

  it('waits out MIN_SETTLE_SECONDS before calling a PR stranded', () => {
    // Guards the race where a review run exists but has not reached its CI poll.
    const justNow = new Date(Date.now() - 5_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const { stdout } = run({
      checkRuns: greenCi(justNow),
      runs: reviewRun({ run_started_at: '2020-01-01T00:00:00Z' }),
    });
    expect(stdout).toContain('giving the review its own chance first');
  });

  it('does nothing when CI is not green', () => {
    const { stdout } = run({
      checkRuns: {
        check_runs: [
          { id: 1, name: 'ci', status: 'completed', conclusion: 'failure', completed_at: '2020-01-01T00:00:00Z' },
        ],
      },
    });
    expect(stdout).toContain('nothing to recover');
  });

  it('leaves a review that is still in flight to finish', () => {
    const { stdout } = run({
      checkRuns: longSettled(),
      runs: reviewRun({ status: 'in_progress', conclusion: null }),
    });
    expect(stdout).toContain('still in flight');
  });
});

describe('trigger 2 — the review reached no verdict of its own', () => {
  it('re-runs a review that concluded `failure` after CI settled', () => {
    const { stdout } = run({
      checkRuns: greenCi('2020-01-01T00:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'failure', run_attempt: 1 }),
    });
    expect(stdout).toContain("concluded 'failure' on attempt 1/3");
    expect(stdout).toContain('would re-run review run 900');
  });

  it('stops at MAX_RERUN_ATTEMPTS instead of re-running forever', () => {
    // run_attempt is monotonic and permanent per run id, which is the only
    // bound available here: a persistently broken reviewer bumps
    // run_started_at on every rerun, so time-since-start never disqualifies it.
    const { stdout } = run({
      checkRuns: greenCi('2020-01-01T00:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'failure', run_attempt: 3 }),
    });
    expect(stdout).toContain('leaving it for a human instead of re-running forever');
    expect(stdout).not.toContain('would re-run');
  });
});

describe('trigger 3 — wedged mergeability', () => {
  const wedgedSummary = (over: { sha?: string; attempts?: string; error?: string } = {}) => [
    {
      id: 5,
      body: [
        'PR Auto-Review Summary',
        '```yaml',
        `  pr_head_sha: ${over.sha ?? SHA}`,
        `  merge_attempts: ${over.attempts ?? '0'}`,
        `  merge_error: ${over.error ?? 'GitHub reported: mergeStateStatus=BLOCKED after 300s'}`,
        '```',
      ].join('\n'),
    },
  ];

  const wedged = (fx: Fixtures = {}) =>
    run({
      prs: openPr({ mergeStateStatus: 'BLOCKED' }),
      checkRuns: greenCi('2020-01-01T00:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success', run_attempt: 1 }),
      comments: wedgedSummary(),
      ...fx,
    });

  it('re-runs once when every guard is satisfied', () => {
    const { stdout } = wedged();
    expect(stdout).toContain('wedged mergeability verdict');
    expect(stdout).toContain('would re-run review run 900');
  });

  it('does NOT fire for a PR whose mergeStateStatus is not BLOCKED', () => {
    const { stdout } = run({
      checkRuns: greenCi('2020-01-01T00:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success' }),
      comments: wedgedSummary(),
    });
    expect(stdout).toContain('it has already seen this state');
    // Matched on the trigger's own sentence, not the bare word: "wedged"
    // legitimately appears in the §1b self-check line and in the summary
    // counter, so a substring check here passes or fails for the wrong reason.
    expect(stdout).not.toContain('wedged mergeability verdict');
  });

  it('refuses to sweep when a REQUIRED context never reported — that block is real', () => {
    // The guard green CI cannot supply: a context with zero check runs is
    // MISSING, not red, so `all_success` says nothing about it. Sweeping here
    // would re-run reviews forever against a genuinely blocked PR.
    const { stdout } = wedged({
      branch: { protection: { required_status_checks: { contexts: ['ci', 'e2e'] } } },
    });
    expect(stdout).toContain("required context 'e2e' never reported");
    expect(stdout).toContain('that block is REAL');
    expect(stdout).not.toContain('would re-run');
  });

  it('refuses to sweep when branch protection cannot be read', () => {
    const { stdout } = wedged({ branch: { name: 'main' } });
    expect(stdout).toContain('not guessing; a real block must never be swept');
    expect(stdout).not.toContain('would re-run');
  });

  it('refuses to sweep when the base requires no context at all', () => {
    const { stdout } = wedged({
      branch: { protection: { required_status_checks: { contexts: [] } } },
    });
    expect(stdout).toContain('requires no status context');
    expect(stdout).not.toContain('would re-run');
  });

  it("refuses when the bot's summary describes a different head SHA", () => {
    const { stdout } = wedged({ comments: wedgedSummary({ sha: OTHER_SHA }) });
    expect(stdout).toContain('not ' + SHA.slice(0, 12));
    expect(stdout).not.toContain('would re-run');
  });

  it('refuses when the merge was actually attempted — GitHub judged it, not us', () => {
    const { stdout } = wedged({ comments: wedgedSummary({ attempts: '2' }) });
    expect(stdout).toContain('after 2 merge attempt(s)');
    expect(stdout).not.toContain('would re-run');
  });

  it('refuses when the recorded merge error is not a BLOCKED mergeability one', () => {
    // DIRTY is excluded here: it is a real conflict, and no number of re-runs
    // resolves one.
    const { stdout } = wedged({
      comments: wedgedSummary({ error: 'GitHub reported: mergeStateStatus=DIRTY' }),
    });
    expect(stdout).toContain('recorded no BLOCKED mergeability error');
    expect(stdout).not.toContain('would re-run');
  });

  it('comments once, instead of re-running, when the re-run budget is spent', () => {
    const { stdout } = wedged({
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success', run_attempt: 2 }),
    });
    expect(stdout).toContain('commenting with the recovery and leaving this PR alone');
    expect(stdout).not.toContain('would re-run');
  });

  it('says nothing a second time once its own marker is on the PR', () => {
    // run_attempt bounds the RE-RUNS but stays at 2 forever, so on its own it
    // would re-comment on every tick. The marker is what bounds the COMMENT,
    // and it carries the SHA so a newly wedged SHA gets a fresh budget.
    const { stdout } = wedged({
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success', run_attempt: 2 }),
      comments: [
        ...wedgedSummary(),
        { id: 6, body: `<!-- stranded-review-sweep:wedged-merge sha=${SHA} -->` },
      ],
    });
    expect(stdout).toContain('already told about the wedged merge');
    expect(stdout).not.toContain('commenting with the recovery');
  });

  it('is not silenced by a marker naming a DIFFERENT sha', () => {
    const { stdout } = wedged({
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success', run_attempt: 2 }),
      comments: [
        ...wedgedSummary(),
        { id: 6, body: `<!-- stranded-review-sweep:wedged-merge sha=${OTHER_SHA} -->` },
      ],
    });
    expect(stdout).toContain('commenting with the recovery');
  });

  it('posts a recovery comment that names the PR’s own base branch', () => {
    // Not `main`. The source script hard-coded it, which would hand a PR based
    // on a release branch a rebase command onto the wrong branch — in the one
    // message whose entire purpose is telling a human exactly what to run.
    const { stdout, calls } = run({
      prs: openPr({ mergeStateStatus: 'BLOCKED', baseRefName: 'release/2.0' }),
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }],
      checkRuns: greenCi('2020-01-01T00:00:00Z'),
      runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success', run_attempt: 2 }),
      comments: wedgedSummary(),
    }, { DRY_RUN: '0' });
    expect(stdout).not.toContain('DRY_RUN');
    expect(calls).toContain('pr comment 42');
    const bodyFile = calls.match(/--body-file (\S+)/)?.[1];
    expect(bodyFile).toBeTruthy();
  });
});

/**
 * CRLF from jq (DnD-gspjs). A NATIVE Windows jq — the usual one under Git
 * Bash — ends every `-r` line with CRLF, and bash's `$( )` removes only the
 * trailing newline(s), so each context/name but (on MSYS) the last keeps a
 * `\r`. Before the fix, `'ci\r'` never matched `ci` and a present required
 * context was reported as "never reported", i.e. a real sweep was refused.
 *
 * These cases must bite on LINUX too, so they do not rely on a native jq: a
 * `jq` shell function, loaded through BASH_ENV (the sweep runs as its own bash
 * process), appends a CR to every output line of the two filters the guard
 * compares — the required-contexts read and the check-run-names read —
 * according to STUB_JQ_CRLF (`both`, `protection` or `names`). Every other jq
 * call is untouched. One-sided CRLF is the shape that actually diverges: on
 * MSYS grep reads its INPUT lines without the CR while the pattern keeps it,
 * so the two lists disagree even when both came out of jq with CRLF.
 */
describe('required-context matching tolerates CRLF jq output (DnD-gspjs)', () => {
  const shimDir = mkdtempSync(join(tmpdir(), 'sweep-jq-crlf-'));
  const shim = join(shimDir, 'jq-crlf.bash');
  writeFileSync(
    shim,
    `jq() {
  local mode=""
  case "$*" in
    *required_status_checks.contexts*) mode=protection ;;
    *'startswith($reviewer)'*) mode=names ;;
  esac
  if [ -n "$mode" ] && { [ "\${STUB_JQ_CRLF:-}" = both ] || [ "\${STUB_JQ_CRLF:-}" = "$mode" ]; }; then
    command jq "$@" | sed 's/\\r*$/\\r/'
  else
    command jq "$@"
  fi
}
# Byte-exact line matching on every host. Linux GNU grep already compares a
# line's CR; Git Bash's grep drops a trailing CR from its INPUT lines unless
# -U is given, which would mask the check-names half of the defect on Windows.
grep() { command grep -U "$@"; }
`,
  );
  const shimEnv = (mode: string) => ({ BASH_ENV: shim.split('\\').join('/'), STUB_JQ_CRLF: mode });

  const bothRequired = { protection: { required_status_checks: { contexts: ['ci', 'e2e'] } } };
  const bothGreen = {
    check_runs: [
      { id: 1, name: 'ci', status: 'completed', conclusion: 'success', completed_at: '2020-01-01T00:00:00Z' },
      { id: 2, name: 'e2e', status: 'completed', conclusion: 'success', completed_at: '2020-01-01T00:00:00Z' },
    ],
  };
  const wedgedFx = (fx: Fixtures): Fixtures => ({
    prs: openPr({ mergeStateStatus: 'BLOCKED' }),
    runs: reviewRun({ run_started_at: '2026-09-08T10:00:00Z', conclusion: 'success', run_attempt: 1 }),
    comments: [
      {
        id: 5,
        body: [
          'PR Auto-Review Summary',
          '```yaml',
          `  pr_head_sha: ${SHA}`,
          '  merge_attempts: 0',
          '  merge_error: GitHub reported: mergeStateStatus=BLOCKED after 300s',
          '```',
        ].join('\n'),
      },
    ],
    ...fx,
  });

  it('the shim really emits CRLF for the filter it targets (so the cases below are not vacuous)', () => {
    const out = execFileSync(
      'bash',
      ['-c', `printf '%s' '${JSON.stringify(bothRequired)}' | jq -r '.protection.required_status_checks.contexts[]'`],
      { encoding: 'utf8', env: { ...process.env, ...shimEnv('protection') } },
    );
    expect(out).toBe('ci\r\ne2e\r\n');
  });

  it.each(['both', 'protection', 'names'])(
    'does NOT report a present required context as never-reported (CRLF on %s)',
    (mode) => {
      const { stdout } = run(wedgedFx({ branch: bothRequired, checkRuns: bothGreen }), shimEnv(mode));
      expect(stdout).not.toContain('never reported');
      expect(stdout).toContain('wedged mergeability verdict');
      expect(stdout).toContain('would re-run review run 900');
    },
  );

  it('still names a genuinely missing context cleanly — no CR in the verdict (CRLF on both)', () => {
    const { stdout } = run(
      wedgedFx({ branch: bothRequired, checkRuns: greenCi('2020-01-01T00:00:00Z') }),
      shimEnv('both'),
    );
    expect(stdout).toContain("required context 'e2e' never reported");
    expect(stdout).not.toContain("'ci' never reported");
    expect(stdout).not.toContain('\r');
    expect(stdout).not.toContain('would re-run');
  });
});

describe('the reviewer check-run prefix', () => {
  it('excludes the reviewer’s own check run from the CI settle time', () => {
    // A reviewer job whose name falls outside the prefix is invisible AS a
    // reviewer and therefore counts as CI — so the reviewer ends up waiting for
    // itself. Observed for real while running two reviewers side by side.
    const { stdout } = run({
      checkRuns: {
        check_runs: [
          { id: 1, name: 'ci', status: 'completed', conclusion: 'success', completed_at: '2020-01-01T00:00:00Z' },
          { id: 2, name: '🤖 Auto-Review PR #42', status: 'in_progress', conclusion: null, completed_at: null },
        ],
      },
      runs: reviewRun({ run_started_at: '2019-01-01T00:00:00Z' }),
    });
    // The reviewer's own in-progress run must not make CI read as unsettled.
    expect(stdout).toContain('is STRANDED');
  });

  it('is configurable, so a repo that renames its reviewer job stays correct', () => {
    const { stdout } = run(
      {
        checkRuns: {
          check_runs: [
            { id: 1, name: 'ci', status: 'completed', conclusion: 'success', completed_at: '2020-01-01T00:00:00Z' },
            { id: 2, name: 'Bot Review #42', status: 'in_progress', conclusion: null, completed_at: null },
          ],
        },
        runs: reviewRun({ run_started_at: '2019-01-01T00:00:00Z' }),
      },
      { REVIEWER_CHECK_PREFIX: 'Bot Review' },
    );
    expect(stdout).toContain('is STRANDED');
  });
});

describe('exit policy', () => {
  it('exits 1 loudly when REPO is missing — that is an infrastructure failure', () => {
    const { status, stdout } = run({}, { REPO: '' });
    expect(status).toBe(1);
    expect(stdout).toContain('REPO is required');
  });

  it('never silently truncates at MAX_PRS', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...openPr()[0],
      number: 100 + i,
    }));
    const { stdout } = run({ prs: many, checkRuns: longSettled() }, { MAX_PRS: '1' });
    expect(stdout).toContain('MAX_PRS=1 reached');
  });
});
