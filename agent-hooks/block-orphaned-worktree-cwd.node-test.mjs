/**
 * block-orphaned-worktree-cwd: a shell command from a harness worktree that lost its `.git` link
 * is refused instead of running against the primary checkout. Both halves: the guard
 * script, and the registered settings.json command, which must block even when the emptied
 * worktree no longer holds the guard script at all (the actual incident). The registered command
 * is the consumer's own settings.json entry, so the test builds the recommended form of it
 * against a fixture checkout that vendors the guard.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { windowsPowerShellEnv } from './windows-powershell-env.mjs';
import { main, orphanedWorktreeRoot } from './block-orphaned-worktree-cwd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'block-orphaned-worktree-cwd.mjs');
const HOOK_FILES = ['block-orphaned-worktree-cwd.mjs', 'refusal-notice.mjs', 'hook-input.mjs', 'agent-tooling-config.mjs'];
const HOOK_DIR = 'tools/hooks';

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-wt-'));
  const primary = path.join(root, 'primary');
  const live = path.join(primary, '.claude', 'worktrees', 'live-session');
  const emptied = path.join(primary, '.claude', 'worktrees', 'emptied-session');
  fs.mkdirSync(path.join(primary, '.git'), { recursive: true });
  // The consumer vendors the guard into its own checkout.
  fs.mkdirSync(path.join(primary, HOOK_DIR), { recursive: true });
  for (const f of HOOK_FILES) fs.copyFileSync(path.join(HERE, f), path.join(primary, HOOK_DIR, f));
  fs.mkdirSync(path.join(live, 'src'), { recursive: true });
  fs.writeFileSync(path.join(live, '.git'), 'gitdir: ../../../.git/worktrees/live-session\n');
  fs.mkdirSync(emptied, { recursive: true });
  return { root, primary, live, emptied, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a live worktree, its subdirectory, the primary checkout and any other cwd pass', () => {
  const l = layout();
  try {
    assert.equal(orphanedWorktreeRoot(l.live), null);
    assert.equal(orphanedWorktreeRoot(path.join(l.live, 'src')), null);
    assert.equal(orphanedWorktreeRoot(l.primary), null);
    assert.equal(orphanedWorktreeRoot(os.tmpdir()), null);
    for (const bad of [undefined, null, '', 42]) assert.equal(orphanedWorktreeRoot(bad), null);
  } finally { l.done(); }
});

test('a .claude/worktrees directory with no .git link is named, from its root or below it, either separator', () => {
  const l = layout();
  try {
    assert.equal(orphanedWorktreeRoot(l.emptied), l.emptied);
    assert.equal(orphanedWorktreeRoot(path.join(l.emptied, 'deep', 'er')), l.emptied);
    const forward = l.emptied.split(path.sep).join('/');
    assert.equal(orphanedWorktreeRoot(forward), forward);
    // A worktree directory that is gone altogether is orphaned too.
    assert.equal(orphanedWorktreeRoot(path.join(l.primary, '.claude', 'worktrees', 'gone')), path.join(l.primary, '.claude', 'worktrees', 'gone'));
  } finally { l.done(); }
});

test('main refuses with the recovery steps, and the hatch lets it through', () => {
  const l = layout();
  const writes = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    assert.equal(main({ cwd: l.emptied }, {}), 2);
    assert.equal(main({ cwd: l.emptied }, { AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD: '1' }), 0);
    assert.equal(main({ cwd: l.live }, {}), 0);
  } finally {
    process.stderr.write = write;
    l.done();
  }
  const text = writes.join('');
  assert.match(text, /has no \.git link any more/);
  assert.match(text, /PRIMARY checkout/);
  assert.match(text, /worktree-new\.sh/);
  assert.match(text, /NOTHING in this command ran/);
});

test('as the hook: exit 2 for an orphaned cwd, 0 for a live one, 0 (fail open) on unreadable input', () => {
  const l = layout();
  try {
    const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: { ...process.env, AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD: '' } });
    const blocked = run(JSON.stringify({ tool_name: 'Bash', cwd: l.emptied, tool_input: { command: 'git status' } }));
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.equal(run(JSON.stringify({ tool_name: 'Bash', cwd: l.live, tool_input: { command: 'git status' } })).status, 0);
    assert.equal(run('not json').status, 0);
  } finally { l.done(); }
});

// The recommended settings.json registration: ONE `node -e` argument that finds the checkout's
// top level, runs the vendored guard when it is there, and when it is NOT there (an emptied
// worktree holds no hooks directory at all) refuses on its own, because a guard that vanished
// with the worktree it guards would pass every command.
function registeredCommand() {
  const script =
    "let t='.';try{t=require('node:child_process').execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{}" +
    `const f=t+'/${HOOK_DIR}/block-orphaned-worktree-cwd.mjs';` +
    "if(require('node:fs').existsSync(f)){const r=require('node:child_process').spawnSync(process.execPath,[f],{stdio:'inherit'});process.exitCode=r.status===null?1:r.status}" +
    `else{console.error('Blocked: ${HOOK_DIR}/ is missing from this session directory, so it is not a checkout any more: an emptied or removed worktree. Every repo guard is gone and git would resolve the primary checkout. Run git worktree list from the primary checkout and move to a live worktree. NOTHING in this command ran.');process.exitCode=2}`;
  return `node -e "${script}"`;
}

// The hook matcher names three tools, and nothing pins which shell the harness runs a hook command
// in, so the command must mean the same thing in every shell it could meet. Each runner below is
// tried when it exists on this host; bash alone was the gap a review caught (#5254). PowerShell's
// -Command reports any failing native command as 1, so its runners forward node's own exit code,
// as a PowerShell-hosted hook runner would have to for ANY exit-2 guard in this file.
const forwardExit = (command) => `${command}; exit $LASTEXITCODE`;
const SHELLS = [
  { name: 'bash', run: (command, opts) => spawnSync('bash', ['-c', command], opts) },
  { name: 'pwsh', run: (command, opts) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', forwardExit(command)], opts) },
  {
    name: 'powershell.exe',
    windowsOnly: true,
    run: (command, opts) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', forwardExit(command)], { ...opts, env: windowsPowerShellEnv(opts.env) }),
  },
  { name: 'cmd.exe', windowsOnly: true, run: (command, opts) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...opts, windowsVerbatimArguments: true }) },
];
const available = (s) => (!s.windowsOnly || process.platform === 'win32') && s.run('exit 0', { encoding: 'utf8' }).status === 0;

test('the worktree suggestion comes from agent-tooling.json, and the consumer hint is appended', () => {
  const l = layout();
  try {
    fs.writeFileSync(
      path.join(l.primary, 'agent-tooling.json'),
      JSON.stringify({ worktreeScripts: { new: 'bash tools/wt-new.sh <slug> <branch>' } }),
    );
    fs.writeFileSync(path.join(l.primary, HOOK_DIR, 'block-orphaned-worktree-cwd.hint.txt'), 'Ask in #infra.\n');
    const r = spawnSync(process.execPath, [path.join(l.primary, HOOK_DIR, 'block-orphaned-worktree-cwd.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: l.emptied, tool_input: { command: 'git status' } }),
      encoding: 'utf8',
      env: { ...process.env, AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD: '' },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /bash tools\/wt-new\.sh <slug> <branch>/);
    assert.match(r.stderr, /Ask in #infra\./);
    assert.doesNotMatch(r.stderr, /scripts\/worktree-new\.sh/);
  } finally { l.done(); }
});

test('the registered command is not shell syntax: it parses the same under bash, PowerShell and cmd', () => {
  const command = registeredCommand();
  assert.match(command, /^node -e "[^"$`]*"$/, 'one node -e argument, with no inner double quote, $ or backtick for any shell to expand');
  assert.ok(SHELLS.some(available), 'at least one shell to run it under');
});

for (const shell of SHELLS) {
  test(`under ${shell.name}: the registered command blocks from an emptied worktree that no longer holds the guard, and runs it from a checkout`, { skip: !available(shell) && `${shell.name} is not on this host` }, () => {
    const command = registeredCommand();
    const env = { ...process.env, AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD: '' };
    const l = layout();
    try {
      // The incident: the hook runs in the emptied directory, where scripts/hooks/ does not exist.
      const emptied = shell.run(command, { cwd: l.emptied, input: JSON.stringify({ cwd: l.emptied }), encoding: 'utf8', env });
      assert.equal(emptied.status, 2, emptied.stderr);
      assert.match(emptied.stderr, /is missing from this session directory/);
      // A healthy checkout: the guard script runs, and passes a live cwd.
      const healthy = shell.run(command, { cwd: l.primary, input: JSON.stringify({ cwd: l.live }), encoding: 'utf8', env });
      assert.equal(healthy.status, 0, healthy.stderr);
      const orphaned = shell.run(command, { cwd: l.primary, input: JSON.stringify({ cwd: l.emptied }), encoding: 'utf8', env });
      assert.equal(orphaned.status, 2, 'the script half refuses an orphaned cwd it is told about');
      assert.match(orphaned.stderr, /has no \.git link any more/, 'and its own message comes through');
    } finally { l.done(); }
  });
}
