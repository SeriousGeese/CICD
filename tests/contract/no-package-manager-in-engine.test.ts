import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The engine must not know which package manager a consumer uses.
 *
 * DnD runs npm + jest shards; PromptCI and promptci-cloud run pnpm + vitest. The
 * whole reason `.cicd/quality-gates.sh` exists is so that difference never has to
 * be merged — the engine asks a hook to "install" or "run gates" and the consumer
 * answers in its own terms.
 *
 * This is a blunt string check on purpose. The realistic way this regresses is not
 * a redesign, it is someone reaching into the engine for one small thing ("just run
 * the changed jest shard here") because the hook is one indirection away. A grep is
 * the right shape of guard for that, and it fails loudly the moment it happens.
 *
 * Comments are exempt: the engine's comments cite the npm-registry incident that
 * produced the infra_fail channel, and deleting that history to satisfy a linter
 * would be the wrong trade.
 *
 * Lockfile NAMES are also allowed, and the distinction is the point: the engine
 * legitimately has to know which files a model may never hand-edit, but must not
 * know how to run an installer. Names are data; `npm ci` is machinery. The
 * lockfile guard gets its own positive test below.
 */

const engine = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'engine',
  'pr-review.sh',
);
const source = readFileSync(engine, 'utf8');

/** Source lines with comment-only lines and trailing comments removed. */
function executableLines(text: string): Array<{ n: number; line: string }> {
  return text
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*#/.test(line))
    .map(({ n, line }) => ({ n, line: line.replace(/\s#.*$/, '') }));
}

describe('engine carries no package-manager knowledge', () => {
  const FORBIDDEN = [
    /\bnpm\s+(ci|install|run|test|exec)\b/,
    /\bpnpm\s+(install|run|test|exec|--filter)\b/,
    /\byarn\s+(install|run|test)\b/,
    /\bnode_modules\b/,
  ];

  for (const re of FORBIDDEN) {
    it(`does not invoke ${re.source}`, () => {
      const hits = executableLines(source)
        .filter(({ line }) => re.test(line))
        .map(({ n, line }) => `  ${n}: ${line.trim()}`);
      expect(
        hits,
        `package-manager knowledge leaked back into the engine.\n` +
          `It belongs in the consumer's .cicd/quality-gates.sh:\n${hits.join('\n')}`,
      ).toEqual([]);
    });
  }

  it('refuses model edits to every lockfile in the fleet, not just the npm one', () => {
    // DnD is npm; PromptCI and promptci-cloud are pnpm. Before consolidation only
    // `package-lock.json` was named here, so both pnpm repos' lockfiles could be
    // hand-edited by a model and applied.
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      expect(source, `${lock} must be in LOCKFILE_NAMES`).toContain(lock);
    }
    expect(source).toMatch(/LOCKFILE_NAMES=/);
  });

  it('routes installs and gates through the hook', () => {
    // The positive half: it is not enough that npm is absent, the delegation has
    // to actually be there — otherwise deleting the feature would pass this file.
    expect(source).toMatch(/\.cicd\/quality-gates\.sh/);
    expect(source).toMatch(/run_install_hook\(\)/);
    expect(source).toMatch(/bash "\$hook" run/);
    expect(source).toMatch(/bash "\$hook" install/);
  });

  it('keeps the pass|fail|infra_fail contract its callers read', () => {
    // Callers take the LAST LINE of run_quality_gates' stdout. Changing these
    // words silently turns "gates failed" into "gates passed" at the merge gate.
    for (const word of ['"pass"', '"fail"', '"infra_fail"']) {
      expect(source, `run_quality_gates must still emit ${word}`).toContain(`echo ${word}`);
    }
  });
});
