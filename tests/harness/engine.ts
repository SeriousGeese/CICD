import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared harness for the BEHAVIOURAL engine specs.
 *
 * Every one of them needs the same four things — a `gh` stand-in, a scratch
 * WORK_DIR, the engine sourced in library mode, and a way to call one function
 * and read what it did — and DnD's originals each rebuilt all four inline. That
 * cost ~60 near-identical lines per file across 19 files, and the copies had
 * already drifted: some logged every gh call, some did not, so only some of them
 * could assert HOW a verdict was reached rather than merely what it was.
 *
 * TWO THINGS THIS DOES DIFFERENTLY FROM THE DnD ORIGINALS.
 *
 * 1. It sources the engine IN PLACE, via PR_REVIEW_LIBRARY_MODE=1. DnD's specs
 *    copied the script to a temp file and stripped the trailing `main "$@"` with
 *    a regex. That cannot work here: engine/pr-review.sh resolves ci-lib.sh,
 *    sanitize-secret.sh, ci-status.jq and hooks/ from its OWN directory, so a
 *    copy in a temp dir fails to source half of itself. The library-mode guard
 *    came from promptci-cloud and is the reason this port is possible at all.
 *
 * 2. It matrixes over the consumer profiles. The engine is the union of three
 *    forks and the behaviours only one repo wants sit behind CICD_FEATURE_*
 *    flags, so a spec that runs under a single implicit configuration tests one
 *    branch of the file that decides whether code merges. The interesting
 *    direction differs per flag: for a merge HOLD the danger is "off" (it stops
 *    holding); for a DISPATCH the danger is "on" in a repo that has no such
 *    workflow.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const enginePath = path.join(repoRoot, 'engine', 'pr-review.sh');
const profilesDir = path.join(repoRoot, 'tests', 'profiles');

/** Bash needs forward slashes even on Windows. */
export const posix = (p: string) => p.split(path.sep).join('/');

export const PROFILE_NAMES = ['dnd', 'cloud', 'promptci'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** Parse one tests/profiles/<name>.env into the CICD_* pairs the engine reads. */
export function profileEnv(name: ProfileName): Record<string, string> {
  const text = readFileSync(path.join(profilesDir, `${name}.env`), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(CICD_[A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\s*#.*$/, '').trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/**
 * The default `gh` stand-in: every call is recorded, and anything not explicitly
 * modelled FAILS LOUDLY.
 *
 * Returning empty for an unmodelled call is the trap — the engine reads it as a
 * legitimate "nothing there", and the spec passes for a reason that has nothing
 * to do with what it claims to test. Extra arms go in `ghArms`, which is spliced
 * in ahead of this catch-all.
 */
const DEFAULT_GH_ARMS = `
  *) echo "gh-stub: unmodelled call: $*" >&2; exit 1 ;;
`;

export type HarnessOptions = {
  /**
   * Must be unique per spec FILE. The engine derives /tmp scratch paths from it
   * and vitest runs files in parallel, so two suites sharing a number will
   * clobber each other's comment file — intermittently, and only under load.
   */
  prNumber: number;
  /** Extra `case "$*" in` arms for the gh stub, spliced before the catch-all. */
  ghArms?: string;
  /**
   * Replace the stub's dispatch entirely, for the specs whose `gh` has to look
   * at argument POSITIONS rather than the flattened `$*` — anything reading
   * `--json <field>`, say. Call logging still happens first either way, because
   * asserting HOW a verdict was reached is most of the value of these specs.
   */
  ghScript?: string;
  /** Extra env every run gets, before per-run env and the profile. */
  env?: Record<string, string>;
};

export type RunOptions = {
  /** Bash to execute after the engine is sourced. */
  body: string;
  env?: Record<string, string>;
  /** Load this profile's CICD_* settings. Omit to run under engine defaults. */
  profile?: ProfileName;
  /** Directory to cd into before `body`. Defaults to WORK_DIR. */
  cwd?: string;
};

export type RunResult = {
  stdout: string;
  status: number;
  /** One entry per gh invocation, so a spec can assert HOW a verdict was reached. */
  calls: string[];
};

/**
 * Thrown when engine code reached the OS `gh` instead of $GH_CLI.
 *
 * Generalised from DnD's prReviewHeldRuns, which was the only spec that had it.
 * Overriding $GH_CLI proves hermeticity only for call sites that actually READ
 * that variable: a call written as a literal `gh ...` bypasses the override and
 * falls through to whatever PATH resolves next — on a dev box or a self-hosted
 * runner that is the real, authenticated binary. The failure is then an
 * intermittent rate-limit error under concurrent runs sharing one identity,
 * which is close to undiagnosable.
 *
 * Putting the net in the harness means EVERY spec enforces it, so the regression
 * is caught by whichever case happens to exercise the new call site rather than
 * only by a dedicated test somebody remembered to write.
 */
export class EscapedToRealGhError extends Error {}

export type Harness = {
  dir: string;
  workDir: string;
  run(opts: RunOptions): RunResult;
  cleanup(): void;
};

export function createEngineHarness(opts: HarnessOptions): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), `cicd-engine-${opts.prNumber}-`));
  const workDir = path.join(dir, 'work');
  const stateDir = path.join(dir, 'state');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // A hard-failing `gh`, first on PATH. See EscapedToRealGhError.
  const hostileBin = path.join(dir, 'hostile-bin');
  const hostileLog = path.join(dir, 'hostile-gh-calls.log');
  mkdirSync(hostileBin, { recursive: true });
  const hostileGh = path.join(hostileBin, 'gh');
  writeFileSync(
    hostileGh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${posix(hostileLog)}"
echo "HOSTILE-GH: an unstubbed call escaped GH_CLI and reached the OS gh on PATH -- args: $*" >&2
exit 99
`,
    'utf8',
  );
  chmodSync(hostileGh, 0o755);

  const stub = path.join(dir, 'gh');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${STUB_STATE_DIR}/calls"
${
  opts.ghScript ??
  `case " $* " in
${opts.ghArms ?? ''}${DEFAULT_GH_ARMS}esac`
}
`,
    'utf8',
  );
  chmodSync(stub, 0o755);

  const harness = path.join(dir, 'harness.sh');

  function run({ body, env = {}, profile, cwd }: RunOptions): RunResult {
    const callsFile = path.join(stateDir, 'calls');
    if (existsSync(callsFile)) rmSync(callsFile);
    if (existsSync(hostileLog)) rmSync(hostileLog);
    // Belt to the `cleanup() { :; }` braces: a spec body is free to run engine
    // code that removes the tree, and a missing WORK_DIR fails the NEXT case
    // rather than the one that caused it.
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      harness,
      `#!/usr/bin/env bash
# DEFAULTS, not assignments. A bare \`export PR_AUTHOR=tester\` here silently
# overrides whatever a spec passed in \`env\`, which does not fail — it makes the
# case pass while testing something else. That cost a real scare: the
# untrusted-author case in held-runs.test.ts reported the engine approving held
# runs for an author outside AUTOMERGE_AUTHORS, i.e. a breach of the gate that
# keeps untrusted PR code off a self-hosted runner. The engine was correct; the
# harness had pinned PR_AUTHOR back to an allowlisted name.
export PR_NUMBER="\${PR_NUMBER:-${opts.prNumber}}"
export PR_HEAD_REF="\${PR_HEAD_REF:-feat/x}"
export PR_BASE_REF="\${PR_BASE_REF:-main}"
export PR_AUTHOR="\${PR_AUTHOR:-tester}"
export PR_TITLE="\${PR_TITLE:-test}" PR_BODY="\${PR_BODY:-}"
export PR_HTML_URL="\${PR_HTML_URL:-https://github.com/SeriousGeese/example/pull/\${PR_NUMBER}}"
export REPO="\${REPO:-SeriousGeese/example}"
export WORK_DIR="\${WORK_DIR:-${posix(workDir)}}"
export GH_TOKEN="\${GH_TOKEN:-fake}" GITHUB_OUTPUT="\${GITHUB_OUTPUT:-/dev/null}"
export HEAD_SHA="\${HEAD_SHA:-aaaaaaaaaaaa}" BASE_SHA="\${BASE_SHA:-bbbbbbbbbbbb}"
export GITHUB_RUN_ID="\${GITHUB_RUN_ID:-123456}"
export PR_REVIEW_LIBRARY_MODE=1
# shellcheck source=/dev/null
source "${posix(enginePath)}"
# The engine installs an EXIT trap that rm -rf's WORK_DIR. Sourcing it arms that
# trap in the HARNESS, so the first run deletes the scratch dir every later run
# depends on — and the symptom is a \`cd\` failure three cases later, nowhere
# near the cause.
cleanup() { :; }
GH_CLI="${posix(stub)}"
# Every clock in the engine is arithmetic in POLL_INTERVAL units, so removing the
# wall-clock wait changes nothing any of them count — only how long this takes.
sleep() { :; }
cd "${posix(cwd ?? workDir)}" || exit 99
${body}
`,
      'utf8',
    );
    chmodSync(harness, 0o755);

    let stdout: string;
    let status = 0;
    try {
      // `2>&1`, not two separate pipes. The engine's log() writes to STDERR by
      // design — its stdout is a data channel other functions parse — so a spec
      // that asserts on a log line sees nothing at all unless the streams are
      // folded. Interleaving is the point rather than a compromise: these specs
      // assert on the ORDER of what the engine reported as often as on the
      // values it returned.
      stdout = execFileSync('bash', ['-c', `"${posix(harness)}" 2>&1`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          STUB_STATE_DIR: stateDir,
          PATH: `${hostileBin}${path.delimiter}${process.env.PATH ?? ''}`,
          ...(opts.env ?? {}),
          ...(profile ? profileEnv(profile) : {}),
          ...env,
        },
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      stdout = (err.stdout ?? '') + (err.stderr ?? '');
      status = err.status ?? 1;
    }

    if (existsSync(hostileLog)) {
      throw new EscapedToRealGhError(
        `engine code bypassed $GH_CLI and reached the OS gh on PATH — logged call(s): ` +
          readFileSync(hostileLog, 'utf8').trim(),
      );
    }

    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
      : [];
    return { stdout, status, calls };
  }

  return { dir, workDir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run one block of cases once per profile.
 *
 * Takes the profile's own settings so a case can assert against what that repo
 * actually configures rather than restating it — the profiles are the record of
 * the live configs, and a spec that hard-codes `true` here would keep passing
 * after the consumer turned the flag off.
 */
export function forEachProfile(fn: (name: ProfileName, settings: Record<string, string>) => void) {
  for (const name of PROFILE_NAMES) fn(name, profileEnv(name));
}
