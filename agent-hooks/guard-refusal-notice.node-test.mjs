#!/usr/bin/env node
// Guardrail test: every PreToolUse guard's refusal carries the shared "nothing in this
// command ran" notice from refusal-notice.mjs.
//
// Why: a PreToolUse hook is all-or-nothing over the WHOLE command string, so when it blocks
// `rm -f X && git checkout -- Y`, the `rm` never ran either. Before the notice was shared, only
// block-masked-gates.mjs's refusal said so, and an agent mis-read its tree mid-way through a
// conflict resolution because a different guard's refusal read like an ordinary "this part is
// wrong" message.
//
// Guards are discovered from the directory this suite sits in (every block-*.mjs that is a
// PreToolUse guard), never a hardcoded list, so whichever sets a consumer vendored are all
// covered, and a guard added later fails here until it has a trigger below. Two block-*.mjs
// files are git hooks, not PreToolUse guards, and are excluded by name: "nothing in this
// command ran" is a PreToolUse guarantee that does not apply to a pre-push or pre-commit
// refusal.
//
// In a consumer, a second check reads the consumer's .claude/settings.json (found by walking up
// from here) and fails when a registered PreToolUse guard is not a file in this directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-cleanup.mjs';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const NOTICE_FRAGMENT = 'NOTHING in this command ran';
/** git hooks named block-*.mjs: not PreToolUse guards, so not covered by the notice. */
const GIT_HOOKS = new Set(['block-rebase-in-progress-push.mjs', 'block-em-dash.mjs']);

/** Every PreToolUse block-*.mjs guard present beside this suite. */
function presentGuards() {
  return readdirSync(HOOKS_DIR)
    .filter((name) => /^block-.*\.mjs$/.test(name) && !name.endsWith('.node-test.mjs') && !GIT_HOOKS.has(name))
    .sort();
}

/** The consumer's .claude/settings.json, walking up from here, or null (e.g. in CICD itself). */
function findSettings() {
  let dir = HOOKS_DIR;
  for (;;) {
    const candidate = path.join(dir, '.claude', 'settings.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function registeredPreToolUseGuards(settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const names = new Set();
  for (const group of settings?.hooks?.PreToolUse ?? []) {
    for (const h of group?.hooks ?? []) {
      for (const m of String(h?.command ?? '').matchAll(/[\\/](block-[\w-]+\.mjs)\b/g)) names.add(m[1]);
    }
  }
  return names;
}

test('every PreToolUse guard a consumer registers in .claude/settings.json is a file beside this suite', (t) => {
  const settingsPath = findSettings();
  if (!settingsPath) {
    t.skip('no .claude/settings.json above this directory (not a consumer checkout)');
    return;
  }
  const present = new Set(readdirSync(HOOKS_DIR));
  const missing = [...registeredPreToolUseGuards(settingsPath)].filter((name) => !present.has(name));
  assert.deepEqual(missing, [], `${settingsPath} registers guards that are not in ${HOOKS_DIR}`);
});

// ---- Per-guard trigger scenarios ----------------------------------------------------------
// Each returns a spawnSync-shaped { status, stderr } for a command the guard is KNOWN to
// block, building and removing its own throwaway fixture.

function run(hookName, payload, opts = {}) {
  return spawnSync(process.execPath, [opts.hook ?? path.join(HOOKS_DIR, hookName)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    removeTempDir(dir, 'guard-refusal-notice.node-test');
  }
}

const TRIGGERS = {
  'block-masked-gates.mjs': () => run('block-masked-gates.mjs', { tool_name: 'Bash', tool_input: { command: 'npm test | tail -8' } }),

  'block-uncommitted-restore.mjs': () =>
    withTempDir('hooks-grn-restore-', (rootRaw) => {
      const root = realpathSync(rootRaw);
      const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(path.join(root, 'a.txt'), 'committed\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      writeFileSync(path.join(root, 'a.txt'), 'dirty\n');
      return run('block-uncommitted-restore.mjs', { tool_input: { command: 'git checkout -- a.txt' } }, { cwd: root });
    }),

  'block-worktree-branch-switch.mjs': () =>
    withTempDir('hooks-grn-wtsw-', (root) => {
      const primary = path.join(root, 'primary');
      const worktree = path.join(root, 'worktree');
      mkdirSync(path.join(primary, '.git'), { recursive: true });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(path.join(worktree, '.git'), 'gitdir: ../primary/.git/worktrees/worktree\n');
      return run('block-worktree-branch-switch.mjs', { tool_input: { command: 'git checkout -b feat/foo origin/main' } }, { cwd: worktree });
    }),

  'block-bare-claim.mjs': () =>
    run('block-bare-claim.mjs', { tool_input: { command: 'bd update bd-6b2ai.1 --claim' } }, { env: { AGENT_HOOKS_ALLOW_BARE_CLAIM: '' } }),

  'block-pr-body-heredoc.mjs': () =>
    run('block-pr-body-heredoc.mjs', {
      tool_input: { command: 'gh pr create --title "feat: x" --body "$(cat <<\'EOF\'\nbody\nEOF\n)"' },
    }),

  'block-bash-double-backslash.mjs': () =>
    run(
      'block-bash-double-backslash.mjs',
      { tool_name: 'Bash', tool_input: { command: "printf '%s' 'a\\\\b'" } },
      { env: { AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH: '' } },
    ),

  'block-prose-backtick-substitution.mjs': () =>
    run(
      'block-prose-backtick-substitution.mjs',
      { tool_name: 'Bash', tool_input: { command: 'bd create "x" -d "its own `mod` variable"' } },
      { env: { AGENT_HOOKS_ALLOW_PROSE_BACKTICK: '' } },
    ),

  'block-npx-unlisted.mjs': () =>
    withTempDir('hooks-grn-npx-', (root) => {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
      return run(
        'block-npx-unlisted.mjs',
        { tool_name: 'Bash', tool_input: { command: 'npx prettier --write .' } },
        { cwd: root, env: { AGENT_HOOKS_ALLOW_NPX_FETCH: '' } },
      );
    }),

  'block-break-glass.mjs': () => run('block-break-glass.mjs', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash --admin' } }),

  'block-pattern-kill.mjs': () =>
    run('block-pattern-kill.mjs', { tool_name: 'Bash', tool_input: { command: 'pkill -f "jest --coverage"' } }, { env: { AGENT_HOOKS_ALLOW_PATTERN_KILL: '' } }),

  'block-primary-checkout-edits.mjs': () =>
    withTempDir('hooks-grn-primary-', (root) => {
      // The guard covers only a checkout that carries the guard itself at its own relative
      // path, so the fixture installs a real copy (and the siblings it imports).
      const primary = path.join(root, 'primary');
      const hookDir = path.join(primary, 'tools', 'hooks');
      mkdirSync(path.join(primary, '.git'), { recursive: true });
      mkdirSync(path.join(primary, 'src'), { recursive: true });
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(path.join(primary, 'src', 'existing.ts'), 'export {};\n');
      for (const name of ['block-primary-checkout-edits.mjs', 'refusal-notice.mjs', 'hook-input.mjs', 'agent-tooling-config.mjs']) {
        copyFileSync(path.join(HOOKS_DIR, name), path.join(hookDir, name));
      }
      return run(
        'block-primary-checkout-edits.mjs',
        { tool_input: { file_path: path.join(primary, 'src', 'existing.ts') } },
        { hook: path.join(hookDir, 'block-primary-checkout-edits.mjs'), env: { AGENT_HOOKS_ALLOW_MAIN_CHECKOUT_EDITS: '' } },
      );
    }),

  'block-orphaned-worktree-cwd.mjs': () =>
    withTempDir('hooks-grn-orphan-', (root) => {
      // A harness worktree directory that has lost its `.git` link.
      const emptied = path.join(root, 'primary', '.claude', 'worktrees', 'emptied');
      mkdirSync(emptied, { recursive: true });
      return run(
        'block-orphaned-worktree-cwd.mjs',
        { tool_name: 'Bash', cwd: emptied, tool_input: { command: 'git status' } },
        { env: { AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD: '' } },
      );
    }),
};

test('every PreToolUse block-*.mjs guard present here carries the shared notice when it refuses', () => {
  const guards = presentGuards();
  assert.ok(guards.length > 0, 'no block-*.mjs guards found beside this suite: discovery broken?');

  const missingTrigger = guards.filter((name) => !TRIGGERS[name]);
  assert.deepEqual(
    missingTrigger,
    [],
    `no trigger scenario for: ${missingTrigger.join(', ')}. Add one to TRIGGERS so a new guard is exercised, not skipped`,
  );

  for (const name of guards) {
    const r = TRIGGERS[name]();
    assert.equal(r.status, 2, `${name}: trigger scenario did not block (status ${r.status}); stderr:\n${r.stderr}`);
    assert.ok(r.stderr.includes(NOTICE_FRAGMENT), `${name}: refusal is missing "${NOTICE_FRAGMENT}". Got:\n${r.stderr}`);
  }
});
