#!/usr/bin/env node
// Durable, cross-session log of every normalize-worktree-eol.mjs SessionStart run
//
// Why: the upstream-bug retirement gate (a check that an upstream harness bug is gone)
// needs "no [eol-fix] line has been
// reported" to be checkable from a LATER session, not just narrated in the
// transcript that happened to be open when a run occurred. `[eol-fix]` is
// printed to stdout and nowhere else, so a verify script was
// capped at NEEDS-MANUAL even on a perfectly clean worktree — a single clean
// reading proves nothing, and a log that starts empty the moment this PR lands
// would let the gate pass on zero real observations. This module gives every
// hook run (not just the ones that had something to fix) a durable record, so
// the verify script can require a real SPAN of clean runs before calling it
// retirable.
//
// The log lives OUTSIDE every worktree, keyed by machine, not by repo clone or
// branch — the bug this tracks is a property of the Claude Code harness on this
// machine, not of any one worktree. One JSON line per hook run:
//
//   {"ts":"2026-09-13T12:00:00.000Z","claudeCodeVersion":"2.1.261","worktreePath":"C:/...","
//    harnessCreated":true,"crlfFiles":0,"rewritten":0,"skippedReason":null}
//
// Capped at MAX_LOG_LINES entries (oldest dropped first) so it never grows
// unbounded across a machine's lifetime of sessions.
//
// Every write and read is best-effort: a hook must never fail the session over
// logging, and a verify script must never crash on a partially-written or
// hand-edited log line — malformed lines are skipped, not thrown.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Oldest entries are dropped once the log exceeds this many lines. */
export const MAX_LOG_LINES = 500;

/**
 * Resolve the durable log path for this machine.
 *
 * Override order: an explicit `logPathOverride`, then `env.AGENT_HOOKS_EOL_FIX_LOG`
 * (what tests use so they never touch a real machine-wide file), then the
 * platform default — `%LOCALAPPDATA%/agent-hooks/eol-fix.log` on Windows,
 * `$XDG_STATE_HOME/agent-hooks/eol-fix.log` (falling back to
 * `~/.local/state/agent-hooks/eol-fix.log`) elsewhere.
 */
export function resolveEolFixLogPath({ env = process.env, platform = process.platform, logPathOverride } = {}) {
  if (logPathOverride) return logPathOverride;
  const envOverride = String(env.AGENT_HOOKS_EOL_FIX_LOG ?? '').trim();
  if (envOverride) return envOverride;

  if (platform === 'win32') {
    const base = String(env.LOCALAPPDATA ?? '').trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'agent-hooks', 'eol-fix.log');
  }

  const xdgState = String(env.XDG_STATE_HOME ?? '').trim();
  const base = xdgState || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'agent-hooks', 'eol-fix.log');
}

/**
 * Best-effort discovery of the running Claude Code version from env. No
 * documented single env var carries it, so this tries the plausible
 * candidates in order and returns null rather than guessing.
 */
export function discoverClaudeCodeVersion(env = process.env) {
  const candidates = [env.CLAUDE_CODE_VERSION, env.CLAUDECODE_VERSION];
  for (const c of candidates) {
    const v = String(c ?? '').trim();
    if (v) return v;
  }
  return null;
}

/**
 * Append one run record to the durable log, capping it at MAX_LOG_LINES.
 * NEVER throws — a hook that logs must never fail the session, and this
 * function is also called from a hook whose caller already wraps everything
 * in try/catch, so this is belt-and-suspenders, not redundant paranoia: an
 * unwritable log directory (locked-down machine, read-only home) must degrade
 * to "nothing recorded", never to a broken SessionStart.
 *
 * @param {object} entry
 * @param {string} entry.worktreePath
 * @param {boolean} entry.harnessCreated
 * @param {number} entry.crlfFiles
 * @param {number} entry.rewritten
 * @param {string|null} [entry.skippedReason]
 * @param {{env?: object, platform?: string, logPathOverride?: string, now?: () => Date}} [opts]
 * @returns {boolean} true if the write succeeded.
 */
export function appendEolFixLogEntry(entry, opts = {}) {
  const { env = process.env, platform = process.platform, logPathOverride, now = () => new Date() } = opts;
  try {
    const logPath = resolveEolFixLogPath({ env, platform, logPathOverride });
    const record = {
      ts: now().toISOString(),
      claudeCodeVersion: discoverClaudeCodeVersion(env),
      worktreePath: String(entry.worktreePath ?? ''),
      harnessCreated: Boolean(entry.harnessCreated),
      crlfFiles: Number.isFinite(entry.crlfFiles) ? entry.crlfFiles : 0,
      rewritten: Number.isFinite(entry.rewritten) ? entry.rewritten : 0,
      skippedReason: entry.skippedReason ?? null,
    };

    mkdirSync(path.dirname(logPath), { recursive: true });

    let lines = [];
    if (existsSync(logPath)) {
      try {
        lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      } catch {
        lines = [];
      }
    }
    lines.push(JSON.stringify(record));
    if (lines.length > MAX_LOG_LINES) lines = lines.slice(lines.length - MAX_LOG_LINES);

    // Rewrite whole-file rather than appendFileSync + separate truncate: the cap
    // has to apply atomically with the write, or a crash between the two could
    // leave the file uncapped forever with nothing to re-trigger the trim.
    writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every parseable entry from the durable log, oldest first. Malformed
 * lines (hand-edited, truncated by a crash mid-write, from a future schema
 * version) are silently skipped rather than throwing — a verify script must
 * still reach a verdict from whatever valid history exists.
 *
 * @param {{env?: object, platform?: string, logPathOverride?: string}} [opts]
 * @returns {Array<object>}
 */
export function readEolFixLog(opts = {}) {
  const { env = process.env, platform = process.platform, logPathOverride } = opts;
  const logPath = resolveEolFixLogPath({ env, platform, logPathOverride });
  if (!existsSync(logPath)) return [];
  let raw;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'string' && typeof parsed.worktreePath === 'string') {
        out.push(parsed);
      }
    } catch {
      // malformed line — skip it, do not throw.
    }
  }
  return out;
}
