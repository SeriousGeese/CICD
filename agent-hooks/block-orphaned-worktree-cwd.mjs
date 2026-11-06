#!/usr/bin/env node
// PreToolUse(Bash/PowerShell/Monitor) hook: refuse to run a shell command from a harness worktree
// that has lost its `.git` link.
//
// The incident (2026-10-23): a live bulk-orchestration lead's worktree,
// `.claude/worktrees/pr-3960-closure-check-8e53c8`, was emptied and unregistered mid-session. The
// directory still existed, so the shell still started there; but with no `.git` file in it, git
// walked UP and found the PRIMARY checkout, because `.claude/worktrees/` lives inside it.
// `git rev-parse --show-toplevel` answered the primary checkout's path, the repo's `scripts/` was
// missing, and every command after that ran against the shared checkout until a repo script
// happened to die with MODULE_NOT_FOUND. Which remover did it is still unknown; this guard makes
// the state loud the moment the next command runs, wherever it came from.
//
// Shape: the session cwd (the hook input's `cwd`) is `<anything>/.claude/worktrees/<name>[/...]`,
// and `<that worktree root>/.git` does not exist. A `.claude/worktrees/<name>` that IS a worktree
// has a `.git` FILE there; the primary checkout itself and every other cwd are not this guard's
// business. Fails OPEN on anything unexpected: a guard that can brick every shell command when the
// environment is odd is worse than the bug it guards.
//
// Escape hatch: AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD=1.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { readHookInput } from './hook-input.mjs';
import { fillTemplate, tryLoadConfig } from './agent-tooling-config.mjs';

const WORKTREE_ROOT = /^(.*[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)(?:[\\/].*)?$/i;

/**
 * The orphaned worktree root `cwd` sits in, or null when `cwd` is fine (or not a harness worktree
 * path at all). `exists` is injectable for the tests. Pure apart from it.
 */
export function orphanedWorktreeRoot(cwd, exists = existsSync) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const m = WORKTREE_ROOT.exec(cwd);
  if (!m) return null;
  const root = m[1];
  return exists(path.join(root, '.git')) ? null : root;
}

export function refusal(root, cfg = tryLoadConfig({ from: root }).config) {
  return [
    `Blocked: this session's worktree ${root} has no .git link any more: it was removed or emptied`,
    'while the session was still in it. From here git walks up to the PRIMARY checkout that',
    '.claude/worktrees/ lives inside, so this command would have run against the shared checkout, not your',
    'work.',
    '',
    '  Check:   git -C "<primary checkout>" worktree list   (is this path still listed?)',
    '  Recover: anything committed and pushed is on its branch; make a fresh worktree from it',
    `           (${fillTemplate(cfg.worktreeScripts.new)}) and continue there, or start a new session.`,
    '           Anything uncommitted in the old directory is gone.',
    '',
    '  Escape hatch, only if you KNOW the primary checkout is the right target: AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD=1',
    NOTHING_RAN_NOTICE + consumerHint(import.meta.url),
  ].join('\n');
}

export function main(payload, env = process.env, exists = existsSync) {
  if (env.AGENT_HOOKS_ALLOW_ORPHANED_WORKTREE_CWD === '1') return 0;
  const root = orphanedWorktreeRoot(payload?.cwd, exists);
  if (!root) return 0;
  const { config: cfg, error } = tryLoadConfig({ from: root });
  if (error) process.stderr.write(`[agent-tooling] ${error}\n`);
  process.stderr.write(`${refusal(root, cfg)}\n`);
  return 2;
}

// Windows-safe entry guard (a bare path comparison fails on Windows).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let code;
  try {
    code = main(readHookInput());
  } catch {
    code = 0; // Fail open. See the header.
  }
  process.exit(code);
}
