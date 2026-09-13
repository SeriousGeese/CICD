// Shared path helpers for the PreToolUse hooks that track a leading `cd <dir>`
// (or a `git -C <dir>`) across a compound command and then ask git about that
// directory (a consumer's per-repo guards, e.g. ones that refuse a destructive
// `git checkout -- <path>` or a branch switch inside a linked worktree).
//
// Why this file exists: on Windows, Node's `path.resolve` treats a leading `/`
// as CURRENT-DRIVE root, so the MSYS/Git-Bash drive form agents write
// everywhere — `/d/Worktrees/...`, `/c/git/...` — resolves to a directory that
// does not exist:
//
//   path.resolve('C:/git/x', '/d/Worktrees/y') -> 'C:\\d\\Worktrees\\y'
//   path.resolve('C:/git/x', '/c/git/z')       -> 'C:\\c\\git\\z'
//   path.resolve('C:/git/x', 'D:/Worktrees/y') -> 'D:\\Worktrees\\y'   (correct)
//
// `git -C C:/d/Worktrees/... status` then dies with "cannot change to ...", which
// is indistinguishable from the guards' ordinary fail-open cases, so a
// destructive `cd /d/<worktree> && git checkout -- <dirty file>` sailed straight
// through: the edits were discarded and the caller got no signal at all, while
// the guard was documented as protection. A guard believed to be active is worse
// than a known-absent one, so the normalisation lives in ONE place guards import.
import path from 'node:path';

// `/d/x` or `/D/x` or a bare `/d` — a single ASCII letter as the FIRST segment is
// the MSYS drive prefix. `/tmp/...` and `/usr/...` are multi-letter and therefore
// untouched (they are Git-Bash mount points, not drives, and resolving them is
// not something these guards attempt).
const MSYS_DRIVE_RE = /^\/([A-Za-z])(?:\/|$)/;

/**
 * Rewrite an MSYS/Git-Bash absolute path (`/d/Worktrees/x`) to the Windows form
 * (`D:/Worktrees/x`) so `path.resolve` keeps the drive. No-op on every non-win32
 * platform, where `/d/...` is a genuine POSIX path and rewriting it would be the
 * bug — hence the explicit `platform` parameter, which also makes this testable
 * from Linux CI.
 */
export function msysToWindowsPath(target, platform = process.platform) {
  if (platform !== 'win32') return target;
  if (typeof target !== 'string' || target.length === 0) return target;
  const m = MSYS_DRIVE_RE.exec(target);
  if (!m) return target;
  return `${m[1].toUpperCase()}:/${target.slice(m[0].length)}`;
}

/** Strip one leading and one trailing quote character from a shell token. */
export function unquote(s) {
  return String(s).replace(/^['"]/, '').replace(/['"]$/, '');
}

/**
 * Resolve a raw shell token naming a directory (a `cd` target or a `git -C`
 * value) against `baseDir`, unquoting it and normalising the MSYS drive form
 * first.
 */
export function resolveShellDir(baseDir, rawToken, platform = process.platform) {
  return path.resolve(baseDir, msysToWindowsPath(unquote(rawToken), platform));
}

/** `process.cwd()` without throwing when the cwd has been deleted underneath us. */
export function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

/**
 * Is this token a plain literal path we can meaningfully check on disk?
 *
 * A token carrying shell expansion (`$REPO`, backticks, globs, `~`, subshells) or
 * `cd -` resolves to nothing useful, and "the directory does not exist" then says
 * nothing about the real target — so callers that fail CLOSED on a missing
 * directory must not do so for these.
 */
export function isLiteralPathToken(rawToken) {
  const t = unquote(rawToken);
  if (t.length === 0 || t === '-') return false;
  return !/[$`*?~()]/.test(t);
}
