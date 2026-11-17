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
//
// FALLBACK AFTER A WAIT. Slots did not save a host with little memory: four sessions on a box
// with about 4.6 GB free each waited for the one slot, and no push landed in 1.5 hours. A
// consumer can set AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS (unset, empty, 0 or not a positive
// number: off, the default, and everything above is unchanged). Once a waiter has waited that
// long for a slot, and that is still inside the lock-wait budget, it stops waiting and runs the
// same command WITHOUT a slot, with AGENT_HOOKS_VERIFY_FALLBACK=1 in the command's environment,
// and exits with the command's code, so a failing check still blocks the push. It takes no slot
// on purpose: a consumer that sets the knob must make its command honour
// AGENT_HOOKS_VERIFY_FALLBACK=1 by running only its targeted checks, which are light enough to
// run beside the slotted ones, and a slot it took would queue the next waiter behind a run that
// was never meant to be heavy. It says loudly, before and after, that the run is partial and CI
// is the authority. A run that got a slot never carries the variable, even one inherited from
// the caller's environment.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_GRACE_MS = 5_000;
export const MAX_HOLD_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_SLOT_FREE_GB = 8;
/** The variable a fallback run's command sees; see FALLBACK AFTER A WAIT above. */
export const FALLBACK_ENV = 'AGENT_HOOKS_VERIFY_FALLBACK';
/** What `acquire` resolves to when the wait passed the fallback threshold. */
export const FALLBACK = Symbol('fallback');
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

/**
 * Waits for a slot; resolves to the dir of the slot it took, to FALLBACK once it has waited
 * `fallbackMs` (when that is positive and below `waitMs`), or to null after `waitMs`.
 */
export async function acquire(lockDir, { waitMs, fallbackMs = 0, maxConcurrent = 1, slotFreeBytes, freemem, log = (line) => process.stderr.write(`${line}\n`), sleep, clock = Date.now } = {}) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = clock();
  let lastReport = -Infinity;
  for (;;) {
    const held = tryAcquireSlot(lockDir, { maxConcurrent, slotFreeBytes, freemem, log });
    if (held) return held;
    const waited = clock() - started;
    // The budget is checked first: a threshold at or past it never fires, and the give-up stays.
    if (waited >= waitMs) return null;
    if (fallbackMs > 0 && waited >= fallbackMs) return FALLBACK;
    if (waited - lastReport >= REPORT_EVERY_MS) {
      const owner = readOwner(lockDir);
      const holder = owner ? `pid ${owner.pid}, for ${Math.round((clock() - owner.at) / 1000)}s` : 'starting';
      const more = maxConcurrent > 1
        ? ` Up to ${maxConcurrent} run at once while ${Math.round((slotFreeBytes ?? DEFAULT_SLOT_FREE_GB * GB) / GB)} GB is free each; ${Math.round((freemem ?? os.freemem)() / GB)} GB is free now.`
        : '';
      const partial = fallbackMs > 0 && fallbackMs < waitMs
        ? ` After ${Math.round(fallbackMs / 1000)}s it runs a partial verify without a slot instead.`
        : '';
      log(`[verify] another push's local verify holds ${lockDir} (${holder}): waiting up to ${Math.round(waitMs / 1000)}s.${more}${partial} Skip it with AGENT_HOOKS_SKIP_LOCAL_VERIFY=1 (CI still runs it).`);
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
export function runWithoutStdin(command, args, env = process.env) {
  const bin = command === 'node' ? process.execPath : command;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'], env });
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

/**
 * The hook. `deps` exists for tests: `sleep`, `clock` and `freemem` drive the wait without real
 * time or memory, `log` receives each stderr line, and `run(command, args, env)` stands in for
 * runWithoutStdin.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { sleep, clock, freemem, run = runWithoutStdin } = deps;
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  const sep = argv.indexOf('--');
  const lockDir = argv[0];
  if (!lockDir || sep !== 1 || argv.length < 3) {
    log('usage: serialize-verify.mjs <lock dir> -- <command> [args...]');
    return 2;
  }
  const [command, ...args] = argv.slice(2);
  const waitSeconds = Number(env.AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS);
  const waitMs = (Number.isFinite(waitSeconds) && waitSeconds >= 0 ? waitSeconds : 1800) * 1000;
  const maxConcurrent = Math.floor(positive(env.AGENT_HOOKS_VERIFY_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT));
  const slotFreeBytes = positive(env.AGENT_HOOKS_VERIFY_SLOT_FREE_GB, DEFAULT_SLOT_FREE_GB) * GB;
  // Off (0) unless a positive number of seconds: see FALLBACK AFTER A WAIT above.
  const fallbackSeconds = positive(env.AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS, 0);
  const held = await acquire(lockDir, { waitMs, fallbackMs: fallbackSeconds * 1000, maxConcurrent, slotFreeBytes, freemem, log, sleep, clock });
  if (!held) {
    log(`[verify] gave up after ${waitMs / 1000}s waiting for the local verify lock at ${lockDir}. Push again, or skip the local verify with AGENT_HOOKS_SKIP_LOCAL_VERIFY=1 (CI still runs it).`);
    return 1;
  }
  if (held === FALLBACK) {
    // No slot is taken and none is released: every lock dir here belongs to someone else.
    log(`[verify] PARTIAL LOCAL VERIFY: the wait for a slot at ${lockDir} passed ${fallbackSeconds}s (AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS=${fallbackSeconds}). Running the verify WITHOUT a slot, with ${FALLBACK_ENV}=1, so it runs only its targeted checks. CI's gate is the authority for this push.`);
    const code = await run(command, args, { ...env, [FALLBACK_ENV]: '1' });
    log(`[verify] PARTIAL LOCAL VERIFY finished with exit ${code}: it ran without a slot after a ${fallbackSeconds}s wait, so it was not the full local verify. CI's gate is the authority for this push.`);
    return code;
  }
  try {
    const childEnv = { ...env };
    delete childEnv[FALLBACK_ENV]; // A stale exported value must not make a slotted run partial.
    return await run(command, args, childEnv);
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
