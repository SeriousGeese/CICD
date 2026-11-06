#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { removeTempDir } from './test-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./check-stale-hooks.mjs', import.meta.url));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runHook(cwd) {
  return spawnSync(process.execPath, [hook], { cwd, encoding: 'utf8' });
}

// A repo with a synthetic refs/remotes/origin/main. No network, no real remote:
// the hook only ever reads that ref, so update-ref is a faithful stand-in.
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-stale-hooks-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'hooks', 'guard.mjs'), 'v1\n');
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n');
  writeFileSync(path.join(root, 'README.md'), 'v1\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
  return root;
}

// Advance origin/main by one commit, leaving the worktree behind on `base`.
function advanceMain(root, mutate) {
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', '-b', 'tmp-main']);
  mutate(root);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'main moves on']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
  git(root, ['checkout', '-q', 'main']);
  assert.equal(git(root, ['rev-parse', 'HEAD']), base);
}

test('a worktree level with origin/main says nothing', () => {
  const root = repo();
  try {
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('a hook fix on origin/main that this worktree lacks is reported', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[hooks-stale\]/);
    assert.match(r.stdout, /scripts\/hooks\/guard\.mjs/);
    assert.match(r.stdout, /1 commit behind/);
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('a NEW hook registered on main is reported via .claude/settings.json', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => {
      writeFileSync(path.join(r, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[]}}\n');
      writeFileSync(path.join(r, 'scripts', 'hooks', 'brand-new.mjs'), 'new\n');
    });
    const r = runHook(root);
    assert.match(r.stdout, /\.claude\/settings\.json/);
    assert.match(r.stdout, /scripts\/hooks\/brand-new\.mjs/);
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('unrelated commits on main are not reported', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => writeFileSync(path.join(r, 'README.md'), 'v2\n'));
    const r = runHook(root);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('a test-only change to a hook is not reported — it cannot change hook behaviour', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.node-test.mjs'), 'test\n'));
    const r = runHook(root);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test("a session's OWN in-flight hook edit is not mistaken for staleness", () => {
  const root = repo();
  try {
    // Worktree is level with origin/main and is itself fixing a hook. Two-dot
    // diff would flag this; three-dot must not.
    writeFileSync(path.join(root, 'scripts', 'hooks', 'guard.mjs'), 'v2 my own work in progress\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'my fix']);
    const r = runHook(root);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('no origin/main ref — silent, exit 0', () => {
  const root = repo();
  try {
    git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('outside a git repo — silent, exit 0', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-not-a-repo-'));
  try {
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

// ---- consumer settings (agent-tooling.json) and consumer hint ----

test('the default watch list names the stale hooks directory and settings.json, and the default new-worktree command', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    const r = runHook(root);
    assert.match(r.stdout, /bash scripts\/worktree-new\.sh <slug> <branch>/);
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('staleHookFiles in agent-tooling.json replaces the watch list', () => {
  const root = repo();
  try {
    mkdirSync(path.join(root, 'tools'), { recursive: true });
    writeFileSync(path.join(root, 'tools', 'guard.mjs'), 'v1\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'tools']);
    git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
    advanceMain(root, (r) => {
      writeFileSync(path.join(r, 'tools', 'guard.mjs'), 'v2\n');
      writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.mjs'), 'v2\n');
    });
    // Untracked, so it never shows up as a change on either side of the comparison.
    writeFileSync(path.join(root, 'agent-tooling.json'), JSON.stringify({ staleHookFiles: ['tools'] }));
    const r = runHook(root);
    assert.match(r.stdout, /\[hooks-stale\] {3}tools\/guard\.mjs/);
    assert.doesNotMatch(r.stdout, /scripts\/hooks\/guard\.mjs/, 'a path outside the configured list is not watched');
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('worktreeScripts.new in agent-tooling.json is the command the banner recommends', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    writeFileSync(path.join(root, 'agent-tooling.json'), JSON.stringify({ worktreeScripts: { new: 'bash tools/make-wt.sh <slug> <branch>' } }));
    const r = runHook(root);
    assert.match(r.stdout, /\(bash tools\/make-wt\.sh <slug> <branch>\)/);
    assert.doesNotMatch(r.stdout, /scripts\/worktree-new\.sh/);
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

test('a broken agent-tooling.json is named on stderr and the hook still reports with defaults', () => {
  const root = repo();
  try {
    advanceMain(root, (r) => writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    writeFileSync(path.join(root, 'agent-tooling.json'), '{ "staleHookFiles": "not-an-array" }');
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /staleHookFiles/);
    assert.match(r.stdout, /scripts\/hooks\/guard\.mjs/);
  } finally {
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});

// The hint file is the consumer's own and sits beside the vendored hook, so the test copies the hook and the
// modules it imports into a scratch directory and drops a hint there.
test('a consumer hint file is appended to the recommended fix', () => {
  const root = repo();
  const hookDir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-stale-hint-'));
  try {
    for (const f of ['check-stale-hooks.mjs', 'refresh-clean-worktree.mjs', 'agent-tooling-config.mjs', 'refusal-notice.mjs']) {
      copyFileSync(path.join(path.dirname(hook), f), path.join(hookDir, f));
    }
    writeFileSync(path.join(hookDir, 'check-stale-hooks.hint.txt'), 'See the stale-hooks handbook entry.\n');
    advanceMain(root, (r) => writeFileSync(path.join(r, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    const r = spawnSync(process.execPath, [path.join(hookDir, 'check-stale-hooks.mjs')], { cwd: root, encoding: 'utf8' });
    assert.match(r.stdout, /See the stale-hooks handbook entry\./);
  } finally {
    removeTempDir(hookDir, 'check-stale-hooks.node-test');
    removeTempDir(root, 'check-stale-hooks.node-test');
  }
});
