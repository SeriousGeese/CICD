import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, posix, type Harness } from '../harness/engine.js';

/**
 * The containment guard on apply_fixes() — ported from DnD's
 * prReviewApplyFixesContainment.
 *
 * WHY THIS PATH IS ATTACKER-REACHABLE. `path` in an LLM fix comes from the
 * model, and the model's input is the PR diff — for a Dependabot PR the body
 * carries third-party release notes. DnD's AUTOMERGE_AUTHORS includes
 * `dependabot[bot]`, so a fix gets applied, with write access, on a self-hosted
 * runner, off the back of content nobody in the org wrote. Before the guard,
 * apply_fixes() interpolated that path straight into
 * `full_path="${WORK_DIR}/${path}"` and wrote there, so `/etc/passwd` and
 * `../../x` both escaped the checkout.
 *
 * THIS IS THE ONE PIECE THAT CAME FROM PromptCI. It had the lexical half; DnD
 * and promptci-cloud had neither, and this is exactly the kind of one-repo
 * hardening a shared engine exists to spread.
 *
 * BOTH LAYERS ARE PINNED because the lexical test alone is NOT sufficient: a
 * symlink committed in the PR makes `linkdir/x` a lexically clean path that
 * still escapes, and the create-new-file branch runs
 * `mkdir -p "$(dirname …)"` before writing, which follows it.
 *
 * TWO HARNESS FACTS, both learned the hard way and both load-bearing:
 *  - the engine ASSIGNS APPLIED_FIXES_FILE/DROPPED_FIXES_FILE itself at source
 *    time, so exporting them beforehand does nothing — they must be reassigned
 *    AFTER the source;
 *  - `trap cleanup EXIT` deletes WORK_DIR on the way out, which would erase the
 *    very evidence these assertions read. The shared harness stubs cleanup for
 *    every spec, which is how that stopped being something each file remembers.
 */

let h: Harness;

/**
 * Why the symlink case cannot run on this host, or null when it can.
 *
 * Creating a symlink on Windows needs Developer Mode or an elevated process;
 * without either, Node's symlinkSync throws EPERM and the case would fail on
 * the FIXTURE, never reaching the guard it exists to test (DnD-gspjs). Only that
 * exact combination skips — any other error, or any other platform, still runs
 * the case (and fails loudly if the fixture breaks), so this can never turn a
 * Linux regression green.
 */
function symlinkSkipReason(): string | null {
  if (process.platform !== 'win32') return null;
  const probe = mkdtempSync(path.join(tmpdir(), 'cicd-symlink-probe-'));
  try {
    mkdirSync(path.join(probe, 'target'));
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'dir');
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      return 'win32 without symlink privilege (EPERM) — enable Developer Mode or run elevated to exercise this case; Linux CI runs it';
    }
    throw e;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const SYMLINK_SKIP = symlinkSkipReason();

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8361 });
});
afterAll(() => h.cleanup());

type Probe = {
  out: string;
  dropped: string;
  applied: string;
  work: string;
  outside: string;
  dir: string;
};

/** Run apply_fixes() with one fix, in a WORK_DIR isolated per case. */
function runFix(pathValue: string, opts: { symlink?: boolean; content?: string } = {}): Probe {
  const dir = mkdtempSync(path.join(tmpdir(), 'cicd-containment-'));
  const work = path.join(dir, 'work');
  const outside = path.join(dir, 'outside');
  mkdirSync(work, { recursive: true });
  mkdirSync(outside, { recursive: true });

  if (opts.symlink) {
    // A symlink the PR itself could carry: tracked, relative, pointing out of tree.
    symlinkSync(outside, path.join(work, 'linkdir'), 'dir');
  }

  const dropped = path.join(dir, 'dropped.md');
  const applied = path.join(dir, 'applied.md');
  // apply_fixes() consumes `.fixes[]`, not a bare fix object.
  const payload = JSON.stringify({
    fixes: [
      {
        path: pathValue,
        old_string: '',
        new_string: opts.content ?? 'PWNED',
        description: 'containment probe',
      },
    ],
  });

  const { stdout } = h.run({
    env: { WORK_DIR: work },
    cwd: work,
    body: [
      // Reassigned AFTER the source; the engine sets its own at source time.
      `DROPPED_FIXES_FILE="${posix(dropped)}"`,
      `APPLIED_FIXES_FILE="${posix(applied)}"`,
      ': > "$DROPPED_FIXES_FILE"; : > "$APPLIED_FIXES_FILE"',
      `apply_fixes ${JSON.stringify(payload)} >/dev/null`,
    ].join('\n'),
  });

  return {
    out: stdout,
    dropped: readFileSync(dropped, 'utf8'),
    applied: readFileSync(applied, 'utf8'),
    work,
    outside,
    dir,
  };
}

describe('apply_fixes containment', () => {
  it('rejects an absolute path', () => {
    const target = path.join(tmpdir(), 'cicd-containment-abs-probe.txt');
    const r = runFix(target);
    expect(existsSync(target)).toBe(false);
    expect(r.out).toMatch(/REJECTED/);
    expect(r.dropped).toMatch(/outside the PR checkout/);
    expect(r.applied.trim()).toBe('');
  });

  // Windows spellings of "absolute", rejected on EVERY host (DnD-gspjs). The
  // engine also runs under Git Bash on Windows runners, where MSYS resolves each
  // of these outside WORK_DIR; the lexical layer used to test only a leading
  // `/`, so a `C:\...` path from the model was written. On Linux they are
  // nonsense names no real fix uses, so rejecting them costs nothing there.
  it.each([
    ['a drive letter with a backslash', 'C:\\Windows\\pwned.txt'],
    ['a drive letter with a forward slash', 'C:/Windows/pwned.txt'],
    ['a drive-relative path', 'c:pwned.txt'],
    ['a leading backslash', '\\Windows\\pwned.txt'],
    ['a UNC path', '\\\\server\\share\\pwned.txt'],
    ['a forward-slash UNC path', '//server/share/pwned.txt'],
    ['a backslash `..` traversal', 'a\\..\\..\\pwned.txt'],
  ])('rejects %s at the lexical layer', (_label, p) => {
    const r = runFix(p);
    expect(r.out).toMatch(/REJECTED .* \(path escapes the PR checkout\)/);
    expect(r.dropped).toMatch(/REJECTED: path outside the PR checkout/);
    expect(r.applied.trim()).toBe('');
    expect(existsSync(path.join(r.dir, 'pwned.txt'))).toBe(false);
  });

  it('rejects a parent-directory escape', () => {
    const r = runFix('../pwned.txt');
    expect(existsSync(path.join(r.dir, 'pwned.txt'))).toBe(false);
    expect(r.dropped).toMatch(/outside the PR checkout/);
  });

  it('rejects a `..` segment buried mid-path', () => {
    // A naive `[[ $path == ../* ]]` check would let this one through.
    const r = runFix('a/b/../../../pwned.txt');
    expect(existsSync(path.join(r.dir, 'pwned.txt'))).toBe(false);
    expect(r.dropped).toMatch(/outside the PR checkout/);
  });

  it('rejects a symlink escape that is lexically clean', (ctx) => {
    ctx.skip(SYMLINK_SKIP !== null, SYMLINK_SKIP ?? undefined);
    // `linkdir/x` is neither absolute nor contains `..` — only the RESOLVED
    // check catches it. This is precisely what a lexical guard cannot see, and
    // why shipping only the lexical half would have read as done.
    const r = runFix('linkdir/x', { symlink: true });
    expect(existsSync(path.join(r.outside, 'x'))).toBe(false);
    expect(r.dropped).toMatch(/resolves outside the PR checkout/);
  });

  it('rejects an absolute path — the one thing ONLY the lexical layer catches', () => {
    // Not a duplicate of the first case; this pins WHY the lexical layer has to
    // exist at all, which is not obvious and was measured rather than assumed.
    //
    // The resolved check tests `${WORK_DIR}/${path}`. For an absolute path that
    // concatenation is `/tmp/work//etc/passwd` — which IS inside WORK_DIR, so
    // fix_path_is_contained says "contained" and the write happens. It lands
    // somewhere harmless, but it lands: the fix is APPLIED instead of REJECTED,
    // and the reviewer reports having made a change nobody asked for at a path
    // nobody named.
    //
    // Verified by mutation: deleting the lexical guard leaves the `..` cases
    // passing and fails only this one.
    const r = runFix('/etc/passwd');
    expect(r.out).toMatch(/REJECTED/);
    expect(r.applied.trim()).toBe('');
  });

  it('catches `..` at the RESOLVED layer too — the lexical half is defence in depth', () => {
    // Stated because the opposite reading is the tempting one. fix_path_is_contained
    // runs `realpath -m`, which normalises `..` before comparing, so every `..`
    // case above is caught twice. Removing the lexical `..` test kills no case in
    // this file — measured.
    //
    // It stays anyway: it is one `[[ ]]` on a path that reached here from an LLM
    // whose input includes third-party release notes, and `realpath -m` is a GNU
    // spelling. On a host without it the resolved layer fails CLOSED — correct,
    // but it means the layers are not independent, so the cheap one is worth
    // keeping. What this case pins is that the claim is TRUE, not that the
    // lexical test is redundant.
    const r = runFix('a/b/../../../pwned.txt');
    expect(r.dropped).toMatch(/outside the PR checkout/);
    // realpath is what the resolved layer depends on; if it is ever absent the
    // guard rejects everything, which the in-tree case below would catch.
    expect(existsSync(path.join(r.dir, 'pwned.txt'))).toBe(false);
  });

  it('still applies an ordinary in-tree fix', () => {
    // The guard must not be so broad that it breaks the feature it protects —
    // the failure mode of an over-tight containment check is a reviewer that
    // silently stops fixing anything.
    const r = runFix('src/ok.txt', { content: 'fine' });
    const written = path.join(r.work, 'src', 'ok.txt');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain('fine');
    expect(r.applied).toMatch(/src\/ok\.txt/);
    expect(r.dropped.trim()).toBe('');
  });
});
