// worktree-stale-banner.mjs: a session start prints one cached line and never runs the scan
// itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  banner,
  formatAge,
  LOCK_EXPIRES_MS,
  LOCK_NAME,
  needsRefresh,
  refresh,
  REFRESH_AFTER_MS,
  REPORT_NAME,
  scanArgv,
  summarize,
} from './worktree-stale-banner.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const REPORT = '  MERGED  /w/a  [refs/heads/a]\n  MERGED  /w/b  [refs/heads/b]\n[worktree-stale] 2 of 9 worktrees are on branches whose work has LANDED.\n';

function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-stale-banner-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const setAge = (file, ageMs) => {
  const when = new Date(NOW - ageMs);
  utimesSync(file, when, when);
};

test('summarize counts the nominations and stays on one line', () => {
  const line = summarize(REPORT, 3 * 60 * 60 * 1000, '/git/agent-hooks-worktree-stale.txt');
  assert.match(line, /^\[worktree-stale\] 2 worktree\(s\) are on merged branches \(scanned 3h ago\)/);
  assert.match(line, /\/git\/agent-hooks-worktree-stale\.txt/);
  assert.equal(line.includes('\n'), false);
});

test('summarize says nothing when nothing is nominated', () => {
  assert.equal(summarize('', 0, 'x'), null);
  assert.equal(summarize('[worktree-stale] 0 of 9\n', 0, 'x'), null);
});

test('the out-of-date-checkout caveat travels with the line', () => {
  const line = summarize(`[worktree-stale] ⚠ READ THIS FIRST\n${REPORT}`, 0, 'x');
  assert.match(line, /out-of-date checkout/);
});

test('formatAge', () => {
  assert.equal(formatAge(10 * 60 * 1000), 'under an hour ago');
  assert.equal(formatAge(5 * 60 * 60 * 1000), '5h ago');
  assert.equal(formatAge(72 * 60 * 60 * 1000), '3d ago');
});

test('needsRefresh: only with no report or an old one, and never over a live lock', () => {
  assert.equal(needsRefresh(null, null, NOW), true);
  assert.equal(needsRefresh(NOW - 60_000, null, NOW), false);
  assert.equal(needsRefresh(NOW - REFRESH_AFTER_MS, null, NOW), true);
  assert.equal(needsRefresh(null, NOW - 60_000, NOW), false);
  assert.equal(needsRefresh(null, NOW - LOCK_EXPIRES_MS, NOW), true);
});

test('banner on a fresh report prints the line and starts nothing', () => {
  withDir((dir) => {
    const report = path.join(dir, REPORT_NAME);
    writeFileSync(report, REPORT);
    setAge(report, 60 * 60 * 1000);
    const lines = [];
    let started = 0;
    banner({ commonDir: dir, repoRoot: dir, now: NOW, start: () => { started += 1; }, write: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.equal(started, 0);
  });
});

test('banner on an old report still prints it, and starts one refresh', () => {
  withDir((dir) => {
    const report = path.join(dir, REPORT_NAME);
    writeFileSync(report, REPORT);
    setAge(report, 2 * REFRESH_AFTER_MS);
    const lines = [];
    let started = 0;
    banner({ commonDir: dir, repoRoot: dir, now: NOW, start: () => { started += 1; }, write: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.equal(started, 1);
  });
});

test('banner with no report prints nothing and starts a refresh', () => {
  withDir((dir) => {
    const lines = [];
    let started = 0;
    banner({ commonDir: dir, repoRoot: dir, now: NOW, start: () => { started += 1; }, write: (l) => lines.push(l) });
    assert.deepEqual(lines, []);
    assert.equal(started, 1);
  });
});

test('banner leaves a scan another session already holds alone', () => {
  withDir((dir) => {
    const lock = path.join(dir, LOCK_NAME);
    writeFileSync(lock, '');
    setAge(lock, 60_000);
    let started = 0;
    banner({ commonDir: dir, repoRoot: dir, now: NOW, start: () => { started += 1; }, write: () => {} });
    assert.equal(started, 0);
  });
});

test('refresh publishes the report and releases the lock', () => {
  withDir((dir) => {
    const calls = [];
    const ok = refresh(dir, dir, (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: REPORT }; });
    assert.equal(ok, true);
    assert.equal(calls[0][0], 'bash');
    assert.equal(calls[0].at(-1), '--stale');
    assert.equal(readFileSync(path.join(dir, REPORT_NAME), 'utf8'), REPORT);
    assert.equal(existsSync(path.join(dir, LOCK_NAME)), false);
  });
});

test('a failed scan keeps the last good report and backs off', () => {
  withDir((dir) => {
    const report = path.join(dir, REPORT_NAME);
    writeFileSync(report, REPORT);
    setAge(report, 2 * REFRESH_AFTER_MS);
    assert.equal(refresh(dir, dir, () => ({ status: 1, stdout: '' })), false);
    assert.equal(readFileSync(report, 'utf8'), REPORT);

    let started = 0;
    banner({ commonDir: dir, repoRoot: dir, start: () => { started += 1; }, write: () => {} });
    assert.equal(started, 0, 'the next session start must not launch another scan');
  });
});

test('a scan that dies on its timeout counts as failed', () => {
  withDir((dir) => {
    assert.equal(refresh(dir, dir, () => ({ status: null, stdout: '' })), false);
    assert.equal(existsSync(path.join(dir, REPORT_NAME)), false);
  });
});

test('a lock past its expiry is taken over', () => {
  withDir((dir) => {
    const lock = path.join(dir, LOCK_NAME);
    writeFileSync(lock, '');
    setAge(lock, Date.now() - NOW + LOCK_EXPIRES_MS + 60_000);
    assert.equal(refresh(dir, dir, () => ({ status: 0, stdout: REPORT })), true);
  });
});

test('the real --refresh entry point runs the scan and publishes its report', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts', 'worktree-rm.sh'), "printf '  MERGED  /w/a  [refs/heads/a]\\n'\n");
    const hook = fileURLToPath(new URL('./worktree-stale-banner.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [hook, '--refresh', dir, dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(path.join(dir, REPORT_NAME), 'utf8'), /MERGED {2}\/w\/a/);
    assert.equal(existsSync(path.join(dir, LOCK_NAME)), false);
  });
});

test('refresh yields to a live lock without scanning', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, LOCK_NAME), '');
    let ran = false;
    assert.equal(refresh(dir, dir, () => { ran = true; return { status: 0, stdout: '' }; }), false);
    assert.equal(ran, false);
    assert.equal(existsSync(path.join(dir, LOCK_NAME)), true);
  });
});

// ---- consumer settings (agent-tooling.json) ----

test('summarize names the default removal command, and a configured one when given', () => {
  assert.match(summarize(REPORT, 0, 'x'), /Remove one with bash scripts\/worktree-rm\.sh <path>\./);
  assert.match(summarize(REPORT, 0, 'x', 'bash tools/rm.sh <path>'), /Remove one with bash tools\/rm\.sh <path>\./);
});

test('banner passes a configured removal command through to the line', () => {
  withDir((dir) => {
    const report = path.join(dir, REPORT_NAME);
    writeFileSync(report, REPORT);
    setAge(report, 60 * 60 * 1000);
    const lines = [];
    banner({ commonDir: dir, repoRoot: dir, now: NOW, start: () => {}, write: (l) => lines.push(l), rmCommand: 'bash tools/rm.sh <path>' });
    assert.match(lines[0], /Remove one with bash tools\/rm\.sh <path>\./);
  });
});

test('scanArgv runs the configured stale command with its script resolved, and never the rm command', () => {
  const root = path.resolve('/repo');
  assert.deepEqual(scanArgv({ worktreeScripts: { stale: 'bash scripts/worktree-rm.sh --stale' } }, root), ['bash', path.resolve(root, 'scripts/worktree-rm.sh'), '--stale']);
  assert.deepEqual(scanArgv({ worktreeScripts: { stale: 'node tools/scan.mjs --merged' } }, root), ['node', path.resolve(root, 'tools/scan.mjs'), '--merged']);
  // A --force on the removal command must not reach the background scan.
  const argv = scanArgv({ worktreeScripts: { rm: 'bash tools/rm.sh --force <path>', stale: 'bash tools/rm.sh --stale' } }, root);
  assert.equal(argv.includes('--force'), false);
});

test('refresh runs the configured stale command', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, 'agent-tooling.json'), JSON.stringify({ worktreeScripts: { stale: 'bash tools/rm.sh --stale' } }));
    const calls = [];
    const ok = refresh(dir, dir, (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: REPORT }; });
    assert.equal(ok, true);
    assert.deepEqual(calls[0], ['bash', path.resolve(dir, 'tools/rm.sh'), '--stale']);
  });
});

test('the real --refresh entry point runs a configured removal script', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, 'tools'));
    writeFileSync(path.join(dir, 'agent-tooling.json'), JSON.stringify({ worktreeScripts: { stale: 'bash tools/rm.sh --stale' } }));
    writeFileSync(path.join(dir, 'tools', 'rm.sh'), "printf '  MERGED  /w/z  [refs/heads/z]\\n'\n");
    const hook = fileURLToPath(new URL('./worktree-stale-banner.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [hook, '--refresh', dir, dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(path.join(dir, REPORT_NAME), 'utf8'), /MERGED {2}\/w\/z/);
  });
});
