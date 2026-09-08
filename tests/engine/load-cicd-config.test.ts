import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOADER = path.join(repoRoot, 'engine', 'load-cicd-config.sh');

/**
 * The loader decides which knobs on the PR-merge gate are live. It was inline in
 * actions/pr-review/action.yml, where two of its bugs were unobservable: a key
 * the filter never matches is a key nothing logs, and a caller default of
 * 'false' is indistinguishable from a caller that passed nothing.
 */
function load(content: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [LOADER, '-'], {
    input: content,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  const settings: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const i = line.indexOf('=');
    settings[line.slice(0, i)] = line.slice(i + 1);
  }
  return { settings, stderr: r.stderr, status: r.status, lines: r.stdout.trim().split('\n').filter(Boolean) };
}

describe('load-cicd-config', () => {
  it('reads a plain assignment', () => {
    expect(load('CICD_REQUIRED_CHECKS_FALLBACK=ci\n').settings).toEqual({
      CICD_REQUIRED_CHECKS_FALLBACK: 'ci',
    });
  });

  it('reads a key with a DIGIT in its name', () => {
    // The bug this file was written for. `CICD_[A-Z_]+` does not match
    // CICD_FEATURE_E2E_GATE, the only flag carrying a digit — so promptci-cloud,
    // the one repo that needs it, would have had its e2e gate silently ignored.
    expect(load('CICD_FEATURE_E2E_GATE=1\n').settings).toEqual({
      CICD_FEATURE_E2E_GATE: '1',
    });
  });

  it('lets a value already set in the environment win, and says so', () => {
    const { settings, stderr } = load('CICD_DRY_RUN=0\n', { CICD_DRY_RUN: 'true' });
    expect(settings).toEqual({});
    expect(stderr).toContain('already set by the caller');
  });

  it('does NOT treat an empty environment value as "already set"', () => {
    // strict-skipped's action input defaults to '' precisely so that an
    // unset knob reads as unset. If empty counted as set, .cicd/config.env
    // could never turn strict-skipped on for any repo.
    expect(load('CICD_STRICT_SKIPPED=true\n', { CICD_STRICT_SKIPPED: '' }).settings).toEqual({
      CICD_STRICT_SKIPPED: 'true',
    });
  });

  it('ignores names outside the CICD_ namespace', () => {
    const { settings } = load('PATH=/evil\nGH_TOKEN=leak\nHOME=/tmp\nCICD_DRY_RUN=1\n');
    expect(settings).toEqual({ CICD_DRY_RUN: '1' });
  });

  it('ignores a lowercase or mixed-case near-miss rather than guessing', () => {
    expect(load('cicd_dry_run=1\nCicd_Dry_Run=1\n').settings).toEqual({});
  });

  it('strips comments, indentation and surrounding quotes', () => {
    const { settings } = load(
      [
        '# a comment',
        '   ',
        '  CICD_REQUIRED_CHECKS_FALLBACK="lint,type-check,build"   # DnD',
        "  CICD_DOCS_ONLY_PREFIXES='docs/,Docs/'",
        'export CICD_FEATURE_BEADS=1',
      ].join('\n'),
    );
    expect(settings).toEqual({
      CICD_REQUIRED_CHECKS_FALLBACK: 'lint,type-check,build',
      CICD_DOCS_ONLY_PREFIXES: 'docs/,Docs/',
      CICD_FEATURE_BEADS: '1',
    });
  });

  it('does not execute the file', () => {
    // The file arrives from a consumer repo. `source`ing it would be arbitrary
    // execution inside the reviewer that decides whether a PR merges.
    const { settings, stderr } = load('CICD_X=$(touch /tmp/cicd-loader-pwned)\nCICD_DRY_RUN=`id`\n');
    expect(settings.CICD_X).toBe('$(touch /tmp/cicd-loader-pwned)');
    expect(settings.CICD_DRY_RUN).toBe('`id`');
    expect(stderr).not.toContain('uid=');
  });

  it('refuses a value carrying a newline, which would forge a second assignment', () => {
    // The caller appends each line to $GITHUB_ENV. A smuggled newline there is a
    // second, unreviewed environment variable in the reviewer's process.
    const { settings, stderr } = load('CICD_DRY_RUN="a\nGH_TOKEN=stolen"\n');
    expect(settings.GH_TOKEN).toBeUndefined();
    expect(stderr + JSON.stringify(settings)).not.toContain('stolen');
  });

  it('emits one KEY=VALUE per line and nothing else on stdout', () => {
    // stdout is consumed by a `while read` loop; a stray log line there becomes
    // a bogus export.
    const { lines } = load('CICD_DRY_RUN=1\nCICD_FEATURE_BEADS=0\n', { CICD_STRICT_SKIPPED: 'x' });
    expect(lines).toEqual(['CICD_DRY_RUN=1', 'CICD_FEATURE_BEADS=0']);
  });

  it('treats a missing file as defaults, not an error', () => {
    const r = spawnSync('bash', [LOADER, '/nonexistent/.cicd/config.env'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('rejects a usage error loudly', () => {
    expect(spawnSync('bash', [LOADER], { encoding: 'utf8' }).status).toBe(2);
  });
});
