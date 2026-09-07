import { describe, expect, it } from 'vitest';

import { DOCS_PREFIX, isDocsOnly, parseChangedPaths } from '../../engine/ci-docs-only.mjs';

/**
 * Every case here is written from the same angle: what would it take to make
 * this function return `true` when the change is NOT docs-only?
 *
 * That direction is the only one that matters. A wrong `false` runs a build that
 * did not need running — a few CI minutes. A wrong `true` skips the build, and
 * because the jobs still conclude `success` (their steps are skipped, not the
 * jobs), the aggregate `gate` still goes green. The pull request merges having
 * verified nothing, with no red anywhere and nothing in the checks UI to notice.
 *
 * So the assertions below are not symmetric by accident: the `false` rows are
 * the load-bearing ones.
 */

describe('isDocsOnly', () => {
  it('is true for a list that is entirely inside Docs/', () => {
    expect(isDocsOnly(['Docs/a.md'])).toBe(true);
    expect(isDocsOnly(['Docs/a.md', 'Docs/nested/b.md'])).toBe(true);
  });

  it('is false when even one path escapes Docs/', () => {
    // The mixed list is the realistic mistake: a PR that is "mostly docs".
    expect(isDocsOnly(['Docs/a.md', 'README.md'])).toBe(false);
    expect(isDocsOnly(['README.md', 'Docs/a.md'])).toBe(false);
  });

  it('is false for a lowercase docs/ path', () => {
    // Same directory on a case-insensitive checkout, different directory to git.
    // Accepting both spellings means the classifier keeps saying `true` after a
    // rename that left one of them pointing at nothing.
    expect(isDocsOnly(['docs/a.md'])).toBe(false);
    expect(isDocsOnly(['DOCS/a.md'])).toBe(false);
  });

  it('is false for an empty list', () => {
    // The whole reason this is not a vacuous `true`: "git listed no files" is
    // indistinguishable from "the diff never ran", and one of those must not
    // skip the build.
    expect(isDocsOnly([])).toBe(false);
  });

  it('is false for a workflow change', () => {
    // tests/repo/ reads the workflow files, so editing CI is never docs-only —
    // and a change that could disable the guard must never be able to skip the
    // tests that pin the guard.
    expect(isDocsOnly(['.github/workflows/ci.yml'])).toBe(false);
    expect(isDocsOnly(['scripts/ci-docs-only.mjs'])).toBe(false);
  });

  it('matches on the directory boundary, not the string prefix', () => {
    expect(isDocsOnly(['Docsomething/x'])).toBe(false);
    expect(isDocsOnly(['Docs.md'])).toBe(false);
    expect(isDocsOnly(['Docs'])).toBe(false);
    // The bare directory itself is not a changed file.
    expect(isDocsOnly([DOCS_PREFIX])).toBe(false);
  });

  it('is false for a path that can traverse back out of Docs/', () => {
    expect(isDocsOnly(['Docs/../apps/web/next.config.ts'])).toBe(false);
    expect(isDocsOnly(['Docs/a/../../package.json'])).toBe(false);
  });

  it('is false for a backslash-bearing or git-quoted path', () => {
    // core.quotePath wraps a path with control/non-ASCII bytes in double quotes
    // and escapes the contents: the `Docs/` prefix would then be an artefact of
    // the encoding, not a fact about the file.
    expect(isDocsOnly(['Docs\\a.md'])).toBe(false);
    expect(isDocsOnly(['Docs/a\\b.md'])).toBe(false);
    expect(isDocsOnly(['Docs/"quoted".md'])).toBe(false);
    expect(isDocsOnly([`Docs/a${String.fromCharCode(9)}b.md`])).toBe(false);
    expect(isDocsOnly([`Docs/a${String.fromCharCode(127)}b.md`])).toBe(false);
  });

  it('is false for malformed input of any shape', () => {
    expect(isDocsOnly(undefined)).toBe(false);
    expect(isDocsOnly(null)).toBe(false);
    expect(isDocsOnly('Docs/a.md')).toBe(false);
    expect(isDocsOnly(42)).toBe(false);
    expect(isDocsOnly({ 0: 'Docs/a.md', length: 1 })).toBe(false);
    expect(isDocsOnly(['Docs/a.md', 7])).toBe(false);
    expect(isDocsOnly(['Docs/a.md', null])).toBe(false);
  });

  it('is false when reading the input throws', () => {
    const exploding = [];
    Object.defineProperty(exploding, 0, {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });

    expect(Array.isArray(exploding)).toBe(true);
    expect(exploding.length).toBe(1);
    expect(isDocsOnly(exploding)).toBe(false);
  });
});

describe('parseChangedPaths', () => {
  it('splits git output and tolerates CRLF', () => {
    expect(parseChangedPaths('Docs/a.md\nDocs/b.md\n')).toEqual(['Docs/a.md', 'Docs/b.md']);
    expect(parseChangedPaths('Docs/a.md\r\nDocs/b.md\r\n')).toEqual(['Docs/a.md', 'Docs/b.md']);
  });

  it('returns an empty list for empty or non-string input', () => {
    // Which then classifies `false` — the point of not special-casing it here.
    expect(parseChangedPaths('')).toEqual([]);
    expect(parseChangedPaths('\n\n')).toEqual([]);
    expect(parseChangedPaths(undefined)).toEqual([]);
    expect(parseChangedPaths(null)).toEqual([]);
    expect(isDocsOnly(parseChangedPaths(''))).toBe(false);
  });

  it('does not trim, so a leading space cannot be shaved into a Docs/ path', () => {
    expect(parseChangedPaths(' Docs/a.md\n')).toEqual([' Docs/a.md']);
    expect(isDocsOnly(parseChangedPaths(' Docs/a.md\n'))).toBe(false);
  });

  it('classifies real git output end to end', () => {
    expect(isDocsOnly(parseChangedPaths('Docs/ci-automation.md\n'))).toBe(true);
    expect(isDocsOnly(parseChangedPaths('Docs/ci-automation.md\npackage.json\n'))).toBe(false);
  });
});
