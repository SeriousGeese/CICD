import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LINUX_ONLY_SUITES } from '../../vitest.win.config.mts';

/**
 * `pnpm test:win` is the defined green a Windows contributor can reach, and it
 * gets there by EXCLUDING suites. An exclusion list is the one kind of test
 * config that fails silently in the direction nobody notices: every entry
 * removes coverage, and an entry naming a file that no longer exists removes
 * nothing while still reading as a justified exception. So the list is checked
 * rather than trusted.
 *
 * What is deliberately NOT asserted here: that the excluded suites actually
 * fail on Windows. This suite runs on Linux in CI, where all four pass — the
 * evidence for the exclusion is the measurement recorded in
 * `vitest.win.config.mts`, not something a Linux run can reproduce.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

describe('the Windows test gate', () => {
  it('excludes only suites that exist', () => {
    // A stale entry silently drops nothing and looks like a live exception.
    const missing = LINUX_ONLY_SUITES.filter((p) => !existsSync(path.join(repoRoot, p)));
    expect(missing, 'excluded by vitest.win.config.mts but not present in the tree').toEqual([]);
  });

  it('excludes only files the project gate would otherwise run', () => {
    // An entry outside `tests/**` excludes nothing from `pnpm test` and is
    // therefore either a typo or a misunderstanding of what this list does.
    const stray = LINUX_ONLY_SUITES.filter((p) => !/^tests\/.+\.test\.(ts|mjs)$/.test(p));
    expect(stray, 'not a path the base include glob matches').toEqual([]);
  });

  it('records a reason beside every exclusion', () => {
    // The list may only shrink, and an entry with no host reason beside it is
    // how it starts growing instead.
    const src = readFileSync(path.join(repoRoot, 'vitest.win.config.mts'), 'utf8');
    const list = src.slice(src.indexOf('export const LINUX_ONLY_SUITES'));
    for (const suite of LINUX_ONLY_SUITES) {
      const at = list.indexOf(`'${suite}'`);
      expect(at, `${suite} is not listed literally in vitest.win.config.mts`).toBeGreaterThan(-1);
      const preceding = list.slice(0, at);
      const lastComment = preceding.lastIndexOf('//');
      const lastEntry = preceding.lastIndexOf("',");
      expect(
        lastComment > lastEntry,
        `${suite} has no comment naming why it cannot run off Linux`,
      ).toBe(true);
    }
  });

  it('leaves the project gate running everything', () => {
    // The Windows gate is additive. If `test` ever starts pointing at the
    // reduced config, CI silently stops running the four engine suites — which
    // is the failure this whole arrangement exists to avoid.
    const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      .scripts as Record<string, string>;
    expect(scripts.test).toBe('vitest run');
    expect(scripts.test).not.toContain('vitest.win.config');
    expect(scripts['test:win'], 'the Windows gate must exist for the guide to name it').toContain(
      'vitest.win.config.mts',
    );
    // It is only a usable gate if it also covers the agent hooks, which are
    // node:test rather than vitest and pass on Windows today.
    expect(scripts['test:win']).toContain('test:agent-hooks');
  });

  it('is named in the consumer guide', () => {
    // A defined green nobody can find is not a defined green.
    const guide = readFileSync(path.join(repoRoot, 'docs', 'CONSUMER-GUIDE.md'), 'utf8');
    expect(guide).toContain('test:win');
  });
});
