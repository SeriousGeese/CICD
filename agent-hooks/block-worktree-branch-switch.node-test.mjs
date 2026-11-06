#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hook = fileURLToPath(new URL('./block-worktree-branch-switch.mjs', import.meta.url));

/** @param {string} command @param {{ cwd?: string, env?: Record<string, string> }} [opts] */
function runHook(command, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}

function fixture() {
  const root = realRoot();
  const primary = path.join(root, 'primary');
  const worktree = path.join(root, 'worktree');
  const outside = path.join(root, 'scratch');

  mkdirSync(path.join(primary, '.git'), { recursive: true }); // .git DIR → primary
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, '.git'), 'gitdir: ../primary/.git/worktrees/worktree\n'); // .git FILE → linked worktree
  mkdirSync(outside, { recursive: true });

  return { root, primary, worktree, outside };
}

// mkdtemp then realpath so the fixture path matches what the hook's realpathSync
// returns (macOS /var → /private/var, Windows 8.3 short names, etc.).
function realRoot() {
  return mkdtempSync(path.join(tmpdir(), 'hook-wtsw-'));
}

const BLOCKED = /worktree's branch in place/;

function cleanup(f) {
  rmSync(f.root, { recursive: true, force: true });
}

// ── Blocked cases (inside a linked worktree) ────────────────────────────────
test('blocks git checkout -b inside a worktree', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -b feat/foo origin/main', { cwd: f.worktree });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('blocks git switch <branch> inside a worktree', () => {
  const f = fixture();
  try {
    const r = runHook('git switch other-branch', { cwd: f.worktree });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks git switch -c inside a worktree', () => {
  const f = fixture();
  try {
    const r = runHook('git switch -c feat/foo origin/main', { cwd: f.worktree });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks a wrapped command: env -u GITHUB_TOKEN git checkout -b', () => {
  const f = fixture();
  try {
    const r = runHook('env -u GITHUB_TOKEN git checkout -b feat/foo', { cwd: f.worktree });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('blocks a wrapped command: rtk git switch', () => {
  const f = fixture();
  try {
    const r = runHook('rtk git switch main', { cwd: f.worktree });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('tracks `cd <worktree>` from a primary cwd and blocks', () => {
  const f = fixture();
  try {
    const r = runHook(`cd ${f.worktree} && git checkout -b feat/foo`, { cwd: f.primary });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

// `/c/...` / `/d/...` is how commands are written against the Bash
// tool on Windows. path.resolve turned that into a nonexistent `C:\c\...`, so the
// guard silently did not fire. Cross-platform coverage of the normaliser itself
// lives in shell-path-lib.node-test.mjs; this is the end-to-end proof.
const WIN32_ONLY = process.platform === 'win32' ? false : 'MSYS drive form is win32-only';

// 'C:\\Users\\x\\tmp' -> '/c/Users/x/tmp'
function msysForm(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  assert.ok(m, `expected a drive-letter path, got ${winPath}`);
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

test('tracks an MSYS `cd /c/<worktree>` and blocks', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    const r = runHook(`cd ${msysForm(f.worktree)} && git checkout -b feat/foo`, { cwd: f.primary });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('honors an MSYS `git -C /c/<worktree>` and blocks', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    const r = runHook(`git -C ${msysForm(f.worktree)} switch other`, { cwd: f.primary });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('no regression: the `C:/...` drive form still blocks', { skip: WIN32_ONLY }, () => {
  const f = fixture();
  try {
    const r = runHook(`cd ${f.worktree.replace(/\\/g, '/')} && git switch other`, { cwd: f.primary });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

test('a nonexistent `cd` target still fails OPEN here (unlike the restore guard)', () => {
  const f = fixture();
  try {
    const r = runHook('cd /d/Worktrees/does-not-exist-xvmte && git checkout -b feat/foo', {
      cwd: f.worktree,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    cleanup(f);
  }
});

test('honors `git -C <worktree>` from a primary cwd and blocks', () => {
  const f = fixture();
  try {
    const r = runHook(`git -C ${f.worktree} checkout -b feat/foo`, { cwd: f.primary });
    assert.equal(r.status, 2);
  } finally {
    cleanup(f);
  }
});

// ── Allowed cases ───────────────────────────────────────────────────────────
test('allows git worktree add -b inside a worktree (the blessed pattern)', () => {
  const f = fixture();
  try {
    const r = runHook(`git worktree add ${f.outside}/new -b feat/foo origin/main`, { cwd: f.worktree });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    cleanup(f);
  }
});

test('allows git checkout -- <file> (file restore) inside a worktree', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -- package-lock.json', { cwd: f.worktree });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('allows git checkout . inside a worktree', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout .', { cwd: f.worktree });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('allows ordinary git ops (commit/push/status/restore) inside a worktree', () => {
  const f = fixture();
  try {
    for (const c of ['git commit -m x', 'git push -u origin feat/foo', 'git status', 'git restore src/a.ts', 'git branch -D old']) {
      assert.equal(runHook(c, { cwd: f.worktree }).status, 0, c);
    }
  } finally {
    cleanup(f);
  }
});

test('allows checkout -b in the PRIMARY checkout (scope: worktrees only)', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -b feat/foo origin/main', { cwd: f.primary });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('honors `cd <primary>` from a worktree cwd and allows', () => {
  const f = fixture();
  try {
    const r = runHook(`cd ${f.primary} && git checkout -b feat/foo`, { cwd: f.worktree });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('allows outside any git repo', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -b feat/foo', { cwd: f.outside });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

// ── Escape hatch + fail-open ─────────────────────────────────────────────────
test('escape hatch AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 allows a blockable command', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -b feat/foo', { cwd: f.worktree, env: { AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH: '1' } });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

// ── Inline hatch ─────────────────────────────────────────────────
// The refusal message tells an agent to set the escape hatch, which only
// works if written as a leading assignment on the SAME segment as the git
// command — process.env of the PreToolUse hook process is unreachable from
// the agent's own Bash command text.

test('inline hatch: a leading VAR=1 on the SAME command allows the switch', () => {
  const f = fixture();
  try {
    const r = runHook('AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 git checkout -b feat/foo', { cwd: f.worktree });
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('inline hatch: works after a leading cd segment too', () => {
  const f = fixture();
  try {
    const r = runHook(`cd "${f.worktree}" && AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 git switch main`);
    assert.equal(r.status, 0);
  } finally {
    cleanup(f);
  }
});

test('inline hatch: an assignment on an UNRELATED segment does not leak in', () => {
  const f = fixture();
  try {
    const r = runHook('AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 echo hi && git checkout -b feat/foo', { cwd: f.worktree });
    assert.equal(r.status, 2);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});

test('inline hatch: the refusal message shows the exact inline form', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -b feat/foo', { cwd: f.worktree });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 git checkout -b/);
  } finally {
    cleanup(f);
  }
});

test('malformed hook input fails open', () => {
  const f = fixture();
  try {
    const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8', cwd: f.worktree });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    cleanup(f);
  }
});

// ── Loop / conditional / grouping bodies ──────────────────────
// Shared keyword stripping (wrapper-strip.mjs): a switch inside a compound
// command's body is seen exactly as it is bare.
for (const command of [
  'for b in x; do git switch other-branch; done',
  'if true; then git checkout -b feat/foo; fi',
  'while true; do git switch other-branch; break; done',
  '{ git switch other-branch; }',
  '(git switch other-branch)',
]) {
  test(`blocks a branch switch inside a compound body: ${command}`, () => {
    const f = fixture();
    try {
      const r = runHook(command, { cwd: f.worktree });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, BLOCKED);
    } finally {
      cleanup(f);
    }
  });
}

test('a compound-body switch in the PRIMARY checkout is still allowed', () => {
  const f = fixture();
  try {
    const r = runHook('for b in x; do git switch other-branch; done', { cwd: f.primary });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    cleanup(f);
  }
});

// ── agent-tooling.json: the suggested worktree comes from the consumer's naming ───────────
test('the suggested worktree uses the default root and name pattern without a config', () => {
  const f = fixture();
  try {
    const r = runHook('git checkout -b feat/foo origin/main', { cwd: f.worktree });
    assert.equal(r.status, 2);
    // <repo> is the basename of the config root: the linked worktree directory.
    assert.match(r.stderr, /git worktree add \.\.\/worktree-<name> -b <branch> origin\/main/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1/);
  } finally {
    cleanup(f);
  }
});

test('a configured worktreeRoot and worktreeNamePattern shape the suggested worktree', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.worktree, 'agent-tooling.json'),
      JSON.stringify({ worktreeRoot: '/d/Trees', worktreeNamePattern: 'proj-<slug>' }),
    );
    const r = runHook('git switch other-branch', { cwd: f.worktree });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git worktree add \/d\/Trees\/proj-<name> -b <branch> origin\/main/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 git switch <branch>/);
  } finally {
    cleanup(f);
  }
});

test('a broken agent-tooling.json still blocks, with the defaults, and says so on stderr', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.worktree, 'agent-tooling.json'), '{ "worktreeRoot": 7 }');
    const r = runHook('git switch other-branch', { cwd: f.worktree });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /agent-tooling config ignored/);
    assert.match(r.stderr, BLOCKED);
  } finally {
    cleanup(f);
  }
});
