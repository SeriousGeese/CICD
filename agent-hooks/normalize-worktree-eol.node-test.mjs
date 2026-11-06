#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { removeTempDir } from './test-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./normalize-worktree-eol.mjs', import.meta.url));

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// AGENT_HOOKS_EOL_FIX_LOG redirects the hook's durable log to an isolated per-test file
// (scripts/hooks/eol-fix-log.mjs honours it) so no test here ever touches this
// machine's real %LOCALAPPDATA%/agent-hooks/eol-fix.log.
function runHook(cwd, { logPath } = {}) {
  const env = { ...process.env };
  if (logPath) env.AGENT_HOOKS_EOL_FIX_LOG = logPath;
  else delete env.AGENT_HOOKS_EOL_FIX_LOG;
  return spawnSync(process.execPath, [hook], { cwd, encoding: 'utf8', env });
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const crCount = (p) => (readFileSync(p, 'utf8').match(/\r/g) || []).length;

// A primary checkout with the repo's real attribute line, plus one linked worktree.
// core.autocrlf=true mirrors the Windows machines this bites on; the attribute is
// what makes the fixture faithful on Linux CI too.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-'));
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  git(primary, ['config', 'core.autocrlf', 'true']);
  writeFileSync(path.join(primary, '.gitattributes'), '* text=auto eol=lf\n');
  mkdirSync(path.join(primary, 'scripts'));
  writeFileSync(path.join(primary, 'scripts', 'a.mjs'), 'const a = 1;\nexport default a;\n');
  writeFileSync(path.join(primary, 'scripts', 'b.mjs'), 'const b = 2;\nexport default b;\n');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'base']);
  const worktree = path.join(root, 'wt');
  git(primary, ['worktree', 'add', '-q', worktree, '-b', 'feat/x']);
  return { root, primary, worktree };
}

// What the harness does to a session worktree: same text, CRLF on disk, and an
// index whose stat data matches those files. The `git add -A` is what produces
// the last part — the clean filter normalizes CRLF back to the identical LF blob
// (so the index does not change) and records the file's stat, after which
// `git status` reads clean exactly as it does in a real harness worktree. Without
// it git reports a conservative ` M` on the stat mismatch even though
// `hash-object --path` equals the index blob and `git diff` is empty.
function plantCrlf(dir, rel) {
  const p = path.join(dir, rel);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  assert.ok(crCount(p) > 0);
  git(dir, ['add', '-A', '--', rel]);
  assert.equal(git(dir, ['diff', '--cached', '--stat']), '', 'planting CRLF must not change the index');
}

test('renormalizes CRLF tracked files in a CLEAN linked worktree and reports the count', () => {
  const f = fixture();
  const logPath = path.join(f.root, 'eol-fix.log');
  try {
    plantCrlf(f.worktree, 'scripts/a.mjs');
    plantCrlf(f.worktree, 'scripts/b.mjs');
    assert.equal(git(f.worktree, ['status', '--porcelain']), '', 'CRLF planting must not show as a change');
    const r = runHook(f.worktree, { logPath });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[eol-fix\] renormalized 2 of 2 CRLF tracked files to LF/);
    assert.equal(crCount(path.join(f.worktree, 'scripts', 'a.mjs')), 0);
    assert.equal(crCount(path.join(f.worktree, 'scripts', 'b.mjs')), 0);
    assert.equal(git(f.worktree, ['status', '--porcelain']), '', 'the fix must leave the tree clean');

    const entries = readLog(logPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].crlfFiles, 2);
    assert.equal(entries[0].rewritten, 2);
    assert.equal(entries[0].skippedReason, null);
    assert.equal(entries[0].harnessCreated, false, 'a script-created fixture worktree, not under .claude/worktrees/');
    assert.equal(entries[0].worktreePath, f.worktree);
    assert.match(entries[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    removeTempDir(f.root, 'normalize-worktree-eol.node-test');
  }
});

test('leaves a DIRTY linked worktree alone and says so, and logs the skip reason', () => {
  const f = fixture();
  const logPath = path.join(f.root, 'eol-fix.log');
  try {
    plantCrlf(f.worktree, 'scripts/a.mjs');
    writeFileSync(path.join(f.worktree, 'scripts', 'b.mjs'), 'const b = 3;\n');
    const r = runHook(f.worktree, { logPath });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[eol-fix\] 1 tracked text files are CRLF .* uncommitted changes/);
    assert.ok(crCount(path.join(f.worktree, 'scripts', 'a.mjs')) > 0, 'must not rewrite a dirty tree');

    const entries = readLog(logPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].crlfFiles, 1);
    assert.equal(entries[0].rewritten, 0);
    assert.equal(entries[0].skippedReason, 'dirty');
  } finally {
    removeTempDir(f.root, 'normalize-worktree-eol.node-test');
  }
});

test('never touches the PRIMARY checkout, even when it is CRLF, and never logs it', () => {
  const f = fixture();
  const logPath = path.join(f.root, 'eol-fix.log');
  try {
    plantCrlf(f.primary, 'scripts/a.mjs');
    const r = runHook(f.primary, { logPath });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(crCount(path.join(f.primary, 'scripts', 'a.mjs')) > 0);
    assert.equal(existsSync(logPath), false, 'the primary checkout must never be logged');
  } finally {
    removeTempDir(f.root, 'normalize-worktree-eol.node-test');
  }
});

test('is silent when a linked worktree is already LF, but still logs the clean run', () => {
  const f = fixture();
  const logPath = path.join(f.root, 'eol-fix.log');
  try {
    const r = runHook(f.worktree, { logPath });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    const entries = readLog(logPath);
    assert.equal(entries.length, 1, 'the clean case is the observation the #91443 gate needs — it must be logged');
    assert.equal(entries[0].crlfFiles, 0);
    assert.equal(entries[0].rewritten, 0);
    assert.equal(entries[0].skippedReason, null);
  } finally {
    removeTempDir(f.root, 'normalize-worktree-eol.node-test');
  }
});

test('exits 0 silently outside a git repository, and never logs it', () => {
  const bare = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-bare-'));
  const logPath = path.join(bare, 'eol-fix.log');
  try {
    const r = runHook(bare, { logPath });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(logPath), false);
  } finally {
    removeTempDir(bare, 'normalize-worktree-eol.node-test');
  }
});

test('logs harnessCreated:true when the worktree path is under .claude/worktrees/', () => {
  const f = fixture();
  // Simulate a harness-created path by pointing AGENT_HOOKS_EOL_FIX_LOG-adjacent cwd at
  // a directory whose path contains the harness marker — normalize-worktree-eol
  // only inspects the path string (isHarnessWorktree), not how the tree was
  // actually made, so a script-created worktree nested under that literal
  // segment name is a faithful stand-in.
  const harnessLike = path.join(f.root, '.claude', 'worktrees', 'sess123');
  mkdirSync(path.dirname(harnessLike), { recursive: true });
  git(f.primary, ['worktree', 'add', '-q', harnessLike, '-b', 'feat/harness-like']);
  const logPath = path.join(f.root, 'eol-fix.log');
  try {
    const r = runHook(harnessLike, { logPath });
    assert.equal(r.status, 0);
    const entries = readLog(logPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].harnessCreated, true);
  } finally {
    removeTempDir(f.root, 'normalize-worktree-eol.node-test');
  }
});
