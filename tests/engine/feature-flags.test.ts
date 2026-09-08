import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Feature flags, exercised under every consumer profile.
 *
 * The engine is the union of three forks, so behaviours only one repo wants sit
 * behind a CICD_FEATURE_* flag. Without a test per profile those flags are
 * untested branches in the file that decides whether code merges — and the way
 * they fail is not a crash, it is a hold that silently stops holding.
 *
 * Each guarded function is checked in BOTH states, because only one direction is
 * interesting per flag and it differs by function: for a hold, the danger is
 * "off" (it stops blocking); for a dispatch, the danger is "on" in a repo that
 * has no such workflow.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, '..', '..', 'engine');
const engine = path.join(engineDir, 'pr-review.sh');

/** Every engine source concatenated — the engine is the directory, not one file. */
function engineSources(): string {
  return readdirSync(engineDir)
    .filter((f) => /\.(sh|jq|mjs|py)$/.test(f))
    .map((f) => readFileSync(path.join(engineDir, f), 'utf8'))
    .join('\n');
}
const profilesDir = path.resolve(here, '..', 'profiles');
const posix = (p: string) => p.split(path.sep).join('/');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cicd-flags-'));
  mkdirSync(path.join(dir, 'work'), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Parse a profile .env into the CICD_* pairs the engine reads. */
function profile(name: string): Record<string, string> {
  const text = readFileSync(path.join(profilesDir, `${name}.env`), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(CICD_[A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function run(body: string, env: Record<string, string>): string {
  const harness = path.join(dir, `h-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
export PR_NUMBER=5 PR_HEAD_REF=feat/x PR_BASE_REF=main PR_AUTHOR=tester
export PR_TITLE=t PR_BODY=""
export REPO=SeriousGeese/CICD WORK_DIR="${posix(path.join(dir, 'work'))}"
export GH_TOKEN=fake GITHUB_OUTPUT=/dev/null
export HEAD_SHA=aaaaaaaaaaaa BASE_SHA=bbbbbbbbbbbb GITHUB_RUN_ID=1
export PR_REVIEW_LIBRARY_MODE=1
${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n')}
# Any real API call would go through these; make them loud and inert.
gh() { echo "GH_CALLED: $*"; return 0; }
# shellcheck source=/dev/null
source "${posix(engine)}"
cleanup() { :; }
GH_CLI=gh
${body}
`,
    'utf8',
  );
  chmodSync(harness, 0o755);
  const r = spawnSync('bash', ['-c', `"${posix(harness)}" 2>&1`], { encoding: 'utf8' });
  return r.stdout ?? '';
}

const HOLDS = [
  { fn: 'stacked_base_violation', flag: 'CICD_FEATURE_STACKED_PRS' },
  { fn: 'unmet_dependencies', flag: 'CICD_FEATURE_STACKED_PRS' },
  { fn: 'would_orphan_children', flag: 'CICD_FEATURE_STACKED_PRS' },
  { fn: 'migration_journal_collision', flag: 'CICD_FEATURE_MIGRATION_JOURNAL' },
];

describe('hold policies are inert when their flag is off', () => {
  for (const { fn, flag } of HOLDS) {
    it(`${fn} reports nothing when ${flag}=false`, () => {
      // Every hold is consumed as `if x="$(fn)"; then …hold… fi`, so "no hold"
      // is a NON-ZERO return. Getting this backwards would turn every PR in a
      // repo that disabled the policy into a permanent hold.
      const out = run(`if ${fn} >/dev/null 2>&1; then echo HOLD; else echo NO_HOLD; fi`, {
        [flag]: 'false',
      });
      expect(out).toContain('NO_HOLD');
      // And it must not have reached the API to decide that.
      expect(out).not.toContain('GH_CALLED');
    });
  }
});

const DISPATCHES = [
  { fn: 'dispatch_e2e_gate', flag: 'CICD_FEATURE_E2E_GATE' },
  { fn: 'dispatch_stage_deploy', flag: 'CICD_FEATURE_STAGE_DEPLOY' },
  { fn: 'dispatch_close_beads', flag: 'CICD_FEATURE_BEADS' },
  { fn: 'approve_held_runs', flag: 'CICD_FEATURE_APPROVE_HELD_RUNS' },
];

describe('a disabled feature is inert, not permissive', () => {
  it('approve_held_runs reports NOTHING APPROVED when disabled', () => {
    // Its return value answers "did I approve something", not "did I succeed" —
    // the live function returns 1 when it found nothing. Its only caller is
    //     if approve_held_runs "$sha"; then zero_checks_elapsed=0; fi
    // so a disabled version returning 0 resets the zero-checks grace on EVERY
    // poll, and the fail-closed that stops a checkless SHA merging can never
    // fire. The first version of this flag got exactly that backwards.
    const out = run(
      `if approve_held_runs abc123; then echo APPROVED_SOMETHING; else echo NOTHING_APPROVED; fi`,
      { CICD_FEATURE_APPROVE_HELD_RUNS: 'false' },
    );
    expect(out).toContain('NOTHING_APPROVED');
    expect(out).not.toContain('GH_CALLED');
  });

  it('the zero-checks grace is not reset by a disabled approve_held_runs', () => {
    // The consequence, asserted directly rather than inferred from the return
    // code: drive the caller's own idiom and confirm the grace survives.
    const out = run(
      `zero_checks_elapsed=99
if approve_held_runs abc123; then zero_checks_elapsed=0; fi
echo "grace=\${zero_checks_elapsed}"`,
      { CICD_FEATURE_APPROVE_HELD_RUNS: 'false' },
    );
    expect(out).toContain('grace=99');
  });
});

describe('dispatch actions do nothing when their flag is off', () => {
  for (const { fn, flag } of DISPATCHES) {
    it(`${fn} makes no API call when ${flag}=false`, () => {
      // These fire workflow_dispatch at workflows a consumer may not have.
      //
      // Do NOT redirect the call's output here. An earlier version ran it as
      // `${fn} 1 >/dev/null 2>&1`, which swallowed the GH_CALLED marker this
      // assertion depends on — deleting the guard outright still passed. The
      // mutation check is what surfaced it.
      const out = run(`${fn} 1 || true; echo DONE`, { [flag]: 'false' });
      expect(out).toContain('DONE');
      expect(out, `${fn} still called the API with ${flag}=false`).not.toContain('GH_CALLED');
    });
  }
});

describe('Dependabot short-circuit', () => {
  it('is OFF by default, so a repo whose reviewer owns Dependabot keeps reviewing', () => {
    const source = readFileSync(engine, 'utf8');
    expect(source).toMatch(/CICD_FEATURE_DEPENDABOT_SKIP\s+false\)/);
  });

  it('skips a Dependabot PR when enabled', () => {
    const out = run('main || true', {
      CICD_FEATURE_DEPENDABOT_SKIP: 'true',
      PR_AUTHOR: 'dependabot[bot]',
      AUTOMERGE_AUTHORS: 'someone-else',
    });
    expect(out).toMatch(/Dependabot PR .* Skipping LLM review/);
  });

  it('does NOT skip when the bot is the Dependabot merge authority', () => {
    // DnD's shape: dependabot[bot] IS in AUTOMERGE_AUTHORS, so the reviewer owns
    // those PRs and must keep reviewing them even with the flag on.
    const out = run(
      `if [ "$CICD_FEATURE_DEPENDABOT_SKIP" = "true" ] && [ "$PR_AUTHOR" = "dependabot[bot]" ] && ! is_automerge_author; then echo SKIP; else echo REVIEW; fi`,
      {
        CICD_FEATURE_DEPENDABOT_SKIP: 'true',
        PR_AUTHOR: 'dependabot[bot]',
        AUTOMERGE_AUTHORS: 'strickdd,dependabot[bot]',
      },
    );
    expect(out).toContain('REVIEW');
  });
});

describe('consumer profiles', () => {
  const names = readdirSync(profilesDir)
    .filter((f) => f.endsWith('.env'))
    .map((f) => f.replace(/\.env$/, ''));

  it('covers all three consumers', () => {
    expect(names.sort()).toEqual(['cloud', 'dnd', 'promptci']);
  });

  for (const name of names) {
    it(`${name}: every flag it sets is one the engine reads`, () => {
      // Catches the quiet failure: a profile setting CICD_FEATURE_TYPO=true, which
      // does nothing and looks configured.
      //
      // Scans the whole engine/ directory, not just pr-review.sh: CICD_STRICT_SKIPPED
      // is consumed in ci-lib.sh, and a check against one file reported it as
      // unread — a false alarm that would have pushed someone to "fix" a
      // correctly-wired flag.
      const source = engineSources();
      for (const key of Object.keys(profile(name))) {
        expect(source, `${name}.env sets ${key}, which the engine never reads`).toContain(key);
      }
    });

    it(`${name}: loads and normalises without error`, () => {
      const out = run('echo "LOADED strict=$CICD_STRICT_SKIPPED stacked=$CICD_FEATURE_STACKED_PRS"', profile(name));
      expect(out).toMatch(/LOADED strict=(true|false) stacked=(true|false)/);
    });
  }

  it('every repo without an aggregate gate job runs strict-skipped', () => {
    // The one cross-profile invariant that actually protects a merge gate: the
    // precise skipped-check rule leans on required_contexts(), which fails OPEN.
    // Only promptci-cloud has a `gate` job today.
    expect(profile('dnd').CICD_STRICT_SKIPPED).toBe('true');
    expect(profile('promptci').CICD_STRICT_SKIPPED).toBe('true');
    expect(profile('cloud').CICD_STRICT_SKIPPED).toBe('false');
  });
});
