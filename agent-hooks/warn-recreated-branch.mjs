#!/usr/bin/env node
// git pre-push hook: WARN when this push would CREATE a remote branch that
// already has an upstream configured locally — the fingerprint of pushing a
// follow-up commit to a branch whose own PR already merged and got its head
// branch deleted.
//
// The incident: the "Demo clips for Initiative Tracker" session (2026-09-21) hit
// PR #3446 on branch `claude/initiative-tracker-demo-clips-5ccd97`. This repo
// sets `delete_branch_on_merge`, and the review tooling deletes the ref
// explicitly too, so by the time a follow-up commit was pushed the remote
// branch was gone. Git does not reject that — it CREATES the branch again and
// prints `* [new branch] <branch> -> <branch>`, exit 0. The commit is genuinely
// on a real remote branch attached to NO pull request, and nothing in git, the
// issue tracker, or the PR list says so. `gh pr reopen` is refused once GitHub has seen the
// head branch deleted-then-recreated, so the recovery is to rebase onto
// current origin/main and open a NEW PR — not to "reopen" anything.
//
// ---------------------------------------------------------------------------
// The signal, and why it is convention-independent
// ---------------------------------------------------------------------------
// The bead's first draft proposed firing on a branch name ending in a
// bead id. That would NOT have fired on its own motivating incident — the
// branch above is a harness session branch with no trailing bead id — so it
// was retracted before being built (see the bead's own notes). The signal
// used here instead:
//
//   git rev-parse --abbrev-ref '@{upstream}'                  succeeds -> this
//     branch has been pushed before and has a configured upstream, named
//     `<remote>/<upstream-branch>`.
//   git ls-remote --exit-code --heads <remote> <upstream-branch>  exits 2 ->
//     the remote ref named by that upstream is GONE.
//
// Both true at once IS the recreation case, and it holds identically for a
// session branch, a `feat/` branch or a bead-suffixed one — it never depends
// on what the branch is named. A genuinely new branch has no upstream
// configured yet, so the first check fails and this stays silent, which is
// the correct direction for a warn-only hook: one that cries wolf on every
// ordinary first push is one people learn to ignore.
//
// The upstream check MUST ask about the upstream's own branch
// name, never the LOCAL branch's name. `git push origin HEAD:<other-branch>`
// (used to push a follow-up commit onto an existing PR from a differently
// named local branch, e.g. a worktree named after a different task) sets an
// upstream whose branch name differs from the local one — `ls-remote`-ing the
// LOCAL name then finds nothing (that ref was never the one being pushed to)
// and warns "will CREATE it" on a push that force-updated a live PR head and
// created nothing. `upstreamRemoteBranch()` below resolves `<remote>/<branch>`
// from `@{upstream}`'s `--symbolic-full-name` form and strips the remote name
// as a literal prefix (`branch.<local>.remote`, not a first-`/` split, since a
// branch name may itself contain a `/`), so the ls-remote and the `gh pr list
// --head` confirmation both ask about the branch that is ACTUALLY being
// pushed to.
//
// ---------------------------------------------------------------------------
// WARN-ONLY, same contract as warn-dropped-files.mjs
// ---------------------------------------------------------------------------
// This script exits 0 on EVERY path — finding, no finding, crash, git or gh
// missing. A push must never fail because of it. The `gh pr list --state
// merged --head` confirmation is best-effort decoration: it runs only when
// `gh` is on PATH, under a short timeout, and its failure or absence never
// changes whether the core warning fires.
//
// ---------------------------------------------------------------------------
// Why this NEVER reads stdin
// ---------------------------------------------------------------------------
// A pre-push hook is normally handed `<local ref> <local sha> <remote ref>
// <remote sha>` lines on stdin — a remote sha of forty zeroes is the textbook
// "this push creates the ref" signal, for free, with no network call. It is
// not used here: `git lfs pre-push` runs from the SAME hook and CONSUMES
// stdin, so reading it here would silently break LFS uploads — a far worse
// failure than the one this guards. See the constraint where the
// consumer's pre-push hook chains `git lfs pre-push`. This hook works from `git rev-parse HEAD`'s
// branch and ordinary git/gh queries instead, exactly like
// warn-dropped-files.mjs.
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 5_000;
const TAG = '[recreated-branch]';

function run(cmd, args, timeout) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function git(args) {
  return run('git', args, GIT_TIMEOUT_MS);
}

/** The branch this push is FROM, or null when HEAD is detached / unreadable. */
function currentBranch() {
  const name = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return name && name !== 'HEAD' ? name : null;
}

/**
 * The REMOTE branch name this push's upstream actually names, or null when
 * there is no configured upstream (a genuinely new branch) or the upstream's
 * shape could not be resolved.
 *
 * The original version of this check asked whether
 * `origin/<LOCAL branch name>` exists, which is wrong whenever the local
 * branch's name differs from what it tracks — e.g. a local `wt/badge-art-
 * bd-gqyr3` whose upstream is `origin/feat/feedback-bd-r3jq3`
 * (a `git push origin HEAD:<other-branch>` sets exactly that upstream). Such
 * a push updates a live PR's head, but the old check asked ls-remote about a
 * branch named after the LOCAL name, found it absent, and warned "will
 * CREATE it" — a false alarm on a push that created nothing.
 *
 * `@{upstream}`'s `--symbolic-full-name` form is `<remote>/<branch>` (e.g.
 * `origin/feat/feedback-bd-r3jq3`); the remote name is read
 * separately via `branch.<local>.remote` and stripped as a literal prefix,
 * rather than splitting on the first `/`, because a branch name may itself
 * contain slashes (`feat/x/y`) while a remote name essentially never does —
 * splitting on the first `/` would misparse a nested branch name.
 */
function upstreamRemoteBranch(localBranch) {
  try {
    const remote = git(['config', '--get', `branch.${localBranch}.remote`]);
    if (!remote) return null;
    const full = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const prefix = `${remote}/`;
    if (!full || !full.startsWith(prefix)) return null; // unexpected shape — say nothing
    return { remote, branch: full.slice(prefix.length) };
  } catch {
    return null; // no upstream configured (a genuinely new branch), or `git config` failed
  }
}

/**
 * Whether `<remote>/<branch>` currently exists on the remote.
 *
 * `git ls-remote --exit-code --heads <remote> <branch>` exits 0 when the ref exists, 2 when it
 * genuinely does not, and anything else (network trouble, auth) is NOT evidence either way —
 * this returns null for that case so the caller stays silent rather than guessing.
 */
function remoteBranchExists(remote, branch) {
  try {
    const out = git(['ls-remote', '--exit-code', '--heads', remote, branch]);
    return out.length > 0;
  } catch (err) {
    // execFileSync throws with err.status set to the child's exit code.
    if (err?.status === 2) return false;
    return null; // inconclusive — say nothing
  }
}

/**
 * Best-effort confirmation: does a MERGED PR already exist for this branch? Returns null on
 * any failure (gh missing, not authenticated, network, timeout) — this is decoration, never
 * the trigger.
 */
function mergedPrConfirmation(branch) {
  try {
    const out = run(
      'gh',
      ['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number,title', '--limit', '1'],
      GH_TIMEOUT_MS,
    );
    const rows = JSON.parse(out || '[]');
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

function main() {
  const branch = currentBranch();
  if (!branch) return; // detached HEAD — nothing to compare

  const upstream = upstreamRemoteBranch(branch);
  if (!upstream) return; // a genuinely new branch has no upstream yet — silent

  const exists = remoteBranchExists(upstream.remote, upstream.branch);
  if (exists !== false) return; // exists, or inconclusive — say nothing either way

  // The local and upstream branch names usually match (an ordinary `git push -u origin
  // <branch>`), but do not have to — `git push origin HEAD:<other-branch>` sets an upstream
  // whose name differs from the local branch pushing to it . Name both explicitly
  // so the warning is accurate either way instead of implying they are the same branch.
  const remoteRef = `${upstream.remote}/${upstream.branch}`;
  const target = branch === upstream.branch ? `"${branch}"` : `"${upstream.branch}" (from local branch "${branch}")`;

  const lines = [
    `${TAG} pushing will CREATE ${target} on the remote, even though local branch "${branch}" has an` +
      ` upstream configured (${remoteRef}) — that remote ref is GONE.`,
    `${TAG} This is almost always a branch whose own PR already merged: this repo deletes` +
      ' the head branch on merge, so a follow-up commit recreates it attached to NO pull' +
      ' request, and nothing will ever review, merge, or notice it.',
  ];

  const merged = mergedPrConfirmation(upstream.branch);
  if (merged) {
    lines.push(`${TAG} Confirmed: PR #${merged.number} ("${merged.title}") on ${upstream.branch} is already MERGED.`);
  }

  lines.push(
    `${TAG} If that's what happened: rebase onto current origin/main and open a NEW PR —` +
      ' "gh pr reopen" is refused once GitHub has seen the head branch deleted-then-recreated.',
    `${TAG} If you genuinely intend a first push of a branch that happens to have an` +
      ' upstream already set (e.g. after "git branch --set-upstream-to"), push on — this is' +
      ' the expected cost of the check.',
    `${TAG} WARNING ONLY — this never blocks a push. See this script (warn-recreated-branch.mjs).`,
  );

  process.stderr.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch {
  // Fail open, always and silently. A push must never fail because of this.
}
process.exit(0);
