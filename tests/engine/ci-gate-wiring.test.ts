import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { enginePath } from '../harness/engine.js';

/**
 * The CI-gate WIRING — the engine-relevant half of DnD's prReviewCiGate.
 *
 * GitHub fires NO workflows for events created with GITHUB_TOKEN. Every push
 * this pipeline makes to a PR branch (base-sync merge, auto-review fix) is a
 * GITHUB_TOKEN push, so the pushed SHA never gets pull_request-triggered CI on
 * its own. Before the fix, wait_for_ci polled that SHA, found zero check runs,
 * and after the grace concluded "no CI applies (docs-only)" — a code that both
 * callers treated as green. On 2026-07-20 that merged ~30 code PRs with zero CI,
 * each carrying the comment "CI green (no CI checks apply to this change)".
 *
 * WHY THESE ARE STATIC. Every case here is about a call site or a return code
 * being handled in BOTH places. A return code that only ONE call site knows
 * about is worse than no new code at all: the other site falls into its `else`
 * and reports a 30-minute-timeout message for a poll that took one interval.
 * That is not reachable from a single-function behavioural test, which is why
 * these read the source rather than run it.
 *
 * WHAT DID NOT COME WITH IT, and why:
 *
 *  - "threads the ci_relevant flag into both call sites" and "keeps
 *    pr_touches_ci_paths globs in sync with ci.yml paths-ignore" are OBSOLETE.
 *    Both described the docs-only grace, which the wait_for_ci graft removed and
 *    whose orphaned producer was deleted. tests/engine/wait-for-ci.test.ts pins
 *    the removal instead.
 *  - "publishes an aggregate gate context, and never renames it" and "keeps
 *    ci.yml paths-ignore and the shim in sync" STAY IN DnD. They assert DnD's
 *    own ci.yml and ci-docs-shim.yml, which is repo configuration, not engine
 *    behaviour — and each consumer's equivalent already lives in that consumer's
 *    adoption test.
 *  - the `//`-free jq assertion and the per-NAME reduction are already covered
 *    directly, in ci-status.test.mjs and superseded-suite.test.ts, against the
 *    real jq rather than its source text.
 */

const script = readFileSync(enginePath, 'utf8');

/**
 * Slice a region between two markers and strip full-line comments, so an
 * assertion reads the CODE and cannot trip on prose ABOUT the code.
 *
 * The end marker is searched FROM the start marker: an earlier occurrence — a
 * comment naming wait_for_ci, say — would yield an empty region that passes
 * every assertion vacuously. Every region assertion goes through this helper for
 * that reason; each inlined copy is a fresh chance to drop the comment filter
 * and reopen the argument about what "the code" is.
 */
function scriptRegion(startMarker: string, endMarker: string): string {
  const start = script.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = script.indexOf(endMarker, start);
  expect(end, `end marker not found after start: ${endMarker}`).toBeGreaterThan(start);
  return script
    .slice(start, end)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
}

describe('wait_for_ci call sites', () => {
  it('passes the bot-pushed flag at both call sites, polling LIVE SHAs', () => {
    // The bot-commit short-circuit: the tip commit is by definition bot-pushed,
    // and the LIVE tip is polled — the event's HEAD_SHA goes stale on re-runs
    // and can be a green author commit while the tip is unverified.
    expect(script).toContain('wait_for_ci "$live_tip" true');
    // The main path: bot-pushed exactly when the polled SHA is not the author's
    // own event commit.
    expect(script).toContain('wait_for_ci "$push_sha" "$poll_bot_pushed"');

    // Neither call site may poll the replayable event SHA directly, and no
    // third, unaudited call site may sneak in without a flag decision.
    const callSites = script.split('\n').filter((l) => /^\s*wait_for_ci /.test(l));
    expect(callSites).toHaveLength(2);
    expect(callSites.some((l) => l.includes('"$HEAD_SHA"'))).toBe(false);
  });

  it('treats the fail-closed exit code as blocked at both call sites', () => {
    const matches = script.match(/"\$ci_exit" -eq 4/g) ?? [];
    expect(matches).toHaveLength(2);
    // And never folds it into the green path.
    expect(script).not.toMatch(/-eq 0 \] \|\| \[ "\$ci_exit" -eq 4/);
  });

  it('handles the terminal-but-unresolved verdict at both call sites', () => {
    const matches = script.match(/"\$ci_exit" -eq 5/g) ?? [];
    expect(matches).toHaveLength(2);
    // Both sites must share ONE message, or the two will drift.
    expect(script.match(/\$\(unresolved_ci_message\)/g) ?? []).toHaveLength(2);
    expect(script.match(/^unresolved_ci_message\(\) \{$/gm) ?? []).toHaveLength(1);
  });

  it('handles the missing-required verdict at both call sites too', () => {
    // Return 6 arrived with the graft and is the newest code here, so it is the
    // one most likely to be wired at one site only — which is the failure this
    // whole describe block exists to catch.
    const matches = script.match(/"\$ci_exit" -eq 6/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(script.match(/\$\(missing_required_message\)/g) ?? []).toHaveLength(2);
    expect(script.match(/^missing_required_message\(\) \{$/gm) ?? []).toHaveLength(1);
  });

  it('reports an unresolved CI verdict as `blocked`, never `blocked_infra`', () => {
    // `blocked_infra` turns the review check RED and is reserved for "the
    // reviewer could not evaluate this PR at all". A cancelled check is the PR's
    // condition, evaluated correctly — painting the reviewer red for it rebuilds
    // exactly the noise the exit-status contract removed.
    const sites = script
      .split('\n')
      .filter((line) => line.includes('unresolved_ci_message'))
      .filter((line) => line.includes('finish '));
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain('"blocked"');
      expect(site).not.toContain('blocked_infra');
    }
  });

  it('never folds the unresolved verdict into the merging path', () => {
    // 0 is the only code both call sites merge on. 5 must never join it: a
    // cancelled-only SHA is not a passing SHA.
    expect(script).not.toMatch(/-eq 0 \] \|\| \[ "\$ci_exit" -eq 5/);
    expect(script).not.toMatch(/-eq 5 \] \|\| \[ "\$ci_exit" -eq 0/);
    // 6 likewise — a required context that never registered is not a pass.
    expect(script).not.toMatch(/-eq 0 \] \|\| \[ "\$ci_exit" -eq 6/);
  });
});

describe('the check-run reduction', () => {
  it('keeps `failures` counting only real failures, so a cancel is never one', () => {
    // The counterweight the terminal-but-unresolved verdict exists to avoid
    // disturbing. If cancelled conclusions were folded into `failures`, rc=1
    // would start blocking legitimate cancelled+rerun pairs.
    const program = readFileSync(enginePath.replace(/pr-review\.sh$/, 'ci-status.jq'), 'utf8');
    expect(program).toMatch(/failures:[\s\S]{0,200}select\(\.conclusion == "failure"\)/);
  });

  it('names the non-terminal checks in the waiting and timeout log lines', () => {
    // "CI: 17 checks, waiting" hid the cause of a 1800s timeout: the
    // 11-green / 5-cancelled / 1-auto-review split had to be reconstructed from
    // the API by hand. Every line that reports a wait now names names.
    const region = scriptRegion('wait_for_ci() {', 'generate_comment() {');
    // The poll reads `.pending` out of the reduction's JSON. Asserting the
    // producer (`pending:` in ci-status.jq) here would pass while the poll
    // ignored it entirely — the log line is the whole point, so the CONSUMER is
    // what this checks.
    expect(region).toMatch(/pending="\$\(echo "\$raw_status" \| jq -r/);

    const timeoutLines = region.split('\n').filter((l) => l.includes('CI: TIMEOUT after'));
    expect(timeoutLines.length).toBeGreaterThan(0);
    expect(timeoutLines.every((l) => l.includes('${pending}'))).toBe(true);

    const waitingLines = region.split('\n').filter((l) => l.includes('checks, waiting'));
    expect(waitingLines.length).toBeGreaterThan(0);
    expect(waitingLines.every((l) => l.includes('${pending}'))).toBe(true);
  });
});
