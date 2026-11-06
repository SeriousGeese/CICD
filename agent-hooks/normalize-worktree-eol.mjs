#!/usr/bin/env node
// SessionStart hook: renormalize a harness-created worktree whose tracked text
// files arrived with CRLF line endings.
//
// Why: `.gitattributes` says `* text=auto eol=lf`, and git honours it — a fresh
// `git worktree add` on this Windows machine checks out 0 CR bytes, and so does
// `git checkout-index`. But a Claude Code session worktree (`.claude/worktrees/…`)
// is created by the harness, not by that path, and it inherits the PRIMARY
// checkout's line endings: measured 2026-09-03, this session's worktree had 2906 of
// 3046 tracked text files CRLF (every .ts/.tsx/.md/.mjs/.yml), a script-created
// sibling worktree had 0, and the primary checkout — which predates the attribute
// and was never renormalized — had 90 of 95 scripts/*.mjs CRLF.
//
// The damage is always silent: node:test assertions doing literal `\n`-anchored
// matches, byte comparisons of regenerated files, and mutation harnesses whose
// `\n` anchors match nothing and report the guardrail as "not biting".
//
// What it does: in a LINKED worktree only (never the primary — other sessions'
// uncommitted work may live there), when the tree is clean, rewrite exactly the
// tracked files that are `w/crlf` under an `eol=lf` attribute via
// `git checkout-index -f --stdin` (attributes applied → LF; LFS files are `-text`
// and never match). A dirty tree is left alone with a warning — a rewrite could
// not distinguish an edit from a line-ending change. Prints one `[eol-fix]` line
// when it does or skips something, and is silent when there is nothing to do.
//
// Never fails the session: any error is reported on stdout and exits 0.
//
// Every run in a LINKED worktree also appends one record to a durable,
// cross-session log (eol-fix-log.mjs beside this file) — not just the runs that
// found something to fix. That is what lets a verify script
// require a real SPAN of clean runs before calling the upstream bug retirable,
// instead of trusting a single clean reading. Logging is
// best-effort and never throws into the session.
import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { appendEolFixLogEntry } from './eol-fix-log.mjs';

const TAG = '[eol-fix]';

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

/** A Claude Code desktop session worktree, as opposed to a script-created (worktree-new.sh) one. */
function isHarnessWorktree(cwd) {
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(cwd);
}

/** Best-effort, never throws — logging must never affect the hook's own outcome. */
function logRun(cwd, fields) {
  try {
    appendEolFixLogEntry({ worktreePath: cwd, harnessCreated: isHarnessWorktree(cwd), ...fields });
  } catch {
    /* logging is never allowed to affect the hook's outcome */
  }
}

function crlfUnderLfAttribute() {
  const r = git(['ls-files', '--eol']);
  if (r.status !== 0) return null;
  const out = [];
  for (const line of r.stdout.split('\n')) {
    // `i/lf    w/crlf  attr/text=auto eol=lf 	path` — attr may contain spaces.
    const m = /^i\/\S+\s+w\/crlf\s+attr\/(.*?)\t(.+)$/.exec(line);
    if (m && /(^|\s)eol=lf(\s|$)/.test(m[1])) out.push(m[2]);
  }
  return out;
}

try {
  const cwd = process.cwd();
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) process.exit(0);

  const gitDir = git(['rev-parse', '--git-dir']).stdout.trim();
  const common = git(['rev-parse', '--git-common-dir']).stdout.trim();
  // Primary checkout: --git-dir and --git-common-dir are the same directory.
  if (!gitDir || !common || path.resolve(cwd, gitDir) === path.resolve(cwd, common)) process.exit(0);

  const before = crlfUnderLfAttribute();
  if (!before) {
    logRun(cwd, { crlfFiles: 0, rewritten: 0, skippedReason: 'ls-files-failed' });
    process.exit(0);
  }
  if (before.length === 0) {
    // The clean, nothing-to-do case — logged like every other run. This is the
    // observation the upstream-bug retirement gate actually needs: a durable record
    // that a harness worktree, on this machine, arrived with 0 CRLF files.
    logRun(cwd, { crlfFiles: 0, rewritten: 0, skippedReason: null });
    process.exit(0);
  }

  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  if (dirty) {
    logRun(cwd, { crlfFiles: before.length, rewritten: 0, skippedReason: 'dirty' });
    console.log(
      `${TAG} ${before.length} tracked text files are CRLF in this worktree (they should be LF per ` +
        '.gitattributes), but the tree has uncommitted changes, so nothing was rewritten. When clean: ' +
        '`git ls-files --eol | grep w/crlf` lists them and `git checkout-index -f -- <paths>` fixes them.',
    );
    process.exit(0);
  }

  // Two git behaviours shape this step, both found by the node-test:
  //  - `checkout-index -f` returns 0 WITHOUT writing a file whose index stat data
  //    still matches the file on disk — and that is exactly the state of a
  //    harness worktree (the index was recorded against the CRLF files, which is
  //    also why `git status` is clean). Unlink first so every path is genuinely
  //    re-created from the index with attributes applied. The tree was verified
  //    clean above, so nothing but committed content is being removed.
  //  - `-u` re-records the stat data of every entry it writes. Without it the
  //    index still remembers the CRLF size, and `git status` reports ` M` on a
  //    size change without ever comparing content (ie_modified's DATA_CHANGED
  //    short-circuit), so a clean tree would come back looking dirty.
  for (const rel of before) {
    try {
      unlinkSync(path.join(cwd, rel));
    } catch {
      /* already gone; checkout-index recreates it either way */
    }
  }
  const fix = git(['checkout-index', '-u', '-f', '-z', '--stdin'], { input: before.join('\0') + '\0' });
  if (fix.status !== 0) {
    logRun(cwd, { crlfFiles: before.length, rewritten: 0, skippedReason: 'checkout-index-failed' });
    console.log(
      `${TAG} git checkout-index failed (${fix.stderr.trim()}). Recover the ${before.length} files with ` +
        '`git checkout-index -a -f` (the tree was clean, so nothing uncommitted is at stake).',
    );
    process.exit(0);
  }

  const after = crlfUnderLfAttribute() ?? [];
  const fixed = before.length - after.length;
  logRun(cwd, { crlfFiles: before.length, rewritten: fixed, skippedReason: null });
  console.log(
    `${TAG} renormalized ${fixed} of ${before.length} CRLF tracked files to LF — a harness-created worktree ` +
      "inherits the primary checkout's line endings." +
      (after.length ? ` ${after.length} still CRLF; inspect with \`git ls-files --eol | grep w/crlf\`.` : ''),
  );
} catch (err) {
  console.log(`${TAG} skipped: ${err?.message ?? err}`);
}
process.exit(0);
