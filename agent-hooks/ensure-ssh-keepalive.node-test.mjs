// ensure-ssh-keepalive.mjs: a keepalive core.sshCommand is written once
// into the SHARED repo config, and never over a transport someone already chose.
// Runs against real throwaway repos.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureSshKeepalive, KEEPALIVE_SSH_COMMAND, reasonToLeaveAlone } from './ensure-ssh-keepalive.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-ssh-keepalive.mjs');
const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// os.devNull is a "nul" device path on Windows that git reports as an unreadable config. An empty
// file in a temp dir is an empty global config on every platform.
const EMPTY_GLOBAL_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-sshka-gcfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_GLOBAL_CONFIG, '');
roots.push(path.dirname(EMPTY_GLOBAL_CONFIG));

// An env with no global/system git config, so the developer's own ~/.gitconfig cannot leak in.
const CLEAN = (() => {
  const e = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_GLOBAL_CONFIG };
  delete e.GIT_SSH_COMMAND;
  delete e.GIT_SSH;
  return e;
})();

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: CLEAN });
  return r.stdout.trim();
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-sshka-'));
  roots.push(root);
  spawnSync('git', ['init', '-q', root], { env: CLEAN });
  return root;
}

test('reasonToLeaveAlone: an env transport or any existing value wins', () => {
  assert.equal(reasonToLeaveAlone({ env: {}, configured: '' }), null);
  assert.match(reasonToLeaveAlone({ env: { GIT_SSH_COMMAND: 'ssh -v' }, configured: '' }), /GIT_SSH_COMMAND/);
  assert.match(reasonToLeaveAlone({ env: { GIT_SSH: 'plink' }, configured: '' }), /GIT_SSH /);
  assert.match(reasonToLeaveAlone({ env: {}, configured: 'ssh -i k' }), /already/);
});

test('sets the keepalive in a fresh repo, once, and a second call changes nothing', () => {
  const root = repo();
    assert.deepEqual(ensureSshKeepalive({ cwd: root, env: CLEAN }), { changed: true });
  assert.equal(git(['config', '--local', '--get', 'core.sshCommand'], root), KEEPALIVE_SSH_COMMAND);
  assert.equal(ensureSshKeepalive({ cwd: root, env: CLEAN }).changed, false);
});

test('the value lands in the shared config, so a linked worktree sees it', () => {
  const root = repo();
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], root);
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  roots.push(wt);
  git(['worktree', 'add', '-q', wt], root);
    assert.equal(ensureSshKeepalive({ cwd: wt, env: CLEAN }).changed, true);
  assert.equal(git(['config', '--get', 'core.sshCommand'], root), KEEPALIVE_SSH_COMMAND);
});

test('never overrides an existing core.sshCommand or an env transport', () => {
  const root = repo();
  git(['config', 'core.sshCommand', 'ssh -i mykey'], root);
  assert.equal(ensureSshKeepalive({ cwd: root, env: CLEAN }).changed, false);
  assert.equal(git(['config', '--get', 'core.sshCommand'], root), 'ssh -i mykey');

  const bare = repo();
    assert.equal(ensureSshKeepalive({ cwd: bare, env: { ...CLEAN, GIT_SSH: 'plink' } }).changed, false);
  assert.equal(ensureSshKeepalive({ cwd: bare, env: { ...CLEAN, GIT_SSH_COMMAND: 'ssh -v' } }).changed, false);
  assert.equal(git(['config', '--get', 'core.sshCommand'], bare), '');
});

test('CLI: --check exits 1 without writing; repair exits 0 and says what it set', () => {
  const root = repo();
  const check = spawnSync(process.execPath, [CLI, '--check'], { cwd: root, encoding: 'utf8', env: CLEAN });
  assert.equal(check.status, 1);
  assert.equal(git(['config', '--get', 'core.sshCommand'], root), '');
  const fix = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8', env: CLEAN });
  assert.equal(fix.status, 0);
  assert.match(fix.stderr, /set core\.sshCommand/);
  const again = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8', env: CLEAN });
  assert.equal(again.status, 0);
  assert.equal(again.stderr, '');
});

test('CLI exits 0 outside a repo: it must never fail a push', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-sshka-norepo-'));
  roots.push(dir);
  const r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8', env: { ...CLEAN, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(r.status, 0);
});
