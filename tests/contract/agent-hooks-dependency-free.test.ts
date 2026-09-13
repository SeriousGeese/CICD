import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `agent-hooks/` is not run from this repo. Its files are COPIED into consumer
 * repositories by `agent-hooks/sync.mjs` and run there by Claude Code, from the
 * consumer's working tree. Three properties make that copy safe, and each is the
 * kind of thing that regresses one convenient import at a time:
 *
 *  1. Dependency-free. A consumer may have no package.json at all (a Unity project),
 *     and a git worktree carries only its own files, so a vendored hook that imports
 *     a package — or a file outside the vendored set — breaks at the moment it is
 *     meant to protect someone. Only `node:` builtins and manifest siblings.
 *  2. The manifest is the whole set. An unlisted file is never vendored; a listed
 *     file that does not exist makes every sync fail.
 *  3. Neutral. This repository is public and serves several products, so the shared
 *     copies carry no consumer's name or escape-hatch prefix. A consumer's prefix is
 *     applied by sync (`--env-prefix`), and its local advice lives in a `.hint.txt`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const hooksDir = path.resolve(here, '..', '..', 'agent-hooks');
const manifest = JSON.parse(readFileSync(path.join(hooksDir, 'manifest.json'), 'utf8')) as {
  files: string[];
};
const listed = new Set(manifest.files);

function importsOf(source: string): string[] {
  const specs: string[] = [];
  // The binding list may span lines (`import {\n a,\n} from 'x'`) but never contains a quote:
  // `[\s\S]*?` here let a side-effect `import 'x';` swallow everything up to a LATER `from`,
  // so `x` itself was never checked.
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  // Re-exports pull a module in without the word `import`.
  for (const m of source.matchAll(/^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const m of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

describe('agent-hooks', () => {
  it('the manifest lists exactly the files in agent-hooks/', () => {
    const onDisk = readdirSync(hooksDir).filter((f) => f !== 'manifest.json').sort();
    expect([...listed].sort()).toEqual(onDisk);
  });

  it('import extraction sees real imports (so an empty result below means something)', () => {
    const specs = importsOf(readFileSync(path.join(hooksDir, 'block-masked-gates.mjs'), 'utf8'));
    expect(specs).toContain('node:fs');
    expect(specs).toContain('./refusal-notice.mjs');
    // Every form a hook could use to reach a module, including the ones without `import`.
    const forms = [
      "import a from 'pkg-a';",
      "import {\n  b,\n  bb,\n} from 'pkg-b';",
      "import 'pkg-c';",
      "export * from 'pkg-d';",
      "export * as e from 'pkg-e';",
      "export { f, g as h } from 'pkg-f';",
      "const i = await import('pkg-g');",
      "const j = require('pkg-h');",
    ].join('\n');
    expect(importsOf(forms).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-e', 'pkg-f', 'pkg-g', 'pkg-h']);
  });

  for (const file of manifest.files.filter((f) => f.endsWith('.mjs'))) {
    it(`${file} imports only node: builtins and manifest siblings`, () => {
      const bad = importsOf(readFileSync(path.join(hooksDir, file), 'utf8')).filter((spec) => {
        if (spec.startsWith('node:')) return false;
        const sibling = /^\.\/([^/]+)$/.exec(spec)?.[1];
        return !(sibling && listed.has(sibling));
      });
      expect(bad, `${file} would break when vendored`).toEqual([]);
    });
  }

  it('carries no consumer name or consumer escape-hatch prefix', () => {
    const hits: string[] = [];
    for (const file of manifest.files) {
      const text = readFileSync(path.join(hooksDir, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\bDnD\b|\bDND_|\bPROMPTCI_|promptci-cloud|tooling-oddities/i.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
