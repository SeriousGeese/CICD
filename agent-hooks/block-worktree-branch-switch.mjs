#!/usr/bin/env node
// PreToolUse(Bash) hook: block an in-place branch switch/create inside a linked
// git worktree.
//
// Why: in a worktree-per-task model a worktree's branch is fixed when
// the worktree is created. Running `git checkout -b`/`git switch` INSIDE it moves
// that worktree's HEAD — which HIJACKS a shared HEAD when another session is
// (wrongly) sharing the worktree. That is exactly what corrupted a multi-agent
// fan-out (2026-08-01): the harness dropped two subagents
// into one worktree, one ran `git checkout -b`, and the other's commits landed on
// the wrong branch.
//
// To work on a different branch, create a NEW worktree instead —
// `git worktree add <worktreeRoot>/<name> -b <branch> origin/main`, named from the
// consumer's agent-tooling.json (`worktreeRoot`, `worktreeNamePattern`) — which this
// hook ALLOWS (only `checkout`/`switch` are blocked, never `worktree add`).
//
// Scope: LINKED worktrees only (.git is a FILE). The primary checkout (.git is a
// DIRECTORY) is intentionally left alone — humans switch branches there routinely,
// and agent edits there are better guarded by a separate primary-checkout edit guard.
// Only the unambiguous branch ops are matched: `checkout -b/-B` (create) and
// `switch` (branch-only). Bare `git checkout <ref>` is NOT matched — it is
// indistinguishable from `git checkout -- <file>` (file restore) without running
// git, and a false block there is worse than the miss; use `git switch`, which IS
// caught.
//
// Escape hatch: AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 (orchestrator recovery or a
// deliberate re-pin).
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything
// unexpected fails OPEN (exit 0) — this guard must never break Bash.
import { existsSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveShellDir, safeCwd } from './shell-path-lib.mjs';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { tryLoadConfig, worktreeName } from './agent-tooling-config.mjs';
import { readToolCommand } from './hook-input.mjs';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';
import { segmentHasInlineHatch } from './inline-hatch.mjs';

const HATCH_VAR = 'AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH';

try {
  if (process.env[HATCH_VAR] === '1') process.exit(0);

  const cmd = readToolCommand();
  if (!cmd) process.exit(0);

  // Split into pipeline/list segments, and track a leading `cd <dir>` so that
  // `cd <dir> && git checkout -b ...` is evaluated against <dir>, not the shell's
  // starting cwd (the orchestrator prefixes almost every command with `cd`).
  // resolveShellDir (not a bare path.resolve) because on Windows the MSYS form
  // `/d/Worktrees/x` resolves to a nonexistent `C:\d\Worktrees\x`, which silently
  // turned this guard OFF for the path form this repo actually writes — see
  // shell-path-lib.mjs. Unlike block-uncommitted-restore, this hook
  // keeps its unconditional fail-open: an unwanted branch switch is recoverable,
  // and its documented stance is that a false block is worse than a miss.
  const segments = cmd.split(/&&|\|\||;|\||\n/);
  let curDir = safeCwd();

  for (const rawSeg of segments) {
    const toks = stripGroupingParens(rawSeg.trim().split(/\s+/).filter(Boolean));
    if (toks.length === 0) continue;

    // A `cd` can follow a keyword or wrapper too (`then cd x`, `(cd x`), so look
    // past them before deciding whether this segment changes directory.
    const lead = skipCommandPrefix(toks);
    if (toks[lead] === 'cd' && toks[lead + 1]) {
      curDir = resolveShellDir(curDir, toks[lead + 1]);
      continue;
    }

    const gitArgs = gitArgsAfterWrappers(toks);
    if (!gitArgs) continue;

    const info = branchOp(gitArgs);
    if (!info.isBranchOp) continue;

    // Inline hatch, scoped to THIS segment only (an agent's Bash
    // command text can prefix the segment itself (`AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_
    // SWITCH=1 git switch main`), which this guard can see, but cannot set
    // process.env of the PreToolUse hook process the way the old message asked).
    if (segmentHasInlineHatch(rawSeg, HATCH_VAR)) continue;

    const effDir = info.dashC ? resolveShellDir(curDir, info.dashC) : curDir;
    if (gitRootKind(effDir) !== 'worktree') continue;

    // The block is decided; only the advice depends on config, so a failure here must still
    // block (the outer catch fails open), with generic advice.
    let newWorktree = '../<repo>-<name>';
    try {
      const { config: cfg, error: cfgError } = tryLoadConfig({ from: effDir });
      if (cfgError) process.stderr.write(`agent-tooling config ignored: ${cfgError}\n`);
      newWorktree = `${cfg.worktreeRoot.replace(/[\\/]+$/, '')}/${worktreeName(cfg, '<name>')}`;
    } catch {
      // keep the generic advice
    }
    process.stderr.write(
      `Blocked: \`git ${info.label}\` changes this worktree's branch in place. A worktree's branch is fixed ` +
        'when the worktree is created; switching it moves the worktree HEAD and HIJACKS a shared HEAD if another ' +
        'session is using this worktree (a multi-agent fan-out collision, 2026-08-01). To work on a different ' +
        `branch, create a NEW worktree: \`git worktree add ${newWorktree} -b <branch> origin/main\` (allowed). ` +
        'If you truly must switch in place — orchestrator recovery or a deliberate re-pin — prefix the SAME ' +
        `command with \`${HATCH_VAR}=1\` (e.g. \`${HATCH_VAR}=1 git ${info.label} <branch>\`) — that works ` +
        'inline, scoped to this one command; a session/harness env var works too. ' +
        NOTHING_RAN_NOTICE +
        consumerHint(import.meta.url),
    );
    process.exit(2);
  }
} catch {
  process.exit(0);
}
process.exit(0);

// The tokens AFTER `git`, or null when the segment is not a git invocation, once
// leading wrappers and shell keywords are skipped (wrapper-strip.mjs, shared
// with block-bare-claim.mjs and block-uncommitted-restore.mjs).
function gitArgsAfterWrappers(toks) {
  const i = skipCommandPrefix(toks);
  return toks[i] === 'git' ? toks.slice(i + 1) : null;
}

// Given the tokens after `git`, decide whether this is an in-place branch
// create/switch, and capture any `-C <dir>` global option.
function branchOp(gitArgs) {
  let i = 0;
  let dashC = null;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (a === '-C') {
      dashC = gitArgs[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (a === '--git-dir' || a === '--work-tree' || a === '-c' || a === '--namespace') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  const sub = gitArgs[i];
  const subArgs = gitArgs.slice(i + 1);
  if (sub === 'switch') {
    if (subArgs[0] === '--help' || subArgs[0] === '-h') return { isBranchOp: false };
    return { isBranchOp: true, label: 'switch', dashC };
  }
  if (sub === 'checkout' && subArgs.some((x) => x === '-b' || x === '-B')) {
    return { isBranchOp: true, label: 'checkout -b', dashC };
  }
  return { isBranchOp: false };
}

// 'primary' when the nearest .git is a directory, 'worktree' when it is a file
// (a linked worktree), null outside any repo. Same rule a primary-checkout edit guard uses.
function gitRootKind(startDir) {
  let cur = startDir;
  while (!existsSync(cur)) {
    const p = path.dirname(cur);
    if (p === cur) return null;
    cur = p;
  }
  cur = realpathSync(cur);
  if (!statSync(cur).isDirectory()) cur = path.dirname(cur);
  while (true) {
    const g = path.join(cur, '.git');
    if (existsSync(g)) return statSync(g).isDirectory() ? 'primary' : 'worktree';
    const p = path.dirname(cur);
    if (p === cur) return null;
    cur = p;
  }
}
