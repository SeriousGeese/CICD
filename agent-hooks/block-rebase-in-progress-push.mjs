#!/usr/bin/env node
// git pre-push hook: REFUSE a push while a rebase is in progress.
//
// The incident (2026-09-05, a linked agent worktree). `git rebase --quiet
// origin/main` stopped after the FIRST pick: that pick's tracked changes were
// applied but not committed, its nine new files were untracked, no conflict
// markers existed, no commit was created, and the todo list still carried the
// same pick. The command's own failure was invisible from two directions at
// once — `--quiet` suppressed the reason, and the pipeline it was written into
// (`… | tail`) reported the FILTER's exit status rather than git's. So the
// session believed the rebase had succeeded and ran
// `git push origin HEAD:refs/heads/<new>`.
//
// In that state HEAD is the REBASE BASE — plain `origin/main`. The push
// therefore succeeded, published a branch identical to main, and the work
// looked simply absent. Nothing about the push said otherwise. Reproduced
// exactly in a scratch repo: a `prepare-commit-msg` hook that exits non-zero
// during a rebase leaves `rebase-merge/` present, the todo carrying both picks,
// zero commits ahead of main, and `git log -1 HEAD` reading `main moves`.
//
// This guard is the last thing between that state and a published lie. Unlike
// its sibling warn-dropped-files.mjs — deliberately warn-only, because every
// legitimate deletion would otherwise need an escape hatch — pushing from
// inside a rebase has NO legitimate form: git has not finished writing your
// commits yet, so whatever the remote receives is not what you meant to send.
// Hence a hard refusal with an escape hatch nobody should need.
//
// Escape hatch: AGENT_HOOKS_ALLOW_REBASE_PUSH=1.
//
// WORKTREE-AWARENESS is the whole implementation risk. A linked worktree's git
// dir is `<primary>/.git/worktrees/<name>`, NOT the primary's `.git`, and its
// rebase state lives under ITS OWN dir — so a guard that looked in the primary
// would never fire for the sessions that actually hit this. `git rev-parse
// --git-path rebase-merge` resolves per-worktree and is asked for directly
// rather than reconstructed, for the same reason block-uncommitted-restore.mjs
// normalizes through shell-path-lib: a hand-built path is where these guards
// fall through to their fail-open branch and silently protect nothing.
//
// FAIL OPEN on anything unexpected — no git, a git that errors, a path that
// cannot be stat'ed. A pre-push hook that can make pushing impossible when the
// environment is odd is worse than the bug it guards; the positive evidence
// (an actual rebase-state directory) is cheap and unambiguous, so nothing is
// lost by requiring it.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { consumerHint } from './refusal-notice.mjs';

const GIT_TIMEOUT_MS = 10_000;

/** Both rebase backends: `rebase-merge` (merge/interactive) and `rebase-apply` (am). */
export const REBASE_STATE_DIRS = ['rebase-merge', 'rebase-apply'];

function gitPath(name, cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--git-path', name], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The rebase-state directory that exists, or null. Exported for the tests: the
 * detection and the message are separable, and only the detection can be wrong
 * in a way that matters.
 */
export function findRebaseState(cwd, resolve = gitPath) {
  for (const name of REBASE_STATE_DIRS) {
    const p = resolve(name, cwd);
    if (!p) continue;
    try {
      if (existsSync(p)) return { name, path: p };
    } catch {
      // Unstat-able: no verdict. See the fail-open note in the header.
    }
  }
  return null;
}

export function renderRefusal({ name, path }) {
  return [
    '',
    `BLOCKED: a rebase is in progress here (${name}/ exists at ${path}).`,
    '',
    '  Your commits have NOT been written yet — HEAD is still the rebase BASE, so this push',
    '  would publish that base commit (typically plain origin/main) and your work would look',
    '  simply absent from the branch. The push itself would SUCCEED.',
    '',
    '  Finish or unwind the rebase first:',
    '    git status                      # what stopped it, and what is staged',
    '    git rebase --continue           # after resolving',
    '    git rebase --abort              # to unwind',
    '',
    '  If --abort refuses with "untracked working tree files would be overwritten", the',
    '  untracked files are the stopped pick\'s new files: move them aside, abort, restore them.',
    '',
    '  Rebasing inside an agent worktree: run it with the repo hooks bypassed, since a',
    '  prepare-commit-msg hook runs on EVERY pick and can wedge the rebase —',
    '    git -c core.hooksPath="$(mktemp -d)" rebase origin/main',
    '  and never with --quiet piped into a filter: that combination is what hid the failure.',
    '',
    '  Escape hatch (you should not need it): AGENT_HOOKS_ALLOW_REBASE_PUSH=1',
    '',
  ].join('\n') + consumerHint(import.meta.url);
}

export function main(cwd = process.cwd(), env = process.env) {
  if (env.AGENT_HOOKS_ALLOW_REBASE_PUSH === '1') return 0;
  const state = findRebaseState(cwd);
  if (!state) return 0;
  process.stderr.write(`${renderRefusal(state)}\n`);
  return 1;
}

// Only act when run as the hook, so the tests can import the pieces. This exact
// comparison is the Windows-safe form a hand-built `file://${argv[1]}` never matches
// on Windows, and the CLI then silently does nothing while exiting 0.
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
  let code;
  try {
    code = main();
  } catch {
    code = 0; // Fail open. See the header.
  }
  process.exit(code);
}
