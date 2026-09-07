/**
 * Docs-only classifier for the `changes` job in .github/workflows/ci.yml.
 *
 * Answers exactly one question: "is EVERY path in this changed-file list inside
 * `Docs/`?" The `ci`, `e2e` and `audit` jobs use the answer to skip their STEPS
 * (never the jobs — see below) and save CI minutes on a prose-only pull request.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION IS A SILENT-PASS VECTOR. IT MUST FAIL CLOSED.
 * ---------------------------------------------------------------------------
 * A false positive here does not produce a red build — it produces a GREEN one
 * that verified nothing. The jobs still run, still conclude `success`, and the
 * aggregate `gate` still passes, because from the gate's point of view all three
 * jobs succeeded. There is no signal anywhere that the work was skipped by
 * mistake. So every input this module cannot reason about with certainty — an
 * empty list, a non-array, a non-string entry, a git-quoted path, a path
 * containing `..` or a backslash, or anything that throws while being read —
 * returns `false`, meaning "run the whole build". `false` costs money; `true`
 * costs correctness.
 *
 * The prefix test is `Docs/` and nothing else:
 *   • `docs/a.md` (lowercase) is FALSE. On a case-insensitive filesystem it is
 *     the same directory, but the repo spells it `Docs/`, and a classifier that
 *     accepts both spellings is one rename away from accepting a directory that
 *     does not exist. Fail closed on the ambiguity.
 *   • `Docsomething/x` is FALSE. The match is on the directory boundary, which
 *     is why the constant carries the trailing slash.
 *   • `.github/workflows/ci.yml` is FALSE, like everything else outside `Docs/`:
 *     `tests/repo/` reads the workflow files, so a workflow edit is never
 *     docs-only even though it ships nothing to the app.
 *
 * Note what is deliberately NOT here: any notion of the event that produced the
 * list. The caller decides when it is even legitimate to ask (only a
 * `pull_request` merge commit; a `push` or `workflow_dispatch` never classifies).
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The one directory whose contents no build, test or scan reads. */
export const DOCS_PREFIX = 'Docs/';

/** Highest code point treated as a control character (US, 0x1F). */
const LAST_CONTROL_CODE_POINT = 31;

/** DEL (0x7F) — the other control character git will quote. */
const DELETE_CODE_POINT = 127;

/**
 * Split raw `git diff --name-only` output into paths.
 *
 * Only the trailing carriage return of a CRLF line ending is stripped — the
 * lines are NOT otherwise trimmed, because a leading space is part of the
 * filename, and trimming one off " Docs/x.md" would turn a path we cannot vouch
 * for into one that looks safe. Blank lines are dropped; anything else is handed
 * through verbatim for {@link isDocsOnly} to judge.
 *
 * @param {unknown} text Raw stdout from git.
 * @returns {string[]} One entry per non-empty line. `[]` for anything unusable.
 */
export function parseChangedPaths(text) {
  if (typeof text !== 'string') return [];

  return text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

/**
 * Is this a path we can read literally, with no quoting or escaping games?
 *
 * git quotes a path containing control or non-ASCII bytes (`core.quotePath`),
 * wrapping it in double quotes and backslash-escaping the contents. Such a line
 * is an ENCODED path, not a literal one, so its `Docs/` prefix would be a
 * coincidence of the encoding rather than a fact about the file.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isLiteralPath(path) {
  for (const char of path) {
    if (char === '"') return false;

    const code = char.codePointAt(0);
    if (code <= LAST_CONTROL_CODE_POINT || code === DELETE_CODE_POINT) return false;
  }

  return true;
}

/**
 * @param {unknown} paths A list of repo-relative, POSIX-separated changed paths.
 * @returns {boolean} `true` only when the list is non-empty and every entry is a
 *   file inside `Docs/`. Every other input, including a throwing one, is `false`.
 */
export function isDocsOnly(paths) {
  try {
    if (!Array.isArray(paths)) return false;

    // An empty list is the dangerous case, not the trivial one: "git told us
    // nothing changed" is indistinguishable from "the diff failed", and vacuous
    // truth would skip the entire build on it.
    if (paths.length === 0) return false;

    for (const path of paths) {
      if (typeof path !== 'string') return false;
      if (!path.startsWith(DOCS_PREFIX)) return false;

      // `Docs/` alone is a directory, not a changed file — git never emits it,
      // so seeing it means the input is not what we think it is.
      if (path.length === DOCS_PREFIX.length) return false;

      // A backslash is either a Windows separator or an escape inside a quoted
      // path; `..` lets an entry traverse back out of Docs/. Neither is
      // something a prefix test can reason about.
      if (path.includes('\\')) return false;
      if (path.split('/').includes('..')) return false;

      if (!isLiteralPath(path)) return false;
    }

    return true;
  } catch {
    // A getter that throws, an exotic proxy, anything at all: unknown is `false`.
    return false;
  }
}

/**
 * Read every byte of stdin. Returns an empty string rather than throwing when
 * stdin is closed, empty, or unreadable — an empty list classifies `false`.
 *
 * @returns {string}
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// CLI guard: only when executed directly, so importing this from a test does not
// consume stdin or exit the test process.
//
// Usage: `git diff --name-only HEAD^1 HEAD | node scripts/ci-docs-only.mjs`
// Prints `true` or `false` and ALWAYS exits 0 — a non-zero exit would fail the
// `changes` job, which would cascade `ci`/`e2e`/`audit` into `skipped` and block
// the PR on a git hiccup. The fail-closed answer is `false` (run everything),
// not "no answer".
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Declared without an initialiser only to satisfy no-useless-assignment; every
  // path below assigns it, and the catch-all assigns the fail-closed answer.
  let verdict;

  try {
    verdict = isDocsOnly(parseChangedPaths(readStdin()));
  } catch {
    verdict = false;
  }

  console.log(verdict ? 'true' : 'false');
  process.exit(0);
}
