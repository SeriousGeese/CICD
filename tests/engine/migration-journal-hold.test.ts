import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEngineHarness, forEachProfile, type Harness } from '../harness/engine.js';

/**
 * The migration-journal hold — ported from DnD's prReviewMigrationJournalHold.
 *
 * WHAT IT PROTECTS. When two branches generate the same migration NUMBER, both
 * append an entry at the same idx in `src/drizzle/meta/_journal.json` and both
 * add a `meta/NNNN_snapshot.json` at the same path. Resolving that either way
 * silently drops one side's migration — its .sql and its journal entry disappear
 * TOGETHER, so the journal stays internally consistent and the schema suite
 * passes. It surfaces on DEPLOY, as `no such column`.
 *
 * So the bot must not attempt the base-sync merge at all when both sides moved
 * the journal, whether or not git would call it a conflict. That is the part
 * worth restating in a shared engine: a CLEAN auto-merge of two same-numbered
 * entries is the WORSE outcome, not the safe one, so "did git conflict" is the
 * wrong question and this guard deliberately does not ask it.
 *
 * WHAT THE PORT ADDS. DnD ran this under one implicit configuration. Here the
 * guard is behind CICD_FEATURE_MIGRATION_JOURNAL, so the flag is exercised in
 * BOTH directions against the same real collision. The "off" direction is not
 * ceremony: a disabled feature must be INERT, and the engine's own history has a
 * case where a disabled guard returned the value that means "I acted" and
 * quietly defeated the fail-closed downstream of it.
 *
 * These exercise the real function against real git history in a scratch repo,
 * rather than asserting on the script's text.
 */

const JOURNAL = 'src/drizzle/meta/_journal.json';

let h: Harness;
let repo: string;
let baselineSha: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });

/** Rewrite the journal to hold `tags` and commit it. */
function writeJournal(tags: string[], message: string) {
  writeFileSync(
    path.join(repo, JOURNAL),
    JSON.stringify(
      { version: '7', dialect: 'sqlite', entries: tags.map((tag, idx) => ({ idx, tag })) },
      null,
      2,
    ),
    'utf8',
  );
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8321 });
  repo = path.join(h.dir, 'repo');

  // A repo whose `origin/main` is a real remote-tracking ref, so the engine's
  // `origin/${PR_BASE_REF}` resolves the way it does on a runner.
  const origin = path.join(h.dir, 'origin.git');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', origin);
  mkdirSync(path.join(repo, 'src', 'drizzle', 'meta'), { recursive: true });
  writeJournal(['0000_baseline'], 'baseline');
  baselineSha = git('rev-parse', 'HEAD').trim();
  git('push', '-q', 'origin', 'main');
});

afterAll(() => h.cleanup());

/**
 * Reset both sides to the shared baseline before each scenario — INCLUDING the
 * bare origin. Without the force-push a previous scenario's `main` survives in
 * `origin/main`, and the next `writeJournal` on main is a no-op commit: the
 * scenario silently stops being the one it claims to set up.
 */
beforeEach(() => {
  git('checkout', '-q', '-B', 'main', baselineSha);
  git('reset', '-q', '--hard', baselineSha);
  git('clean', '-qfd');
  git('push', '-q', '-f', 'origin', 'main');
  git('checkout', '-q', '-B', 'feature', baselineSha);
});

function verdict(env: Record<string, string> = {}): string {
  return h
    .run({
      cwd: repo,
      env: { CICD_FEATURE_MIGRATION_JOURNAL: 'true', ...env },
      body: 'if migration_journal_collision; then echo COLLISION; else echo CLEAR; fi',
    })
    .stdout.trim();
}

/** Both sides append an entry — the same-number collision. */
function bothSidesAddAMigration() {
  writeJournal(['0000_baseline', '0001_mine'], 'branch adds 0001');
  git('checkout', '-q', 'main');
  writeJournal(['0000_baseline', '0001_theirs'], 'main adds a different 0001');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', 'feature');
}

describe('migration_journal_collision', () => {
  it('holds when BOTH sides added a journal entry', () => {
    bothSidesAddAMigration();
    expect(verdict()).toBe('COLLISION');
  });

  it('holds even when the two entries would MERGE cleanly — the dangerous case', () => {
    // Nothing here depends on git reporting a conflict. Two sides can append
    // entries that a text merge reconciles into a journal carrying two different
    // tags at idx 1, or the numbers out of order — both of which pass every
    // other gate, and both of which have already lost a migration.
    writeJournal(['0000_baseline', '0001_mine', '0002_mine_too'], 'branch adds two');
    git('checkout', '-q', 'main');
    writeJournal(['0000_baseline', '0001_theirs'], 'main adds one');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', 'feature');

    expect(verdict()).toBe('COLLISION');
  });

  it('does NOT hold when only the branch added a migration — the ordinary case', () => {
    writeJournal(['0000_baseline', '0001_mine'], 'branch adds 0001');
    git('checkout', '-q', 'main');
    writeFileSync(path.join(repo, 'unrelated.txt'), 'main moved on\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'unrelated main commit');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', 'feature');

    expect(verdict()).toBe('CLEAR');
  });

  it('does NOT hold when only main added a migration', () => {
    writeFileSync(path.join(repo, 'branch-only.txt'), 'no migrations here\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'branch changes something else');
    git('checkout', '-q', 'main');
    writeJournal(['0000_baseline', '0001_theirs'], 'main adds 0001');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', 'feature');

    expect(verdict()).toBe('CLEAR');
  });

  it('does NOT hold when neither side touched the journal', () => {
    writeFileSync(path.join(repo, 'branch-only.txt'), 'a\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'branch change');
    git('checkout', '-q', 'main');
    writeFileSync(path.join(repo, 'main-only.txt'), 'b\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'main change');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', 'feature');

    expect(verdict()).toBe('CLEAR');
  });
});

describe('CICD_FEATURE_MIGRATION_JOURNAL', () => {
  it('reports NO collision when the feature is off, against a real collision', () => {
    // The same git history that returns COLLISION above. A disabled feature must
    // be INERT — and the direction matters: this guard's "I found something" is
    // return 0, so a disabled version that returned 0 would hold every PR in
    // every repo that never adopted Drizzle.
    bothSidesAddAMigration();
    expect(verdict({ CICD_FEATURE_MIGRATION_JOURNAL: 'false' })).toBe('CLEAR');
  });

  forEachProfile((name, settings) => {
    it(`${name}: matches what that profile configures`, () => {
      // Asserted against the profile's own value rather than a hard-coded one:
      // the profiles mirror the live consumer configs, so hard-coding `true`
      // here would keep passing after a consumer turned the flag off.
      bothSidesAddAMigration();
      const enabled = settings.CICD_FEATURE_MIGRATION_JOURNAL === 'true';
      expect(h.run({
        cwd: repo,
        profile: name,
        body: 'if migration_journal_collision; then echo COLLISION; else echo CLEAR; fi',
      }).stdout.trim()).toBe(enabled ? 'COLLISION' : 'CLEAR');
    });
  });
});
