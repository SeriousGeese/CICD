import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every composite action must resolve to a file that exists, and must pass the
 * engine the inputs it actually reads.
 *
 * These actions run from `${{ github.action_path }}`, a checkout of THIS repo in
 * the consumer's runner temp — so a path that is merely plausible fails at
 * runtime, in someone else's CI, with a bare "No such file or directory". That is
 * the whole class of bug this file exists to catch before it ships.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsDir = path.join(repoRoot, 'actions');
const actions = readdirSync(actionsDir).filter((d) =>
  existsSync(path.join(actionsDir, d, 'action.yml')),
);

describe('composite actions', () => {
  it('every action directory has an action.yml', () => {
    expect(actions.sort()).toEqual(['ci-gate', 'pr-review', 'resolve-gh']);
  });

  for (const name of actions) {
    const yml = readFileSync(path.join(actionsDir, name, 'action.yml'), 'utf8');

    it(`${name}: every engine file it runs exists`, () => {
      // `${ACTION_PATH}/../../engine/x` resolves to <repo>/engine/x.
      //
      // Not every action runs an engine file — resolve-gh is pure bash — so this
      // asserts that whatever IS referenced exists, and a separate case below
      // checks the set as a whole is not empty.
      const refs = [...yml.matchAll(/ACTION_PATH\}?\/\.\.\/\.\.\/(\S+?)"/g)].map((m) => m[1]);
      for (const rel of refs) {
        expect(
          existsSync(path.join(repoRoot, rel)),
          `${name}/action.yml runs ${rel}, which does not exist`,
        ).toBe(true);
      }
    });

    it(`${name}: declares every input it interpolates`, () => {
      // Catches a renamed input silently becoming the empty string — which for
      // ci-gate would mean an empty required-jobs list.
      //
      // Matches both YAML styles: a block key on its own line, and the inline
      // `name: { description: ..., required: true }` form. An earlier version
      // only handled the former and reported every inline-declared input as
      // undeclared.
      const inputsBlock = yml.split(/^runs:/m)[0];
      const declared = new Set(
        [...inputsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]),
      );
      const used = new Set([...yml.matchAll(/inputs\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
      for (const u of used) {
        expect(declared.has(u), `${name} uses inputs.${u} but never declares it`).toBe(true);
      }
    });
  }

  for (const name of actions) {
    it(`${name}: no expressions in description text`, () => {
      // GitHub evaluates ${{ }} inside `description:` too. An expression naming a
      // context an action cannot resolve — `needs`, `matrix`, `secrets` — fails the
      // ENTIRE manifest at load time with "Unrecognized named-value", before any
      // step runs, in the consumer's CI rather than here.
      //
      // This is not hypothetical: ci-gate shipped with `${{ toJSON(needs) }}` in an
      // input description as documentation, and every consuming job died on
      // "Failed to load action.yml". The wiring checks above all passed, because
      // the file existed and the inputs were declared.
      const yml = readFileSync(path.join(actionsDir, name, 'action.yml'), 'utf8');
      const meta = yml.split(/^runs:/m)[0];
      // `outputs.<id>.value:` is the ONE place an expression legitimately belongs
      // in the metadata section — `steps` IS resolvable there, and an action's
      // outputs cannot be wired any other way. Everything else in this section is
      // prose, where an expression is either dead text or a manifest-breaking
      // reference to a context the action cannot see.
      const offenders = meta
        .split('\n')
        .map((line, i) => ({ n: i + 1, line }))
        .filter(({ line }) => /\$\{\{/.test(line) && !/^\s*value:/.test(line));
      expect(
        offenders.map(({ n, line }) => `  ${n}: ${line.trim()}`),
        `${name}/action.yml has an expression in its metadata section`,
      ).toEqual([]);
    });
  }

  it('at least one action actually runs the engine', () => {
    // The per-action check above tolerates an action that runs nothing from
    // engine/ (resolve-gh). This makes sure they are not ALL like that, which
    // would mean the actions had quietly stopped invoking the shared engine.
    const runsEngine = actions.filter((n) =>
      /ACTION_PATH\}?\/\.\.\/\.\.\/engine\//.test(
        readFileSync(path.join(actionsDir, n, 'action.yml'), 'utf8'),
      ),
    );
    expect(runsEngine.sort()).toEqual(['ci-gate', 'pr-review']);
  });

  it('ci-gate refuses an empty required-jobs list', () => {
    // A gate that passes unconditionally is worse than no gate: it looks like
    // protection. Pinned here as well as in ci-gate.test.mjs because the action
    // is the surface a consumer actually wires up.
    const engine = readFileSync(path.join(repoRoot, 'engine', 'ci-gate.mjs'), 'utf8');
    expect(engine).toMatch(/GATE_REQUIRED_JOBS is empty/);
  });
});
