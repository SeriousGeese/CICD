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
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
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

function main() {
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

  if (!existsSync(path.join(top, LOCKFILES[pm]))) return;
  if (!depsStale(top, pm)) return;

  // An install already running (e.g. the worktree script backgrounded one seconds
  // ago) must not be duplicated: two concurrent installs on one tree corrupt
  // node_modules.
  if (existsSync(path.join(top, `.${pm}-install.pid`))) {
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

try {
  main();
} catch {
  // Fail open, always. See the header.
}
process.exit(0);
