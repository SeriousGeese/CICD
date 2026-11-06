#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { removeTempDir } from './test-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./refresh-clean-worktree.mjs', import.meta.url));
const staleHook = fileURLToPath(new URL('./check-stale-hooks.mjs', import.meta.url));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function run(file, cwd, env = {}) {
  return spawnSync(process.execPath, [file], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

// A primary checkout plus one linked worktree cut from its HEAD, exactly the
// shape of a harness-created session worktree. origin/main is a synthetic ref
// (update-ref): the hook's fetch fails instantly with no remote and is ignored,
// which is also the offline-session path.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-wt-refresh-'));
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(primary, 'scripts', 'hooks'), { recursive: true });
  writeFileSync(path.join(primary, 'scripts', 'hooks', 'guard.mjs'), 'v1\n');
  writeFileSync(path.join(primary, 'README.md'), 'v1\n');
  writeFileSync(path.join(primary, 'package-lock.json'), '{"v":1}\n');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'base']);
  const base = git(primary, ['rev-parse', 'HEAD']);
  const worktree = path.join(root, 'wt');
  git(primary, ['worktree', 'add', '-q', worktree, '-b', 'claude/session-x']);
  git(primary, ['update-ref', 'refs/remotes/origin/main', base]);
  return { root, primary, worktree, base };
}

// Land a commit on origin/main that neither checkout has — the way main moves on
// while a session worktree sits at the commit it was cut from.
function advanceMain(f, mutate) {
  git(f.primary, ['checkout', '-q', '-b', 'tmp-main']);
  mutate(f.primary);
  git(f.primary, ['add', '-A']);
  git(f.primary, ['commit', '-qm', 'main moves on']);
  const tip = git(f.primary, ['rev-parse', 'HEAD']);
  git(f.primary, ['update-ref', 'refs/remotes/origin/main', tip]);
  git(f.primary, ['checkout', '-q', 'main']);
  git(f.primary, ['branch', '-q', '-D', 'tmp-main']);
  return tip;
}

test('a clean, zero-commit linked worktree behind origin/main is fast-forwarded and says so', () => {
  const f = fixture();
  try {
    const tip = advanceMain(f, (p) => writeFileSync(path.join(p, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[worktree-refresh\] fast-forwarded claude\/session-x \w{10}\.\.\w{10} \(1 commit behind origin\/main/);
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), tip, 'HEAD moved to origin/main');
    assert.equal(git(f.worktree, ['symbolic-ref', '--short', 'HEAD']), 'claude/session-x', 'still on its own branch');
    assert.equal(git(f.worktree, ['status', '--porcelain']), '', 'tree stays clean');
    assert.doesNotMatch(r.stdout, /package-lock/, 'no deps note when the lockfile did not change');
    // The primary is untouched: its HEAD is still the base commit.
    assert.equal(git(f.primary, ['rev-parse', 'HEAD']), f.base);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('a worktree with commits of its OWN is left alone, with the reason', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    writeFileSync(path.join(f.worktree, 'mine.txt'), 'work\n');
    git(f.worktree, ['add', '-A']);
    git(f.worktree, ['commit', '-qm', 'my work']);
    const before = git(f.worktree, ['rev-parse', 'HEAD']);
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[worktree-refresh\] NOT fast-forwarded: claude\/session-x has 1 commit of its own \(1 commit behind/);
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), before);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('a DIRTY worktree is left alone, with the reason', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    writeFileSync(path.join(f.worktree, 'README.md'), 'edited but not committed\n');
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOT fast-forwarded: the tree has uncommitted changes/);
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), f.base);
    assert.match(git(f.worktree, ['status', '--porcelain']), /README\.md/, 'the edit survives');
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('never touches the PRIMARY checkout, even when it is clean and behind', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    const r = run(hook, f.primary);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(git(f.primary, ['rev-parse', 'HEAD']), f.base);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('is silent when the worktree is already level with origin/main', () => {
  const f = fixture();
  try {
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('a detached HEAD is left alone, with the reason', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    git(f.worktree, ['checkout', '-q', '--detach']);
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOT fast-forwarded: HEAD is detached/);
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), f.base);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('AGENT_HOOKS_NO_WORKTREE_REFRESH=1 pins the worktree and is silent', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    const r = run(hook, f.worktree, { AGENT_HOOKS_NO_WORKTREE_REFRESH: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), f.base);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('a lockfile change in the fast-forwarded range is called out so the session awaits deps', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'package-lock.json'), '{"v":2}\n'));
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /fast-forwarded/);
    assert.match(r.stdout, /package\.json \/ package-lock\.json changed .* --await/);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('a fast-forward git refuses (an untracked file main now tracks) is reported, never forced', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'new-on-main.txt'), 'from main\n'));
    // Untracked, so the tree reads clean to `status --untracked-files=no`, but
    // the merge would overwrite it — git must refuse and the file must survive.
    writeFileSync(path.join(f.worktree, 'new-on-main.txt'), 'my local scratch\n');
    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOT fast-forwarded: fast-forward failed/);
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), f.base);
    assert.equal(spawnSync('cat', [path.join(f.worktree, 'new-on-main.txt')], { encoding: 'utf8' }).stdout, 'my local scratch\n');
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test("the repo's own git hooks do NOT run during the fast-forward (they would take the Dolt lock)", () => {
  const f = fixture();
  try {
    // A post-merge hook that leaves a marker, installed the way this repo installs
    // its hooks: core.hookspath in the shared config, so the linked worktree sees it.
    const hooksDir = path.join(f.root, 'hooks');
    mkdirSync(hooksDir);
    const marker = path.join(f.root, 'post-merge-ran');
    writeFileSync(path.join(hooksDir, 'post-merge'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`);
    spawnSync('chmod', ['+x', path.join(hooksDir, 'post-merge')]);
    git(f.primary, ['config', 'core.hooksPath', hooksDir]);
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    // Control: a plain merge in the primary DOES fire the hook, or this test proves nothing.
    git(f.primary, ['merge', '--ff-only', '-q', 'refs/remotes/origin/main']);
    assert.ok(existsSync(marker), 'control: the hook must fire on an ordinary merge');
    rmSync(marker);
    git(f.primary, ['reset', '-q', '--hard', f.base]);

    const r = run(hook, f.worktree);
    assert.match(r.stdout, /fast-forwarded/);
    assert.ok(!existsSync(marker), 'the fast-forward ran the post-merge hook');
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test("a branch whose own UPSTREAM is ahead is left alone — moving it would diverge from its remote", () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'README.md'), 'v2\n'));
    // Simulate `origin/claude/session-x` holding a commit this checkout lacks (pushed elsewhere).
    git(f.worktree, ['checkout', '-q', '-b', 'tmp-remote']);
    writeFileSync(path.join(f.worktree, 'elsewhere.txt'), 'pushed from another machine\n');
    git(f.worktree, ['add', '-A']);
    git(f.worktree, ['commit', '-qm', 'remote-only work']);
    const remoteTip = git(f.worktree, ['rev-parse', 'HEAD']);
    git(f.worktree, ['checkout', '-q', 'claude/session-x']);
    git(f.worktree, ['branch', '-q', '-D', 'tmp-remote']);
    // A remote must EXIST for @{upstream} to resolve; point it somewhere dead so the
    // hook's fetch fails fast and cannot clobber the synthetic refs.
    git(f.primary, ['remote', 'add', 'origin', path.join(f.root, 'no-such-remote.git')]);
    git(f.primary, ['update-ref', 'refs/remotes/origin/claude/session-x', remoteTip]);
    git(f.worktree, ['config', 'branch.claude/session-x.remote', 'origin']);
    git(f.worktree, ['config', 'branch.claude/session-x.merge', 'refs/heads/claude/session-x']);

    const r = run(hook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOT fast-forwarded: claude\/session-x's upstream has 1 commit this checkout lacks/);
    assert.equal(git(f.worktree, ['rev-parse', 'HEAD']), f.base);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('a .claude/settings.json change in the range is called out — the harness already read the old one', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => {
      mkdirSync(path.join(p, '.claude'), { recursive: true });
      writeFileSync(path.join(p, '.claude', 'settings.json'), '{"hooks":{}}\n');
    });
    const r = run(hook, f.worktree);
    assert.match(r.stdout, /fast-forwarded/);
    assert.match(r.stdout, /\.claude\/settings\.json changed in that range .* restarted/);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('check-stale-hooks refreshes FIRST, so a fixable stale worktree gets [worktree-refresh] and no [hooks-stale]', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    const r = run(staleHook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[worktree-refresh\] fast-forwarded/);
    assert.doesNotMatch(r.stdout, /\[hooks-stale\]/, 'the banner must describe the post-refresh tree');
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('check-stale-hooks still warns when the refresh had to skip (own commits) and names why', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'scripts', 'hooks', 'guard.mjs'), 'v2 fixed\n'));
    writeFileSync(path.join(f.worktree, 'mine.txt'), 'work\n');
    git(f.worktree, ['add', '-A']);
    git(f.worktree, ['commit', '-qm', 'my work']);
    const r = run(staleHook, f.worktree);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOT fast-forwarded: claude\/session-x has 1 commit of its own/);
    assert.match(r.stdout, /\[hooks-stale\]/);
    assert.match(r.stdout, /scripts\/hooks\/guard\.mjs/);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

// ---- consumer settings (agent-tooling.json) ----

test('packageManager pnpm: a pnpm-lock.yaml change is called out, with the configured await command', () => {
  const f = fixture();
  try {
    // Untracked in the worktree, so the tree still reads clean to `status --untracked-files=no`.
    writeFileSync(
      path.join(f.worktree, 'agent-tooling.json'),
      JSON.stringify({ packageManager: 'pnpm', worktreeScripts: { await: 'bash tools/await.sh <path>' } }),
    );
    advanceMain(f, (p) => writeFileSync(path.join(p, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'));
    const r = run(hook, f.worktree);
    assert.match(r.stdout, /fast-forwarded/);
    assert.match(r.stdout, /package\.json \/ pnpm-lock\.yaml changed .* `bash tools\/await\.sh <this path>`/);
    assert.doesNotMatch(r.stdout, /package-lock/);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('packageManager pnpm: an npm lockfile change is NOT a dependency change', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.worktree, 'agent-tooling.json'), JSON.stringify({ packageManager: 'pnpm' }));
    advanceMain(f, (p) => writeFileSync(path.join(p, 'package-lock.json'), '{"v":2}\n'));
    const r = run(hook, f.worktree);
    assert.match(r.stdout, /fast-forwarded/);
    assert.doesNotMatch(r.stdout, /changed in that range/);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});

test('the default await command is named when nothing is configured', () => {
  const f = fixture();
  try {
    advanceMain(f, (p) => writeFileSync(path.join(p, 'package-lock.json'), '{"v":2}\n'));
    const r = run(hook, f.worktree);
    assert.match(r.stdout, /`bash scripts\/worktree-new\.sh --await <this path>`/);
  } finally {
    removeTempDir(f.root, 'refresh-clean-worktree.node-test');
  }
});
