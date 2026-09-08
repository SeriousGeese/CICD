import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The consumer guide is the only artefact a fourth repo would adopt from, so a
 * claim in it that is no longer true is a defect with a blast radius.
 *
 * These check the two kinds of drift that have actually happened here:
 *
 *  1. Documenting a knob the engine does not read — which reads as configuration
 *     and does nothing.
 *  2. Re-teaching the aggregate-gate shorthand for CICD_STRICT_SKIPPED. That one
 *     has been wrong in THREE places already: this guide, the action's input
 *     description, and the test profiles. Following it hangs PromptCI's reviewer
 *     on every PR, so it is worth a test rather than a hope.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const guide = readFileSync(path.join(repoRoot, 'docs', 'CONSUMER-GUIDE.md'), 'utf8');

/** Every CICD_* name the engine or its actions actually read. */
function knownNames(): Set<string> {
  const files = [
    ...readdirSync(path.join(repoRoot, 'engine'))
      .filter((f) => /\.(sh|jq|mjs)$/.test(f))
      .map((f) => path.join(repoRoot, 'engine', f)),
    ...readdirSync(path.join(repoRoot, 'actions')).map((d) =>
      path.join(repoRoot, 'actions', d, 'action.yml'),
    ),
  ];
  const names = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bCICD_[A-Z0-9_]+\b/g)) names.add(m[0]);
  }
  return names;
}

describe('the consumer guide', () => {
  it('documents only CICD_* names the engine actually reads', () => {
    const known = knownNames();
    // Sanity-check the extractor before trusting the diff it produces.
    expect(known.has('CICD_DRY_RUN')).toBe(true);
    expect(known.has('CICD_STRICT_SKIPPED')).toBe(true);

    const mentioned = new Set([...guide.matchAll(/\bCICD_[A-Z0-9_]+\b/g)].map((m) => m[0]));
    expect(mentioned.size).toBeGreaterThan(0);
    const unknown = [...mentioned].filter((n) => !known.has(n));
    expect(unknown, 'documented but read by nothing').toEqual([]);
  });

  it('does not re-teach the aggregate-gate shorthand for CICD_STRICT_SKIPPED', () => {
    // The exact claim that was wrong: "a repo without an aggregate gate job must
    // set CICD_STRICT_SKIPPED=true". PromptCI has no aggregate gate and MUST set
    // false, or its reviewer waits out its poll budget on every pull request.
    const strictSection = guide.slice(guide.indexOf('### `CICD_STRICT_SKIPPED`'));
    expect(strictSection.length).toBeGreaterThan(200);
    expect(strictSection).not.toMatch(/without an aggregate `?gate`? job must set/i);
    // And it states the real rule in both directions.
    expect(strictSection).toMatch(/no check in the repo ever legitimately skips/i);
    expect(strictSection).toMatch(/REQUIRED context itself cannot skip/i);
  });

  it('does not claim config.env is read from the PR head', () => {
    // It is read from the BASE commit. The head-read was a real hole: a PR could
    // point the required-check fallback at a context that does not exist, and
    // required_contexts() fails open.
    expect(guide).toMatch(/read from the \*\*BASE commit\*\*/);
    expect(guide).not.toMatch(/config\.env[^.]{0,80}arrives from the PR under review/i);
  });

  it('names the commands this repo actually has', () => {
    // The guide told adopters to run `pnpm test` in a repo that uses npm.
    const scripts = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ).scripts as Record<string, string>;
    const verify = guide.slice(guide.indexOf('## Verifying an adoption'));
    for (const m of verify.matchAll(/^npm (?:run )?([a-z-]+)/gm)) {
      expect(Object.keys(scripts), `npm ${m[1]} is not a script here`).toContain(m[1]);
    }
    expect(verify).not.toContain('pnpm ');
  });
});
