#!/usr/bin/env node
// git pre-push hook: WARN when files that exist at the merge-base with
// origin/main are absent from HEAD — the fingerprint of a stale rebase that
// silently dropped an already-merged commit.
//
// The incident (a stacked-PR recovery, 2026-08-30): rebasing a stale
// local branch dropped an entire already-merged commit. No conflict, no
// warning, no marker — the feature was simply absent from the result. What
// caught it was a human remembering to check that an expected file still
// existed (`ls src/lib/tracking/tracker.ts`) before pushing.
//
// `--force-with-lease` does NOT cover this class: the local ref genuinely
// matched the remote at fetch time, so the lease was valid. The damage is on
// the CONTENT side, not the ref side, and nothing in git looks there.
//
// ---------------------------------------------------------------------------
// WARN-ONLY, deliberately (the maintainers, 2026-08-30)
// ---------------------------------------------------------------------------
// This script exits 0 on EVERY path — finding, no finding, crash, missing ref,
// git not on PATH. A push must never fail because of it. A hard block with a
// AGENT_HOOKS_ALLOW_FILE_DROP=1 escape hatch was explicitly declined: every legitimate
// deletion would need the hatch, and once an escape hatch is routine, the guard
// is bypassed reflexively and stops being a guard at all.
//
// The corollary is that a legitimate deletion is not a false positive to be
// engineered away — it is a cheap "yes, I meant that" while reading the list.
//
// ---------------------------------------------------------------------------
// Why the baseline is the MERGE-BASE, not the remote tip
// ---------------------------------------------------------------------------
// baseline = git merge-base HEAD origin/main.
//
//   * Against origin/main's TIP, every file main gained after you branched
//     reads as "missing from your tip". That is a list of dozens-to-hundreds
//     of files, all of them correct absences. A warning nobody can read is
//     worse than no warning.
//   * The merge-base is by construction the newest commit you and main agree
//     on, so every path it contains is one your branch genuinely started from.
//     Anything in it that your tip lacks is a real, deliberate-or-not removal.
//   * It also lands exactly on the incident. After `git rebase origin/main`
//     the merge-base IS origin/main's tip, so the baseline is main's whole
//     tree — precisely the set a bad replay can silently eat.
//
// ---------------------------------------------------------------------------
// Why there is no "deliberate delete" filter
// ---------------------------------------------------------------------------
// The tempting filter is "hide paths that a commit on this branch deleted,
// since the commit is evidence of intent; surface only paths that vanished
// with no commit deleting them."
//
// That filter is VACUOUS, and provably so: the merge-base is by definition an
// ancestor of HEAD, so `baseline..HEAD` is the complete history of every tree
// change between them. A path present at the baseline and absent at HEAD must
// have been removed by some commit in that range — there is nowhere else for
// the change to live. "No commit on this branch deleted it" is the empty set.
// Applying it as a filter would suppress 100% of findings, the incident's own
// included: a rebase replays its result as ordinary branch commits, so the
// dropped file's deletion is recorded by a perfectly normal-looking commit.
//
// So every removal is listed. What keeps the list short and TRUE is instead:
//
//   1. The merge-base baseline (above) — the single biggest noise cut.
//   2. Rename detection (-M): a file that MOVED is not a file that vanished.
//   3. A hard cap on lines printed, so even a legitimate mass delete can never
//      produce a wall of text.
//   4. Naming the commit that removed each path. This is what turns "is this
//      deliberate?" from a chore into a glance: a commit subject saying what
//      you meant to do answers it, and a subject that has nothing to do with
//      deleting that file is the alarm.
//
// ---------------------------------------------------------------------------
// Why HEAD rather than the refs on stdin
// ---------------------------------------------------------------------------
// A pre-push hook is normally handed `<local ref> <local sha> <remote ref>
// <remote sha>` lines on stdin. This check deliberately does not read them:
// `git lfs pre-push` runs from the same hook and CONSUMES stdin, and quietly
// stealing it would break LFS uploads — a far worse failure than the one this
// guards. HEAD is also the thing a human's `ls` check inspects, so it matches
// the workflow this replaces.
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 15_000;
const MAX_LISTED = 20;
const TAG = '[dropped-files]';

// Sentinels for the single-pass attribution log. Control characters, so they
// cannot collide with a path or a commit subject.
const COMMIT_MARK = '\u0001';
const FIELD_MARK = '\u0002';

function git(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Paths present at `baseline` and absent at HEAD, renames excluded.
 *
 * @param {string} baseline commit-ish to compare from
 * @returns {string[]}
 */
function droppedPaths(baseline) {
  return git(['diff', '--name-only', '--diff-filter=D', '-M', baseline, 'HEAD'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Map each removed path to the commit that removed it, in ONE git call.
 *
 * Merge commits show no diff to `git log --name-only`, so a path removed by a
 * merge simply gets no entry. That is reported as "no commit in this range
 * records the deletion" rather than guessed at.
 *
 * @param {string} baseline commit-ish to compare from
 * @returns {Map<string, string>} path -> "<short sha> <subject>"
 */
function deletionAttribution(baseline) {
  const out = git([
    'log',
    '--no-color',
    `--format=${COMMIT_MARK}%h${FIELD_MARK}%s`,
    '--name-only',
    '--diff-filter=D',
    '-M',
    `${baseline}..HEAD`,
  ]);

  const byPath = new Map();
  let current = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(COMMIT_MARK)) {
      const [sha, subject = ''] = line.slice(COMMIT_MARK.length).split(FIELD_MARK);
      current = subject ? `${sha} "${subject}"` : sha;
      continue;
    }
    // `git log` walks newest-first; the FIRST commit seen for a path is the one
    // that left it deleted at HEAD, so never overwrite an existing entry.
    if (current && !byPath.has(line)) byPath.set(line, current);
  }
  return byPath;
}

function main() {
  // No local origin/main (fresh clone mid-fetch, detached CI checkout, a fork
  // whose default branch is named something else) — say nothing.
  try {
    git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  } catch {
    return;
  }

  let baseline;
  try {
    baseline = git(['merge-base', 'HEAD', 'refs/remotes/origin/main']);
  } catch {
    // Unrelated histories — there is no shared starting point to compare to.
    return;
  }
  if (!baseline) return;

  const dropped = droppedPaths(baseline);
  if (dropped.length === 0) return;

  let attribution = new Map();
  try {
    attribution = deletionAttribution(baseline);
  } catch {
    // Attribution is decoration; the path list is the signal.
  }

  const n = dropped.length;
  const lines = [
    `${TAG} ${n} file${n === 1 ? '' : 's'} present at the merge-base with origin/main ${
      n === 1 ? 'is' : 'are'
    } ABSENT from HEAD:`,
  ];
  for (const p of dropped.slice(0, MAX_LISTED)) {
    const who = attribution.get(p);
    lines.push(`${TAG}   ${p}${who ? `   (removed by ${who})` : '   (no commit in this range records the deletion)'}`);
  }
  if (n > MAX_LISTED) {
    lines.push(`${TAG}   … and ${n - MAX_LISTED} more (git diff --name-only --diff-filter=D -M ${baseline} HEAD)`);
  }
  lines.push(`${TAG} If you meant to remove these, push on — this is the expected cost of the check.`);
  lines.push(`${TAG} If you did NOT, a stale rebase may have dropped an already-merged commit:`);
  lines.push(`${TAG} that leaves no conflict and no marker, and --force-with-lease does not catch it.`);
  lines.push(`${TAG} WARNING ONLY — this never blocks a push. See this script (warn-dropped-files.mjs).`);

  process.stderr.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch {
  // Fail open, always and silently. A push must never fail because of this.
}
process.exit(0);
