#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { removeTempDir } from './test-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./ensure-worktree-deps.mjs', import.meta.url));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runHook(cwd) {
  return spawnSync(process.execPath, [hook], { cwd, encoding: 'utf8' });
}

// A primary checkout plus one linked worktree — the real shape the hook keys on
// (.git is a DIRECTORY in the primary, a FILE in the worktree).
function fixture({ withLock = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-wt-deps-'));
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(primary, 'scripts'));
  // Stand-in for worktree-new.sh: records that it was called with --install <path>
  // instead of actually running a ~0.7 GB npm ci. It writes a temp file and
  // renames it into place, so the marker never exists half-written (see waitFor).
  writeFileSync(
    path.join(primary, 'scripts', 'worktree-new.sh'),
    '#!/usr/bin/env bash\nm="$(dirname "$0")/../.install-called"\nprintf "%s\n" "$@" > "$m.tmp" && mv "$m.tmp" "$m"\n',
  );
  writeFileSync(path.join(primary, 'package.json'), '{"name":"x"}\n');
  if (withLock) writeFileSync(path.join(primary, 'package-lock.json'), '{}\n');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'base']);

  const worktree = path.join(root, 'wt');
  git(primary, ['worktree', 'add', '-q', worktree, '-b', 'feat/x']);
  return { root, primary, worktree };
}

function cleanup(root) {
  removeTempDir(root, 'ensure-worktree-deps.node-test');
}

// Real `npm ci`/`npm install` always writes node_modules/.package-lock.json as
// part of a successful install; that is the marker depsStale() keys off of.
// Explicit utimesSync (rather than relying on real elapsed time, which can
// land inside one filesystem mtime tick) makes the before/after ordering
// deterministic regardless of host filesystem timestamp resolution.
function markInstalled(worktree, { stale = false } = {}) {
  mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
  const recordPath = path.join(worktree, 'node_modules', '.package-lock.json');
  writeFileSync(recordPath, '{}\n');
  const lockPath = path.join(worktree, 'package-lock.json');
  const older = new Date(Date.now() - 60_000);
  const newer = new Date();
  if (stale) {
    // Simulates a rebase landing a NEW dependency: the lockfile is touched
    // after the node_modules install it should invalidate.
    utimesSync(recordPath, older, older);
    utimesSync(lockPath, newer, newer);
  } else {
    // Simulates a normal `npm ci` that ran after the lockfile was checked out.
    utimesSync(lockPath, older, older);
    utimesSync(recordPath, newer, newer);
  }
}

// The hook spawns detached; give the child a moment to land its marker file.
/**
 * Wait for a marker file to exist AND have content.
 *
 * Existence alone is not readiness, and the difference is a live flake: the stub
 * writes its marker with `printf "%s\n" "$@" > .install-called`, and the shell
 * CREATES AND TRUNCATES that file before printf writes a byte. A reader that
 * returns on existence can land in that window, read '', and split it into
 * [''] — so the assertion fails as `'' !== '--install'`, which reads as "the
 * hook never passed --install" rather than "the test read too early".
 *
 * Observed on a self-hosted CI runner and not
 * reproducible locally, because the window widens under load. That matters more
 * now than it did: `lint` feeds the `gate` context, which is a REQUIRED check, so
 * this flake blocks a merge rather than costing a rerun.
 *
 * Non-empty is the right readiness signal for every marker here — all of them are
 * written with content, and none is legitimately empty.
 *
 * Non-empty is still not COMPLETE: printf can land "--install\n"
 * and the path in separate writes, and under a 3-worker wave a reader landed
 * between them and failed on 'a target path was passed'. The stub in fixture()
 * therefore writes a temp file and renames it, so the marker appears whole.
 */
function waitFor(p, ms = 4000) {
  const deadline = Date.now() + ms;
  const ready = () => {
    try {
      return statSync(p).size > 0;
    } catch {
      return false; // not created yet
    }
  };
  while (Date.now() < deadline) {
    if (ready()) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
  }
  return ready();
}

test('a linked worktree with no node_modules gets an install started', () => {
  const { root, worktree } = fixture();
  try {
    const r = runHook(worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[worktree-deps\]/);
    assert.match(r.stdout, /--await/);
    const marker = path.join(worktree, '.install-called');
    assert.ok(waitFor(marker), 'worktree-new.sh --install was never invoked');
    const args = readFileSync(marker, 'utf8').trim().split('\n');
    assert.equal(args[0], '--install');
    assert.ok(args[1] && args[1].length > 0, 'a target path was passed');
  } finally {
    cleanup(root);
  }
});

test('the PRIMARY checkout is never touched', () => {
  const { root, primary } = fixture();
  try {
    const r = runHook(primary);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(path.join(primary, '.install-called')), false);
  } finally {
    cleanup(root);
  }
});

test('a worktree with node_modules in sync with package-lock.json is left alone', () => {
  const { root, worktree } = fixture();
  try {
    markInstalled(worktree);
    const r = runHook(worktree);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(path.join(worktree, '.install-called')), false);
  } finally {
    cleanup(root);
  }
});

// a worktree that WAS fully installed can still be wrong once it is
// rebased across a commit that changed package.json/package-lock.json — the
// original bug only ever checked node_modules' EXISTENCE, so this case sailed
// through as "already installed" and produced phantom type errors in files
// the branch never touched.
test('node_modules that predates a rebased package-lock.json is treated as stale and reinstalled', () => {
  const { root, worktree } = fixture();
  try {
    markInstalled(worktree, { stale: true });
    const r = runHook(worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[worktree-deps\]/);
    assert.match(r.stdout, /--await/);
    const marker = path.join(worktree, '.install-called');
    assert.ok(waitFor(marker), 'worktree-new.sh --install was never invoked for stale deps');
    const args = readFileSync(marker, 'utf8').trim().split('\n');
    assert.equal(args[0], '--install');
  } finally {
    cleanup(root);
  }
});

// the [worktree-refresh] fast-forward rewrites package-lock.json
// WHILE the provisioning install runs, so npm's record lands NEWER than the
// lockfile and the mtime comparison reads the tree as fresh — while it holds the
// previous lock's versions. Comparing the versions npm RECORDED against the ones
// the lockfile WANTS is immune to that ordering.
function lockJson(versions) {
  const packages = { '': { name: 'x', version: '0.1.0' } };
  for (const [name, version] of Object.entries(versions)) {
    packages[`node_modules/${name}`] = { version };
  }
  return `${JSON.stringify({ name: 'x', lockfileVersion: 3, packages }, null, 2)}\n`;
}

/** Lay down both lockfiles, then force the record-NEWER-than-lockfile ordering. */
function writeLockPair(worktree, wanted, installed) {
  mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
  const lockPath = path.join(worktree, 'package-lock.json');
  const recordPath = path.join(worktree, 'node_modules', '.package-lock.json');
  writeFileSync(lockPath, lockJson(wanted));
  writeFileSync(recordPath, lockJson(installed));
  const older = new Date(Date.now() - 60_000);
  const newer = new Date();
  utimesSync(lockPath, older, older);
  utimesSync(recordPath, newer, newer);
}

test('node_modules installed from a DIFFERENT lockfile is reinstalled, record mtime notwithstanding', () => {
  const { root, worktree } = fixture();
  try {
    writeLockPair(worktree, { 'playwright-core': '1.62.1' }, { 'playwright-core': '1.56.0' });
    const r = runHook(worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[worktree-deps\]/);
    const marker = path.join(worktree, '.install-called');
    assert.ok(waitFor(marker), 'worktree-new.sh --install was never invoked for drifted deps');
  } finally {
    cleanup(root);
  }
});

test('matching versions with a newer record stay silent — the drift check is not a blanket reinstall', () => {
  const { root, worktree } = fixture();
  try {
    const same = { 'playwright-core': '1.62.1', jest: '30.2.0' };
    writeLockPair(worktree, same, same);
    const r = runHook(worktree);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(path.join(worktree, '.install-called')), false);
  } finally {
    cleanup(root);
  }
});

// A node_modules directory with no install record is either mid-install or
// corrupted — never trust it silently. Treating "record missing" as stale
// (rather than as "present, so fine") is the conservative default: it costs
// one extra npm ci at worst, versus a silent false green/red at best.
test('a node_modules dir with no install record is treated as incomplete and reinstalled', () => {
  const { root, worktree } = fixture();
  try {
    mkdirSync(path.join(worktree, 'node_modules'));
    const r = runHook(worktree);
    assert.equal(r.status, 0);
    const marker = path.join(worktree, '.install-called');
    assert.ok(waitFor(marker), 'worktree-new.sh --install was never invoked');
  } finally {
    cleanup(root);
  }
});

test('an install already in flight is reported, not duplicated', () => {
  const { root, worktree } = fixture();
  try {
    writeFileSync(path.join(worktree, '.npm-install.pid'), '12345\n');
    const r = runHook(worktree);
    assert.match(r.stdout, /already running/);
    assert.equal(existsSync(path.join(worktree, '.install-called')), false);
  } finally {
    cleanup(root);
  }
});

test('no package-lock.json — nothing to npm ci, stay silent', () => {
  const { root, worktree } = fixture({ withLock: false });
  try {
    const r = runHook(worktree);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(path.join(worktree, '.install-called')), false);
  } finally {
    cleanup(root);
  }
});

test('outside a git repo — silent, exit 0', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-not-a-repo-'));
  try {
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    cleanup(root);
  }
});

// ---- consumer settings (agent-tooling.json) ----

// A worktree set up for a consumer whose package manager is pnpm and whose scripts live under tools/.
function pnpmFixture() {
  const f = fixture({ withLock: false });
  writeFileSync(
    path.join(f.worktree, 'agent-tooling.json'),
    JSON.stringify({
      packageManager: 'pnpm',
      worktreeScripts: { install: 'bash tools/install.sh <path>', await: 'bash tools/await.sh <path>' },
    }),
  );
  mkdirSync(path.join(f.worktree, 'tools'));
  writeFileSync(
    path.join(f.worktree, 'tools', 'install.sh'),
    '#!/usr/bin/env bash\nm="$(dirname "$0")/../.pnpm-install-called"\nprintf "%s\\n" "$@" > "$m.tmp" && mv "$m.tmp" "$m"\n',
  );
  writeFileSync(path.join(f.worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return f;
}

test('packageManager pnpm: the configured install command runs and the configured await command is printed', () => {
  const { root, worktree } = pnpmFixture();
  try {
    const r = runHook(worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /starting the pnpm install in the BACKGROUND/);
    assert.match(r.stdout, /bash tools\/await\.sh /);
    assert.doesNotMatch(r.stdout, /worktree-new\.sh/);
    const marker = path.join(worktree, '.pnpm-install-called');
    assert.ok(waitFor(marker), 'the configured install command was never invoked');
    const args = readFileSync(marker, 'utf8').trim().split('\n');
    assert.ok(args[0] && args[0].length > 0, 'the target path was passed');
    assert.equal(existsSync(path.join(worktree, '.install-called')), false, 'the default install command was not used');
  } finally {
    cleanup(root);
  }
});

test('packageManager pnpm: only pnpm-lock.yaml counts as the lockfile', () => {
  const { root, worktree } = pnpmFixture();
  try {
    rmSync(path.join(worktree, 'pnpm-lock.yaml'));
    writeFileSync(path.join(worktree, 'package-lock.json'), '{}\n');
    const r = runHook(worktree);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(path.join(worktree, '.pnpm-install-called')), false);
  } finally {
    cleanup(root);
  }
});

test('packageManager pnpm: an install newer than the lockfile is left alone, an older one is reinstalled', () => {
  const { root, worktree } = pnpmFixture();
  try {
    mkdirSync(path.join(worktree, 'node_modules', '.pnpm'), { recursive: true });
    const record = path.join(worktree, 'node_modules', '.pnpm', 'lock.yaml');
    writeFileSync(record, 'lockfileVersion: 9\n');
    const lock = path.join(worktree, 'pnpm-lock.yaml');
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(lock, older, older);
    utimesSync(record, newer, newer);
    assert.equal(runHook(worktree).stdout.trim(), '');
    assert.equal(existsSync(path.join(worktree, '.pnpm-install-called')), false);

    utimesSync(record, older, older);
    utimesSync(lock, newer, newer);
    const r = runHook(worktree);
    assert.match(r.stdout, /\[worktree-deps\]/);
    assert.ok(waitFor(path.join(worktree, '.pnpm-install-called')), 'a stale pnpm install was not redone');
  } finally {
    cleanup(root);
  }
});

test('packageManager pnpm: an install already in flight is the pnpm pid file', () => {
  const { root, worktree } = pnpmFixture();
  try {
    writeFileSync(path.join(worktree, '.pnpm-install.pid'), '12345\n');
    const r = runHook(worktree);
    assert.match(r.stdout, /already running/);
    assert.match(r.stdout, /bash tools\/await\.sh /);
    assert.equal(existsSync(path.join(worktree, '.pnpm-install-called')), false);
  } finally {
    cleanup(root);
  }
});

test('a configured install script that does not exist is silent, not an error', () => {
  const { root, worktree } = pnpmFixture();
  try {
    rmSync(path.join(worktree, 'tools', 'install.sh'));
    const r = runHook(worktree);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    cleanup(root);
  }
});

test('the default await command is printed when nothing is configured', () => {
  const { root, worktree } = fixture();
  try {
    const r = runHook(worktree);
    assert.match(r.stdout, /bash scripts\/worktree-new\.sh --await /);
    assert.ok(waitFor(path.join(worktree, '.install-called')));
  } finally {
    cleanup(root);
  }
});
