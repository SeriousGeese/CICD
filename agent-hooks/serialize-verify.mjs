#!/usr/bin/env node
// Run the pre-push local verify under a per-user lock, on every platform, with
// stdin closed.
//
//   node serialize-verify.mjs <lock dir> -- <command> [args…]
//
// WHY A LOCK. Two sessions pushing at once each run `verify.mjs run --mode local`, whose
// related-test fan-out for a shared module reaches 1000+ jest suites. The hook serialized them
// with `flock -w 1800`, and `flock` does not exist in Git Bash, so on Windows, the host where N
// agent sessions push concurrently, there was no serialization at all: pushes hung 40+ minutes
// and failed on 5 s hook timeouts under the load they made for each other. This lock is a
// `mkdir` (atomic on Windows and Linux alike, the same primitive a worktree-creation lock
// can use) plus an owner stamp, so the same code serializes on every host.
//
// WHY STDIN IS CLOSED. `git lfs pre-push` runs after this in the same hook and reads the
// `<local ref> <local sha> <remote ref> <remote sha>` lines git writes to the hook's stdin. Verify and every jest/node child it starts inherited that stdin. A force-push
// that exited 141 (SIGPIPE) right after a passing verify, with the remote not updated, is the
// observed symptom; the command now gets no stdin at all, so nothing it starts can read, close
// or hold the pipe LFS depends on.
//
// STALE LOCKS. A holder whose pid is no longer alive, a lock older than MAX_HOLD_MS, or a lock
// whose owner stamp is still missing after STAMP_GRACE_MS (a crash between the mkdir and the
// stamp; a live holder writes it microseconds after the mkdir, see the stamp grace below) is broken.
//
// GIVING UP. After AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS (default 1800, flock's old budget) it exits 1 and
// says how to skip, as `flock -w` did. While it waits it says so, so a wait never reads as a hang.
//
// SLOTS, MEASURED. One lock serialized a whole wave of parallel agent sessions: N workers queued N
// ten-minute verifies, and the last waited the full 30 minutes and gave up. The lock is now a
// small set of slots: `<lock dir>` itself, then `<lock dir>.1`, `.2`… up to
// AGENT_HOOKS_VERIFY_MAX_CONCURRENT (default 3). The first slot is always open to a waiter; each further
// one only while the host has AGENT_HOOKS_VERIFY_SLOT_FREE_GB (default 8) of memory free at that moment,
// the budget for one concurrent full jest run. Measured on every attempt, so a host
// already busy with other verifies (or anything else) falls back to one at a time by itself. An
// older hook that knows only `<lock dir>` still serializes against the first slot.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_GRACE_MS = 5_000;
export const MAX_HOLD_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_SLOT_FREE_GB = 8;
const GB = 1024 ** 3;
const POLL_MS = 1_000;
const REPORT_EVERY_MS = 60_000;

/** True when `pid` names a live process (EPERM means it exists but is not ours). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** The lock's `{ pid, at }` stamp, or null when it is missing or unparseable. */
export function readOwner(lockDir) {
  let text;
  try {
    text = readFileSync(path.join(lockDir, 'owner'), 'utf8');
  } catch {
    return null;
  }
  const m = /^(\d+) (\d+)\s*$/.exec(text);
  if (!m) return null;
  const pid = Number(m[1]);
  const at = Number(m[2]);
  return pid > 0 && at > 0 ? { pid, at } : null;
}

/** Why an existing lock may be broken, or null while its holder looks live. */
export function staleReason(lockDir, { now = Date.now(), alive = pidAlive } = {}) {
  const owner = readOwner(lockDir);
  if (owner) {
    if (!alive(owner.pid)) return `its holder (pid ${owner.pid}) is gone`;
    if (now - owner.at > MAX_HOLD_MS) return `it has been held for over ${MAX_HOLD_MS / 60_000} minutes`;
    return null;
  }
  let made;
  try {
    made = statSync(lockDir).mtimeMs;
  } catch {
    return null; // Vanished between the mkdir and here: the next attempt takes it.
  }
  return now - made > STAMP_GRACE_MS ? 'it has no owner stamp' : null;
}

/** One acquire attempt: true when this process now holds the lock. */
export function tryAcquire(lockDir, { pid = process.pid, now = Date.now(), alive = pidAlive, log = () => {} } = {}) {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const reason = staleReason(lockDir, { now, alive });
    if (!reason) return false;
    log(`[verify] breaking the local verify lock at ${lockDir}: ${reason}.`);
    rmSync(lockDir, { recursive: true, force: true });
    try {
      mkdirSync(lockDir);
    } catch (again) {
      if (again?.code === 'EEXIST') return false; // Another waiter broke it first and won.
      throw again;
    }
  }
  writeFileSync(path.join(lockDir, 'owner'), `${pid} ${now}\n`);
  return true;
}

/** Remove the lock, but only while it is still this process's. */
export function release(lockDir, pid = process.pid) {
  if (readOwner(lockDir)?.pid === pid) rmSync(lockDir, { recursive: true, force: true });
}

/** Slot `i` of the lock: the lock dir itself for the first, `<lock dir>.<i>` after it. */
export function slotDir(lockDir, i) {
  return i === 0 ? lockDir : `${lockDir}.${i}`;
}

/**
 * One pass over the slots: the dir of the slot this process now holds, or null. A slot past the
 * first is tried only while `freemem()` is at least `slotFreeBytes`; see SLOTS above.
 */
export function tryAcquireSlot(lockDir, { maxConcurrent = 1, slotFreeBytes = DEFAULT_SLOT_FREE_GB * GB, freemem = os.freemem, ...opts } = {}) {
  for (let i = 0; i < maxConcurrent; i++) {
    if (i > 0 && freemem() < slotFreeBytes) return null;
    const dir = slotDir(lockDir, i);
    if (tryAcquire(dir, opts)) return dir;
  }
  return null;
}

/** Waits for a slot; resolves to the dir of the slot it took, or null after `waitMs`. */
export async function acquire(lockDir, { waitMs, maxConcurrent = 1, slotFreeBytes, freemem, log = (line) => process.stderr.write(`${line}\n`), sleep } = {}) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let lastReport = -Infinity;
  for (;;) {
    const held = tryAcquireSlot(lockDir, { maxConcurrent, slotFreeBytes, freemem, log });
    if (held) return held;
    const waited = Date.now() - started;
    if (waited >= waitMs) return null;
    if (waited - lastReport >= REPORT_EVERY_MS) {
      const owner = readOwner(lockDir);
      const holder = owner ? `pid ${owner.pid}, for ${Math.round((Date.now() - owner.at) / 1000)}s` : 'starting';
      const more = maxConcurrent > 1
        ? ` Up to ${maxConcurrent} run at once while ${Math.round((slotFreeBytes ?? DEFAULT_SLOT_FREE_GB * GB) / GB)} GB is free each; ${Math.round((freemem ?? os.freemem)() / GB)} GB is free now.`
        : '';
      log(`[verify] another push's local verify holds ${lockDir} (${holder}): waiting up to ${Math.round(waitMs / 1000)}s.${more} Skip it with AGENT_HOOKS_SKIP_LOCAL_VERIFY=1 (CI still runs it).`);
      lastReport = waited;
    }
    await pause(POLL_MS);
  }
}

/** A positive number from `raw`, or `fallback`. */
function positive(raw, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Run `command args` with stdin closed and stdout/stderr passed through; resolves to its exit code. */
export function runWithoutStdin(command, args) {
  const bin = command === 'node' ? process.execPath : command;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    const forward = (signal) => () => child.kill(signal);
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.on('error', (err) => {
      process.stderr.write(`[verify] could not start ${command}: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const sep = argv.indexOf('--');
  const lockDir = argv[0];
  if (!lockDir || sep !== 1 || argv.length < 3) {
    process.stderr.write('usage: serialize-verify.mjs <lock dir> -- <command> [args...]\n');
    return 2;
  }
  const [command, ...args] = argv.slice(2);
  const waitSeconds = Number(env.AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS);
  const waitMs = (Number.isFinite(waitSeconds) && waitSeconds >= 0 ? waitSeconds : 1800) * 1000;
  const maxConcurrent = Math.floor(positive(env.AGENT_HOOKS_VERIFY_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT));
  const slotFreeBytes = positive(env.AGENT_HOOKS_VERIFY_SLOT_FREE_GB, DEFAULT_SLOT_FREE_GB) * GB;
  const held = await acquire(lockDir, { waitMs, maxConcurrent, slotFreeBytes });
  if (!held) {
    process.stderr.write(`[verify] gave up after ${waitMs / 1000}s waiting for the local verify lock at ${lockDir}. Push again, or skip the local verify with AGENT_HOOKS_SKIP_LOCAL_VERIFY=1 (CI still runs it).\n`);
    return 1;
  }
  try {
    return await runWithoutStdin(command, args);
  } finally {
    release(held);
  }
}

// Windows-safe entry guard: a hand-built file:// URL never matches argv[1] on Windows.
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
  process.exitCode = await main();
}
