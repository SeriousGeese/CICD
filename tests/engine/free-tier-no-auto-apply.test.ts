import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, posix, type Harness } from '../harness/engine.js';

/**
 * The free-tier auto-apply gate — ported from DnD's prReviewFreeTierNoAutoApply.
 *
 * THE INCIDENT. On PR #2747 the auto-reviewer reported that "the clone action
 * used the source run's raw playerSlots value instead of the tier-clamped value
 * from the gate", and generated an auto-appliable fix. The finding was FALSE and
 * the fix would have CREATED the bug it claimed to prevent — in merged main the
 * raw value goes only INTO the gate as an input, and what is inserted is the
 * clamped `runGate.resolvedPlayerSlots`.
 *
 * This bot auto-applies fixes and then merges them for allowlisted authors. The
 * only thing between that confidently-wrong patch and `main`, on a
 * billing-adjacent tier-limit guard, was a `do-not-merge` label that happened to
 * be on for an unrelated reason. With the label off — the normal state — it
 * would have merged a regression.
 *
 * The root-cause signal was in the metadata of the same batch:
 *   PR #2747 (wrong):  llm_tier: openrouter-free, nvidia/nemotron-…:free
 *   PR #2746 (clean):  llm_tier: openrouter,      z-ai/glm-5.2
 * Not a truncation artifact — the free run burned 59272 prompt / 9892 completion
 * tokens. It read the diff and was confidently wrong.
 *
 * THE RULE: a free-tier review may COMMENT but never auto-APPLY. Deliberately
 * out of scope (product decision, 2026-09-01): making a free-tier review fail
 * the merge gate on its own, which risks stalling auto-merge whenever the paid
 * tier is unavailable.
 *
 * THE SECOND HALF of this file is about what the PR comment SAYS. fix_skip_reason
 * once branched on $HOLD_LABEL alone, so every other hold — a stacked base, an
 * unmet Depends-on, both fail-closed lookup paths — fell through to "author not
 * in auto-merge allowlist". That is a false statement about the author, printed
 * onto their PR, sending whoever reads it hunting an allowlist problem that does
 * not exist.
 */

const script = readFileSync(enginePath, 'utf8');

const PAID_MODEL = 'z-ai/glm-5.2';
const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

/**
 * The fail-closed sentinel the label / base-ref / body lookups emit instead of a
 * value they could not read. Parsed out of the engine rather than duplicated, so
 * a rename follows here instead of leaving these cases quietly asserting on an
 * ordinary string no guard ever produces.
 */
const SENTINEL = (() => {
  const m = script.match(/^LABEL_LOOKUP_FAILED='([^']+)'/m);
  if (!m) throw new Error('could not parse LABEL_LOOKUP_FAILED out of engine/pr-review.sh');
  return m[1];
})();

let h: Harness;
let commentFile: string;

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8381 });
  commentFile = path.join(h.dir, 'comment.md');
});
afterAll(() => h.cleanup());

type Holds = { label?: string; base?: string; deps?: string; orphans?: string };

function call(
  mode: string,
  tier: string,
  model: string,
  opts: { eligible?: string; holds?: Holds } = {},
) {
  const holds = opts.holds ?? {};
  const body = [
    `COMMENT_FILE="${posix(commentFile)}"`,
    `LLM_USED_TIER=${JSON.stringify(tier)}`,
    `LLM_USED_MODEL=${JSON.stringify(model)}`,
    // Each is a real engine global, so setting them here is exactly what the
    // guards in main/merge_pr do.
    `HOLD_LABEL=${JSON.stringify(holds.label ?? '')}`,
    `HOLD_STACKED_BASE=${JSON.stringify(holds.base ?? '')}`,
    `HOLD_UNMET_DEPS=${JSON.stringify(holds.deps ?? '')}`,
    `HOLD_ORPHANS=${JSON.stringify(holds.orphans ?? '')}`,
    {
      is_paid: 'if llm_tier_is_paid; then echo PAID; else echo FREE; fi',
      may_apply: `if review_may_apply_fixes ${JSON.stringify(opts.eligible ?? 'true')}; then echo APPLY; else echo SKIP; fi`,
      reason: 'fix_skip_reason; echo',
      sentinel: `printf '%s\\n' "$LABEL_LOOKUP_FAILED"`,
      header: 'llm_tier_header_line; echo',
      comment: 'generate_comment "Review complete." commented 1 >/dev/null; cat "$COMMENT_FILE"',
    }[mode],
  ].join('\n');
  return h.run({ body }).stdout;
}

const verdict = (out: string) => out.split('\n').filter((l) => l.trim() !== '').pop()?.trim() ?? '';

describe('llm_tier_is_paid', () => {
  it('identifies the paid tier', () => {
    expect(verdict(call('is_paid', 'openrouter', PAID_MODEL))).toBe('PAID');
  });

  it('identifies the free tier — the one that produced the #2747 finding', () => {
    expect(verdict(call('is_paid', 'openrouter-free', FREE_MODEL))).toBe('FREE');
  });

  it.each([
    ['no tier completed a review', 'none', 'none'],
    ['an empty tier', '', ''],
    ['a tier added to the chain later and not allowlisted', 'anthropic-experimental', 'claude-x'],
  ])('fails closed on %s', (_label, tier, model) => {
    // Same contract as the do-not-merge label lookup: a tier that cannot be
    // POSITIVELY identified as paid is treated as free and refused.
    expect(verdict(call('is_paid', tier, model))).toBe('FREE');
  });

  it('fails closed when the PAID tier resolved to a `:free` model id', () => {
    // OPENROUTER_MODEL is an Actions variable — the paid tier's NAME can be
    // pointed at a free model without touching the engine at all.
    expect(verdict(call('is_paid', 'openrouter', FREE_MODEL))).toBe('FREE');
  });

  it("rejects every `:free` model in the engine's own tier chain", () => {
    // Guards against the hole reopening by a rename: if the fallback tier is
    // renamed to something the allowlist happens to accept, the model-id check
    // must still catch it — and if the array can no longer be parsed, fail
    // rather than pass vacuously.
    const tiers = [...script.matchAll(/^\s*"([a-z0-9-]+)\|\$\{[A-Z_]+\}\|\$\{([A-Z_]+)\}\|/gm)].map(
      (m) => ({ tier: m[1], modelVar: m[2] }),
    );
    expect(tiers.length).toBeGreaterThanOrEqual(2);

    const defaults = new Map(
      [...script.matchAll(/^: "\$\{(OPENROUTER_[A-Z_]*MODEL):=([^}]+)\}"/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const freeTiers = tiers.filter((t) => (defaults.get(t.modelVar) ?? '').endsWith(':free'));
    expect(freeTiers.length).toBeGreaterThanOrEqual(1);

    for (const t of freeTiers) {
      expect(verdict(call('is_paid', t.tier, defaults.get(t.modelVar) as string))).toBe('FREE');
    }
  });
});

describe('review_may_apply_fixes — the damage path', () => {
  it('applies a fix from the paid tier for an allowlisted author', () => {
    // The behaviour this must NOT break: paid-tier auto-fix still works.
    expect(verdict(call('may_apply', 'openrouter', PAID_MODEL, { eligible: 'true' }))).toBe('APPLY');
  });

  it('refuses to apply a fix from the free tier even when everything else allows it', () => {
    // THE BEAD. Allowlisted author, no hold label — pre-fix this applied the
    // patch and then merged it. `do-not-merge` being on for #2747 was luck.
    expect(verdict(call('may_apply', 'openrouter-free', FREE_MODEL, { eligible: 'true' }))).toBe(
      'SKIP',
    );
  });

  it('still refuses a paid-tier fix when the author is not allowlisted', () => {
    expect(verdict(call('may_apply', 'openrouter', PAID_MODEL, { eligible: 'false' }))).toBe('SKIP');
  });

  it('still refuses a paid-tier fix under a hold label', () => {
    // automerge_eligible is already false by the time main reaches the gate when
    // a hold label is on; assert the collapsed input, not the label.
    expect(
      verdict(
        call('may_apply', 'openrouter', PAID_MODEL, {
          eligible: 'false',
          holds: { label: 'do-not-merge' },
        }),
      ),
    ).toBe('SKIP');
  });
});

describe('the reason a human reads', () => {
  it('names the tier when the tier is what blocked the apply', () => {
    const out = call('reason', 'openrouter-free', FREE_MODEL);
    expect(out).toContain('openrouter-free');
    expect(out).toContain(FREE_MODEL);
    expect(out).toContain('never auto-applies');
  });

  it('still names the label and the allowlist for the pre-existing reasons', () => {
    expect(call('reason', 'openrouter', PAID_MODEL, { holds: { label: 'do-not-merge' } })).toContain(
      "'do-not-merge' label",
    );
    expect(call('reason', 'openrouter', PAID_MODEL)).toContain('auto-merge allowlist');
  });
});

describe('reports the real hold cause, not the allowlist', () => {
  const reason = (holds: Holds) => call('reason', 'openrouter', PAID_MODEL, { holds });

  it('agrees with the engine about the fail-closed sentinel', () => {
    // SENTINEL is parsed from the engine so a rename follows rather than
    // silently turning these into ordinary-string tests; this asserts the parse
    // still resolves, and that the harness sees the same value the functions do.
    expect(SENTINEL).toBe('<label lookup failed>');
    expect(verdict(call('sentinel', 'openrouter', PAID_MODEL))).toBe(SENTINEL);
  });

  it('names the stacked base', () => {
    const out = reason({ base: 'feat/parent' });
    expect(out).toContain('feat/parent');
    expect(out).toContain('stacked');
    expect(out).not.toContain('allowlist');
  });

  it('names the unmet Depends-on refs', () => {
    const out = reason({ deps: '#2694 #2701' });
    expect(out).toContain('#2694 #2701');
    expect(out).toContain('Depends-on');
    expect(out).not.toContain('allowlist');
  });

  it('names the orphan block', () => {
    const out = reason({ orphans: '#2710' });
    expect(out).toContain('#2710');
    expect(out).toContain('orphan');
    expect(out).not.toContain('allowlist');
  });

  it('reads as fail-closed when the LABEL lookup failed, and never leaks the sentinel', () => {
    const out = reason({ label: SENTINEL });
    expect(out).toContain('failed closed');
    expect(out).toContain('labels could not be read');
    // The sentinel is an internal marker; rendering it verbatim would read as a
    // label literally named "<label lookup failed>".
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain('allowlist');
  });

  it.each([
    ['the base ref lookup failed', 'base' as const],
    ['the body lookup failed', 'deps' as const],
  ])('reads as fail-closed when %s', (_label, key) => {
    const out = reason({ [key]: SENTINEL });
    expect(out).toContain('failed closed');
    expect(out).toContain('base ref or body could not be read');
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain('allowlist');
  });

  it('still blames the allowlist only when NO hold is recorded', () => {
    // The one case where the old message was true. It must survive.
    expect(reason({})).toContain('author not in auto-merge allowlist');
  });

  it('prefers the label over a co-occurring stacked-base hold', () => {
    // Both guards run in main and both can be set on one run. The order mirrors
    // the held-run `case "$result"` block, so the comment's hold section, the
    // run result and this reason cannot disagree.
    expect(reason({ label: 'do-not-merge', base: 'feat/parent' })).toContain("'do-not-merge' label");
  });

  it('still puts the free tier ahead of every hold', () => {
    // A free-tier run genuinely cannot apply the fix no matter what else is
    // true, and it is the cause a reader is least likely to guess.
    const out = call('reason', 'openrouter-free', FREE_MODEL, {
      holds: { label: 'do-not-merge', base: 'feat/parent' },
    });
    expect(out).toContain('never auto-applies');
  });

  it('covers every hold global the engine records', () => {
    // Structural backstop: if a future guard adds a HOLD_* global, this fails
    // until fix_skip_reason learns to report it — which is exactly the original
    // bug, reintroduced under a new name.
    const declared = [...script.matchAll(/^(HOLD_[A-Z_]+)=/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThanOrEqual(4);
    // Anchored on the line start: `review_may_apply_fixes() {` ENDS with the
    // substring `apply_fixes() {` and sits above fix_skip_reason, so a bare
    // indexOf slices an empty string and the loop passes vacuously.
    const body = script.slice(
      script.indexOf('\nfix_skip_reason() {'),
      script.indexOf('\napply_fixes() {'),
    );
    expect(body.length).toBeGreaterThan(0);
    for (const g of new Set(declared)) {
      expect(body).toContain(`$${g}`);
    }
  });
});

describe('the tier is visible without expanding the metabox', () => {
  const header = (comment: string) => {
    const idx = comment.indexOf('<details>');
    expect(idx).toBeGreaterThan(0); // the metadata block still exists
    return comment.slice(0, idx);
  };

  it('names the free tier ABOVE the collapsed metadata block', () => {
    const comment = call('comment', 'openrouter-free', FREE_MODEL);
    const above = header(comment);
    expect(above).toContain('openrouter-free');
    expect(above).toContain(FREE_MODEL);
    expect(above).toContain('FREE tier');
    // The metadata block still carries it too — the header is an ADDITION, not
    // a move; the yaml block is what tooling greps.
    expect(comment).toContain('llm_tier: openrouter-free');
  });

  it('names the paid tier above the fold as well', () => {
    const above = header(call('comment', 'openrouter', PAID_MODEL));
    expect(above).toContain('openrouter');
    expect(above).toContain(PAID_MODEL);
    expect(above).not.toContain('FREE tier');
  });

  it('says so above the fold when no tier reviewed at all', () => {
    expect(header(call('comment', 'none', 'none'))).toContain('no LLM tier completed a review');
  });

  it('renders the header line directly for both tiers', () => {
    expect(call('header', 'openrouter', PAID_MODEL)).toContain('paid tier');
    expect(call('header', 'openrouter-free', FREE_MODEL)).toContain('FREE tier');
  });
});

describe('the gate cannot be bypassed by a second call site', () => {
  it('gates the only apply_fixes call site, and discards free-tier work before the commit', () => {
    const callSites = script
      .split('\n')
      .filter((l) => /(^|[^_a-z])apply_fixes\s+"/.test(l) && !l.trimStart().startsWith('#'));
    expect(callSites).toHaveLength(1);

    const guardIdx = script.indexOf('review_may_apply_fixes "$automerge_eligible"');
    expect(guardIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(script.indexOf(callSites[0]));

    // Belt and braces: nothing a free or unidentified tier touched may be
    // committed, so it can never be pushed and never merged.
    const commitBlock = script.slice(
      script.indexOf('# ── 6. Commit and push fixes / sync merge'),
      script.indexOf('local ahead_count'),
    );
    expect(commitBlock.length).toBeGreaterThan(0);
    expect(commitBlock).toContain('llm_tier_is_paid');
    expect(commitBlock.indexOf('llm_tier_is_paid')).toBeLessThan(commitBlock.indexOf('git commit'));
  });
});

describe('CICD_DRY_RUN sits ahead of the tier gate', () => {
  it('refuses to apply even a paid-tier fix in shadow mode', () => {
    // The engine checks dry-run FIRST and unconditionally, which is what makes
    // shadow mode impossible to talk past — whatever the allowlist or the tier
    // says. Not in DnD's original because dry-run did not exist there.
    const out = h.run({
      body: [
        'LLM_USED_TIER=openrouter',
        `LLM_USED_MODEL=${JSON.stringify(PAID_MODEL)}`,
        'if review_may_apply_fixes true; then echo APPLY; else echo SKIP; fi',
      ].join('\n'),
      env: { CICD_DRY_RUN: 'true' },
    }).stdout;
    expect(verdict(out)).toBe('SKIP');
  });
});
