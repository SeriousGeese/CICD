#!/usr/bin/env node
// SessionStart hook: report merged worktrees from a cached scan, so a new session never waits for
// one.
//
// The consumer's stale-worktree scan (`worktreeScripts.stale` in agent-tooling.json, default
// `bash scripts/worktree-rm.sh --stale`) used to be the hook itself, and SessionStart hooks hold the first turn.
// Across October it ran 318 times at a median of 147s (p90 394s); one session sat 9m52s before its
// first message was read. Its 60-line report was the same every time, too.
//
// So this prints ONE line from a scan kept in the git common dir, shared by every worktree, and
// when that scan is over a day old it starts a detached refresh and exits. The refresh writes a
// temp file and renames it, so a reader never sees half a report, and a lock file keeps a burst of
// session starts from running several scans at once. The report keeps the script's own caveat when
// the scan came from an out-of-date checkout, and the line says so, because removal
// decisions are made from it.
//
// Never fails a session: every error is swallowed and the hook exits 0.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, fillTemplate, findRoot, tryLoadConfig } from './agent-tooling-config.mjs';

export const REPORT_NAME = 'agent-hooks-worktree-stale.txt';
export const LOCK_NAME = 'agent-hooks-worktree-stale.lock';
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** A scan took 11m34s on a busy day, so 20 minutes means it hung. */
export const SCAN_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * Longer than a scan can run, so a lock this old belonged to a process that died. A failed scan
 * leaves its lock in place on purpose: that is the back-off that stops a scan which keeps failing
 * from running again at every session start.
 */
export const LOCK_EXPIRES_MS = 30 * 60 * 1000;

const HOOK_FILE = fileURLToPath(import.meta.url);
const DEFAULT_RM_COMMAND = fillTemplate(DEFAULTS.worktreeScripts.rm);
const TAG = '[worktree-stale]';

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

export function formatAge(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The one line for a cached report, or null when it nominates nothing. */
export function summarize(report, ageMs, reportPath, rmCommand = DEFAULT_RM_COMMAND) {
  const count = (report.match(/^ {2}MERGED {2}/gm) ?? []).length;
  if (count === 0) return null;
  const caveat = report.includes('READ THIS FIRST') ? ' That scan ran from an out-of-date checkout: read its first lines before acting.' : '';
  return `${TAG} ${count} worktree(s) are on merged branches (scanned ${formatAge(ageMs)}). List: ${reportPath} Remove one with ${rmCommand}.${caveat}`;
}

/** Whether to start a scan: no report yet, or an old one, and no live lock. */
export function needsRefresh(reportMtime, lockMtime, now = Date.now()) {
  if (lockMtime !== null && now - lockMtime < LOCK_EXPIRES_MS) return false;
  return reportMtime === null || now - reportMtime >= REFRESH_AFTER_MS;
}

function gitCommonDir(cwd) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).trim();
}

/**
 * The argv of the scan: the configured scan command (`worktreeScripts.stale`), split on
 * whitespace (so a script path may not contain a space), with the script path resolved
 * against the repository root. Its own key, never derived from `rm`: flags a consumer gives
 * its removal command (`--force`) must not ride along into a detached background scan.
 */
export function scanArgv(cfg, repoRoot) {
  const tokens = cfg.worktreeScripts.stale.trim().split(/\s+/);
  return tokens.map((t, i) => (i > 0 && !t.startsWith('-') && /[\\/]|\.(sh|mjs|cjs|js)$/.test(t) ? path.resolve(repoRoot, t) : t));
}

/** Takes the lock, or reports that another scan holds a live one. */
function takeLock(lockFile, now = Date.now()) {
  const mtime = mtimeOf(lockFile);
  if (mtime !== null) {
    if (now - mtime < LOCK_EXPIRES_MS) return false;
    rmSync(lockFile, { force: true });
  }
  try {
    closeSync(openSync(lockFile, 'wx'));
    return true;
  } catch {
    return false;
  }
}

/** Runs the scan and publishes its report. The detached half of this hook. */
export function refresh(commonDir, repoRoot, run = spawnSync) {
  const reportFile = path.join(commonDir, REPORT_NAME);
  const lockFile = path.join(commonDir, LOCK_NAME);
  if (!takeLock(lockFile)) return false;
  const [command, ...args] = scanArgv(tryLoadConfig({ root: repoRoot }).config, repoRoot);
  const result = run(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return false;
  const temp = `${reportFile}.${process.pid}.tmp`;
  writeFileSync(temp, result.stdout ?? '');
  renameSync(temp, reportFile);
  rmSync(lockFile, { force: true });
  return true;
}

function startDetachedRefresh(commonDir, repoRoot) {
  const child = spawn(process.execPath, [HOOK_FILE, '--refresh', commonDir, repoRoot], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

export function banner({ commonDir, repoRoot, now = Date.now(), start = startDetachedRefresh, write = console.log, rmCommand = DEFAULT_RM_COMMAND }) {
  const reportFile = path.join(commonDir, REPORT_NAME);
  const reportMtime = mtimeOf(reportFile);
  if (reportMtime !== null) {
    const line = summarize(readFileSync(reportFile, 'utf8'), now - reportMtime, reportFile, rmCommand);
    if (line) write(line);
  }
  if (needsRefresh(reportMtime, mtimeOf(path.join(commonDir, LOCK_NAME)), now)) start(commonDir, repoRoot);
}

// Windows-safe entry guard: compare file URLs, not raw paths.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv[2] === '--refresh') {
      refresh(process.argv[3], process.argv[4]);
    } else {
      // The repository that holds this vendored copy: a linked worktree reads its own config.
      const repoRoot = findRoot(path.dirname(HOOK_FILE));
      const { config: cfg } = tryLoadConfig({ root: repoRoot });
      banner({ commonDir: gitCommonDir(repoRoot), repoRoot, rmCommand: fillTemplate(cfg.worktreeScripts.rm) });
    }
  } catch {
    // Never fails a session. See the header.
  }
  process.exit(0);
}
