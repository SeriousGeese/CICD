#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { removeTempDir } from './test-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(here, 'verify-worktree-isolation.sh');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// The hook always exits 0 — the banner IS the mechanism — so every assertion
// here is on stdout, never on the exit code.
//
// `logical` matters and is the whole point of the symlink case: bash's `pwd`
// builtin reports $PWD when that names the same directory, and only falls back
// to getcwd() (which resolves every symlink) otherwise. A shell that cd'd
// through a symlink — and the Claude Code harness, which exports the session
// cwd — therefore yields the UNRESOLVED path, while `git rev-parse
// --show-toplevel` always answers the resolved one. Passing only `cwd` to
// spawnSync makes bash call getcwd(), both sides agree, and the test cannot
// fail: that vacuous version of this file passed against the pre-fix hook.
function run(cwd, logical = cwd) {
  const r = spawnSync('bash', [hook], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PWD: logical },
  });
  assert.equal(r.status, 0, `hook should always exit 0, got ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-wt-isolation-'));
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(primary, 'README.md'), 'v1\n');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'base']);
  return { root, primary };
}

test('the shared primary checkout is reported as such, not as broken', () => {
  const f = repo();
  try {
    const out = run(f.primary);
    assert.doesNotMatch(out, /BROKEN ISOLATION/);
    assert.match(out, /SHARED main checkout/);
  } finally {
    removeTempDir(f.root);
  }
});

test('a linked worktree reached by its real path is OK', () => {
  const f = repo();
  try {
    const wt = path.join(f.root, 'wt');
    git(f.primary, ['worktree', 'add', '-q', wt, '-b', 'feature']);
    const out = run(wt);
    assert.doesNotMatch(out, /BROKEN ISOLATION/);
    assert.match(out, /OK — isolated worktree/);
  } finally {
    removeTempDir(f.root);
  }
});

// The hook as the harness invokes it: stdin carries the SessionStart input JSON,
// whose `cwd` names the session directory.
function runWithInput(processCwd, input) {
  const r = spawnSync('bash', [hook], {
    cwd: processCwd,
    encoding: 'utf8',
    env: { ...process.env, PWD: processCwd },
    input,
  });
  assert.equal(r.status, 0, `hook should always exit 0, got ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// The harness layout: a linked worktree NESTED inside the primary checkout at
// .claude/worktrees/<name>. Run from inside it, it is OK; the stdin-cwd case
// (the hook's process cwd is the primary while stdin names the worktree) is
// pinned by the test after this one.
test('a linked worktree nested under .claude/worktrees/ is OK, not the shared checkout', () => {
  const f = repo();
  try {
    const wt = path.join(f.primary, '.claude', 'worktrees', 'beads-bulk-x');
    git(f.primary, ['worktree', 'add', '-q', wt, '-b', 'feature']);
    const out = run(wt);
    assert.doesNotMatch(out, /BROKEN ISOLATION/);
    assert.doesNotMatch(out, /SHARED main checkout/);
    assert.match(out, /OK — isolated worktree/);
    // And the primary beside it is still the shared one.
    assert.match(run(f.primary), /SHARED main checkout/);
  } finally {
    removeTempDir(f.root);
  }
});

// Reproduced by a Windows desktop session on 2026-10-19: Claude Code ran
// SessionStart with process cwd = the PRIMARY checkout and stdin `cwd` = the
// .claude/worktrees session. Reading only `pwd`, the hook told that session it was
// the shared main checkout.
test('stdin cwd naming a nested linked worktree wins over the process cwd', () => {
  const f = repo();
  try {
    const wt = path.join(f.primary, '.claude', 'worktrees', 'desktop-session');
    git(f.primary, ['worktree', 'add', '-q', wt, '-b', 'feature']);
    const out = runWithInput(
      f.primary,
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: wt }),
    );
    assert.doesNotMatch(out, /SHARED main checkout/);
    assert.doesNotMatch(out, /BROKEN ISOLATION/);
    assert.match(out, /OK — isolated worktree/);
    // The banner prints git's forward-slash form; on Windows `wt` is backslashed, and a
    // runner's temp dir can be an 8.3 short name (RUNNER~1) that git reports expanded.
    const long = realpathSync.native(wt);
    const named = [wt, long].flatMap((p) => [p, p.split(path.sep).join('/')]).some((p) => out.includes(p));
    assert.ok(named, `banner should name the session worktree ${wt}:\n${out}`);
  } finally {
    removeTempDir(f.root);
  }
});

test('stdin cwd naming the primary still reports the shared checkout', () => {
  const f = repo();
  try {
    const out = runWithInput(f.primary, JSON.stringify({ cwd: f.primary }));
    assert.match(out, /SHARED main checkout/);
  } finally {
    removeTempDir(f.root);
  }
});

test('missing, unparseable or non-directory stdin cwd falls back to pwd', () => {
  const f = repo();
  try {
    const wt = path.join(f.root, 'wt');
    git(f.primary, ['worktree', 'add', '-q', wt, '-b', 'feature']);
    for (const input of ['', 'not json', '{}', JSON.stringify({ cwd: 42 }),
      JSON.stringify({ cwd: path.join(f.root, 'does-not-exist') })]) {
      const out = runWithInput(wt, input);
      assert.match(out, /OK — isolated worktree/, `input ${JSON.stringify(input)}:\n${out}`);
    }
  } finally {
    removeTempDir(f.root);
  }
});

// The symlinked-parent regression. On Fedora Atomic images (Silverblue/Kinoite/Bazzite)
// /home is a symlink to var/home: the harness reports cwd through the symlink
// while `git rev-parse --show-toplevel` answers the resolved path, for the SAME
// directory. Before the fix this printed BROKEN ISOLATION on every session on
// such a host, destroying the signal for the case the hook exists to catch.
test('a cwd reached through a symlinked parent is NOT reported broken', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation needs elevation on Windows');
    return;
  }
  const f = repo();
  try {
    // link/ -> real/, so link/primary and real/primary are one directory.
    const real = path.join(f.root, 'real');
    mkdirSync(real);
    const inner = path.join(real, 'checkout');
    mkdirSync(inner);
    git(inner, ['init', '-q', '-b', 'main']);
    git(inner, ['config', 'user.email', 'test@example.com']);
    git(inner, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(inner, 'README.md'), 'v1\n');
    git(inner, ['add', '-A']);
    git(inner, ['commit', '-qm', 'base']);

    const link = path.join(f.root, 'link');
    symlinkSync(real, link, 'dir');

    // cwd is the real directory; PWD is the symlinked spelling of it — exactly
    // what the harness hands the hook on an ostree host.
    const out = run(inner, path.join(link, 'checkout'));
    assert.doesNotMatch(out, /BROKEN ISOLATION/);
    assert.match(out, /SHARED main checkout/);
  } finally {
    removeTempDir(f.root);
  }
});

// The other half: the fix must not blunt the real detection. A subdirectory of a
// checkout has a toplevel that is a genuinely different directory, and resolving
// symlinks does not make the two equal.
test('a subdirectory of a checkout is still reported BROKEN', () => {
  const f = repo();
  try {
    const sub = path.join(f.primary, 'nested');
    mkdirSync(sub);
    const out = run(sub);
    assert.match(out, /BROKEN ISOLATION/);
  } finally {
    removeTempDir(f.root);
  }
});

// The BROKEN banner's recovery example names where a replacement worktree would go. That comes from
// the consumer's agent-tooling.json, so a repository with its own layout is told its own layout.
test('the BROKEN banner shows the default worktree layout when there is no config', () => {
  const f = repo();
  try {
    const sub = path.join(f.primary, 'nested');
    mkdirSync(sub);
    const out = run(sub);
    assert.match(out, /BROKEN ISOLATION/);
    assert.match(out, /worktree add \.\.\/primary-<name> -b <branch> origin\/main/);
  } finally {
    removeTempDir(f.root);
  }
});

test('the BROKEN banner shows the consumer-configured worktree layout', () => {
  const f = repo();
  try {
    writeFileSync(
      path.join(f.primary, 'agent-tooling.json'),
      JSON.stringify({ worktreeRoot: '../trees', worktreeNamePattern: 'wt-<slug>' }),
    );
    const sub = path.join(f.primary, 'nested');
    mkdirSync(sub);
    const out = run(sub);
    assert.match(out, /BROKEN ISOLATION/);
    assert.match(out, /worktree add \.\.\/trees\/wt-<name> -b <branch> origin\/main/);
    assert.doesNotMatch(out, /primary-<name>/);
  } finally {
    removeTempDir(f.root);
  }
});

test('a broken agent-tooling.json never silences the banner, which falls back to the default layout', () => {
  const f = repo();
  try {
    writeFileSync(path.join(f.primary, 'agent-tooling.json'), '{ not json');
    const sub = path.join(f.primary, 'nested');
    mkdirSync(sub);
    const out = run(sub);
    assert.match(out, /BROKEN ISOLATION/);
    assert.match(out, /worktree add \.\.\/primary-<name> -b <branch> origin\/main/);
  } finally {
    removeTempDir(f.root);
  }
});

// The consumer's own advice sits in a hint file beside the vendored hook, so the test copies the hook and
// its config reader into a scratch directory and drops a hint there.
test('a consumer hint file is appended to every banner, and absent hint adds nothing', () => {
  const f = repo();
  const hookDir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-isolation-hint-'));
  try {
    for (const name of ['verify-worktree-isolation.sh', 'agent-tooling-config.mjs']) copyFileSync(path.join(here, name), path.join(hookDir, name));
    const copy = path.join(hookDir, 'verify-worktree-isolation.sh');
    const wt = path.join(f.root, 'wt');
    git(f.primary, ['worktree', 'add', '-q', wt, '-b', 'feature']);
    const sub = path.join(f.primary, 'nested');
    mkdirSync(sub);
    const runCopy = (cwd) => spawnSync('bash', [copy], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } }).stdout;

    assert.doesNotMatch(runCopy(wt), /team handbook/);
    writeFileSync(path.join(hookDir, 'verify-worktree-isolation.hint.txt'), 'See the team handbook section on isolation.\n');
    for (const [label, cwd, banner] of [
      ['ok', wt, /OK — isolated worktree/],
      ['shared', f.primary, /SHARED main checkout/],
      ['broken', sub, /BROKEN ISOLATION/],
    ]) {
      const out = runCopy(cwd);
      assert.match(out, banner, label);
      assert.match(out, /See the team handbook section on isolation\./, `${label} banner carries the hint`);
    }
  } finally {
    removeTempDir(hookDir);
    removeTempDir(f.root);
  }
});
