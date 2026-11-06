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
  default: string;
  files: string[];
  sets: Record<string, string[]>;
};
/** Every vendorable file: the union of the named sets (what `sync --set all` writes). */
const allFiles = [...new Set(Object.values(manifest.sets).flat())].sort();
const listed = new Set(allFiles);

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
  it('the manifest sets together list exactly the files in agent-hooks/', () => {
    const onDisk = readdirSync(hooksDir).filter((f) => f !== 'manifest.json').sort();
    expect(allFiles).toEqual(onDisk);
  });

  it('"files" is the default set, core, so an older sync.mjs still vendors exactly that', () => {
    expect(manifest.default).toBe('core');
    expect([...manifest.files].sort()).toEqual([...manifest.sets.core].sort());
  });

  it('"all" is not a manifest set: sync computes it as the union', () => {
    expect(Object.keys(manifest.sets)).not.toContain('all');
  });

  for (const [name, files] of Object.entries(manifest.sets)) {
    it(`set "${name}" carries sync.mjs and its tests, so a consumer of that set alone can re-sync and check`, () => {
      expect(files).toContain('sync.mjs');
      expect(files).toContain('sync.node-test.mjs');
    });

    it(`set "${name}" is closed: every .mjs imports only node: builtins and files in the same set`, () => {
      const inSet = new Set(files);
      const bad: string[] = [];
      for (const file of files.filter((f) => f.endsWith('.mjs'))) {
        for (const spec of importsOf(readFileSync(path.join(hooksDir, file), 'utf8'))) {
          if (spec.startsWith('node:')) continue;
          const sibling = /^\.\/([^/]+)$/.exec(spec)?.[1];
          if (!(sibling && inSet.has(sibling))) bad.push(`${file} -> ${spec}`);
        }
      }
      expect(bad, `set "${name}" would break when vendored on its own`).toEqual([]);
    });

    it(`set "${name}" ships the node:test suite of every module it ships`, () => {
      const missing = files
        .filter((f) => f.endsWith('.mjs') && !f.endsWith('.node-test.mjs'))
        .map((f) => f.replace(/\.mjs$/, '.node-test.mjs'))
        .filter((t) => readdirSync(hooksDir).includes(t) && !files.includes(t));
      expect(missing).toEqual([]);
    });
  }

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

  for (const file of allFiles.filter((f) => f.endsWith('.mjs'))) {
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
    for (const file of allFiles) {
      const text = readFileSync(path.join(hooksDir, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\bDnD\b|\bDND_|\bPROMPTCI_|promptci-cloud|tooling-oddities/i.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('an entry-point check compares through realpath, so a hook reached through a link still runs', () => {
    // node resolves import.meta.url through symlinks and junctions but leaves argv[1] as typed.
    // A guard whose entry check compares them directly does nothing through a linked checkout:
    // it fails open, and so does a name check (`argv[1].endsWith(...)`) for a file linked under
    // another name. So argv[1] may appear in a shipped module only inside the realpath
    // comparison, on its own line: that also catches a check split across two lines.
    const bad: string[] = [];
    let checks = 0;
    for (const file of allFiles.filter((f) => f.endsWith('.mjs') && !f.endsWith('.node-test.mjs'))) {
      readFileSync(path.join(hooksDir, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('process.argv[1]')) return;
          checks += 1;
          const realpathCompare = /realpathSync\(process\.argv\[1\]\)\s*===\s*realpathSync\(fileURLToPath\(import\.meta\.url\)\)/;
          if (!realpathCompare.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(checks, 'found the entry checks (so a clean result means something)').toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});
