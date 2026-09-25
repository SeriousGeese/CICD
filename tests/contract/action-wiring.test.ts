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

  it('pr-review reads .cicd/config.env from the BASE commit, never the PR head', () => {
    // quality-gates.sh is read from the head on purpose — it is product code.
    // config.env is the opposite: it names the required checks and the feature
    // flags, i.e. it configures the gate that decides whether THIS PR merges.
    // Reading it from the head lets a PR author point
    // CICD_REQUIRED_CHECKS_FALLBACK at a context that does not exist, and
    // required_contexts() fails OPEN — after which every skipped check counts
    // as a pass. This asserts the wiring, because the difference between the
    // two sources is one word and produces no visible symptom either way.
    const yml = readFileSync(path.join(actionsDir, 'pr-review', 'action.yml'), 'utf8');
    expect(yml).toMatch(/git -C "\$WORK_DIR" show "\$\{BASE_SHA\}:\$\{CICD_CONFIG_FILE\}"/);
    expect(yml).not.toMatch(/config="\$\{WORK_DIR\}\/\$\{CICD_CONFIG_FILE\}"/);
  });

  it('pr-review parses config.env rather than sourcing it', () => {
    const yml = readFileSync(path.join(actionsDir, 'pr-review', 'action.yml'), 'utf8');
    expect(yml).toContain('engine/load-cicd-config.sh');
    // `source`/`.` on a file from a consumer repo is arbitrary execution inside
    // the reviewer, with GH_TOKEN and the OpenRouter key in scope.
    expect(yml).not.toMatch(/^\s*(source|\.)\s+.*CICD_CONFIG_FILE/m);
  });

  it('no action input that config.env is meant to supply carries a non-empty default', () => {
    // The loader's precedence rule is "a name already set in the environment was
    // passed explicitly by the caller, so it wins". An input with a default is
    // ALWAYS set — so a non-empty default silently makes the corresponding
    // config.env key dead. strict-skipped shipped exactly that way.
    const yml = readFileSync(path.join(actionsDir, 'pr-review', 'action.yml'), 'utf8');
    const configurable = ['strict-skipped'];
    for (const input of configurable) {
      const block = yml.slice(yml.indexOf(`  ${input}:`));
      const def = block.match(/default:\s*(.*)/)?.[1]?.trim();
      expect(def, `inputs.${input} default`).toMatch(/^(''|"")$/);
    }
  });

  it('pr-review forwards llm-max-time to the name the engine reads, defaulting to empty', () => {
    // The shadow engine could not be re-budgeted before this input existed: no
    // input mapped to PR_REVIEW_LLM_MAX_TIME, and config.env only carries CICD_*
    // names (DnD-tc2sq). The default must stay EMPTY so an unwired caller keeps
    // the engine's own default rather than a literal the action invented.
    const yml = readFileSync(path.join(actionsDir, 'pr-review', 'action.yml'), 'utf8');
    const block = yml.slice(yml.indexOf('  llm-max-time:'));
    expect(yml.indexOf('  llm-max-time:')).toBeGreaterThan(-1);
    expect(block.match(/default:\s*(.*)/)?.[1]?.trim()).toMatch(/^(''|"")$/);
    expect(yml).toMatch(/^\s+PR_REVIEW_LLM_MAX_TIME: \$\{\{ inputs\.llm-max-time \}\}$/m);

    // ...and that name is the one call_llm actually reads.
    const engine = readFileSync(path.join(repoRoot, 'engine', 'pr-review.sh'), 'utf8');
    expect(engine).toMatch(/\$\{PR_REVIEW_LLM_MAX_TIME:-\d+\}/);
  });

  it('pr-review forwards the cross-provider tier inputs, each defaulting to EMPTY', () => {
    // DnD-jc8my. Empty defaults are the "behaves exactly as before" guarantee:
    // an unwired switch is off, unwired endpoint/model inputs keep the engine
    // defaults, and an unwired token leaves the GitHub Models arm out of the
    // draw. Each input must also reach the NAME the engine reads — a renamed
    // env var turns the input into configuration that does nothing.
    const yml = readFileSync(path.join(actionsDir, 'pr-review', 'action.yml'), 'utf8');
    const engine = readFileSync(path.join(repoRoot, 'engine', 'pr-review.sh'), 'utf8');
    const wiring: Array<[string, string]> = [
      ['cross-provider-tier', 'PR_REVIEW_CROSS_PROVIDER'],
      ['sasquatch-endpoint', 'SASQUATCH_ENDPOINT'],
      ['sasquatch-model', 'SASQUATCH_MODEL'],
      ['github-models-token', 'GITHUB_MODELS_TOKEN'],
      ['github-models-model', 'GITHUB_MODELS_MODEL'],
    ];
    for (const [input, envName] of wiring) {
      const at = yml.indexOf(`  ${input}:`);
      expect(at, `inputs.${input} is declared`).toBeGreaterThan(-1);
      const def = yml.slice(at).match(/default:\s*(.*)/)?.[1]?.trim();
      expect(def, `inputs.${input} default`).toMatch(/^(''|"")$/);
      expect(yml).toMatch(new RegExp(`^\\s+${envName}: \\$\\{\\{ inputs\\.${input} \\}\\}$`, 'm'));
      // Read with a colon-dash fallback, so the empty string an unwired input
      // arrives as means "unset" rather than a literal empty value.
      expect(engine).toMatch(new RegExp(`${envName}="\\$\\{${envName}:-`));
    }
  });

  it('ci-gate refuses an empty required-jobs list', () => {
    // A gate that passes unconditionally is worse than no gate: it looks like
    // protection. Pinned here as well as in ci-gate.test.mjs because the action
    // is the surface a consumer actually wires up.
    const engine = readFileSync(path.join(repoRoot, 'engine', 'ci-gate.mjs'), 'utf8');
    expect(engine).toMatch(/GATE_REQUIRED_JOBS is empty/);
  });
});
