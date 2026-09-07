import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These specs run the REAL jq program the way ci-lib.sh runs it — `jq -s -f
// scripts/ci-status.jq` with the same two --argjson bindings — rather than
// reimplementing its semantics in JS. A reimplementation would agree with a
// wrong program just as happily as with a right one, and the whole point of
// this file is that the check-run reduction is exactly right: the bug it
// exists to prevent (PR #155, below) is a FALSE MERGE BLOCK on green CI, and
// its mirror image would be a false green on a red PR.
// Subject lives in engine/, tests in tests/engine/ — in promptci-cloud these were
// co-located under scripts/, so the original resolved its subject as its own dir.
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');
const jqProgram = path.join(scriptsDir, 'ci-status.jq');

/** Invoke the real jq with a stream of page objects, as --paginate emits them. */
function ciStatus(pages, { superseded = [], required = [] } = {}) {
  const input = pages.map((page) => JSON.stringify(page)).join('\n');
  const out = execFileSync(
    'jq',
    [
      '-s',
      '--argjson',
      'superseded',
      JSON.stringify(superseded),
      '--argjson',
      'required',
      JSON.stringify(required), '--argjson', 'strict_skipped', 'false',
      '-f',
      jqProgram,
    ],
    { input, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

let autoId = 1000;
const run = ({
  name,
  status = 'completed',
  conclusion = 'success',
  id = autoId++,
  suite = 900,
}) => ({
  id,
  name,
  status,
  conclusion,
  check_suite: { id: suite },
});

/** One `gh api --paginate` page. */
const page = (runs) => ({ total_count: runs.length, check_runs: runs });

describe('scripts/ci-status.jq', () => {
  it('compiles, and contains no alternative operator', () => {
    // jq 1.7.1 (what ubuntu-latest ships) rejects the two-slash alternative
    // operator as an object-construction VALUE. A syntax error there is not a
    // wrong field, it is a program that does not compile at all — every poll
    // then falls back to the api_failed sentinel forever. Local jq is newer
    // and would happily accept the form, so this has to be asserted on the
    // source text rather than left to the local parser to catch.
    const source = readFileSync(jqProgram, 'utf8');
    expect(source).not.toContain('//');

    // And it compiles and runs end-to-end under whatever jq is on this
    // machine: empty stdin slurps to [], which is a legitimate zero-page input.
    expect(ciStatus([])).toMatchObject({ total: 0, api_failed: false });
  });

  // ── The regression this whole library exists for ──────────────────────────
  it('PR #155 shape: two superseded cancelled auto-merge runs plus a later success is GREEN', () => {
    // Real ids and suites from repos/SeriousGeese/promptci-cloud head 98a70d4.
    // auto-merge.yml has cancel-in-progress:true and fires on every label and
    // synchronize, so the same SHA carries three generations of `auto-merge`.
    // Only `ci` is flipped to success here — on the real SHA it failed, which
    // is the sole reason this bug had not yet blocked a mergeable PR.
    const status = ciStatus([
      page([
        run({ name: 'e2e', conclusion: 'skipped', id: 101508696852, suite: 92230702651 }),
        run({ name: 'auto-merge', conclusion: 'success', id: 101508523940, suite: 92230701261 }),
        run({ name: '🤖 Auto-Review PR', conclusion: 'success', id: 101508523149, suite: 92230702698 }),
        run({ name: 'Generated types match migrations', id: 101508522941, suite: 92230702651 }),
        run({ name: 'ci', conclusion: 'success', id: 101508522840, suite: 92230702651 }),
        run({ name: 'audit', id: 101508522707, suite: 92230702615 }),
        run({ name: 'auto-merge', conclusion: 'cancelled', id: 101508521301, suite: 92230700324 }),
        run({ name: 'auto-merge', conclusion: 'cancelled', id: 101508518115, suite: 92230698661 }),
      ]),
    ]);

    expect(status.all_success).toBe(true);
    expect(status.all_completed).toBe(true);
    expect(status.unresolved).toBe(0);
    expect(status.failures).toBe(0);
    expect(status.pending).toBe('');
    // 8 raw runs minus the self-review minus the two superseded auto-merge
    // generations: e2e, auto-merge, Generated types, ci, audit.
    expect(status.total).toBe(5);
  });

  it('excludes the bot own check run by name prefix', () => {
    const status = ciStatus([
      page([
        run({ name: '🤖 Auto-Review PR', status: 'in_progress', conclusion: null }),
        run({ name: 'ci' }),
      ]),
    ]);
    expect(status.total).toBe(1);
    expect(status.all_completed).toBe(true);
    expect(status.all_success).toBe(true);
  });

  it('counts check runs across every page of a paginated response', () => {
    // `gh api` returns 30 per page by default and --paginate emits one object
    // per page. A program that looks at only the first page silently loses the
    // rest, and a lost check run is indistinguishable from one that never
    // existed — i.e. it reads as green.
    const status = ciStatus([
      page([run({ name: 'ci' }), run({ name: 'audit' })]),
      page([run({ name: 'e2e' }), run({ name: 'gate' })]),
    ]);
    expect(status.total).toBe(4);
    expect(status.success).toBe(4);
    expect(status.all_success).toBe(true);
  });

  it('treats a skipped check that is NOT required as a pass', () => {
    const status = ciStatus(
      [page([run({ name: 'ci' }), run({ name: 'Close beads', conclusion: 'skipped' })])],
      { required: ['ci'] },
    );
    expect(status.skipped).toBe(1);
    expect(status.unresolved).toBe(0);
    expect(status.all_success).toBe(true);
    expect(status.required_not_passing).toEqual([]);
  });

  it('treats a skipped check that IS required as unresolved and blocking', () => {
    // GitHub will not merge on a skipped required context, so neither may we.
    const status = ciStatus(
      [page([run({ name: 'ci' }), run({ name: 'gate', conclusion: 'skipped' })])],
      { required: ['gate'] },
    );
    expect(status.all_success).toBe(false);
    expect(status.unresolved).toBe(1);
    expect(status.unresolved_names).toContain('gate');
    expect(status.required_not_passing).toEqual(['gate']);
    expect(status.required_missing).toEqual([]);
  });

  it('blocks when a required context produced no check run at all', () => {
    // Zero runs for a required gate is the shape of a workflow that never
    // registered, not of a green PR.
    const status = ciStatus([page([run({ name: 'ci' }), run({ name: 'audit' })])], {
      required: ['gate'],
    });
    expect(status.all_completed).toBe(true);
    expect(status.all_success).toBe(false);
    expect(status.required_missing).toEqual(['gate']);
    expect(status.required_not_passing).toEqual([]);
  });

  it('names the failing checks and their suites', () => {
    const status = ciStatus([
      page([
        run({ name: 'ci', conclusion: 'failure', suite: 42 }),
        run({ name: 'audit' }),
      ]),
    ]);
    expect(status.failures).toBe(1);
    expect(status.failure_names).toContain('ci');
    expect(status.failure_suites).toEqual([42]);
    expect(status.all_success).toBe(false);
    expect(status.unresolved).toBe(0);
    expect(status.pending).toContain('ci');
  });

  it('leaves a cancelled run with no successor unresolved, and resolves it once its suite is superseded', () => {
    // The unexpanded-matrix case group_by(.name) cannot reach: a run cancelled
    // before its matrix expanded publishes a name no later generation
    // republishes, so there is no same-named successor to prefer.
    const runs = [
      page([
        run({ name: 'ci' }),
        run({ name: 'e2e (shard 1)', conclusion: 'cancelled', suite: 7 }),
      ]),
    ];

    const before = ciStatus(runs);
    expect(before.unresolved).toBe(1);
    expect(before.unresolved_names).toContain('e2e (shard 1)');
    expect(before.all_success).toBe(false);

    const after = ciStatus(runs, { superseded: [7] });
    expect(after.unresolved).toBe(0);
    expect(after.total).toBe(1);
    expect(after.all_success).toBe(true);
  });

  it('never lets a superseded suite hide a real failure or an in-flight run', () => {
    // The superseded filter drops ONLY terminal-with-no-verdict runs, so it can
    // turn no red into a green.
    const status = ciStatus(
      [
        page([
          run({ name: 'ci', conclusion: 'failure', suite: 7 }),
          run({ name: 'e2e', status: 'in_progress', conclusion: null, suite: 7 }),
        ]),
      ],
      { superseded: [7] },
    );
    expect(status.total).toBe(2);
    expect(status.failures).toBe(1);
    expect(status.all_completed).toBe(false);
    expect(status.all_success).toBe(false);
  });

  it('reports a still-running check as pending, not complete', () => {
    const status = ciStatus([
      page([run({ name: 'ci', status: 'in_progress', conclusion: null }), run({ name: 'audit' })]),
    ]);
    expect(status.all_completed).toBe(false);
    expect(status.all_success).toBe(false);
    expect(status.pending).toContain('conclusion=none');
    expect(status.unresolved).toBe(0);
  });

  it('is never all_success on zero check runs, and always reports api_failed false', () => {
    const status = ciStatus([page([])]);
    expect(status.total).toBe(0);
    expect(status.all_completed).toBe(false);
    expect(status.all_success).toBe(false);
    expect(status.api_failed).toBe(false);
  });
});
