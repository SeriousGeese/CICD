#!/usr/bin/env node
// Give this repo's SSH transport a keepalive, so a push survives the pre-push verify.
//
// Git opens the SSH connection to the remote BEFORE it runs the pre-push hook, and the hook's local
// verify leaves that connection silent the whole time. Past roughly five minutes of silence GitHub
// closes it ("Connection to github.com closed by remote host.", printed MID-verify and easily lost
// in thousands of lines of test output), and git, writing to the dead pipe after the hook returns,
// dies: exit 141, or a backgrounded push that reads as exit 0. The hook said VERIFY
// PASS and the branch was NOT updated. 23 such push logs from 2026-10-23..26 all waited 4-12 min
// (the shared verify lock plus a 4-8 min verify); a probe hook idling 300 s survived, 480 s did
// not without keepalives and did with them. SSH keepalives make the client talk while it waits.
//
// A hook cannot fix the push it runs inside (that connection is already open), so this writes
// `core.sshCommand` into the repo's SHARED config (`--local` is the common .git/config, seen by every
// linked worktree), once, and every later push uses it. It is meant to be called from a consumer's setup
// script and, as the self-healing path for clones that never re-ran setup, from its pre-push hook.
//
// It never overrides a choice someone already made: GIT_SSH_COMMAND or GIT_SSH in the environment
// (GIT_SSH_COMMAND outranks core.sshCommand, but core.sshCommand outranks GIT_SSH, so setting it
// would silently replace a plink setup), or a core.sshCommand at ANY scope. Git LFS reads the same
// settings for its SSH probe; extra `-o` options are inert there.
//
// Usage: node ensure-ssh-keepalive.mjs [--check]   (the path of this script as vendored)
//   prints one line to stderr when it sets the value; silent otherwise. Always exits 0 in repair
//   mode (it must never fail a push); --check exits 1 when the value would be set.

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEPALIVE_SSH_COMMAND = 'ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=60';

/** Why the value is left alone, or null when it should be set. Pure. */
export function reasonToLeaveAlone({ env, configured }) {
  if (env.GIT_SSH_COMMAND) return 'GIT_SSH_COMMAND is set in the environment';
  if (env.GIT_SSH) return 'GIT_SSH is set in the environment';
  if (configured) return `core.sshCommand is already "${configured}"`;
  return null;
}

function git(args, cwd, env) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

export function ensureSshKeepalive({ cwd = process.cwd(), env = process.env, check = false } = {}) {
  const got = git(['config', '--get', 'core.sshCommand'], cwd, env);
  if (got.error || (got.status !== 0 && got.status !== 1)) return { changed: false, reason: 'git config unreadable' };
  const reason = reasonToLeaveAlone({ env, configured: got.status === 0 ? got.stdout.trim() : '' });
  if (reason) return { changed: false, reason };
  if (check) return { changed: false, wouldSet: true };
  const set = git(['config', '--local', 'core.sshCommand', KEEPALIVE_SSH_COMMAND], cwd, env);
  return set.status === 0 ? { changed: true } : { changed: false, reason: (set.stderr || '').trim() };
}

/**
 * True when this module is the process entry point. Compared through realpath on both sides:
 * node resolves import.meta.url through symlinks and junctions but leaves argv[1] as typed, so
 * a plain comparison is false whenever the checkout is reached through a link, and the hook
 * then silently does nothing (a guard that fails open).
 */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const check = process.argv.includes('--check');
  const r = ensureSshKeepalive({ check });
  if (r.changed) {
    console.error(`[ssh-keepalive] set core.sshCommand="${KEEPALIVE_SSH_COMMAND}" for this repo.`);
    console.error('[ssh-keepalive] A push already in flight predates it: if git exits 141 or prints "Connection');
    console.error('[ssh-keepalive] to github.com closed by remote host" after VERIFY PASS, the ref was NOT updated; push again.');
  } else if (check && r.wouldSet) {
    console.error('[ssh-keepalive] core.sshCommand is unset: run node ' + path.relative(process.cwd(), fileURLToPath(import.meta.url)).split(path.sep).join('/'));
    process.exit(1);
  }
  process.exit(0);
}
