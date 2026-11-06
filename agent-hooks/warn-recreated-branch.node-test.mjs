#!/usr/bin/env node
// Tests for the warn-only pre-push recreated-branch check .
//
// Every test asserts `status === 0` as well as its own subject — warn-only is the whole
// design, matching warn-dropped-files.node-test.mjs's convention. A local BARE repo stands in
// for the remote (a `file://`-reachable origin), so `git ls-remote` genuinely runs against it
// with no network involved, the same approach other shared hook suites use for a remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { removeTempDir } from './test-cleanup.mjs';

const hook = fileURLToPath(new URL('./warn-recreated-branch.mjs', import.meta.url));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runHook(cwd) {
  // Never feed real stdin — the hook must not read it (git lfs pre-push consumes it in the
  // real chain), but also must not HANG waiting on an interactive terminal's stdin here.
  return spawnSync(process.execPath, [hook], { cwd, encoding: 'utf8', input: '' });
}

/** A working repo with a bare "origin" reachable by path — no network. */
function repoWithOrigin() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-recreated-branch-'));
  const bare = mkdtempSync(path.join(tmpdir(), 'agent-hooks-recreated-branch-origin-'));
  git(bare, ['init', '-q', '--bare', '-b', 'main']);

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['remote', 'add', 'origin', bare]);
  writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  git(root, ['push', '-q', 'origin', 'main']);
  return { root, bare };
}

test('stays silent on a branch with no upstream at all (a genuinely new branch)', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  git(root, ['checkout', '-qb', 'feature/never-pushed']);
  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('stays silent when the branch has an upstream and the remote ref still exists', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  git(root, ['checkout', '-qb', 'feature/still-open']);
  git(root, ['push', '-q', '-u', 'origin', 'feature/still-open']);
  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('warns when the branch has an upstream but the remote ref is GONE (the recreation case)', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  const branch = 'claude/initiative-tracker-demo-clips-5ccd97';
  git(root, ['checkout', '-qb', branch]);
  git(root, ['push', '-q', '-u', 'origin', branch]);
  // Simulate the branch's own PR merging and delete_branch_on_merge deleting the remote ref —
  // WITHOUT touching the local upstream config, exactly as a real merge does.
  git(bare, ['branch', '-D', branch]);

  const r = runHook(root);
  assert.equal(r.status, 0, 'warn-only: must never fail the push');
  assert.match(r.stderr, /\[recreated-branch\]/);
  assert.match(r.stderr, new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.stderr, /WARNING ONLY/);
  assert.match(r.stderr, /rebase onto current origin\/main/);
});

test('the warning fires the same way for a bead-suffixed branch name — the signal is convention-independent', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  const branch = 'fix/some-thing-bd-9xyz1';
  git(root, ['checkout', '-qb', branch]);
  git(root, ['push', '-q', '-u', 'origin', branch]);
  git(bare, ['branch', '-D', branch]);

  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /\[recreated-branch\]/);
});

test('stays silent when a DIFFERENTLY-NAMED local branch tracks an upstream that still exists', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  // The differently-named shape: local `wt/x` pushed to a differently-named remote
  // branch via `git push origin HEAD:feat/y`, which sets an upstream of
  // `origin/feat/y` without the local branch itself ever being named that.
  // The OLD check asked ls-remote about "wt/x" (never pushed under that name)
  // and warned "will CREATE it" even though feat/y — the branch actually
  // being pushed to — is alive and well; this must now stay silent.
  git(root, ['checkout', '-qb', 'wt/x']);
  git(root, ['push', '-q', 'origin', 'HEAD:feat/y']);
  git(root, ['fetch', '-q', 'origin']); // populate refs/remotes/origin/feat/y, required by set-upstream-to
  git(root, ['branch', '-q', '--set-upstream-to=origin/feat/y', 'wt/x']);

  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('warns for a DIFFERENTLY-NAMED local branch when the upstream it tracks is GONE, naming the real target', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  git(root, ['checkout', '-qb', 'wt/badge-art-bd-gqyr3']);
  git(root, ['push', '-q', 'origin', 'HEAD:feat/feedback-bd-r3jq3']);
  git(root, ['fetch', '-q', 'origin']); // populate the remote-tracking ref, required by set-upstream-to
  git(root, ['branch', '-q', '--set-upstream-to=origin/feat/feedback-bd-r3jq3', 'wt/badge-art-bd-gqyr3']);
  // The upstream branch's own PR merged and its remote ref was deleted — the
  // local branch's upstream CONFIG still points at it, unchanged.
  git(bare, ['branch', '-D', 'feat/feedback-bd-r3jq3']);

  const r = runHook(root);
  assert.equal(r.status, 0, 'warn-only: must never fail the push');
  assert.match(r.stderr, /\[recreated-branch\]/);
  // Names the REMOTE branch actually being pushed to, not the local branch name.
  assert.match(r.stderr, /feat\/feedback-bd-r3jq3/);
  assert.match(r.stderr, /wt\/badge-art-bd-gqyr3/);
});

test('stays silent with no origin remote configured at all', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-recreated-branch-noorigin-'));
  t.after(() => removeTempDir(root, 'warn-recreated-branch'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);

  const r = runHook(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('never reads stdin — a real chained "git lfs pre-push" style consumer still sees the refs', (t) => {
  const { root, bare } = repoWithOrigin();
  t.after(() => { removeTempDir(root, 'warn-recreated-branch'); removeTempDir(bare, 'warn-recreated-branch'); });

  const branch = 'claude/stdin-untouched';
  git(root, ['checkout', '-qb', branch]);
  git(root, ['push', '-q', '-u', 'origin', branch]);
  git(bare, ['branch', '-D', branch]);

  // Feed the classic pre-push stdin line. If the hook consumed it, this test would tell us
  // nothing either way — the assertion is that behaviour is IDENTICAL whether or not real
  // pre-push stdin content is present, proving the hook never reads fd 0.
  const withStdin = spawnSync(process.execPath, [hook], {
    cwd: root,
    encoding: 'utf8',
    input: `refs/heads/${branch} 0000000000000000000000000000000000000000 refs/heads/${branch} 0000000000000000000000000000000000000000\n`,
  });
  const withoutStdin = runHook(root);
  assert.equal(withStdin.status, 0);
  assert.equal(withStdin.stderr, withoutStdin.stderr, 'stdin content must not change the outcome at all');
});
