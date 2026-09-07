import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Differential test: DnD's inline-jq `check_ci_status()` vs the `ci-status.jq`
 * delegation that replaces it.
 *
 * This is the highest-risk single edit in the consolidation. `check_ci_status`
 * decides whether a PR merges; DnD's version is 198 lines of jq grown over years
 * of incidents, and promptci-cloud's is 39 lines delegating to a jq program grown
 * over a *different* set of incidents. Reading both and concluding "these look
 * equivalent" is not a standard worth swapping on, so instead both are run over
 * the same fixtures and their outputs compared field by field.
 *
 * Contract being pinned: for every field DnD's version emits, the replacement
 * emits the same value. The replacement additionally emits `required_missing`,
 * `required_not_passing` and `skipped`, which DnD's has no concept of — a strict
 * superset, so no consumer of the old output can observe a difference.
 *
 * Deliberately NOT asserted: identical behaviour on the supersession path. Both
 * call `superseded_check_suites()` and re-parse, but the re-parse guard differs
 * (Cloud keeps the first parse when the re-parse comes back `api_failed`; DnD
 * does not). Cloud's is strictly safer — DnD's can turn a SHA with a known
 * failure into an all-zeros "zero checks" reading — so that difference is an
 * intended improvement rather than a regression, and it is covered separately.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, '..', '..', 'engine');
const legacyPath = path.join(here, 'legacy', 'check-ci-status.legacy.sh');
const posix = (p: string) => p.split(path.sep).join('/');

let dir: string;
let ghStub: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cicd-ccs-equiv-'));
  // WORK_DIR must NOT be `dir`: the engine's `trap cleanup EXIT` deletes WORK_DIR,
  // which would take the harnesses and the gh stub with it on the first run.
  mkdirSync(path.join(dir, 'work'), { recursive: true });
  ghStub = path.join(dir, 'gh');
  writeFileSync(
    ghStub,
    `#!/usr/bin/env bash
case " $* " in
  *"/check-runs"*)
    if [ "\${STUB_CHECKS_RC:-0}" != "0" ]; then
      echo "gh: Internal Server Error (HTTP 500)" >&2
      exit "$STUB_CHECKS_RC"
    fi
    printf '%s' "\${STUB_CHECKS:-}"
    exit 0
    ;;
  *"/actions/runs"*)
    printf '%s' '{"workflow_runs":[]}'
    exit 0
    ;;
  *"/rules/branches/"*)
    printf '%s' '[]'
    exit 0
    ;;
  *)
    echo "gh-stub: unexpected call: $*" >&2
    exit 1
    ;;
esac
`,
    'utf8',
  );
  chmodSync(ghStub, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One `--paginate` page of check-runs, as the real endpoint emits it. */
function page(runs: unknown[]): string {
  return JSON.stringify({ total_count: runs.length, check_runs: runs });
}

function run(
  name: string,
  status: string,
  conclusion: string | null,
  id = Math.floor(Math.random() * 1e6),
  suiteId = 1,
) {
  return { id, name, status, conclusion, check_suite: { id: suiteId } };
}

/** Run one implementation against a fixture and return its parsed verdict. */
function verdict(impl: 'legacy' | 'current', checks: string, rc = 0, strict = true): Verdict {
  const harness = path.join(dir, `h-${impl}-${Math.random().toString(36).slice(2)}.sh`);
  // The legacy copy is a bare function body, so it needs the engine sourced first
  // for log()/annotate()/superseded_check_suites(); defining it AFTER the source
  // overrides the current implementation of the same name.
  const overlay = impl === 'legacy' ? `source "${posix(legacyPath)}"\n` : '';
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
export PR_NUMBER=1 PR_HEAD_REF=x PR_BASE_REF=main PR_AUTHOR=t
export PR_TITLE=t PR_BODY=""
export REPO=SeriousGeese/CICD WORK_DIR="${posix(path.join(dir, 'work'))}"
export GH_TOKEN=fake GITHUB_OUTPUT=/dev/null
export HEAD_SHA=deadbeefcafe BASE_SHA=bbbbbbbbbbbb GITHUB_RUN_ID=1
export PR_REVIEW_LIBRARY_MODE=1
export CICD_STRICT_SKIPPED="${strict ? 'true' : 'false'}"
export PATH="${posix(dir)}:$PATH"
# shellcheck source=/dev/null
source "${posix(path.join(engineDir, 'pr-review.sh'))}"
cleanup() { :; }   # the EXIT trap would remove WORK_DIR mid-suite
GH_CLI=gh
${overlay}check_ci_status deadbeefcafe 2>/dev/null
`,
    'utf8',
  );
  chmodSync(harness, 0o755);
  const r = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: { ...process.env, STUB_CHECKS: checks, STUB_CHECKS_RC: String(rc) },
  });
  const out = (r.stdout ?? '').trim();
  try {
    return JSON.parse(out) as Verdict;
  } catch {
    throw new Error(`${impl} produced unparseable output (rc=${r.status}): ${out || r.stderr}`);
  }
}

type Verdict = Record<string, unknown>;

/** Fields DnD's implementation always emits — these must match exactly. */
const SHARED_FIELDS = [
  'total',
  'completed',
  'success',
  'failures',
  'failure_names',
  'failure_suites',
  'neutral',
  'unresolved',
  'unresolved_names',
  'all_completed',
  'all_success',
  'pending',
];

/**
 * `api_failed` is compared by MEANING, not identity, and that is a real
 * difference rather than a fudge: the legacy version emits the key only on the
 * failure path, while the replacement always emits it. Every consumer reads it
 * through jq, where an absent key is `null` and therefore falsy in exactly the
 * same way `false` is — so the two are indistinguishable downstream. On the
 * failure path both emit `true`, which the api-failure case below pins directly.
 */
const apiFailed = (v: Verdict) => v.api_failed === true;

const CASES: Array<{ name: string; checks: string; rc?: number }> = [
  {
    name: 'all green',
    checks: page([run('ci', 'completed', 'success'), run('e2e', 'completed', 'success')]),
  },
  {
    name: 'one hard failure',
    checks: page([run('ci', 'completed', 'failure'), run('e2e', 'completed', 'success')]),
  },
  {
    name: 'still pending',
    checks: page([run('ci', 'in_progress', null), run('e2e', 'completed', 'success')]),
  },
  {
    name: 'neutral and skipped are not failures',
    checks: page([run('ci', 'completed', 'neutral'), run('e2e', 'completed', 'skipped')]),
  },
  {
    name: 'cancelled with no rerun is unresolved, not a pass',
    checks: page([run('ci', 'completed', 'cancelled'), run('e2e', 'completed', 'success')]),
  },
  {
    name: 'timed_out and action_required',
    checks: page([run('ci', 'completed', 'timed_out'), run('e2e', 'completed', 'action_required')]),
  },
  {
    name: 'duplicate names — only the newest run of each counts',
    // The draft->ready and cancel-in-progress reruns both produce this shape.
    checks: page([
      run('ci', 'completed', 'failure', 100),
      run('ci', 'completed', 'success', 200),
      run('e2e', 'completed', 'success', 300),
    ]),
  },
  {
    name: 'the bot ignores its own check',
    checks: page([run('🤖 Auto-Review PR', 'completed', 'failure'), run('ci', 'completed', 'success')]),
  },
  {
    name: 'zero checks',
    checks: page([]),
  },
  {
    name: 'multiple pages (the silent-truncation path)',
    checks: `${page([run('ci', 'completed', 'success', 1)])}\n${page([run('e2e', 'completed', 'failure', 2)])}`,
  },
  {
    name: 'api failure',
    checks: '',
    rc: 1,
  },
];

describe('check_ci_status: ci-status.jq delegation matches DnD inline jq', () => {
  for (const c of CASES) {
    it(`agrees on: ${c.name}`, () => {
      // strict-skipped ON is the DnD-preserving profile, which is what
      // equivalence with DnD's implementation means.
      const legacy = verdict('legacy', c.checks, c.rc ?? 0);
      const current = verdict('current', c.checks, c.rc ?? 0, true);
      for (const f of SHARED_FIELDS) {
        expect(current[f], `field '${f}' differs on "${c.name}"`).toStrictEqual(legacy[f]);
      }
      expect(apiFailed(current), `api_failed differs on "${c.name}"`).toBe(apiFailed(legacy));
    });
  }

  it('DIVERGES on a non-required skipped check when strict-skipped is OFF', () => {
    // The one real behavioural difference found by this suite, pinned so it can
    // never be reintroduced silently in either direction.
    //
    // DnD's rule: ANY skipped check is unresolved -> blocks.
    // ci-status.jq's rule: a skipped check is a PASS unless its name is a
    // REQUIRED context. Strictly more precise — and strictly more dangerous when
    // the required set is empty, which is exactly what required_contexts() yields
    // when it fails open. A repo without an aggregate `gate` job should stay
    // strict until it has one.
    const checks = page([run('lint', 'completed', 'skipped'), run('ci', 'completed', 'success')]);
    const legacy = verdict('legacy', checks);
    const lenient = verdict('current', checks, 0, false);
    const strict = verdict('current', checks, 0, true);

    expect(legacy.unresolved, 'DnD blocks on any skipped check').toBe(1);
    expect(lenient.unresolved, 'jq passes a skipped NON-required check').toBe(0);
    expect(strict.unresolved, 'the flag restores DnD behaviour exactly').toBe(1);
    expect(strict.all_success).toStrictEqual(legacy.all_success);
  });

  it('emits a strict superset of the legacy fields', () => {
    const legacy = verdict('legacy', page([run('ci', 'completed', 'success')]));
    const current = verdict('current', page([run('ci', 'completed', 'success')]));
    for (const k of Object.keys(legacy)) {
      expect(Object.keys(current), `replacement dropped field '${k}'`).toContain(k);
    }
    // The three the replacement adds; no old consumer can observe them.
    expect(Object.keys(current)).toEqual(
      expect.arrayContaining(['required_missing', 'required_not_passing', 'skipped']),
    );
  });
});
