#!/usr/bin/env node
// Drives the pre-push guard against REAL repositories — including a
// real LINKED WORKTREE mid-rebase, which is the only shape the incident took and
// the one a primary-checkout-only implementation would silently miss.
//
// The rebase is wedged the same way the incident was: a prepare-commit-msg hook
// that exits non-zero. That is not a contrivance: a hook that takes a
// machine-wide lock does exactly this when the lock hands it an error, and it is the
// hook `git rebase` actually invokes (pre-commit is NOT run by the sequencer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTempDir } from './test-cleanup.mjs';
import { findRebaseState, renderRefusal, REBASE_STATE_DIRS } from './block-rebase-in-progress-push.mjs';

const hook = fileURLToPath(new URL('./block-rebase-in-progress-push.mjs', import.meta.url));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  AGENT_HOOKS_ALLOW_REBASE_PUSH: '',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runHook(cwd, env = {}) {
  return spawnSync(process.execPath, [hook], {
    cwd,
    encoding: 'utf8',
    env: { ...ENV, ...env },
  });
}

/**
 * A primary checkout on `main` (one commit ahead of the branch point) plus a
 * LINKED worktree on `feat` carrying two commits of its own — the shape a rebase
 * onto main has something to replay.
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-rebase-push-'));
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(primary, 'README.md'), 'base\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-qm', 'base');
  const branchPoint = git(primary, 'rev-parse', 'HEAD');
  writeFileSync(path.join(primary, 'MAIN.txt'), 'mainline\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-qm', 'main moves');

  git(primary, 'branch', '-q', 'feat', branchPoint);
  const worktree = path.join(root, 'wt');
  git(primary, 'worktree', 'add', '-q', worktree, 'feat');
  mkdirSync(path.join(worktree, 'newdir'));
  writeFileSync(path.join(worktree, 'newdir', 'n1.txt'), 'n1\n');
  writeFileSync(path.join(worktree, 'WORK.txt'), 'work1\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'feat commit 1');
  writeFileSync(path.join(worktree, 'WORK.txt'), 'work1\nwork2\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'feat commit 2');
  return { root, primary, worktree };
}

/** Wedge a rebase exactly as the incident did: prepare-commit-msg exits non-zero. */
function wedgeRebase({ primary, worktree, root }) {
  const hooks = path.join(root, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  git(primary, 'config', 'core.hooksPath', hooks);
  spawnSync('git', ['rebase', '--quiet', 'main'], { cwd: worktree, env: ENV, encoding: 'utf8' });
}

test('a clean linked worktree passes untouched', () => {
  const f = fixture();
  try {
    const r = runHook(f.worktree);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(f.root, 'block-rebase-in-progress-push.node-test');
  }
});

test('a clean PRIMARY checkout passes untouched', () => {
  const f = fixture();
  try {
    const r = runHook(f.primary);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
  } finally {
    removeTempDir(f.root, 'block-rebase-in-progress-push.node-test');
  }
});

test('a LINKED worktree with a wedged rebase is BLOCKED, and the state is the incident shape', () => {
  const f = fixture();
  try {
    wedgeRebase(f);

    // Pin the state itself, so a git that stopped wedging this way fails loudly here
    // rather than turning the block assertion below into a vacuous pass.
    const stateDir = git(f.worktree, 'rev-parse', '--git-path', 'rebase-merge');
    assert.ok(existsSync(stateDir), `rebase-merge should exist at ${stateDir}`);
    assert.ok(
      stateDir.includes('worktrees'),
      `the state must live in the WORKTREE's git dir, not the primary's: ${stateDir}`,
    );
    // HEAD is the rebase base — this is what a push would publish.
    assert.equal(git(f.worktree, 'rev-list', '--count', 'main..HEAD'), '0');

    const r = runHook(f.worktree);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLOCKED: a rebase is in progress/);
    assert.match(r.stderr, /rebase BASE/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_REBASE_PUSH/);
  } finally {
    removeTempDir(f.root, 'block-rebase-in-progress-push.node-test');
  }
});

test('the PRIMARY checkout is NOT blocked by a rebase wedged in a sibling worktree', () => {
  const f = fixture();
  try {
    wedgeRebase(f);
    // The whole point of resolving --git-path per worktree: the primary is fine.
    const r = runHook(f.primary);
    assert.equal(r.status, 0);
  } finally {
    removeTempDir(f.root, 'block-rebase-in-progress-push.node-test');
  }
});

test('AGENT_HOOKS_ALLOW_REBASE_PUSH=1 lets the push through', () => {
  const f = fixture();
  try {
    wedgeRebase(f);
    const r = runHook(f.worktree, { AGENT_HOOKS_ALLOW_REBASE_PUSH: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
  } finally {
    removeTempDir(f.root, 'block-rebase-in-progress-push.node-test');
  }
});

test('outside a git repo it fails OPEN — a push must never be impossible', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-rebase-push-norepo-'));
  try {
    const r = runHook(root);
    assert.equal(r.status, 0);
  } finally {
    removeTempDir(root, 'block-rebase-in-progress-push.node-test');
  }
});

// ── Unit-level: both backends, and a resolver that cannot answer ────────────

test('rebase-apply (the am backend) is detected too, not just rebase-merge', () => {
  assert.deepEqual(REBASE_STATE_DIRS, ['rebase-merge', 'rebase-apply']);
  const seen = [];
  const resolve = (name) => {
    seen.push(name);
    return name === 'rebase-apply' ? __filename_of_this_test() : null;
  };
  const state = findRebaseState('/nowhere', resolve);
  assert.equal(state?.name, 'rebase-apply');
  assert.deepEqual(seen, ['rebase-merge', 'rebase-apply']);
});

test('a resolver that answers nothing yields no verdict (fail open)', () => {
  assert.equal(findRebaseState('/nowhere', () => null), null);
});

test('the refusal names the state directory and the safe rebase form', () => {
  const text = renderRefusal({ name: 'rebase-merge', path: '/x/.git/worktrees/w/rebase-merge' });
  assert.match(text, /\/x\/\.git\/worktrees\/w\/rebase-merge/);
  assert.match(text, /core\.hooksPath/);
  assert.match(text, /rebase --abort/);
});

/** Any path that certainly exists, so the detection branch is the thing under test. */
function __filename_of_this_test() {
  return fileURLToPath(import.meta.url);
}

test('a consumer hint file beside the guard is appended to the refusal', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-rebase-push-hint-'));
  try {
    for (const name of ['block-rebase-in-progress-push.mjs', 'refusal-notice.mjs']) {
      copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(dir, name));
    }
    writeFileSync(path.join(dir, 'block-rebase-in-progress-push.hint.txt'), 'CONSUMER-HINT: rebase with hooks bypassed.\n');
    const copy = await import(pathToFileURL(path.join(dir, 'block-rebase-in-progress-push.mjs')).href);
    const text = copy.renderRefusal({ name: 'rebase-merge', path: '/x/rebase-merge' });
    assert.match(text, /CONSUMER-HINT: rebase with hooks bypassed\.$/);
    assert.doesNotMatch(renderRefusal({ name: 'rebase-merge', path: '/x/rebase-merge' }), /CONSUMER-HINT/);
  } finally {
    removeTempDir(dir, 'block-rebase-in-progress-push.node-test');
  }
});
