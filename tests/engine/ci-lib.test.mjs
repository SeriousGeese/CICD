import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ci-lib.sh talks to `gh`, so it is exercised the way pr-review.sh's own bash
// seams are: a stub `gh` written to a temp dir and prepended to PATH, the real
// library sourced (not reimplemented), one function called, stdout parsed.
// The stub is driven entirely by env vars so a single harness covers the
// success, API-error and empty-result paths.
// Subject lives in engine/, tests in tests/engine/ — in promptci-cloud these were
// co-located under scripts/, so the original resolved its subject as its own dir.
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');
const libPath = path.join(scriptsDir, 'ci-lib.sh');

let dir;
let ghStub;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'promptci-ci-lib-'));
  ghStub = path.join(dir, 'gh');

  writeFileSync(
    ghStub,
    `#!/usr/bin/env bash
case " $* " in
  *"/rules/branches/"*)
    if [ "\${STUB_RULES_RC:-0}" != "0" ]; then
      echo "gh: Not Found (HTTP 404)" >&2
      exit "$STUB_RULES_RC"
    fi
    printf '%s' "\${STUB_RULES:-[]}"
    exit 0
    ;;
  *"/check-runs"*)
    if [ "\${STUB_CHECKS_RC:-0}" != "0" ]; then
      echo "gh: Internal Server Error (HTTP 500)" >&2
      exit "$STUB_CHECKS_RC"
    fi
    printf '%s' "\${STUB_CHECKS:-}"
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

/** Bash-facing (forward-slash) form of a Windows path. */
const posix = (p) => p.split(path.sep).join('/');

/**
 * Run the real jq program once and return its output object, purely to read the
 * set of keys it emits. Used to pin the api_failed sentinel against the real
 * shape so the two cannot drift.
 */
function jqOutputShape() {
  const out = spawnSync(
    'jq',
    // reviewer_prefix has no in-program default (`//` is banned in that file and
    // an unbound $var is a jq compile error), so every direct caller binds it.
    ['-s', '--argjson', 'superseded', '[]', '--argjson', 'required', '[]', '--argjson', 'strict_skipped', 'false', '--arg', 'reviewer_prefix', '🤖 Auto-Review', '-f', path.join(scriptsDir, 'ci-status.jq')],
    {
      input: JSON.stringify({
        total_count: 1,
        check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', id: 1, check_suite: { id: 9 } }],
      }),
      encoding: 'utf8',
    },
  );
  if (out.status !== 0) throw new Error(`jq failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

/**
 * Source the REAL ci-lib.sh with the stub standing in for gh, then call one of
 * its functions. `set -u` mirrors pr-review.sh's own options, so a library that
 * dereferenced an unset variable would fail here rather than in production.
 */
function callLib(argv, env = {}) {
  const harness = path.join(dir, 'harness.sh');
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
set -uo pipefail
export REPO=SeriousGeese/promptci-cloud
export PATH="${posix(dir)}:$PATH"
export GH_CLI="${posix(ghStub)}"
# shellcheck source=/dev/null
source "${posix(libPath)}"
"$@"
`,
    'utf8',
  );
  chmodSync(harness, 0o755);

  const result = spawnSync('bash', [harness, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return { stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '', code: result.status };
}

describe('required_contexts (scripts/ci-lib.sh)', () => {
  it('extracts the required status check contexts from a ruleset response', () => {
    const rules = [
      { type: 'pull_request', parameters: {} },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'gate' }] },
      },
    ];
    const { stdout, stderr } = callLib(['required_contexts', 'main'], {
      STUB_RULES: JSON.stringify(rules),
    });
    expect(JSON.parse(stdout)).toEqual(['gate']);
    expect(stderr).not.toContain('falling back');
  });

  it('de-duplicates contexts repeated across rules', () => {
    const rules = [
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gate' }] } },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'gate' }, { context: 'audit' }] },
      },
    ];
    const { stdout } = callLib(['required_contexts', 'main'], { STUB_RULES: JSON.stringify(rules) });
    expect(JSON.parse(stdout)).toEqual(['audit', 'gate']);
  });

  it('falls back — loudly — when the rules API errors', () => {
    const { stdout, stderr } = callLib(['required_contexts', 'main'], { STUB_RULES_RC: '1' });
    expect(JSON.parse(stdout)).toEqual(['gate']);
    expect(stderr).toContain('falling back');
  });

  it('falls back — loudly — on an EMPTY result, which is not evidence that nothing is required', () => {
    // An empty array is equally the shape of a token that cannot see the
    // ruleset. Taking it at face value would make every skipped check a pass
    // and required_missing unreachable: precisely the fail-open this guards.
    const { stdout, stderr } = callLib(['required_contexts', 'main'], { STUB_RULES: '[]' });
    expect(JSON.parse(stdout)).toEqual(['gate']);
    expect(stderr).toContain('falling back');
  });

  it('honours REQUIRED_CHECKS_FALLBACK, split on commas and trimmed', () => {
    const { stdout } = callLib(['required_contexts', 'main'], {
      STUB_RULES_RC: '1',
      REQUIRED_CHECKS_FALLBACK: 'gate, audit ,ci',
    });
    expect(JSON.parse(stdout)).toEqual(['audit', 'ci', 'gate']);
  });
});

describe('ci_status_json (scripts/ci-lib.sh)', () => {
  const checkRunsPage = (runs) => JSON.stringify({ total_count: runs.length, check_runs: runs });

  it('pipes the paginated response through the real ci-status.jq program', () => {
    const body = checkRunsPage([
      { id: 3, name: 'auto-merge', status: 'completed', conclusion: 'success', check_suite: { id: 3 } },
      { id: 2, name: 'auto-merge', status: 'completed', conclusion: 'cancelled', check_suite: { id: 2 } },
      { id: 1, name: 'ci', status: 'completed', conclusion: 'success', check_suite: { id: 1 } },
    ]);
    const { stdout } = callLib(['ci_status_json', 'deadbeef', '[]', '["ci"]'], { STUB_CHECKS: body });
    const status = JSON.parse(stdout);
    expect(status.api_failed).toBe(false);
    expect(status.total).toBe(2);
    expect(status.unresolved).toBe(0);
    expect(status.all_success).toBe(true);
  });

  it('returns the api_failed sentinel when gh fails', () => {
    const { stdout, stderr } = callLib(['ci_status_json', 'deadbeef'], { STUB_CHECKS_RC: '1' });
    const status = JSON.parse(stdout);
    expect(status.api_failed).toBe(true);
    expect(status.all_success).toBe(false);
    expect(status.all_completed).toBe(false);
    expect(status.total).toBe(0);
    expect(stderr).toContain('CI API call failed');
  });

  it('returns the api_failed sentinel when the response is not JSON jq can parse', () => {
    const { stdout, stderr } = callLib(['ci_status_json', 'deadbeef'], { STUB_CHECKS: 'not json at all' });
    expect(JSON.parse(stdout).api_failed).toBe(true);
    expect(stderr).toContain('jq parse FAILED');
  });

  it('sentinel carries every key the jq program can emit', () => {
    // A caller doing `jq -r '.unresolved'` on a failed poll must get 0, not the
    // string "null" — `[ "null" -gt 0 ]` is a syntax error that kills the script
    // under `set -e`, so a transient API blip would abort the review instead of
    // retrying. This asserts the two key sets match EXACTLY, so a field added to
    // ci-status.jq without being added to the sentinel fails here rather than in
    // production on the one poll where it matters.
    const { stdout } = callLib(['ci_status_json', 'deadbeef'], { STUB_CHECKS_RC: '1' });
    const sentinelKeys = Object.keys(JSON.parse(stdout)).sort();

    const realKeys = Object.keys(jqOutputShape()).sort();

    expect(sentinelKeys).toEqual(realKeys);
  });

  it('sentinel numeric fields are numbers and list fields are arrays', () => {
    // Shape, not just presence: `.required_missing` must be [] rather than null
    // so `| length` works, and the counters must be 0 so numeric tests are safe.
    const { stdout } = callLib(['ci_status_json', 'deadbeef'], { STUB_CHECKS_RC: '1' });
    const s = JSON.parse(stdout);

    for (const k of ['total', 'completed', 'success', 'failures', 'neutral', 'skipped', 'unresolved']) {
      expect(typeof s[k], `${k} must be a number`).toBe('number');
    }
    for (const k of ['failure_suites', 'required_missing', 'required_not_passing']) {
      expect(Array.isArray(s[k]), `${k} must be an array`).toBe(true);
    }
    expect(s.api_failed).toBe(true);
    expect(s.all_success).toBe(false);
  });
});
