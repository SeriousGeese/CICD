#!/usr/bin/env node
// SessionStart hook: fast-forward a CLEAN, zero-commits-ahead LINKED worktree to
// origin/main before the session does anything with it.
//
// Why: .claude/settings.json registers every hook against the toplevel of the
// session's cwd (its worktree) and a worktree is pinned to the
// commit it was cut from. A harness-created session worktree is cut from the
// PRIMARY checkout's HEAD, which lags origin/main by however long it has been
// since someone pulled there. So a brand-new session routinely starts on hooks,
// scripts and docs that are hours or days behind main, and "restart Claude Code"
// does not help because the restart resumes into the same worktree.
// check-stale-hooks.mjs has reported this since 2026-08-22; it was report-only
// because rebasing on the session's behalf looked risky. It is not risky in the
// one state that matters: a worktree that is clean AND has no commits of its own
// is byte-for-byte "origin/main as of some earlier moment", and fast-forwarding it
// cannot lose anything — there is nothing to lose. That is exactly the state every
// fresh session worktree is in.
//
// The cost of NOT doing it, measured: a friction-log sweep found all three open
// entries had been fixed on main within a day of filing, by other sessions that never
// saw the fix because their trees predated it; one was filed as a P1, escalated on a
// second stale session's agreement, and retracted against a fix that had landed 13
// hours earlier.
//
// What it does, in order, stopping at the first "no":
//   1. linked worktree (never the primary — other sessions' uncommitted work
//      lives there and its branch is not ours to move);
//   2. best-effort `git fetch origin main` (15s cap, no terminal prompt) so the
//      comparison is against the REAL origin/main, not a stale local ref;
//   3. HEAD is on a branch (not detached), is an ANCESTOR of origin/main (zero
//      commits of its own), the branch's own upstream is not ahead of it (a remote
//      that has commits this checkout lacks would silently diverge from a moved
//      local ref), and the tree has no uncommitted tracked changes;
//   4. `git merge --ff-only origin/main`, with git hooks bypassed for this one
//      command: a repo's post-merge hook can take a machine-wide lock (an
//      issue-tracker sync, say) and block for minutes under another session's
//      push burst. A
//      SessionStart hook must never wait on that. Nothing the bypassed hooks do
//      matters for a fast-forward (the LFS post-merge hook only re-applies
//      read-only bits on lockable files).
//
// It reports, rather than acts on, two things the fast-forward cannot fix: a
// dependency-manifest or lockfile change in the range (ensure-worktree-deps.mjs runs
// right after this in the same settings.json command, sequenced by the shell, and
// restarts the install against the NEW lockfile) and a change to .claude/settings.json itself (the
// harness read the old file when the session started, so a hook registered on
// main still does not run until the session is restarted).
//
// Ordering matters and is deliberate: settings.json chains
// check-stale-hooks → normalize-worktree-eol → ensure-worktree-deps in ONE shell
// command. Claude Code runs separate SessionStart hooks concurrently, and both the
// merge here and normalize-worktree-eol.mjs mutate the index; run in parallel
// they can contend for index.lock and the eol hook's unlink-then-checkout-index
// would leave files deleted. The chain is what makes this safe — do not split
// those three back into separate entries.
//
// Prints one `[worktree-refresh]` line when it fast-forwards, one when it is
// behind but cannot safely fast-forward (with the reason), and nothing otherwise.
// Escape hatch: AGENT_HOOKS_NO_WORKTREE_REFRESH=1 (a deliberately pinned worktree, e.g.
// a bisect). Never fails the session: every error path is a printed skip, exit 0.
//
// Exported so check-stale-hooks.mjs can run it FIRST and then judge staleness on
// the post-refresh tree.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillTemplate, tryLoadConfig } from './agent-tooling-config.mjs';

// The dependency manifest and lockfile a package manager reads, so a fast-forward that
// moved either can say "await the install". Mirrors `packageManager` in agent-tooling.json.
const DEPENDENCY_FILES = {
  npm: ['package.json', 'package-lock.json'],
  pnpm: ['package.json', 'pnpm-lock.yaml'],
  yarn: ['package.json', 'yarn.lock'],
  bun: ['package.json', 'bun.lock'],
};

export const TAG = '[worktree-refresh]';
const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const MERGE_TIMEOUT_MS = 45_000;

/** @param {string[]} args @param {{ cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv }} [opts] */
function git(args, { cwd, timeout = GIT_TIMEOUT_MS, env } = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout, env, stdio: ['ignore', 'pipe', 'pipe'] });
}
const ok = (r) => (r.status === 0 ? r.stdout.trim() : null);

/**
 * @returns {{ action: 'noop' | 'skipped' | 'refreshed', reason?: string, branch?: string,
 *             from?: string, to?: string, behind?: string, fetched?: boolean,
 *             depsChanged?: boolean, settingsChanged?: boolean, depsFiles?: string[],
 *             awaitCommand?: string }}
 */
export function refreshCleanWorktree({ cwd = process.cwd(), fetch = true, env = process.env } = {}) {
  if (env.AGENT_HOOKS_NO_WORKTREE_REFRESH === '1') return { action: 'skipped', reason: 'AGENT_HOOKS_NO_WORKTREE_REFRESH=1' };

  const top = ok(git(['rev-parse', '--show-toplevel'], { cwd }));
  if (!top) return { action: 'noop', reason: 'not a git repository' };
  const { config: cfg } = tryLoadConfig({ from: cwd });
  const gitDir = ok(git(['rev-parse', '--git-dir'], { cwd }));
  const common = ok(git(['rev-parse', '--git-common-dir'], { cwd }));
  // Primary checkout: --git-dir and --git-common-dir are the same directory.
  if (!gitDir || !common || path.resolve(cwd, gitDir) === path.resolve(cwd, common)) {
    return { action: 'noop', reason: 'primary checkout' };
  }

  let fetched = false;
  if (fetch) {
    const f = spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], {
      cwd,
      timeout: FETCH_TIMEOUT_MS,
      stdio: 'ignore',
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    fetched = f.status === 0;
  }

  const main = ok(git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd }));
  if (!main) return { action: 'noop', reason: 'no origin/main ref', fetched };
  const head = ok(git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }));
  if (!head) return { action: 'noop', reason: 'no HEAD', fetched };
  if (head === main) return { action: 'noop', reason: 'already at origin/main', fetched };

  const behind = ok(git(['rev-list', '--count', 'HEAD..refs/remotes/origin/main'], { cwd })) ?? '?';
  if (behind === '0') return { action: 'noop', reason: 'ahead of origin/main', fetched };
  const base = { behind, fetched, from: head.slice(0, 10), to: main.slice(0, 10) };

  const branch = ok(git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }));
  if (!branch) return { ...base, action: 'skipped', reason: 'HEAD is detached' };
  base.branch = branch;

  const ancestor = git(['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], { cwd });
  if (ancestor.status !== 0) {
    const ahead = ok(git(['rev-list', '--count', 'refs/remotes/origin/main..HEAD'], { cwd })) ?? '?';
    return { ...base, action: 'skipped', reason: `${branch} has ${ahead} commit${ahead === '1' ? '' : 's'} of its own` };
  }

  // The branch's own remote may hold commits this checkout lacks (pushed from
  // another machine). Moving the local ref to origin/main would then diverge from
  // its upstream and a later --force-with-lease would overwrite them. Judged from
  // the LOCAL remote-tracking ref (only origin/main was fetched above).
  const upstreamAhead = ok(git(['rev-list', '--count', 'HEAD..@{upstream}'], { cwd }));
  if (upstreamAhead && upstreamAhead !== '0') {
    return { ...base, action: 'skipped', reason: `${branch}'s upstream has ${upstreamAhead} commit${upstreamAhead === '1' ? '' : 's'} this checkout lacks` };
  }

  const dirty = ok(git(['status', '--porcelain', '--untracked-files=no'], { cwd }));
  if (dirty === null) return { ...base, action: 'skipped', reason: 'git status failed' };
  if (dirty) return { ...base, action: 'skipped', reason: 'the tree has uncommitted changes' };

  const changedIn = (paths) => (ok(git(['diff', '--name-only', 'HEAD', 'refs/remotes/origin/main', '--', ...paths], { cwd })) ?? '') !== '';
  const depsFiles = DEPENDENCY_FILES[cfg.packageManager] ?? DEPENDENCY_FILES.npm;
  const depsChanged = changedIn(depsFiles);
  const settingsChanged = changedIn(['.claude/settings.json']);

  // An empty hooks directory: git looks for <hooksPath>/post-merge, finds nothing,
  // runs nothing. See the header for why the repo's own hooks are bypassed here.
  const noHooks = mkdtempSync(path.join(tmpdir(), 'agent-hooks-no-hooks-'));
  let ff;
  try {
    ff = git(['-c', `core.hooksPath=${noHooks}`, 'merge', '--ff-only', '--quiet', 'refs/remotes/origin/main'], {
      cwd,
      timeout: MERGE_TIMEOUT_MS,
    });
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
  if (ff.status !== 0) {
    const why = (ff.stderr || ff.stdout || '').trim().split('\n')[0] || `exit ${ff.status ?? 'null (timed out)'}`;
    return { ...base, action: 'skipped', reason: `fast-forward failed: ${why}` };
  }

  return { ...base, action: 'refreshed', depsChanged, settingsChanged, depsFiles, awaitCommand: fillTemplate(cfg.worktreeScripts.await, { path: '<this path>' }) };
}

/** Render the result as the lines a SessionStart hook prints. Empty for a noop. */
export function renderRefresh(r) {
  if (r.action === 'refreshed') {
    const lines = [
      `${TAG} fast-forwarded ${r.branch} ${r.from}..${r.to} (${r.behind} commit${r.behind === '1' ? '' : 's'} behind origin/main; ` +
        'the tree was clean with no commits of its own, so nothing could be lost). Hooks, scripts and docs now match origin/main.',
    ];
    if (r.depsChanged) {
      lines.push(
        `${TAG} ${(r.depsFiles ?? DEPENDENCY_FILES.npm).join(' / ')} changed in that range — run \`${r.awaitCommand}\` before any gate.`,
      );
    }
    if (r.settingsChanged) {
      lines.push(
        `${TAG} .claude/settings.json changed in that range — the harness read the OLD file at startup, so a hook registered on main does not run until this session is restarted.`,
      );
    }
    return lines;
  }
  if (r.action === 'skipped' && r.behind) {
    return [
      `${TAG} NOT fast-forwarded: ${r.reason} (${r.behind} commit${r.behind === '1' ? '' : 's'} behind origin/main). ` +
        'Rebase by hand when convenient — until then this tree runs older hooks, scripts and docs than main.',
    ];
  }
  return [];
}

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
  try {
    const lines = renderRefresh(refreshCleanWorktree());
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } catch (err) {
    process.stdout.write(`${TAG} skipped: ${/** @type {any} */ (err)?.message ?? err}\n`);
  }
  process.exit(0);
}
