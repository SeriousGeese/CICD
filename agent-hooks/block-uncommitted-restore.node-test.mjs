#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { removeTempDir } from './test-cleanup.mjs';

const hook = fileURLToPath(new URL('./block-uncommitted-restore.mjs', import.meta.url));

/** @param {string} command @param {{ cwd?: string, env?: Record<string, string> }} [opts] */
function runHook(command, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}

// A real repo is required: the hook shells out to `git status --porcelain` to
// decide whether the target is dirty. mkdtemp then realpath so the fixture path
// matches what git reports (macOS /var → /private/var, Windows 8.3 names).
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-')));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // Assertions below compare literal LF bytes; a host's CRLF checkout policy
  // must not change this throwaway conflict fixture.
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'a.txt'), 'committed a\n');
  writeFileSync(path.join(root, 'b.txt'), 'committed b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}

function dirty(f, file = 'a.txt') {
  writeFileSync(path.join(f.root, file), 'uncommitted edit\n');
}

const BLOCKED = /DISCARD uncommitted changes/;

function cleanup(f) {
  removeTempDir(f.root, 'block-uncommitted-restore.node-test');
}

// ── Blocked cases (target has uncommitted changes) ──────────────────────────
test('blocks git checkout -- <file> on a dirty file', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD/);
  } finally {
    cleanup(f);
  }
});

test('blocks git checkout <rev> -- <file> on a dirty file', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout HEAD -- a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks git checkout . with a dirty tree', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout .', { cwd: f.root });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks git restore <file> on a dirty file', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git restore a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks git restore --staged --worktree on a dirty file (worktree IS touched)', () => {
  const f = fixture();
  try {
    dirty(f);
    f.git('add', 'a.txt');
    const r = runHook('git restore --staged --worktree a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks a wrapped command: rtk git checkout -- <file>', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('rtk git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('tracks `cd <repo>` from outside and blocks', () => {
  const f = fixture();
  try {
    dirty(f);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
    try {
      const r = runHook(`cd ${f.root} && git checkout -- a.txt`, { cwd: outside });
      assert.equal(r.status, 2);
    } finally {
      removeTempDir(outside, 'block-uncommitted-restore.node-test');
    }
  } finally {
    cleanup(f);
  }
});

test('honors `git -C <repo>` and blocks', () => {
  const f = fixture();
  try {
    dirty(f);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
    try {
      const r = runHook(`git -C ${f.root} checkout -- a.txt`, { cwd: outside });
      assert.equal(r.status, 2);
    } finally {
      removeTempDir(outside, 'block-uncommitted-restore.node-test');
    }
  } finally {
    cleanup(f);
  }
});

// ── MSYS-style `cd` targets ─────────────────────────────────────
// `/d/Worktrees/x` and `/c/git/x` are how commands are written against the Bash
// tool on Windows — every fanned-out worktree path in a fan-out prompt uses
// that form. Node's path.resolve turned `/d/x` into `C:\d\x`, `git -C` failed,
// and the guard fell through its fail-open path: a REAL discard on 2026-09-02.
const WIN32_ONLY = process.platform === 'win32' ? false : 'MSYS drive form is win32-only';

// 'C:\\Users\\x\\tmp' -> '/c/Users/x/tmp'
function msysForm(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  assert.ok(m, `expected a drive-letter path, got ${winPath}`);
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

test('blocks via an MSYS `cd /c/...` target on a dirty file', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    dirty(f);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
    try {
      const r = runHook(`cd ${msysForm(f.root)} && git checkout -- a.txt`, { cwd: outside });
      assert.equal(r.status, 2);
      assert.match(r.stderr, BLOCKED);
    } finally {
      removeTempDir(outside, 'block-uncommitted-restore.node-test');
    }
  } finally {
    cleanup(f);
  }
});

test('blocks via an UPPERCASE MSYS `cd /C/...` target on a dirty file', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    dirty(f);
    const msys = msysForm(f.root);
    const upper = `/${msys[1].toUpperCase()}${msys.slice(2)}`;
    const r = runHook(`cd ${upper} && git checkout -- a.txt`, { cwd: tmpdir() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('blocks via an MSYS `git -C /c/...` on a dirty file', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook(`git -C ${msysForm(f.root)} restore a.txt`, { cwd: tmpdir() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('no regression: the `D:/...` drive form still blocks', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook(`cd ${f.root.replace(/\\/g, '/')} && git checkout -- a.txt`, { cwd: tmpdir() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('a CLEAN target is still allowed from BOTH path forms', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    for (const dirForm of [msysForm(f.root), f.root.replace(/\\/g, '/')]) {
      const r = runHook(`cd ${dirForm} && git checkout -- a.txt`, { cwd: tmpdir() });
      assert.equal(r.status, 0, dirForm);
      assert.equal(r.stderr, '', dirForm);
    }
  } finally {
    cleanup(f);
  }
});

// ── Fail-CLOSED on an unverifiable named directory ───────────────
// Runs on every platform: `/d/Worktrees/...` does not exist on Linux either, and
// blocking is the right answer there too. This is what makes the acceptance
// criterion hold on CI, where the win32-only cases above are skipped.
test('fails CLOSED when a named `cd` directory does not exist', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('cd /d/Worktrees/does-not-exist-xvmte && git checkout -- a.txt', {
      cwd: f.root,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot inspect/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD/);
  } finally {
    cleanup(f);
  }
});

test('fails CLOSED when a named `git -C` directory does not exist', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git -C /c/git/does-not-exist-xvmte restore a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot inspect/);
  } finally {
    cleanup(f);
  }
});

test('the fail-closed path respects the escape hatch', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('cd /d/Worktrees/does-not-exist-xvmte && git checkout -- a.txt', {
      cwd: f.root,
      env: { AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD: '1' },
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('a non-literal `cd` token stays fail-OPEN (its non-existence proves nothing)', () => {
  const f = fixture();
  try {
    dirty(f);
    for (const tok of ['"$REPO"', '$WORKTREE', '~/repo', '-']) {
      const r = runHook(`cd ${tok} && git checkout -- a.txt`, { cwd: f.root });
      assert.equal(r.status, 0, tok);
    }
  } finally {
    cleanup(f);
  }
});

test('an ordinary command with NO named directory is unaffected by fail-closed', () => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
  try {
    // Not a repo, no `cd`, no `-C` — the generic fail-open still applies.
    assert.equal(runHook('git checkout -- a.txt', { cwd: outside }).status, 0);
  } finally {
    removeTempDir(outside, 'block-uncommitted-restore.node-test');
  }
});

// ── Allowed cases ───────────────────────────────────────────────────────────
test('allows git checkout -- <file> on a CLEAN file (no-op restore)', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    cleanup(f);
  }
});

test('allows git checkout -- <dirty-file-A> when only file B is dirty', () => {
  const f = fixture();
  try {
    dirty(f, 'b.txt');
    const r = runHook('git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('allows the pure unstage form: git restore --staged <file>', () => {
  const f = fixture();
  try {
    dirty(f);
    f.git('add', 'a.txt');
    const r = runHook('git restore --staged a.txt', { cwd: f.root });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('allows bare git checkout <ref> (ambiguous — branch guard territory)', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout some-branch', { cwd: f.root });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('allows ordinary git ops on a dirty tree', () => {
  const f = fixture();
  try {
    dirty(f);
    for (const c of ['git status', 'git diff -- a.txt', 'git add a.txt', 'git stash push -u -m tag', 'git checkout -b feat/x']) {
      assert.equal(runHook(c, { cwd: f.root }).status, 0, c);
    }
  } finally {
    cleanup(f);
  }
});

test('allows outside any git repo (status fails → fail open)', () => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
  try {
    const r = runHook('git checkout -- a.txt', { cwd: outside });
    assert.equal(r.status, 0);
  } finally {
    removeTempDir(outside, 'block-uncommitted-restore.node-test');
  }
});

// ── Picking a conflict side ─────────────────────────────────────
// `git checkout --ours|--theirs -- <path>` on an UNMERGED path is how a conflict
// is resolved by taking one side. It overwrites only the marker file git wrote.
// The guard used to block it like any other pathspec restore, leaving the hatch
// as the only way through a routine rebase.

/** a.txt ends up `UU` (both modified), mid-merge. Returns the fixture. */
function conflicted(f) {
  const base = f.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  f.git('checkout', '-q', '-b', 'other');
  writeFileSync(path.join(f.root, 'a.txt'), 'their a\n');
  f.git('commit', '-qam', 'theirs');
  f.git('checkout', '-q', base);
  writeFileSync(path.join(f.root, 'a.txt'), 'our a\n');
  f.git('commit', '-qam', 'ours');
  const r = spawnSync('git', ['-C', f.root, 'merge', 'other'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'the fixture merge was meant to conflict');
  assert.match(f.git('status', '--porcelain', '--untracked-files=no'), /^UU a\.txt$/m);
  return f;
}

const SIDE_PICKS = [
  'git checkout --ours -- a.txt',
  'git checkout --theirs -- a.txt',
  'git checkout -q --theirs -- a.txt',
  'git restore --ours a.txt',
  'git restore --theirs -- a.txt',
  'rtk git checkout --ours -- a.txt',
  'git checkout --ours .',
];

for (const command of SIDE_PICKS) {
  test(`allows picking a side of an UNMERGED path: ${command}`, () => {
    const f = conflicted(fixture());
    try {
      const r = runHook(command, { cwd: f.root });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    } finally {
      cleanup(f);
    }
  });

  // The other direction. A side flag on a merely MODIFIED file restores it from
  // the index, which is the discard this guard exists for.
  test(`still blocks the same command on a merely modified path: ${command}`, () => {
    const f = fixture();
    try {
      dirty(f);
      const r = runHook(command, { cwd: f.root });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, BLOCKED);
      assert.match(r.stderr, /only when EVERY named target is an unmerged conflict path/);
    } finally {
      cleanup(f);
    }
  });
}

test('blocks a side pick when ONE target is unmerged and another merely modified', () => {
  const f = conflicted(fixture());
  try {
    dirty(f, 'b.txt');
    const r = runHook('git checkout --ours -- a.txt b.txt', { cwd: f.root });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, BLOCKED);
    // Both lines are shown, XY column intact, so the agent can see which is which.
    assert.match(r.stderr, /^UU a\.txt$/m);
    assert.match(r.stderr, /^ M b\.txt$/m);
  } finally {
    cleanup(f);
  }
});

test('blocks a side pick over the whole tree when a modified file sits beside the conflict', () => {
  const f = conflicted(fixture());
  try {
    dirty(f, 'b.txt');
    assert.equal(runHook('git checkout --theirs .', { cwd: f.root }).status, 2);
  } finally {
    cleanup(f);
  }
});

test('an unmerged path WITHOUT --ours/--theirs is still blocked', () => {
  const f = conflicted(fixture());
  try {
    for (const command of ['git checkout -- a.txt', 'git checkout HEAD -- a.txt', 'git restore --source=HEAD a.txt']) {
      const r = runHook(command, { cwd: f.root });
      assert.equal(r.status, 2, command);
      assert.doesNotMatch(r.stderr, /only when EVERY named target/, command);
    }
  } finally {
    cleanup(f);
  }
});

test('a side flag written AFTER the `--` is a path, not a flag, and does not exempt', () => {
  const f = conflicted(fixture());
  try {
    assert.equal(runHook('git checkout -- --ours a.txt', { cwd: f.root }).status, 2);
  } finally {
    cleanup(f);
  }
});

test('the allowed side pick really resolves the file (the guard judged a real conflict)', () => {
  const f = conflicted(fixture());
  try {
    assert.equal(runHook('git checkout --theirs -- a.txt', { cwd: f.root }).status, 0);
    f.git('checkout', '--theirs', '--', 'a.txt');
    assert.equal(readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'their a\n');
  } finally {
    cleanup(f);
  }
});

// ── Escape hatch + fail-open ────────────────────────────────────────────────
test('escape hatch AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 allows a blockable command', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout -- a.txt', {
      cwd: f.root,
      env: { AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD: '1' },
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

// ── Inline hatch ─────────────────────────────────────────────────
// The old refusal message told an agent to "set AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1",
// which reads as an instruction the agent can follow inline in its own Bash
// command — and could not, because process.env of the PreToolUse HOOK process
// is unreachable from the command string it is judging. These prove the
// inline form the (updated) message now shows actually works.

test('inline hatch: a leading VAR=1 on the SAME command allows the discard', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('inline hatch: works after a leading cd segment too', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook(`cd "${f.root}" && AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.txt`);
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('inline hatch: an assignment on an UNRELATED segment does not leak in', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 echo hi && git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('inline hatch: the refusal message shows the exact inline form', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout/);
  } finally {
    cleanup(f);
  }
});

test('inline hatch also covers the fail-closed (missing directory) path', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook(
      'cd /d/Worktrees/does-not-exist-xvmte && AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.txt',
      { cwd: f.root },
    );
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('malformed hook input fails open', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8', cwd: f.root });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    cleanup(f);
  }
});

// ── Loop / conditional / grouping bodies ──────────────────────
// The command is split on `;`, `&&`, `||`, `|` and newlines, so a restore inside
// a compound command arrives as a segment led by a shell keyword (`do`, `then`,
// `else`, `{`, `(`, `!`). Before wrapper-strip.mjs those segments were not
// recognised as git invocations at all and a dirty target was discarded.
const COMPOUND_SHAPES = [
  ['for … do', 'for f in a; do git checkout -- a.txt; done'],
  ['if … then', 'if true; then git checkout -- a.txt; fi'],
  ['if … else', 'if false; then :; else git restore a.txt; fi'],
  ['while … do', 'while true; do git checkout -- a.txt; break; done'],
  ['until … do', 'until false; do git restore a.txt; done'],
  ['{ …; } group', '{ git checkout -- a.txt; }'],
  ['( … ) subshell, spaced', '( git checkout -- a.txt )'],
  ['(…) subshell, glued', '(git checkout -- a.txt)'],
  ['! negation', '! git checkout -- a.txt'],
  ['multi-line for body', 'for f in a\ndo\n  git checkout -- a.txt\ndone'],
  ['timeout wrapper inside a loop', 'for f in a; do timeout 30 git checkout -- a.txt; done'],
];

for (const [name, command] of COMPOUND_SHAPES) {
  test(`blocks a dirty-target restore inside a ${name} body`, () => {
    const f = fixture();
    try {
      dirty(f);
      const r = runHook(command, { cwd: f.root });
      assert.equal(r.status, 2, `expected a block for ${JSON.stringify(command)}; stderr=${r.stderr}`);
      assert.match(r.stderr, BLOCKED);
    } finally {
      cleanup(f);
    }
  });

  test(`allows the same ${name} restore when the target is CLEAN`, () => {
    const f = fixture();
    try {
      const r = runHook(command, { cwd: f.root });
      assert.equal(r.status, 0, `expected a pass for ${JSON.stringify(command)}; stderr=${r.stderr}`);
      assert.equal(r.stderr, '');
    } finally {
      cleanup(f);
    }
  });
}

test('the plain (non-compound) restore of a dirty target still blocks', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('git checkout -- a.txt', { cwd: f.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('a `cd` inside a subshell is tracked: `(cd <repo> && git checkout -- <file>)` blocks', () => {
  const f = fixture();
  try {
    dirty(f);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
    try {
      const r = runHook(`(cd ${f.root} && git checkout -- a.txt)`, { cwd: outside });
      assert.equal(r.status, 2, r.stderr);
    } finally {
      removeTempDir(outside, 'block-uncommitted-restore.node-test');
    }
  } finally {
    cleanup(f);
  }
});

test('a `cd` after a keyword is tracked: `if …; then cd <repo>; git restore <file>; fi` blocks', () => {
  const f = fixture();
  try {
    dirty(f);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-restore-out-')));
    try {
      const r = runHook(`if true; then cd ${f.root}; git restore a.txt; fi`, { cwd: outside });
      assert.equal(r.status, 2, r.stderr);
    } finally {
      removeTempDir(outside, 'block-uncommitted-restore.node-test');
    }
  } finally {
    cleanup(f);
  }
});

test('the inline hatch still works inside a loop body', () => {
  const f = fixture();
  try {
    dirty(f);
    const r = runHook('for f in a; do AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.txt; done', { cwd: f.root });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    cleanup(f);
  }
});
