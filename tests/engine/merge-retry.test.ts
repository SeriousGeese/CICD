import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, type Harness } from '../harness/engine.js';

/**
 * merge_pr's merge retry — ported from DnD's prReviewMergeRetry.
 *
 * THE INCIDENT, run 33329508795 attempt 1, PR #2713:
 *
 *   19:09:37  CI: ALL CHECKS PASSED
 *   19:09:37  CI all green - merging PR #2713
 *   19:09:39  Mergeability: UNSTABLE after 0s
 *   19:09:42  GraphQL: Base branch was modified. Review and try the merge again.
 *   19:09:42  === PR Auto-Review Complete: #2713 -> blocked ===
 *
 * wait_for_mergeable SUCCEEDED — it returned 0 on its very first read. The
 * refusal came from the mergePullRequest mutation three seconds later, because
 * `main` advanced in between. The run terminated as `blocked` and nothing ever
 * retried; a human `gh run rerun` merged it minutes later, unchanged.
 *
 * `mergeStateStatus` is computed ASYNCHRONOUSLY by GitHub, so a "mergeable"
 * verdict is never a guarantee that the following mutation succeeds. The gap
 * cannot be closed by reading harder — only by retrying the mutation, which is
 * what GitHub's own error text ("Review and try the merge again") asks for.
 *
 * Structural in a bulk flow: readying N PRs together means every merge
 * invalidates the base of every other open PR, so the slowest review in a batch
 * is the most likely to lose. That batch merged five; the fifth lost.
 *
 * THE RETRY IS THE DANGEROUS KIND OF FIX, so most of this file is about what it
 * must NOT do: never retry a durable refusal, never outlive its budget, never
 * hoist the do-not-merge lookup out of the loop, and never re-fire without
 * re-reading mergeability. A wrongly-retried merge is far worse than a stuck PR,
 * which the next review picks up on its own.
 */

const script = readFileSync(enginePath, 'utf8');

const BASE_MODIFIED =
  'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)';

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({
    prNumber: 8421,
    // Scripted per call shape. Like the real gh it fails without a repo, so a
    // call that forgets --repo is caught here rather than in production.
    //   STUB_MERGE_FAILURES  how many leading `pr merge` calls refuse
    //   STUB_MERGE_ERROR     the refusal text (default: base branch was modified)
    //   STUB_MERGE_STATES    comma-separated mergeStateStatus sequence
    //   STUB_PR_STATE        what `pr view --json state` reports
    //   STUB_LABELS          labels on the first lookup
    //   STUB_LABELS_AFTER    labels from the SECOND lookup on (a human labelling
    //                        the PR while the bot is mid-retry)
    //   STUB_LABELS_FAIL     make the label lookup error, to prove fail-closed
    ghScript: `
case " $* " in
  *" --repo "*) ;;
  *"repos/"*) ;;
  *) echo "failed to run git: fatal: not a git repository" >&2; exit 1 ;;
esac

bump() { # $1 = counter name -> echoes the new count
  local f="$STATE_DIR/$1" n
  n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$f"
  echo "$n"
}

if [ "$1" = "workflow" ]; then exit 0; fi

if [ "$1" = "api" ]; then
  case " $* " in
    *"--jq .default_branch"*) printf 'main'; exit 0 ;;
    *"git/refs/heads/"*) exit 1 ;;   # already removed by delete_branch_on_merge
  esac
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf ''; exit 0; fi

if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  n="$(bump merge-calls)"
  if [ "$n" -gt "\${STUB_MERGE_CALL_CAP:-12}" ]; then
    # Boundedness net. MERGE_MAX_ATTEMPTS is what stops merge_pr; if it ever
    # stopped stopping it, a sleep-neutralised merge_pr would spin at full speed
    # and the ONLY thing to notice would be a wall-clock timeout — an assertion
    # whose verdict depends on how busy the machine is. So the stub COUNTS
    # instead: past the cap it answers with a NON-retryable refusal (so the loop
    # terminates deterministically, in CPU time) and leaves a marker the spec
    # turns into a named failure.
    : > "$STATE_DIR/merge-cap-exceeded"
    echo "STUB: merge call cap exceeded — the retry loop is UNBOUNDED" >&2
    exit 1
  fi
  if [ "$n" -le "\${STUB_MERGE_FAILURES:-0}" ]; then
    echo "\${STUB_MERGE_ERROR:-${BASE_MODIFIED}}" >&2
    exit 1
  fi
  echo "✓ Squashed and merged pull request #8421"
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  field=""; prev=""
  for a in "$@"; do
    [ "$prev" = "--json" ] && field="$a"
    prev="$a"
  done
  case "$field" in
    labels)
      [ "\${STUB_LABELS_FAIL:-0}" = "1" ] && { echo "gh: API rate limit exceeded" >&2; exit 4; }
      n="$(bump label-calls)"
      if [ "$n" -gt 1 ] && [ -n "\${STUB_LABELS_AFTER:-}" ]; then
        printf '%s' "$STUB_LABELS_AFTER"
      else
        printf '%s' "\${STUB_LABELS:-}"
      fi ;;
    baseRefName) printf '%s' "\${STUB_BASE:-main}" ;;
    body) printf '%s' "\${STUB_BODY:-}" ;;
    state) printf '%s' "\${STUB_PR_STATE:-OPEN}" ;;
    mergeStateStatus)
      n="$(bump state-calls)"
      IFS=, read -r -a states <<< "\${STUB_MERGE_STATES:-UNSTABLE}"
      idx=$(( n - 1 ))
      [ "$idx" -ge "\${#states[@]}" ] && idx=$(( \${#states[@]} - 1 ))
      printf '%s' "\${states[$idx]}" ;;
  esac
  exit 0
fi
exit 0
`,
  });
});

afterAll(() => h.cleanup());

type Mode = 'merge' | 'retryable' | 'refused_summary' | 'metadata';

function run(mode: Mode, env: Record<string, string> = {}, messages: string[] = []) {
  // A FRESH state dir per run: every counter in the stub is a file, and a shared
  // dir would carry one case's merge-call count into the next.
  const stateDir = mkdtempSync(path.join(tmpdir(), 'cicd-merge-retry-'));
  const commentFile = path.join(stateDir, 'comment.md');

  const bodies: Record<Mode, string> = {
    merge: `
rc=0
merge_pr >/dev/null 2>&1 || rc=$?
echo "rc=$rc"
echo "merge_calls=$(cat "$STATE_DIR/merge-calls" 2>/dev/null || echo 0)"
echo "attempts=$MERGE_ATTEMPTS_MADE"
echo "hold_label=\${HOLD_LABEL:-none}"
echo "error=$(merge_error_oneline)"
`,
    // Every message classified in ONE bash invocation. The predicate is a pure
    // string test, so a process per message buys no isolation — only spawns,
    // which are the largest wall-clock item here and the thing machine
    // contention multiplies. One verdict per line, in argument order.
    retryable: messages
      .map(
        (m) =>
          `if is_retryable_merge_error ${JSON.stringify(m)}; then echo RETRY; else echo TERMINAL; fi`,
      )
      .join('\n'),
    refused_summary: `
rc=0
merge_pr >/dev/null 2>&1 || rc=$?
echo "rc=$rc"
merge_refused_message
echo
`,
    metadata: `
rc=0
merge_pr >/dev/null 2>&1 || rc=$?
generate_comment "Review complete." blocked 1 >/dev/null
grep -E '^  merge_(attempts|error):' "$COMMENT_FILE"
`,
  };

  const out = h.run({
    body: `COMMENT_FILE="${commentFile.split(path.sep).join('/')}"\n${bodies[mode]}`,
    env: {
      STATE_DIR: stateDir,
      AUTOMERGE_AUTHORS: 'tester',
      // Real values are 3 attempts / 15s / 60s / 15s / 300s. Kept tiny so the
      // arithmetic is easy to follow; with sleep neutralised they buy no
      // wall-clock saving either way.
      MERGE_MAX_ATTEMPTS: '3',
      MERGE_RETRY_INTERVAL: '1',
      MERGE_RETRY_MERGEABLE_TIMEOUT: '2',
      MERGEABLE_POLL_INTERVAL: '1',
      MERGEABLE_POLL_TIMEOUT: '3',
      ...env,
    },
  }).stdout;

  if (existsSync(path.join(stateDir, 'merge-cap-exceeded'))) {
    throw new Error(
      `merge_pr made more than ${env.STUB_MERGE_CALL_CAP ?? 12} merge attempts — the retry ` +
        `loop is UNBOUNDED. MERGE_MAX_ATTEMPTS is no longer stopping it.`,
    );
  }
  return { out, stateDir };
}

const fields = (out: string) =>
  Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter((l) => /^[a-z_]+=/.test(l))
      .map((l) => l.split('=') as [string, string])
      .map(([k, ...v]) => [k, v.join('=')]),
  ) as Record<string, string>;

describe('is_retryable_merge_error', () => {
  it('retries the confirmed transient refusal', () => {
    // GitHub's own text: "Review and try the merge again."
    expect(run('retryable', {}, [BASE_MODIFIED]).out.trim()).toBe('RETRY');
  });

  it('is terminal for every refusal that describes a durable property of the PR', () => {
    // Each is either unchanged by a retry, or ambiguous between transient and
    // durable — and a wrongly-retried merge is far worse than a stuck PR.
    const messages = [
      'GraphQL: Pull Request is not mergeable (mergePullRequest)',
      'GraphQL: Changes must be made through a pull request. (mergePullRequest)',
      'GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)',
      'GraphQL: Required status check "e2e (Playwright)" is expected. (mergePullRequest)',
      'gh: Resource not accessible by integration (HTTP 403)',
      'merge commit cannot be cleanly created',
      'base branch policy prohibits the merge',
    ];
    const verdicts = run('retryable', {}, messages).out.trim().split('\n');
    // Paired with its message so a failure names WHICH refusal was misclassified.
    expect(messages.map((m, i) => [m, verdicts[i]])).toEqual(messages.map((m) => [m, 'TERMINAL']));
  });

  it("matches on GitHub's phrase, so the predicate is one message wide", () => {
    // A substring test against GitHub's own wording. Pin the phrase itself:
    // widening it later (to "not mergeable", say) would start retrying refusals
    // that are durable properties of the PR.
    expect(script).toContain("MERGE_RETRYABLE_ERROR='Base branch was modified'");
    const fn = script.slice(
      script.indexOf('is_retryable_merge_error() {'),
      script.indexOf('MERGE_MAX_ATTEMPTS='),
    );
    expect(fn).toContain('$MERGE_RETRYABLE_ERROR');
    // Exactly one case arm returns 0 — no second, unaudited retryable message.
    expect(fn.match(/return 0/g)).toHaveLength(1);
  });
});

describe('the #2713 race', () => {
  it('merges on the retry after GitHub reports the base was modified', () => {
    // The whole bead: one refusal, one retry, merged. Pre-fix the run ended
    // `blocked` here and nothing ever tried again.
    const out = fields(run('merge', { STUB_MERGE_FAILURES: '1' }).out);
    expect(out.rc).toBe('0');
    expect(out.merge_calls).toBe('2');
    expect(out.attempts).toBe('2');
    expect(out.error).toBe('none');
  });

  it('merges first time when nothing races it, without a wasted attempt', () => {
    const out = fields(run('merge').out);
    expect(out.rc).toBe('0');
    expect(out.merge_calls).toBe('1');
    expect(out.attempts).toBe('1');
  });

  it('re-checks mergeability between attempts rather than blindly re-firing', () => {
    // The base moved — re-reading it is the entire point. Three mergeability
    // reads for three merge attempts.
    const { stateDir } = run('merge', { STUB_MERGE_FAILURES: '99' });
    expect(readFileSync(path.join(stateDir, 'state-calls'), 'utf8').trim()).toBe('3');
  });
});

describe('the retry is bounded', () => {
  it('terminates on an always-refusing merge instead of spinning', () => {
    const out = fields(run('merge', { STUB_MERGE_FAILURES: '99' }).out);
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('3');
    expect(out.attempts).toBe('3');
  });

  it('the unbounded-loop detector is live, and does not need a clock to fire', () => {
    // Mutation check for the NET itself. Raising MERGE_MAX_ATTEMPTS past the
    // stub's call cap models the regression the two cases around this one exist
    // to catch — a retry loop that never gives up.
    //
    // Without this, the cap is unfalsifiable scaffolding: every other case stays
    // far below it, so a cap that had stopped working would look exactly like a
    // cap that was never reached.
    expect(() =>
      run('merge', {
        STUB_MERGE_FAILURES: '99',
        MERGE_MAX_ATTEMPTS: '999',
        STUB_MERGE_CALL_CAP: '5',
      }),
    ).toThrow(/UNBOUNDED/);
  });

  it('honours a tightened attempt budget', () => {
    // Proves the bound is the constant and not an accident of the fixture.
    const out = fields(run('merge', { STUB_MERGE_FAILURES: '99', MERGE_MAX_ATTEMPTS: '1' }).out);
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('1');
  });

  it('stops at the FIRST non-retryable refusal, spending no retry budget', () => {
    const out = fields(
      run('merge', {
        STUB_MERGE_FAILURES: '99',
        STUB_MERGE_ERROR: 'GraphQL: Pull Request is not mergeable (mergePullRequest)',
      }).out,
    );
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('1');
  });

  it('treats a nonzero exit on an already-merged PR as success, not a retry', () => {
    // The PR #1124 case: the merge landed, gh still exited 1.
    const out = fields(run('merge', { STUB_MERGE_FAILURES: '99', STUB_PR_STATE: 'MERGED' }).out);
    expect(out.rc).toBe('0');
    expect(out.merge_calls).toBe('1');
    expect(out.error).toBe('none');
  });
});

describe('DIRTY stays terminal — a conflict is never retried', () => {
  it('never reaches the merge mutation when GitHub reports DIRTY', () => {
    const out = fields(run('merge', { STUB_MERGE_STATES: 'DIRTY' }).out);
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('0');
    expect(out.error).toContain('DIRTY');
    expect(out.error).toContain('conflicts with main');
  });

  it('stops the retry when the base move introduced the conflict', () => {
    // Attempt 1 sees UNSTABLE and is refused with "base branch was modified";
    // the re-check then reports DIRTY, and that is the end of it.
    const out = fields(
      run('merge', { STUB_MERGE_FAILURES: '99', STUB_MERGE_STATES: 'UNSTABLE,DIRTY' }).out,
    );
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('1');
    expect(out.error).toContain('DIRTY');
  });
});

describe('the do-not-merge label survives the retry loop', () => {
  it('still blocks a labelled PR before any merge attempt', () => {
    const out = fields(run('merge', { STUB_LABELS: 'enhancement,hold' }).out);
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('0');
    expect(out.hold_label).toBe('hold');
  });

  it('stops a retry when a human labels the PR mid-loop', () => {
    // Merge-time re-reading exists precisely because a human notices the bot is
    // about to take something AT merge time. A retry loop that hoisted the label
    // lookup out would merge past a hold added seconds earlier.
    const out = fields(
      run('merge', {
        STUB_MERGE_FAILURES: '99',
        STUB_LABELS: '',
        STUB_LABELS_AFTER: 'do-not-merge',
      }).out,
    );
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('1');
    expect(out.hold_label).toBe('do-not-merge');
  });

  it('still fails CLOSED when the labels cannot be read at all', () => {
    const out = fields(run('merge', { STUB_LABELS_FAIL: '1' }).out);
    expect(out.rc).toBe('1');
    expect(out.merge_calls).toBe('0');
    expect(out.hold_label).toBe('<label lookup failed>');
  });

  it('does not let a merge race downgrade a fail-closed lookup', () => {
    const out = fields(run('merge', { STUB_MERGE_FAILURES: '99', STUB_LABELS_FAIL: '1' }).out);
    expect(out.hold_label).toBe('<label lookup failed>');
    expect(out.merge_calls).toBe('0');
  });
});

describe('the posted comment carries the real error', () => {
  // These call merge_refused_message() directly. DnD's original lifted the
  // summary expression out of the script's `finish` call site with a regex and
  // eval'd it — which no longer parses here, because both call sites were
  // collapsed into that helper when dry-run stopped reporting fabricated
  // refusals. Calling the helper is what the regex was approximating anyway.
  it('quotes GitHub verbatim on exhaustion instead of guessing at causes', () => {
    const { out } = run('refused_summary', { STUB_MERGE_FAILURES: '99' });
    expect(out).toContain('rc=1');
    expect(out).toContain('the merge was refused after 3 merge attempt(s)');
    expect(out).toContain(BASE_MODIFIED);
    // The guess the old text opened with — a triager reading it started by
    // looking for conflicts that did not exist.
    expect(out).not.toContain('a required check not yet reported');
  });

  it('quotes the DIRTY verdict when the merge never ran', () => {
    const { out } = run('refused_summary', { STUB_MERGE_STATES: 'DIRTY' });
    expect(out).toContain('rc=1');
    expect(out).toContain('mergeStateStatus=DIRTY');
  });

  it('names the mergeability verdict when the poll simply never settled', () => {
    const { out } = run('refused_summary', { STUB_MERGE_STATES: 'BLOCKED' });
    expect(out).toContain('mergeStateStatus=BLOCKED');
  });

  it('records the attempt count and error in the metadata block', () => {
    const { out } = run('metadata', { STUB_MERGE_FAILURES: '99' });
    expect(out).toContain('merge_attempts: 3');
    expect(out).toContain('Base branch was modified');
    // Flattened to one line so it cannot break the metadata YAML.
    expect(out.match(/^ {2}merge_error:/gm)).toHaveLength(1);
  });

  it('reports no merge error at all on a clean merge', () => {
    const { out } = run('metadata');
    expect(out).toContain('merge_attempts: 1');
    expect(out).toContain('merge_error: "none"');
  });
});
