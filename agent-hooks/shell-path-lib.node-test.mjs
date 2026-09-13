// Pure unit tests for the shared shell-path helpers.
//
// These are the CROSS-PLATFORM regression guard for the MSYS drive form. The
// end-to-end hook tests that drive `cd /d/<repo> && git checkout -- <file>`
// through the real hook can only run on win32 (on Linux `/d/...` is a genuine
// POSIX path and there is nothing to normalise), so CI would otherwise assert
// nothing about the bug that was actually shipped. Passing `platform` explicitly
// lets Linux CI exercise the win32 branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isLiteralPathToken, msysToWindowsPath, resolveShellDir, unquote } from './shell-path-lib.mjs';

test('msysToWindowsPath rewrites the MSYS drive form on win32', () => {
  assert.equal(msysToWindowsPath('/d/Worktrees/ABC-x', 'win32'), 'D:/Worktrees/ABC-x');
  assert.equal(msysToWindowsPath('/c/git/example/app', 'win32'), 'C:/git/example/app');
  // Uppercase drive letter — `/D/...` is equally valid MSYS.
  assert.equal(msysToWindowsPath('/D/Worktrees/ABC-x', 'win32'), 'D:/Worktrees/ABC-x');
  // Bare drive, with and without the trailing slash.
  assert.equal(msysToWindowsPath('/d', 'win32'), 'D:/');
  assert.equal(msysToWindowsPath('/d/', 'win32'), 'D:/');
});

test('msysToWindowsPath leaves everything else alone on win32', () => {
  // Multi-letter first segments are Git-Bash mount points, not drives.
  assert.equal(msysToWindowsPath('/tmp/foo', 'win32'), '/tmp/foo');
  assert.equal(msysToWindowsPath('/usr/bin', 'win32'), '/usr/bin');
  assert.equal(msysToWindowsPath('/', 'win32'), '/');
  // Already-Windows and relative forms are untouched.
  assert.equal(msysToWindowsPath('D:/Worktrees/ABC-x', 'win32'), 'D:/Worktrees/ABC-x');
  assert.equal(msysToWindowsPath('C:\\git\\app', 'win32'), 'C:\\git\\app');
  assert.equal(msysToWindowsPath('../ABC-x', 'win32'), '../ABC-x');
  assert.equal(msysToWindowsPath('', 'win32'), '');
});

test('msysToWindowsPath is a no-op off win32 — /d/x is a real POSIX path there', () => {
  for (const p of ['/d/Worktrees/ABC-x', '/c/git/app', '/D/x', '/tmp/foo']) {
    assert.equal(msysToWindowsPath(p, 'linux'), p);
    assert.equal(msysToWindowsPath(p, 'darwin'), p);
  }
});

test('resolveShellDir keeps the drive that a bare path.resolve would lose', () => {
  // The bug: path.resolve treats a leading `/` as CURRENT-DRIVE root on Windows.
  const base = 'C:/git/example/app';
  assert.equal(path.win32.resolve(base, '/d/Worktrees/ABC-x'), 'C:\\d\\Worktrees\\ABC-x');
  assert.equal(
    path.win32.resolve(base, msysToWindowsPath('/d/Worktrees/ABC-x', 'win32')),
    'D:\\Worktrees\\ABC-x',
  );
});

test('resolveShellDir unquotes the token before resolving', () => {
  assert.equal(msysToWindowsPath(unquote('"/d/Worktrees/ABC-x"'), 'win32'), 'D:/Worktrees/ABC-x');
  assert.equal(msysToWindowsPath(unquote("'/c/git/app'"), 'win32'), 'C:/git/app');
  // And it still resolves relative tokens against the base on the host platform.
  assert.equal(resolveShellDir(path.resolve('a', 'b'), 'c'), path.resolve('a', 'b', 'c'));
});

test('isLiteralPathToken rejects tokens whose non-existence proves nothing', () => {
  assert.equal(isLiteralPathToken('/d/Worktrees/ABC-x'), true);
  assert.equal(isLiteralPathToken('"D:/Worktrees/ABC-x"'), true);
  assert.equal(isLiteralPathToken('../ABC-x'), true);
  for (const t of ['$REPO', '"$REPO/sub"', '`pwd`', '~/repo', '../ABC-*', '-', '']) {
    assert.equal(isLiteralPathToken(t), false, t);
  }
});
