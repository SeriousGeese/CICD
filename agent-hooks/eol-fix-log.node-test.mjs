#!/usr/bin/env node
// Tests for scripts/hooks/eol-fix-log.mjs — the durable, cross-session log that
// backs the upstream-bug retirement gate. Every test uses an explicit
// `logPathOverride` so none of them ever touch this machine's real
// %LOCALAPPDATA%/agent-hooks/eol-fix.log (or its POSIX equivalent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTempDir } from './test-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_LOG_LINES,
  appendEolFixLogEntry,
  discoverClaudeCodeVersion,
  readEolFixLog,
  resolveEolFixLogPath,
} from './eol-fix-log.mjs';

test('resolveEolFixLogPath: an explicit logPathOverride always wins', () => {
  assert.equal(
    resolveEolFixLogPath({ logPathOverride: '/explicit/path.log', env: { AGENT_HOOKS_EOL_FIX_LOG: '/other.log' } }),
    '/explicit/path.log',
  );
});

test('resolveEolFixLogPath: AGENT_HOOKS_EOL_FIX_LOG env override wins over the platform default', () => {
  assert.equal(
    resolveEolFixLogPath({ env: { AGENT_HOOKS_EOL_FIX_LOG: '/from/env.log' }, platform: 'win32' }),
    '/from/env.log',
  );
});

test('resolveEolFixLogPath: win32 default is under LOCALAPPDATA', () => {
  const p = resolveEolFixLogPath({ env: { LOCALAPPDATA: 'C:\\Users\\z\\AppData\\Local' }, platform: 'win32' });
  assert.equal(p, path.join('C:\\Users\\z\\AppData\\Local', 'agent-hooks', 'eol-fix.log'));
});

test('resolveEolFixLogPath: POSIX default respects XDG_STATE_HOME, else ~/.local/state', () => {
  const withXdg = resolveEolFixLogPath({ env: { XDG_STATE_HOME: '/home/z/.state' }, platform: 'linux' });
  assert.equal(withXdg, path.join('/home/z/.state', 'agent-hooks', 'eol-fix.log'));

  const withoutXdg = resolveEolFixLogPath({ env: {}, platform: 'linux' });
  assert.ok(withoutXdg.endsWith(path.join('.local', 'state', 'agent-hooks', 'eol-fix.log')));
});

test('discoverClaudeCodeVersion: reads the first known candidate env var, else null', () => {
  assert.equal(discoverClaudeCodeVersion({ CLAUDE_CODE_VERSION: '2.1.261' }), '2.1.261');
  assert.equal(discoverClaudeCodeVersion({ CLAUDECODE_VERSION: '2.1.258' }), '2.1.258');
  assert.equal(discoverClaudeCodeVersion({}), null);
  assert.equal(discoverClaudeCodeVersion({ CLAUDE_CODE_VERSION: '   ' }), null);
});

test('appendEolFixLogEntry: writes every field, including nulls, as one JSON line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  const logPath = path.join(dir, 'eol-fix.log');
  try {
    const ok = appendEolFixLogEntry(
      { worktreePath: 'C:/git/x', harnessCreated: true, crlfFiles: 3, rewritten: 2, skippedReason: null },
      { logPathOverride: logPath, env: { CLAUDE_CODE_VERSION: '2.1.261' }, now: () => new Date('2026-09-13T00:00:00.000Z') },
    );
    assert.equal(ok, true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.deepEqual(record, {
      ts: '2026-09-13T00:00:00.000Z',
      claudeCodeVersion: '2.1.261',
      worktreePath: 'C:/git/x',
      harnessCreated: true,
      crlfFiles: 3,
      rewritten: 2,
      skippedReason: null,
    });
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});

test('appendEolFixLogEntry: defaults missing numeric/skippedReason fields sanely', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  const logPath = path.join(dir, 'eol-fix.log');
  try {
    appendEolFixLogEntry(
      { worktreePath: 'C:/git/x', harnessCreated: false },
      { logPathOverride: logPath, env: {}, now: () => new Date('2026-09-13T00:00:00.000Z') },
    );
    const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
    assert.equal(record.crlfFiles, 0);
    assert.equal(record.rewritten, 0);
    assert.equal(record.skippedReason, null);
    assert.equal(record.claudeCodeVersion, null);
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});

test('appendEolFixLogEntry: caps the log at MAX_LOG_LINES, dropping the oldest first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  const logPath = path.join(dir, 'eol-fix.log');
  try {
    for (let i = 0; i < MAX_LOG_LINES + 10; i++) {
      appendEolFixLogEntry(
        { worktreePath: `run-${i}`, harnessCreated: true, crlfFiles: 0, rewritten: 0, skippedReason: null },
        { logPathOverride: logPath, env: {}, now: () => new Date(2026, 8, 13, 0, 0, i) },
      );
    }
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, MAX_LOG_LINES);
    const first = JSON.parse(lines[0]);
    const last = JSON.parse(lines[lines.length - 1]);
    // The oldest 10 (run-0..run-9) must have been dropped; run-10 is the new oldest.
    assert.equal(first.worktreePath, 'run-10');
    assert.equal(last.worktreePath, `run-${MAX_LOG_LINES + 9}`);
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});

test('appendEolFixLogEntry: never throws when the log directory cannot be created, and reports failure', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  try {
    // A FILE sitting where a directory component needs to be — mkdirSync(..., {
    // recursive: true }) fails on this reliably, on both Windows and POSIX,
    // without depending on filesystem permission semantics.
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const logPath = path.join(blocker, 'nested', 'eol-fix.log');

    let ok;
    assert.doesNotThrow(() => {
      ok = appendEolFixLogEntry({ worktreePath: 'x', harnessCreated: true, crlfFiles: 0, rewritten: 0 }, { logPathOverride: logPath, env: {} });
    });
    assert.equal(ok, false);
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});

test('readEolFixLog: returns [] when the log file does not exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  try {
    const entries = readEolFixLog({ logPathOverride: path.join(dir, 'absent.log') });
    assert.deepEqual(entries, []);
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});

test('readEolFixLog: round-trips what appendEolFixLogEntry wrote, in order', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  const logPath = path.join(dir, 'eol-fix.log');
  try {
    appendEolFixLogEntry(
      { worktreePath: 'a', harnessCreated: true, crlfFiles: 0, rewritten: 0, skippedReason: null },
      { logPathOverride: logPath, env: {}, now: () => new Date('2026-09-01T00:00:00.000Z') },
    );
    appendEolFixLogEntry(
      { worktreePath: 'b', harnessCreated: false, crlfFiles: 2, rewritten: 2, skippedReason: null },
      { logPathOverride: logPath, env: {}, now: () => new Date('2026-09-02T00:00:00.000Z') },
    );
    const entries = readEolFixLog({ logPathOverride: logPath });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].worktreePath, 'a');
    assert.equal(entries[1].worktreePath, 'b');
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});

test('readEolFixLog: silently skips malformed / non-object lines instead of throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-eol-fix-log-'));
  const logPath = path.join(dir, 'eol-fix.log');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      logPath,
      [
        '{"ts":"2026-09-01T00:00:00.000Z","worktreePath":"a","harnessCreated":true,"crlfFiles":0,"rewritten":0,"skippedReason":null}',
        'not json at all',
        '{"broken json',
        '"just a string"', // valid JSON, but not an object with ts/worktreePath
        '',
        '   ',
        '{"ts":"2026-09-02T00:00:00.000Z","worktreePath":"b","harnessCreated":true,"crlfFiles":0,"rewritten":0,"skippedReason":null}',
      ].join('\n'),
      'utf8',
    );
    const entries = readEolFixLog({ logPathOverride: logPath });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.worktreePath), ['a', 'b']);
  } finally {
    removeTempDir(dir, 'eol-fix-log.node-test');
  }
});
