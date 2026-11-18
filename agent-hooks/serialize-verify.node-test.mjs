/**
 * serialize-verify.mjs: the pre-push local verify's lock and closed stdin.
 *
 * The lock replaced `flock -w 1800`, which does not exist in Git Bash, so Windows pushes ran
 * their verifies concurrently. These tests pin that the lock serializes on any host, breaks a
 * stale holder, gives up loudly, and that the command it runs never sees the hook's stdin (the
 * ref lines `git lfs pre-push` reads after it).
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_HOLD_MS, STAMP_GRACE_MS, fallbackSlotDir, main, readOwner, release, slotDir, staleReason, tryAcquire, tryAcquireSlot } from './serialize-verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'serialize-verify.mjs');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serialize-verify-'));
  return { dir, lock: path.join(dir, 'nested', 'verify.lock.d'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The caller's environment without the fallback knobs (or the variable a fallback run sets), so
 * a value exported in the shell that runs these tests cannot change what a test pins; then `set`.
 */
function cleanEnv(set = {}) {
  const env = { ...process.env };
  for (const k of ['AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS', 'AGENT_HOOKS_VERIFY_FALLBACK_MAX_CONCURRENT', 'AGENT_HOOKS_VERIFY_FALLBACK']) delete env[k];
  return { ...env, ...set };
}

function stamp(lock, pid, at) {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `${pid} ${at}\n`);
}

test('the first caller takes the lock (creating its parent) and stamps it with its pid', () => {
  const s = scratch();
  try {
    assert.equal(tryAcquire(s.lock, { pid: 4242, now: 1_000 }), true);
    assert.deepEqual(readOwner(s.lock), { pid: 4242, at: 1_000 });
  } finally { s.done(); }
});

test('a second caller waits while the holder is alive', () => {
  const s = scratch();
  try {
    stamp(s.lock, 4242, Date.now());
    assert.equal(tryAcquire(s.lock, { pid: 99, alive: () => true }), false);
    assert.equal(readOwner(s.lock).pid, 4242);
  } finally { s.done(); }
});

test('a lock whose holder is gone is broken and taken', () => {
  const s = scratch();
  try {
    stamp(s.lock, 4242, Date.now());
    const lines = [];
    assert.equal(tryAcquire(s.lock, { pid: 99, alive: () => false, log: (l) => lines.push(l) }), true);
    assert.equal(readOwner(s.lock).pid, 99);
    assert.match(lines.join('\n'), /holder \(pid 4242\) is gone/);
  } finally { s.done(); }
});

test('a lock held longer than any verify takes is broken even if its pid looks alive (pid reuse)', () => {
  const now = Date.now();
  const s = scratch();
  try {
    stamp(s.lock, 4242, now - MAX_HOLD_MS - 1);
    assert.match(staleReason(s.lock, { now, alive: () => true }), /held for over/);
  } finally { s.done(); }
});

test('a stampless lock is a live holder mid-acquire until the grace runs out, then stale', () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.lock, { recursive: true });
    assert.equal(staleReason(s.lock), null);
    const old = new Date(Date.now() - STAMP_GRACE_MS - 1_000);
    fs.utimesSync(s.lock, old, old);
    assert.match(staleReason(s.lock), /no owner stamp/);
  } finally { s.done(); }
});

test('release removes only a lock this process holds', () => {
  const s = scratch();
  try {
    stamp(s.lock, 4242, Date.now());
    release(s.lock, 99);
    assert.ok(fs.existsSync(s.lock), 'released a lock it did not hold');
    release(s.lock, 4242);
    assert.equal(fs.existsSync(s.lock), false);
  } finally { s.done(); }
});

test('the command runs with stdin closed: it never sees the ref lines git hands the hook', () => {
  const s = scratch();
  try {
    // Exits 3 if any byte reaches it, 0 on an immediate EOF.
    const child = "let n=0;process.stdin.on('data',d=>{n+=d.length});process.stdin.on('end',()=>process.exit(n?3:0))";
    const r = spawnSync(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', child], {
      env: cleanEnv(),
      input: 'refs/heads/b 1111111111111111111111111111111111111111 refs/heads/b 2222222222222222222222222222222222222222\n',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `the command read the hook's stdin (exit ${r.status}): ${r.stderr}`);
    assert.equal(fs.existsSync(s.lock), false, 'the lock outlived the command');
  } finally { s.done(); }
});

test("the command's exit code is the hook's", () => {
  const s = scratch();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', 'process.exit(7)'], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 7);
  } finally { s.done(); }
});

test('two pushes at once run their verifies one after the other, never overlapping', async () => {
  const s = scratch();
  try {
    const log = path.join(s.dir, 'intervals.txt');
    const body = `const fs=require('node:fs');const a=Date.now();setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},a+' '+Date.now()+'\\n')},1500)`;
    const run = () => new Promise((resolve) => {
      // One slot: what this test pins is the lock itself, not how many slots the host's memory buys.
      const p = spawn(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', body], { stdio: 'ignore', env: cleanEnv({ AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '1' }) });
      p.on('exit', resolve);
    });
    const codes = await Promise.all([run(), run()]);
    assert.deepEqual(codes, [0, 0]);
    const spans = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number)).sort((x, y) => x[0] - y[0]);
    assert.equal(spans.length, 2);
    assert.ok(spans[1][0] >= spans[0][1], `the verifies overlapped: ${JSON.stringify(spans)}`);
  } finally { s.done(); }
});

// One lock queued a whole wave of parallel agent sessions behind each other's ten-minute verifies.
test('a second slot opens only while the host has the memory for it', () => {
  const s = scratch();
  try {
    stamp(s.lock, 4242, Date.now());
    const plenty = () => 64 * 1024 ** 3;
    const scarce = () => 2 * 1024 ** 3;
    const opts = { pid: 99, alive: () => true, slotFreeBytes: 8 * 1024 ** 3 };
    assert.equal(tryAcquireSlot(s.lock, { ...opts, maxConcurrent: 3, freemem: scarce }), null, 'took a second slot with 2 GB free');
    assert.equal(tryAcquireSlot(s.lock, { ...opts, maxConcurrent: 1, freemem: plenty }), null, 'took a second slot with only one allowed');
    assert.equal(tryAcquireSlot(s.lock, { ...opts, maxConcurrent: 3, freemem: plenty }), slotDir(s.lock, 1));
    assert.equal(readOwner(slotDir(s.lock, 1)).pid, 99);
    assert.equal(readOwner(s.lock).pid, 4242, 'the first slot is still its holder\'s');
    // The first slot needs no memory check: a lone push always runs.
    release(s.lock, 4242);
    assert.equal(tryAcquireSlot(s.lock, { ...opts, pid: 7, maxConcurrent: 3, freemem: scarce }), s.lock);
  } finally { s.done(); }
});

test('with slots and the memory for them, two pushes run their verifies at once', async () => {
  const s = scratch();
  try {
    const log = path.join(s.dir, 'intervals.txt');
    const body = `const fs=require('node:fs');const a=Date.now();setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},a+' '+Date.now()+'\\n')},1500)`;
    const env = cleanEnv({ AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '2', AGENT_HOOKS_VERIFY_SLOT_FREE_GB: '0.000001' });
    const run = () => new Promise((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', body], { stdio: 'ignore', env });
      p.on('exit', resolve);
    });
    const codes = await Promise.all([run(), run()]);
    assert.deepEqual(codes, [0, 0]);
    const spans = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number)).sort((x, y) => x[0] - y[0]);
    assert.equal(spans.length, 2);
    assert.ok(spans[1][0] < spans[0][1], `the verifies ran one after the other: ${JSON.stringify(spans)}`);
    assert.equal(fs.existsSync(s.lock) || fs.existsSync(slotDir(s.lock, 1)), false, 'a slot outlived its command');
  } finally { s.done(); }
});

test('it gives up loudly when a live holder keeps the lock past the wait, and runs nothing', () => {
  const s = scratch();
  try {
    stamp(s.lock, process.pid, Date.now()); // This test process: certainly alive.
    const marker = path.join(s.dir, 'ran');
    const r = spawnSync(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`], {
      encoding: 'utf8',
      env: cleanEnv({ AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '0', AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '1' }),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gave up .* AGENT_HOOKS_SKIP_LOCAL_VERIFY=1/);
    assert.equal(fs.existsSync(marker), false, 'it ran the command without the lock');
    assert.equal(readOwner(s.lock).pid, process.pid, "it released the holder's lock");
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------
// FALLBACK AFTER A WAIT: four sessions on a host with about 4.6 GB free waited for the one slot
// and landed no push in 1.5 hours. These drive main() on a fake clock (each sleep advances it), so
// a 300 s threshold costs no real time, with a `run` stand-in that records what the command saw.
// The lock is stamped with this process's own pid: certainly alive, and a stray release(lockDir)
// would visibly remove it.

/** main() against a lock held by a live stand-in, on a fake clock. */
async function drive(s, env, { freeAfterSleeps = Infinity, code = 0 } = {}) {
  stamp(s.lock, process.pid, Date.now());
  const start = 1_000_000;
  let t = start;
  let sleeps = 0;
  const events = [];
  const runs = [];
  const deps = {
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
      sleeps += 1;
      if (sleeps === freeAfterSleeps) fs.rmSync(s.lock, { recursive: true, force: true });
    },
    freemem: () => 1, // Never the memory for a second slot: only the first one is in play.
    log: (line) => events.push(line),
    run: async (command, args, childEnv) => {
      events.push('<run>');
      runs.push({
        command,
        args,
        env: { ...childEnv },
        waitedMs: t - start,
        lockOwner: readOwner(s.lock)?.pid ?? null,
        extraSlots: [1, 2].filter((i) => fs.existsSync(slotDir(s.lock, i))),
      });
      return code;
    },
  };
  const exit = await main([s.lock, '--', 'node', 'verify.mjs'], { AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '3', ...env }, deps);
  return { exit, events, runs, sleeps, waitedMs: t - start };
}

const GAVE_UP = /^\[verify\] gave up after (\d+)s waiting for the local verify lock at .*\. Push again, or skip the local verify with AGENT_HOOKS_SKIP_LOCAL_VERIFY=1 \(CI still runs it\)\.$/;

test('fallback knob unset: a waiter that never gets a slot waits the whole budget, gives up as before, and runs nothing', async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '10' });
    assert.equal(r.exit, 1);
    assert.equal(r.runs.length, 0, 'it ran the command without a slot');
    assert.equal(r.waitedMs, 10_000, 'it did not wait the full budget');
    assert.match(r.events.at(-1), GAVE_UP);
    assert.equal(GAVE_UP.exec(r.events.at(-1))[1], '10');
    assert.doesNotMatch(r.events.join('\n'), /FALLBACK|PARTIAL/);
    assert.equal(readOwner(s.lock).pid, process.pid);
  } finally { s.done(); }
});

test('fallback knob set, slot freed before the threshold: a slotted run, and an inherited FALLBACK variable is removed', async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '300', AGENT_HOOKS_VERIFY_FALLBACK: '1' }, { freeAfterSleeps: 120 });
    assert.equal(r.exit, 0);
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].lockOwner, process.pid, 'the command ran without holding the slot');
    assert.equal(r.runs[0].waitedMs, 120_000);
    assert.equal(Object.hasOwn(r.runs[0].env, 'AGENT_HOOKS_VERIFY_FALLBACK'), false, 'a slotted run carried AGENT_HOOKS_VERIFY_FALLBACK');
    assert.doesNotMatch(r.events.join('\n'), /PARTIAL/);
    assert.equal(fs.existsSync(s.lock), false, 'the slot outlived the command');
  } finally { s.done(); }
});

test('a slot taken at once never carries the FALLBACK variable, even one exported by the caller', async () => {
  const s = scratch();
  try {
    const runs = [];
    const exit = await main([s.lock, '--', 'node', 'verify.mjs'], { AGENT_HOOKS_VERIFY_FALLBACK: '1', AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '300', KEEP: 'me' }, {
      log: () => {},
      run: async (_c, _a, childEnv) => { runs.push({ ...childEnv }); return 0; },
    });
    assert.equal(exit, 0);
    assert.equal(runs.length, 1);
    assert.equal(Object.hasOwn(runs[0], 'AGENT_HOOKS_VERIFY_FALLBACK'), false, 'a slotted run carried AGENT_HOOKS_VERIFY_FALLBACK');
    assert.equal(runs[0].KEEP, 'me', 'the rest of the environment was not passed through');
  } finally { s.done(); }
});

test('fallback knob set, no slot by the threshold: the command runs once, without a slot, with AGENT_HOOKS_VERIFY_FALLBACK=1', async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '300', KEEP: 'me' });
    assert.equal(r.exit, 0);
    assert.equal(r.runs.length, 1, 'the command did not run exactly once');
    const [run] = r.runs;
    assert.equal(run.env.AGENT_HOOKS_VERIFY_FALLBACK, '1');
    assert.equal(run.env.KEEP, 'me');
    assert.deepEqual([run.command, run.args], ['node', ['verify.mjs']]);
    assert.equal(run.lockOwner, process.pid, "the fallback touched the other owner's lock");
    assert.deepEqual(run.extraSlots, [], 'the fallback took a slot');
    assert.equal(run.waitedMs, 300_000);
  } finally { s.done(); }
});

test("a fallback run neither releases nor breaks another owner's lock", async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5' });
    assert.equal(r.runs.length, 1);
    assert.ok(fs.existsSync(s.lock), "the fallback removed the other owner's lock");
    assert.equal(readOwner(s.lock).pid, process.pid, "the other owner's stamp changed");
    assert.deepEqual([1, 2].filter((i) => fs.existsSync(slotDir(s.lock, i))), [], 'a slot dir was left behind');
    assert.equal(fs.existsSync(fallbackSlotDir(s.lock, 0)), false, 'the fallback slot outlived the run');
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------
// FALLBACK SLOTS: uncapped, three waiters at a 1 s threshold all ran beside the holder (four
// verifies where the lock allows three). Several waiters share one fake clock here: every sleep
// parks until `tick()` advances the clock a second and wakes them all, and a fallback `run` stays
// open until the test finishes it, so concurrency is observable.

function sharedClock() {
  let t = 1_000_000;
  let parked = [];
  return {
    clock: () => t,
    sleep: () => new Promise((resolve) => parked.push(resolve)),
    async tick(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 1_000;
        const wake = parked;
        parked = [];
        for (const r of wake) r();
        await new Promise((r) => setImmediate(r));
      }
    },
    parked: () => parked.length,
  };
}

/** A waiter on the shared clock; its run stays open until `finish(code)`. */
function waiter(s, sc, env, name) {
  const w = { name, runs: [], logs: [], exit: undefined };
  let finish;
  w.finish = (code = 0) => finish(code);
  w.done = main([s.lock, '--', 'node', 'verify.mjs'], { AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '3', AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '60', ...env }, {
    clock: sc.clock,
    sleep: sc.sleep,
    freemem: () => 1, // Only the first real slot is ever in play.
    log: (line) => w.logs.push(line),
    run: (_c, _a, childEnv) => new Promise((resolve) => {
      w.runs.push({ fallback: childEnv.AGENT_HOOKS_VERIFY_FALLBACK === '1', hasVar: Object.hasOwn(childEnv, 'AGENT_HOOKS_VERIFY_FALLBACK') });
      finish = resolve;
    }),
  }).then((code) => { w.exit = code; return code; });
  return w;
}

const fallbackDirs = (lock) => [0, 1, 2, 3].filter((i) => fs.existsSync(fallbackSlotDir(lock, i)));

for (const frees of ['the real slot', 'the fallback slot']) {
  test(`fallback cap 1, two waiters past the threshold: one runs as a fallback, the other waits and takes ${frees} when it frees`, async () => {
    const s = scratch();
    try {
      stamp(s.lock, process.pid, Date.now());
      const sc = sharedClock();
      const env = { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5' };
      const a = waiter(s, sc, env, 'a');
      const b = waiter(s, sc, env, 'b');
      await sc.tick(5);
      const [first, second] = a.runs.length ? [a, b] : [b, a];
      assert.equal(first.runs.length, 1, 'nobody ran as a fallback at the threshold');
      assert.equal(first.runs[0].fallback, true);
      assert.equal(second.runs.length, 0, 'a second fallback ran beside the first (cap 1)');
      assert.deepEqual(fallbackDirs(s.lock), [0]);
      await sc.tick(3);
      assert.equal(second.runs.length, 0, 'the second waiter stopped waiting');
      assert.match(second.logs.join('\n'), /all 1 fallback slot\(s\) .* are taken: still waiting/);
      if (frees === 'the real slot') {
        fs.rmSync(s.lock, { recursive: true, force: true });
        await sc.tick();
        assert.equal(second.runs.length, 1);
        assert.deepEqual(second.runs[0], { fallback: false, hasVar: false }, 'the freed real slot was not taken as a slotted run');
        assert.equal(readOwner(s.lock).pid, process.pid);
        second.finish(0);
        first.finish(0);
      } else {
        first.finish(0);
        await first.done;
        assert.deepEqual(fallbackDirs(s.lock), [], 'the finished fallback kept its slot');
        await sc.tick();
        assert.equal(second.runs.length, 1);
        assert.deepEqual(second.runs[0], { fallback: true, hasVar: true });
        second.finish(0);
      }
      assert.deepEqual(await Promise.all([a.done, b.done]), [0, 0]);
      assert.deepEqual(fallbackDirs(s.lock), [], 'a fallback slot outlived its run');
    } finally { s.done(); }
  });
}

test('fallback cap 2, three waiters past the threshold: exactly two run as fallbacks, the third waits', async () => {
  const s = scratch();
  try {
    stamp(s.lock, process.pid, Date.now());
    const sc = sharedClock();
    const env = { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5', AGENT_HOOKS_VERIFY_FALLBACK_MAX_CONCURRENT: '2' };
    const ws = ['a', 'b', 'c'].map((n) => waiter(s, sc, env, n));
    await sc.tick(8);
    assert.equal(ws.filter((w) => w.runs.length).length, 2, 'not exactly two fallbacks at once');
    assert.deepEqual(fallbackDirs(s.lock), [0, 1]);
    const idle = ws.find((w) => !w.runs.length);
    assert.equal(idle.exit, undefined, 'the third gave up instead of waiting');
    for (const w of ws) if (w.runs.length) w.finish(0);
    await sc.tick();
    assert.equal(idle.runs.length, 1);
    assert.equal(idle.runs[0].fallback, true);
    idle.finish(0);
    assert.deepEqual(await Promise.all(ws.map((w) => w.done)), [0, 0, 0]);
    assert.deepEqual(fallbackDirs(s.lock), []);
    assert.equal(readOwner(s.lock).pid, process.pid, "the holder's real slot was touched");
  } finally { s.done(); }
});

for (const bad of ['0', '-1', 'abc', '']) {
  test(`an invalid fallback cap (${JSON.stringify(bad)}) means the default 1`, async () => {
    const s = scratch();
    try {
      stamp(s.lock, process.pid, Date.now());
      const sc = sharedClock();
      const env = { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5', AGENT_HOOKS_VERIFY_FALLBACK_MAX_CONCURRENT: bad };
      const ws = ['a', 'b'].map((n) => waiter(s, sc, env, n));
      await sc.tick(7);
      assert.equal(ws.filter((w) => w.runs.length).length, 1, `${JSON.stringify(bad)} did not cap the fallbacks at 1`);
      for (const w of ws) if (w.runs.length) w.finish(0);
      await sc.tick();
      for (const w of ws) if (w.runs.length === 1 && w.exit === undefined) w.finish(0);
      await Promise.all(ws.map((w) => w.done));
    } finally { s.done(); }
  });
}

test('a fallback slot whose holder is gone is broken and taken, and released after the run', async () => {
  const s = scratch();
  try {
    stamp(s.lock, process.pid, Date.now());
    const dead = spawnSync(process.execPath, ['-e', '']).pid; // Exited: certainly not alive.
    stamp(fallbackSlotDir(s.lock, 0), dead, Date.now());
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5', AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '30' });
    assert.equal(r.runs.length, 1, 'the stale fallback slot was never broken');
    assert.equal(r.runs[0].env.AGENT_HOOKS_VERIFY_FALLBACK, '1');
    assert.match(r.events.join('\n'), new RegExp(`holder \\(pid ${dead}\\) is gone`));
    assert.equal(fs.existsSync(fallbackSlotDir(s.lock, 0)), false);
  } finally { s.done(); }
});

test("a fallback run releases its own fallback slot and nothing else: another holder's fallback slot stays", async () => {
  const s = scratch();
  try {
    stamp(s.lock, process.pid, Date.now());
    stamp(fallbackSlotDir(s.lock, 0), process.ppid, Date.now()); // A live other holder.
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5', AGENT_HOOKS_VERIFY_FALLBACK_MAX_CONCURRENT: '2' });
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].env.AGENT_HOOKS_VERIFY_FALLBACK, '1');
    assert.equal(readOwner(fallbackSlotDir(s.lock, 0)).pid, process.ppid, "the other holder's fallback slot was touched");
    assert.equal(fs.existsSync(fallbackSlotDir(s.lock, 1)), false, 'its own fallback slot outlived the run');
    assert.equal(readOwner(s.lock).pid, process.pid);
  } finally { s.done(); }
});

test('a real slot that frees on exactly the threshold poll is taken slotted, not fallen back (acquire before the threshold check)', async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5', AGENT_HOOKS_VERIFY_FALLBACK: '1' }, { freeAfterSleeps: 5 });
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].waitedMs, 5_000);
    assert.equal(Object.hasOwn(r.runs[0].env, 'AGENT_HOOKS_VERIFY_FALLBACK'), false, 'fell back although a real slot was free on that poll');
    assert.doesNotMatch(r.events.join('\n'), /PARTIAL/);
  } finally { s.done(); }
});

test("the fallback run's exit code is the hook's: a failing targeted verify still blocks the push", async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5' }, { code: 5 });
    assert.equal(r.runs.length, 1);
    assert.equal(r.exit, 5);
  } finally { s.done(); }
});

test('fallback boundary: no fallback at N-1 seconds, fallback at exactly N', async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '5', AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '30' });
    assert.equal(r.runs.length, 1);
    // One-second polls: the attempt at 4 s waits on, the attempt at 5 s falls back.
    assert.equal(r.sleeps, 5, 'it fell back before or after the threshold');
    assert.equal(r.runs[0].waitedMs, 5_000);
  } finally { s.done(); }
});

for (const [label, n] of [['equal to', '30'], ['greater than', '45']]) {
  test(`a fallback threshold ${label} the lock-wait budget never fires: today's give-up wins`, async () => {
    const s = scratch();
    try {
      const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: n, AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '30' });
      assert.equal(r.exit, 1);
      assert.equal(r.runs.length, 0, 'it fell back instead of giving up');
      assert.equal(r.waitedMs, 30_000);
      assert.match(r.events.at(-1), GAVE_UP);
      assert.doesNotMatch(r.events.join('\n'), /PARTIAL/);
    } finally { s.done(); }
  });
}

for (const bad of ['abc', '-5', '0', '']) {
  test(`an invalid fallback threshold (${JSON.stringify(bad)}) is no fallback at all`, async () => {
    const s = scratch();
    try {
      const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: bad, AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '3' });
      assert.equal(r.exit, 1);
      assert.equal(r.runs.length, 0, `${JSON.stringify(bad)} turned the fallback on`);
      assert.equal(r.waitedMs, 3_000);
      assert.match(r.events.at(-1), GAVE_UP);
    } finally { s.done(); }
  });
}

test('the partial-verify notice comes before the command starts, names the threshold, and repeats after it ends', async () => {
  const s = scratch();
  try {
    const r = await drive(s, { AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '7' }, { code: 3 });
    const runAt = r.events.indexOf('<run>');
    assert.ok(runAt > 0, 'the command did not run, or ran before any notice');
    const before = r.events.slice(0, runAt).join('\n');
    const after = r.events.slice(runAt + 1).join('\n');
    assert.match(before, /PARTIAL LOCAL VERIFY: the wait for a slot .* passed 7s .*WITHOUT a slot.*CI's gate is the authority/);
    assert.match(after, /PARTIAL LOCAL VERIFY finished with exit 3: .*7s wait.*CI's gate is the authority/);
  } finally { s.done(); }
});

test('end to end: past the threshold the real command runs without a slot and sees AGENT_HOOKS_VERIFY_FALLBACK=1', () => {
  const s = scratch();
  try {
    stamp(s.lock, process.pid, Date.now());
    const r = spawnSync(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', "process.exit(process.env.AGENT_HOOKS_VERIFY_FALLBACK === '1' ? 4 : 9)"], {
      encoding: 'utf8',
      env: cleanEnv({ AGENT_HOOKS_VERIFY_FALLBACK_AFTER_SECONDS: '1', AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '30', AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '1' }),
    });
    assert.equal(r.status, 4, `the command did not see the variable (exit ${r.status}): ${r.stderr}`);
    assert.match(r.stderr, /PARTIAL LOCAL VERIFY: .*passed 1s/);
    assert.equal(readOwner(s.lock).pid, process.pid, "it released the holder's lock");
  } finally { s.done(); }
});
