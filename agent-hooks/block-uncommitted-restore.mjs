#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) hook: block `git checkout -- <path>` / `git restore
// <path>` when a named target has uncommitted changes.
//
// Why: `git checkout -- <path>` discards ALL uncommitted changes to those paths —
// no confirmation, no reflog entry, no recovery. The mutation-check discipline
// many repos mandate (deliberately edit a file, verify a test goes red, undo the edit)
// steers agents straight at the destructive form many times per session, and on
// 2026-08-30 a worker undoing a one-line mutation with `git checkout -- <file>`
// lost every OTHER edit it had made to that file. The safe pattern: capture the original text before mutating and
// restore it by writing that text back (or `git stash push -u -m "<tag>"` a named
// entry) — never a pathspec checkout.
//
// The hook only fires when at least one named target actually HAS uncommitted
// changes (`git status --porcelain -uno -- <paths>` is non-empty). A pathspec
// restore over a clean target is a no-op and passes untouched, so routine use
// against clean files never sees this guard.
//
// What is matched (deliberately narrow, mirroring block-worktree-branch-switch's
// rationale that a false block is worse than a miss):
//   * `git checkout [-q/-f/...] [<rev>] -- <path>...`  — the explicit `--` form
//   * `git checkout .`                                  — `.` cannot be a ref
//   * `git restore <path>...`                           — unless it is the pure
//     `--staged` form with no `--worktree`, which only unstages and destroys nothing
// Bare `git checkout <ref>` stays unmatched — indistinguishable from a file
// restore without running git, and branch ops are block-worktree-branch-switch's
// territory anyway.
//
// Picking a conflict side is NOT a discard. `git checkout --ours|--theirs
// -- <path>` (and `git restore --ours|--theirs <path>`) on an UNMERGED path is the
// standard way to resolve a conflict by taking one side. What it overwrites is the
// conflict-marker file git itself wrote, and both sides stay in the index stages and
// in the commits being merged. Blocking it left the hatch as the only way through a
// routine rebase, which trains the habit that makes this guard useless on the day
// it matters. So that form passes when EVERY dirty line `git status --porcelain`
// prints for the named targets is unmerged (XY in DD/AU/UD/UA/DU/AA/UU). One merely
// modified target (` M`, `M `, `MM`, …) and the whole command is blocked as before:
// there --ours/--theirs restores from the index and the edit is gone. Without one of
// the two flags nothing changes, whatever the status. Unmerged entries exist only
// mid-merge/rebase/cherry-pick/stash-pop, so the status alone is the evidence and
// no separate "is a rebase running" probe is needed.
//
// Escape hatch: AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 (a deliberate, understood discard).
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything
// unexpected — unparseable input, git missing, status failing — fails OPEN
// (exit 0): this guard must never break the shell tools.
//
// ONE deliberate exception to that fail-open stance: when the command
// is a matched destructive restore AND it explicitly names a directory (`cd <dir>`
// or `git -C <dir>`) that is a literal path which does NOT exist, the guard fails
// CLOSED. That combination is not "unparseable input", it is the guard being
// unable to look — which is exactly the shape that let a real discard through when
// `path.resolve` mangled `/d/Worktrees/...` into a nonexistent `C:\d\...`. The
// discard is unrecoverable and the block is not (clear message + escape hatch), so
// the asymmetry is worth one confusing message on a `cd` that was going to fail
// anyway. Tokens carrying shell expansion (`$REPO`, globs, `~`) and `cd -` are
// excluded — for those, "does not exist" says nothing, so they stay fail-open.
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isLiteralPathToken, resolveShellDir, safeCwd, unquote } from './shell-path-lib.mjs';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { readToolCommand } from './hook-input.mjs';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';
import { segmentHasInlineHatch } from './inline-hatch.mjs';

const HATCH_VAR = 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD';
// The XY codes `git status --porcelain` gives an unmerged path (git-status(1)).
// Declared up here, not beside its function: the main block below runs before any
// later `const` is initialised, and its catch would turn that TDZ error into a
// silent fail-open on every side pick.
const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

try {
  if (process.env[HATCH_VAR] === '1') process.exit(0);

  const cmd = readToolCommand();
  if (!cmd) process.exit(0);

  // Split into pipeline/list segments, tracking a leading `cd <dir>` so that
  // `cd <dir> && git checkout -- x` is evaluated against <dir>.
  const segments = cmd.split(/&&|\|\||;|\||\n/);
  let curDir = safeCwd();
  // The raw token of the most recent `cd`, or null while we are still on the
  // shell's own cwd. Only an EXPLICITLY named directory can fail closed below.
  let cdToken = null;

  for (const rawSeg of segments) {
    // stripGroupingParens: `(cd x && git checkout -- f)` leaves `(cd` and `f)`
    // glued to the words; detach them so the cd and the path both read true.
    const toks = stripGroupingParens(rawSeg.trim().split(/\s+/).filter(Boolean));
    if (toks.length === 0) continue;

    // A `cd` can follow a keyword or wrapper too (`then cd x`, `(cd x`), so look
    // past them before deciding whether this segment changes directory.
    const lead = skipCommandPrefix(toks);
    if (toks[lead] === 'cd' && toks[lead + 1]) {
      curDir = resolveShellDir(curDir, toks[lead + 1]);
      cdToken = toks[lead + 1];
      continue;
    }

    const gitArgs = gitArgsAfterWrappers(toks);
    if (!gitArgs) continue;

    const op = restoreOp(gitArgs);
    if (!op.isRestore) continue;

    // Inline hatch, scoped to THIS segment only: the refusal
    // messages below tell an agent to "set AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1",
    // which only works if it is written as a leading assignment on the same
    // segment as the git command — `AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout
    // -- <path>` — never process.env of the PreToolUse hook, which an agent's
    // Bash command text cannot reach.
    if (segmentHasInlineHatch(rawSeg, HATCH_VAR)) continue;

    const effDir = op.dashC ? resolveShellDir(curDir, op.dashC) : curDir;
    const dirToken = op.dashC ?? cdToken;

    if (dirToken !== null && isLiteralPathToken(dirToken) && !isDirectory(effDir)) {
      process.stderr.write(
        `Blocked: \`git ${op.label}\` names a directory this guard cannot inspect — ` +
          `\`${unquote(dirToken)}\` resolved to \`${effDir}\`, which does not exist.\n` +
          'Because the target may well be dirty, permitting the command would risk an unrecoverable discard, ' +
          'so this guard fails CLOSED here rather than open. Check the directory spelling; note ' +
          'that MSYS forms like `/d/Worktrees/x` are normalised to `D:/Worktrees/x` on Windows, so a path that ' +
          `still fails to resolve is very likely a typo. To proceed anyway, prefix the SAME command with ` +
          `\`${HATCH_VAR}=1\` (e.g. \`${HATCH_VAR}=1 git ${op.label} -- <path>\`) — that works inline, scoped to ` +
          `this one command; a session/harness env var works too. ` +
          NOTHING_RAN_NOTICE +
          consumerHint(import.meta.url),
      );
      process.exit(2);
    }

    const dirty = dirtyPaths(effDir, op.paths);
    if (!dirty) continue;
    if (op.pickSide && everyLineUnmerged(dirty)) continue;

    process.stderr.write(
      `Blocked: \`git ${op.label}\` would DISCARD uncommitted changes with no reflog and no recovery — ` +
        `\`git status --porcelain\` shows the target dirty:\n${dirty}\n` +
        'If you are undoing a mutation-check edit, restore the file by writing back the ORIGINAL text you ' +
        'captured before mutating (Edit/Write tool), which preserves your other uncommitted edits in that ' +
        'file — a pathspec checkout throws them all away. To set work aside ' +
        'instead, use `git stash push -u -m "<unique-tag>"`. If you truly intend to discard these changes, ' +
        `prefix the SAME command with \`${HATCH_VAR}=1\` (e.g. \`${HATCH_VAR}=1 git ${op.label} -- <path>\`) — ` +
        'that works inline, scoped to this one command; a session/harness env var works too. ' +
        (op.pickSide
          ? '`--ours` / `--theirs` passes this guard only when EVERY named target is an unmerged conflict path ' +
            '(`UU`, `AA`, `DU`, …): at least one line above is an ordinary modification, which that flag would ' +
            'overwrite from the index. Name only the conflicted paths. '
          : '') +
        NOTHING_RAN_NOTICE +
        consumerHint(import.meta.url),
    );
    process.exit(2);
  }
} catch {
  process.exit(0);
}
process.exit(0);

// True when every porcelain line is an unmerged entry. `porcelain` is non-empty.
function everyLineUnmerged(porcelain) {
  return porcelain.split('\n').every((line) => UNMERGED_XY.has(line.slice(0, 2)));
}

// `--ours` / `--theirs`: the caller is picking a side of a conflict.
function isSideFlag(a) {
  return a === '--ours' || a === '--theirs';
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The tokens AFTER `git`, or null when the segment is not a git invocation, once
// leading wrappers and shell keywords are skipped (wrapper-strip.mjs, shared
// with block-bare-claim.mjs and block-worktree-branch-switch.mjs).
function gitArgsAfterWrappers(toks) {
  const i = skipCommandPrefix(toks);
  return toks[i] === 'git' ? toks.slice(i + 1) : null;
}

// Given the tokens after `git`, decide whether this is a working-tree pathspec
// restore, and capture any `-C <dir>` global option plus the target paths.
function restoreOp(gitArgs) {
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

  if (sub === 'checkout') {
    // Branch create/switch is block-worktree-branch-switch's territory.
    if (subArgs.some((x) => x === '-b' || x === '-B')) return { isRestore: false };
    const dd = subArgs.indexOf('--');
    if (dd !== -1) {
      const paths = subArgs.slice(dd + 1).map(unquote).filter(Boolean);
      const pickSide = subArgs.slice(0, dd).some(isSideFlag);
      if (paths.length > 0) return { isRestore: true, label: 'checkout --', dashC, paths, pickSide };
      return { isRestore: false };
    }
    // `git checkout .` — "." can never be a ref name, so this is unambiguously the
    // pathspec form. Anything else without `--` stays unmatched (could be a ref).
    const nonFlags = subArgs.filter((x) => !x.startsWith('-')).map(unquote);
    if (nonFlags.length > 0 && nonFlags.every((x) => x === '.' || x.startsWith('./'))) {
      return { isRestore: true, label: 'checkout', dashC, paths: nonFlags, pickSide: subArgs.some(isSideFlag) };
    }
    return { isRestore: false };
  }

  if (sub === 'restore') {
    let staged = false;
    let worktree = false;
    let pickSide = false;
    const paths = [];
    for (let j = 0; j < subArgs.length; j++) {
      const a = subArgs[j];
      if (a === '--') {
        for (const p of subArgs.slice(j + 1)) paths.push(unquote(p));
        break;
      }
      if (a === '--staged') {
        staged = true;
        continue;
      }
      if (a === '--worktree') {
        worktree = true;
        continue;
      }
      if (isSideFlag(a)) {
        pickSide = true;
        continue;
      }
      if (a === '--source' || a === '-s') {
        j++; // skip the source value
        continue;
      }
      if (a.startsWith('--source=')) continue;
      if (/^-[A-Za-z]+$/.test(a)) {
        // Combined short flags: -S = --staged, -W = --worktree. Lowercase -s is
        // --source and was handled above (it takes a value, so it can't combine).
        if (a.includes('S')) staged = true;
        if (a.includes('W')) worktree = true;
        continue;
      }
      if (a.startsWith('-')) continue;
      paths.push(unquote(a));
    }
    // The pure `--staged` form only moves index entries back to HEAD — the working
    // tree (where uncommitted edits live) is untouched, so it destroys nothing.
    if (staged && !worktree) return { isRestore: false };
    if (paths.length === 0) return { isRestore: false };
    return { isRestore: true, label: 'restore', dashC, paths, pickSide };
  }

  return { isRestore: false };
}

// Non-empty porcelain output for the named paths (tracked files only — a pathspec
// checkout/restore never deletes untracked files), or null when clean / unknowable.
function dirtyPaths(dir, paths) {
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'status', '--porcelain', '--untracked-files=no', '--', ...paths],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trimEnd(); // not .trim(): a first line of ` M path` keeps its XY column
    return out.length > 0 ? out : null;
  } catch {
    return null; // not a repo, git missing, bad pathspec — fail open
  }
}
