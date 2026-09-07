/**
 * The aggregate CI gate.
 *
 * Run by the `gate` job in .github/workflows/ci.yml, which is the single
 * REQUIRED status-check context on `main`. It reads the `needs` context of that
 * job (serialised into GATE_NEEDS as JSON by `toJSON(needs)`) and fails unless
 * every job named in GATE_REQUIRED_JOBS is present AND concluded `success`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS AT ALL, RATHER THAN A `needs:` LIST
 * ---------------------------------------------------------------------------
 * GitHub's own `needs:` semantics are the opposite of a gate:
 *
 *   • A dependency that is SKIPPED does not fail the dependent job — with
 *     `if: always()` the gate still runs, and `needs.e2e.result` is `'skipped'`.
 *     Left unchecked that is a rubber stamp: a PR merges with no e2e.
 *   • A required check that never REPORTS blocks the merge forever (GitHub does
 *     not synthesise a pass for a workflow that a path filter suppressed), while
 *     a required check that reports `skipped` is counted as PASSING. Those two
 *     failure modes are mirror images, and both are silent.
 *
 * So the gate treats anything that is not literally `success` as a failure, and
 * treats a required job that is absent from `needs` entirely — renamed, deleted,
 * or dropped from the gate's `needs:` list — as a failure too. "I could not see
 * it" is never "it passed".
 */

import { pathToFileURL } from 'node:url';

/** The only `needs.<job>.result` value that satisfies the gate. */
const SUCCESS = 'success';

/** Reported in place of a `result` when a required job is missing from `needs`. */
const ABSENT = 'absent';

/**
 * Pure decision function. No I/O, no process.exit — so tests can exercise every
 * conclusion (including the ones that are painful to reproduce in a real run,
 * like `cancelled`) without spawning anything.
 *
 * @param {object} args
 * @param {string | undefined} args.needsJson  Raw GATE_NEEDS (JSON from toJSON(needs)).
 * @param {string | undefined} args.requiredJobs  Raw GATE_REQUIRED_JOBS (comma-separated).
 * @returns {{ ok: boolean, errors: string[] }} `errors` are GitHub workflow-command lines.
 */
export function decideGate({ needsJson, requiredJobs }) {
  const errors = [];

  const required = String(requiredJobs ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  if (required.length === 0) {
    // A gate that requires nothing is a green rubber stamp, which is strictly
    // worse than no gate at all: the ruleset would still count it as satisfied.
    return {
      ok: false,
      errors: ['::error title=gate::GATE_REQUIRED_JOBS is empty — the gate would pass unconditionally'],
    };
  }

  let needs;
  try {
    needs = JSON.parse(String(needsJson ?? ''));
  } catch {
    return {
      ok: false,
      errors: [`::error title=gate::GATE_NEEDS is not valid JSON (got ${JSON.stringify(needsJson ?? null)})`],
    };
  }

  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return {
      ok: false,
      errors: [`::error title=gate::GATE_NEEDS is not an object (got ${JSON.stringify(needs)})`],
    };
  }

  for (const job of required) {
    // Presence check first, and deliberately with hasOwnProperty rather than a
    // truthiness test: a job that vanished from `needs` must fail loudly instead
    // of reading as `undefined` and being skipped over by the result comparison.
    const present = Object.prototype.hasOwnProperty.call(needs, job);
    const result = present ? needs[job]?.result : undefined;

    if (!present) {
      errors.push(`::error title=gate::job '${job}' concluded '${ABSENT}'`);
      continue;
    }

    if (result !== SUCCESS) {
      errors.push(`::error title=gate::job '${job}' concluded '${result ?? ABSENT}'`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} log
 * @returns {number} exit code
 */
export function runGate(env, log) {
  const { ok, errors } = decideGate({
    needsJson: env.GATE_NEEDS,
    requiredJobs: env.GATE_REQUIRED_JOBS,
  });

  for (const error of errors) log(error);

  if (!ok) {
    log('gate: FAILED — the pull request is not mergeable.');
    return 1;
  }

  log(`gate: all required jobs succeeded (${env.GATE_REQUIRED_JOBS}).`);
  return 0;
}

// CLI guard: only run when executed directly, so importing this module from a
// test does not exit the test process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runGate(process.env, (line) => console.log(line)));
}
