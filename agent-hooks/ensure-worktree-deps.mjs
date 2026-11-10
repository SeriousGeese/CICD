#!/usr/bin/env node
// SessionStart hook: provision a harness-created worktree that arrived without
// dependencies, or whose dependencies went stale after a rebase.
//
// The consumer's worktree script installs at creation, but the Claude Code harness
// creates .claude/worktrees/<name> ITSELF and provisions nothing, and no other
// script covers those. Every such session therefore paid a hand-run install
// before its first gate, and a session that forgot got failures that look like
// real breakage, because the worktree resolves the PRIMARY checkout's
// node_modules through the package manager's lockfile-root heuristic and the
// bundler then refuses the dev server. The same false-breakage signature also shows
// up in a worktree that WAS fully installed, then got rebased across a commit that
// added a dependency to the manifest, see depsStale() below.
//
// The install itself is delegated to the consumer's own install command
// (`worktreeScripts.install` in agent-tooling.json), deliberately: that is the same
// block creation uses, so the .<pm>-install.pid / .<pm>-install.log contract is
// identical and the consumer's await command (`worktreeScripts.await`) works against a
// harness worktree unchanged. Never a symlinked node_modules.
//
// Package managers: the lockfile name follows `packageManager` (npm package-lock.json,
// pnpm pnpm-lock.yaml, yarn yarn.lock, bun bun.lock). The install-record mtime check and
// the version-drift check read each manager's own record of the last install; the drift
// check (comparing the versions recorded against the versions the lockfile wants) exists
// for npm only, because only npm writes a lockfile-shaped JSON record.
//
// Contract, as with the other SessionStart hooks: plain text on STDOUT, ALWAYS
// exit 0, every failure path silent or report-only. A session must never fail to
// start because dependencies could not be installed.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillTemplate, tryLoadConfig } from './agent-tooling-config.mjs';

const GIT_TIMEOUT_MS = 10_000;

const LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};

// What each manager leaves inside node_modules after a SUCCESSFUL install, relative to
// node_modules. npm's is the one the mtime and drift checks were written against.
const INSTALL_RECORDS = {
  npm: ['.package-lock.json'],
  pnpm: ['.pnpm/lock.yaml', '.modules.yaml'],
  yarn: ['.yarn-integrity', '.yarn-state.yml'],
  bun: [],
};

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// Deps are stale when node_modules is missing, the package manager's own record of the
// last successful install is missing, or the lockfile has been modified more recently
// than that record. A rebase that lands a new dependency touches the lockfile's mtime
// (git rewrites mtimes on any checkout that changes content) without touching
// node_modules at all, so a worktree can have a COMPLETE, successfully-installed
// node_modules and still be wrong for the manifest it now carries. For a manager with
// no known record file (bun), the node_modules directory's own mtime stands in.
function depsStale(top, pm) {
  const nodeModules = path.join(top, 'node_modules');
  if (!existsSync(nodeModules)) return true;
  const records = INSTALL_RECORDS[pm] ?? [];
  let record = nodeModules;
  if (records.length > 0) {
    const found = records.map((r) => path.join(nodeModules, r)).find((r) => existsSync(r));
    if (!found) return true;
    record = found;
  }
  try {
    if (statSync(path.join(top, LOCKFILES[pm])).mtimeMs > statSync(record).mtimeMs) return true;
  } catch {
    return true;
  }
  return pm === 'npm' ? depsVersionDrift(top) : false;
}

// The one ordering the mtime comparison cannot see: the lockfile rewritten WHILE the
// install runs (the SessionStart [worktree-refresh] fast-forward does exactly this), so
// the install record lands NEWER than the lockfile and the tree reads fresh while holding
// the previous lock's versions. npm's own record of what it installed versus what is
// wanted is immune to the ordering. Only an entry present on BOTH sides with two
// differing versions counts (optional and platform-specific packages are legitimately
// absent from a healthy tree).
function depsVersionDrift(top) {
  let wanted, installed;
  try {
    wanted = JSON.parse(readFileSync(path.join(top, 'package-lock.json'), 'utf8'));
    installed = JSON.parse(
      readFileSync(path.join(top, 'node_modules', '.package-lock.json'), 'utf8'),
    );
  } catch {
    return false; // No verdict. Never invent a reinstall out of an unreadable file.
  }
  const want = wanted?.packages ?? {};
  const have = installed?.packages ?? {};
  for (const [entry, meta] of Object.entries(have)) {
    if (!entry || typeof meta?.version !== 'string') continue;
    const w = want[entry];
    if (typeof w?.version !== 'string') continue;
    if (w.version !== meta.version) return true;
  }
  return false;
}

/** A configured command template as an argv: split BEFORE filling, so a path with spaces stays one argument. */
function argvFor(template, values) {
  return template
    .trim()
    .split(/\s+/)
    .map((token) => fillTemplate(token, values));
}

/** True when HEAD tracks the package manager's lockfile (so its absence from the tree is a partial checkout). */
function lockfileInHead(top, pm) {
  try {
    return git(['-C', top, 'ls-tree', '--name-only', 'HEAD', '--', LOCKFILES[pm]]) !== '';
  } catch {
    return false;
  }
}

const WAIT_SECONDS = () => {
  const n = Number(process.env.AGENT_HOOKS_DEPS_WAIT_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 600;
};
const WAIT_POLL_MS = () => {
  const n = Number(process.env.AGENT_HOOKS_DEPS_WAIT_POLL_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
};

function installPidFile(top, pm) {
  return path.join(top, `.${pm}-install.pid`);
}

function readPid(file) {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Launch the waiter and return the pid a SHELL can see. On Windows a Node pid is invisible to
 * Git Bash's `kill -0`, which is exactly how `worktree-new.sh --await` decides an install is
 * still running, so the waiter is started through bash (as the install script starts its own
 * background install) and the pid is bash's `$!`. Elsewhere the child's own pid is that pid.
 */
function launchWaiter(top) {
  const script = fileURLToPath(import.meta.url);
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'bash',
        [
          '-c',
          // `exec` keeps the shell's pid, so the waiter's token ($$ exported before the exec) is
          // the same pid `$!` reports here and `kill -0` sees.
          'nohup bash -c \'export AGENT_HOOKS_DEPS_WAITER_PID=$$; exec "$0" "$@"\' "$0" "$@" >/dev/null 2>&1 </dev/null & echo $!',
          process.execPath,
          script,
          '--wait',
        ],
        { cwd: top, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (/^\d+$/.test(out)) return out;
    } catch {
      /* no usable bash: fall through to a plain spawn */
    }
  }
  const child = spawn(process.execPath, [script, '--wait'], { cwd: top, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child.pid ? String(child.pid) : null;
}

/**
 * Detached, bounded poller: starts the install once the checkout delivers the lockfile.
 * It CLAIMS the install pid file `--await` already waits on, so a worker's `--await` heartbeats on
 * the waiter instead of reporting "no install recorded" (and running its own install). A pid file
 * that already exists means an install or a waiter is already here: nothing to start.
 */
function startWaiter(top, pm, awaitCommand) {
  const pidFile = installPidFile(top, pm);
  if (existsSync(pidFile)) return;
  const pid = launchWaiter(top);
  if (!pid) return;
  try {
    writeFileSync(pidFile, `${pid}\n`, { flag: 'wx' });
  } catch {
    /* lost the race to another claimant; the waiter finds its pid is not in the file and stands down */
  }
  process.stdout.write(
    `[worktree-deps] The checkout of this worktree is not finished (the lockfile is tracked but missing).\n` +
      `[worktree-deps] A background waiter (pid ${pid}, recorded in ${path.basename(pidFile)}) will start the install once it lands, up to ${WAIT_SECONDS()}s.\n` +
      `[worktree-deps] Wait for it before any gate:\n[worktree-deps]   ${awaitCommand}\n`,
  );
}

let waiterToken = null;
const HANDOFF_MS = () => {
  const n = Number(process.env.AGENT_HOOKS_DEPS_HANDOFF_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
};

/**
 * The waiter's body: poll for the lockfile, let the checkout settle, then provision exactly as
 * SessionStart would. Its token is whatever startWaiter() wrote to the install pid file; the
 * moment the file holds anything else (a worker ran the install by hand) it stands down.
 */
async function waitThenProvision() {
  const top = git(['rev-parse', '--show-toplevel']);
  const { config: cfg } = tryLoadConfig({ from: top });
  const pm = cfg.packageManager;
  const lock = path.join(top, LOCKFILES[pm]);
  const pidFile = installPidFile(top, pm);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // This process's pid as a shell sees it (exported by the launcher), which is what the launcher
  // wrote to the pid file; process.pid when it was spawned directly.
  const token = process.env.AGENT_HOOKS_DEPS_WAITER_PID || String(process.pid);
  waiterToken = token;
  const mine = () => readPid(pidFile) === token;
  const deadline = Date.now() + WAIT_SECONDS() * 1000;
  try {
    while (!existsSync(lock) && Date.now() < deadline && mine()) await sleep(WAIT_POLL_MS());
    if (!mine() || !existsSync(lock)) return;
    await sleep(WAIT_POLL_MS()); // let the checkout finish writing
    if (!mine()) return;
    main({ waiting: true });
    // The install script replaces the file with the install's own pid; until it does, the file
    // still names this live waiter, never a dead pid. Hold on, bounded, so that stays true.
    const handoffUntil = Date.now() + HANDOFF_MS();
    while (mine() && Date.now() < handoffUntil) await sleep(100);
  } finally {
    // Remove the file only if it still holds the waiter's own token.
    try {
      if (mine()) rmSync(pidFile, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function main({ waiting = false } = {}) {
  let top;
  try {
    top = git(['rev-parse', '--show-toplevel']);
  } catch {
    return; // Not a git repo.
  }

  const { config: cfg, error } = tryLoadConfig({ from: top });
  if (error) process.stderr.write(`[worktree-deps] ${error}\n`);
  const pm = cfg.packageManager;
  const awaitCommand = fillTemplate(cfg.worktreeScripts.await, { path: top });

  // A LINKED worktree has `.git` as a FILE; the primary checkout has it as a
  // directory. The primary is shared by every session and is already installed,
  // touching it is explicitly out of scope.
  if (!existsSync(path.join(top, '.git')) || !isFile(path.join(top, '.git'))) return;

  if (!existsSync(path.join(top, LOCKFILES[pm]))) {
    // A lockfile that HEAD tracks but the tree does not have yet is a checkout still in
    // progress (the desktop app finishes a start_session worktree's full checkout in the
    // background, and SessionStart can fire first), not a repo without an install. Staying
    // silent here left such a worktree with no node_modules and nothing running. Wait for it.
    if (!waiting && lockfileInHead(top, pm)) startWaiter(top, pm, awaitCommand);
    return;
  }
  if (!depsStale(top, pm)) return;

  // An install already running (e.g. the worktree script backgrounded one seconds
  // ago) must not be duplicated: two concurrent installs on one tree corrupt
  // node_modules.
  const heldPid = readPid(installPidFile(top, pm));
  // The waiter's own token in that file is its claim, not another install: proceed and hand the file over.
  if (heldPid !== null && !(waiting && heldPid === waiterToken)) {
    process.stdout.write(`[worktree-deps] An install is already running here, wait for it before any gate:\n[worktree-deps]   ${awaitCommand}\n`);
    return;
  }

  const argv = argvFor(cfg.worktreeScripts.install, { path: top });
  // The first argument that names a file in the repo (the worktree script) must exist,
  // or there is nothing to run and the hook stays silent.
  const script = argv.slice(1).find((a) => !a.startsWith('-') && /[\\/]|\.(sh|mjs|cjs|js)$/.test(a) && a !== top);
  if (script) {
    const abs = path.resolve(top, script);
    if (!existsSync(abs)) return;
    argv[argv.indexOf(script)] = abs; // the script is run by absolute path, as creation does
  }

  // Detached: the hook returns immediately and the install proceeds while the agent
  // reads its task. Output is already captured into .<pm>-install.log by the script itself.
  const child = spawn(argv[0], argv.slice(1), {
    cwd: top,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    // Report-only: no bash, no package manager, anything. Say so and let the session start.
    process.stdout.write(
      `[worktree-deps] Dependencies are missing or stale and the install could not be started.\n[worktree-deps] Run it by hand:  ${fillTemplate(cfg.worktreeScripts.install, { path: '.' })}\n`,
    );
  });
  child.unref();

  process.stdout.write(
    `[worktree-deps] Dependencies missing or stale in this worktree, starting the ${pm} install in the BACKGROUND.\n` +
      `[worktree-deps] Log: ${path.join(top, `.${pm}-install.log`)}\n` +
      `[worktree-deps] ALWAYS wait for it before a gate (a half-installed tree fails like real breakage):\n` +
      `[worktree-deps]   ${awaitCommand}\n`,
  );
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

if (process.argv.includes('--wait')) {
  // The detached waiter started by startWaiter(): bounded, silent, always exits 0.
  try {
    await waitThenProvision();
  } catch {
    // Fail open, always.
  }
  process.exit(0);
}

try {
  main();
} catch {
  // Fail open, always. See the header.
}
process.exit(0);
