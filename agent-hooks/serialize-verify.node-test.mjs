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
import { MAX_HOLD_MS, STAMP_GRACE_MS, readOwner, release, slotDir, staleReason, tryAcquire, tryAcquireSlot } from './serialize-verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'serialize-verify.mjs');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serialize-verify-'));
  return { dir, lock: path.join(dir, 'nested', 'verify.lock.d'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
    const r = spawnSync(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', 'process.exit(7)'], { encoding: 'utf8' });
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
      const p = spawn(process.execPath, [SCRIPT, s.lock, '--', 'node', '-e', body], { stdio: 'ignore', env: { ...process.env, AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '1' } });
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
    const env = { ...process.env, AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '2', AGENT_HOOKS_VERIFY_SLOT_FREE_GB: '0.000001' };
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
      env: { ...process.env, AGENT_HOOKS_VERIFY_LOCK_WAIT_SECONDS: '0', AGENT_HOOKS_VERIFY_MAX_CONCURRENT: '1' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gave up .* AGENT_HOOKS_SKIP_LOCAL_VERIFY=1/);
    assert.equal(fs.existsSync(marker), false, 'it ran the command without the lock');
    assert.equal(readOwner(s.lock).pid, process.pid, "it released the holder's lock");
  } finally { s.done(); }
});
