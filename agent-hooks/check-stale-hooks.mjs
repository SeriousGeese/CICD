#!/usr/bin/env node
// SessionStart hook: (1) fast-forward a clean, zero-commits-ahead linked worktree
// to origin/main via refresh-clean-worktree.mjs, then (2) warn when THIS
// worktree's hook files are STILL older than origin/main, i.e. the session is
// executing hook logic that has already been fixed on main.
//
// Why this is needed at all: .claude/settings.json registers every hook against
// `git rev-parse --show-toplevel`, resolved from the session's cwd, which is its
// worktree. A worktree is pinned to the commit it was
// created on, so a session whose worktree predates a hook fix keeps running the
// OLD file forever. Restarting Claude Code does not help: the restart resumes
// into the same worktree. On 2026-08-22 the very session that shipped four hook
// fixes restarted and was still running all four pre-fix hooks, 34 commits
// behind main, with nothing on screen to say so.
//
// Report-only from 2026-08-22 to 2026-09-05 (fix direction 1 on the bead).
// Resolving hook paths from the primary checkout instead would change how every
// hook executes and merely move the staleness onto the primary, which lags too.
// A later change added the fast-forward instead: in the
// one state that is provably safe — clean tree, no commits of its own — the
// worktree IS origin/main-as-of-earlier and moving it forward cannot lose
// anything. That is the state of every fresh session worktree, which is where
// the staleness comes from. The refresh runs INSIDE this hook, before the
// comparison, because SessionStart hooks run concurrently and the banner must
// describe the tree the session actually ends up with. Anything the refresh
// cannot safely do (dirty tree, own commits, detached HEAD, git refused the
// fast-forward) falls through to the original banner, plus the reason.
//
// Contract, shared by every SessionStart hook in this set: plain text on STDOUT (that is what lands in the session's
// starting context) and ALWAYS exit 0. Every failure path is silent — this hook
// must never be the reason a session fails to start.
import { execFileSync } from 'node:child_process';
import { fillTemplate, tryLoadConfig } from './agent-tooling-config.mjs';
import { consumerHint } from './refusal-notice.mjs';
import { refreshCleanWorktree, renderRefresh } from './refresh-clean-worktree.mjs';

// The files whose content decides what the session's hooks DO come from the consumer's
// agent-tooling.json (`staleHookFiles`; the default is settings.json plus the hooks
// directory). settings.json belongs in any such list because a hook added on main is one an
// old worktree never runs at all, the most invisible form of this bug. A consumer whose git
// hooks live outside the hooks directory (a core.hooksPath target) lists that too, since a
// stale copy there means git hooks silently do not run.

const GIT_TIMEOUT_MS = 10_000;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function main() {
  const { config: cfg, error } = tryLoadConfig({ from: process.cwd() });
  if (error) process.stderr.write(`[hooks-stale] ${error}\n`);
  const WATCHED = cfg.staleHookFiles;

  // Step 1: the fix, when it is safe. Its own output comes first so the banner
  // below (if any) reads as "and here is what is STILL stale".
  let refresh = { action: 'noop' };
  try {
    refresh = refreshCleanWorktree();
    const lines = renderRefresh(refresh);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } catch {
    /* fall through to the report — the report is the floor, not the ceiling */
  }

  // No origin/main ref (fresh clone mid-fetch, detached CI checkout) — say nothing.
  try {
    git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  } catch {
    return;
  }

  // Three-dot: diff the MERGE BASE against origin/main, i.e. exactly "what
  // landed on main that this worktree does not have". Two-dot would also report
  // the session's own in-flight hook edits — a session fixing a hook is the
  // normal case and must not be nagged about its own work.
  const changed = git(['diff', '--name-only', 'HEAD...origin/main', '--', ...WATCHED])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // A changed test file does not change what the running hook does.
    .filter((p) => !p.endsWith('.node-test.mjs'));

  if (changed.length === 0) return;

  let behind = '';
  try {
    behind = git(['rev-list', '--count', 'HEAD..origin/main']);
  } catch {
    /* count is decoration; the file list is the signal */
  }

  const lines = [
    `[hooks-stale] This worktree is running hook files that are OLDER than origin/main${
      behind ? ` (${behind} commit${behind === '1' ? '' : 's'} behind)` : ''
    }.`,
    '[hooks-stale] Hooks resolve from THIS directory, so restarting Claude Code will not pick the fixes up:',
  ];
  for (const p of changed) lines.push(`[hooks-stale]   ${p}`);
  if (refresh.action === 'skipped' && refresh.reason) {
    lines.push(`[hooks-stale] Not fast-forwarded automatically because ${refresh.reason}.`);
  }
  lines.push('[hooks-stale] Fix: rebase this worktree on origin/main, or start work in a fresh one');
  lines.push(`[hooks-stale]      (${fillTemplate(cfg.worktreeScripts.new)}).${consumerHint(import.meta.url)}`);
  if (!refresh.fetched) {
    lines.push('[hooks-stale] Compared against the LOCAL origin/main ref — run `git fetch origin` if it is itself old.');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch {
  // Fail open, always and silently. See the header.
}
process.exit(0);
