import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, posix, type Harness } from '../harness/engine.js';

/**
 * Review validity — ported from DnD's prReviewLlmValidity.
 *
 * review_llm() used to accept ANY response that parsed into JSON with a "fixes"
 * key, so an empty `{"fixes": []}` from a model that never read the diff counted
 * as a completed review. On 2026-07-20, with the CI gate ALSO broken, roughly 35
 * consecutive 3–10s "no fixes needed" flash-model reviews were the only gate PRs
 * passed through before reaching main.
 *
 * THE CONTRACT PINNED HERE. A review must carry a non-empty summary to count.
 * That specific test is not arbitrary: extract-fixes.py maps a plain-text reply
 * like "LGTM" onto a summary, so a MISSING summary cannot mean "the model
 * answered in prose" — it means substance-free JSON, which is the rubber-stamp
 * signature exactly.
 *
 * The accepted review's token usage and call duration are recorded into the PR
 * comment's metadata, which is what makes a rubber-stamp visible per PR rather
 * than only in aggregate afterwards. A 3-second review with 40 completion tokens
 * looks like every other green comment until those numbers are printed next to
 * it.
 */

const script = readFileSync(enginePath, 'utf8');

describe('review telemetry reaches the PR comment', () => {
  it('surfaces the review call telemetry in the metadata block', () => {
    // Without these the rubber-stamp is invisible per PR — which is how ~35 of
    // them went unnoticed.
    expect(script).toContain('llm_call_seconds: ${LLM_CALL_SECONDS}');
    expect(script).toContain('llm_prompt_tokens: ${LLM_PROMPT_TOKENS}');
    expect(script).toContain('llm_completion_tokens: ${LLM_COMPLETION_TOKENS}');
  });
});

let h: Harness;

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8371 });
});
afterAll(() => h.cleanup());

const apiBody = (content: string, usage = { prompt_tokens: 1234, completion_tokens: 56 }) =>
  JSON.stringify({ choices: [{ message: { content } }], usage });

/**
 * Drive review_llm's VALIDATION against a canned API body, with no network.
 *
 * call_llm is overridden after the source. SCRIPT_DIR is left alone — unlike
 * DnD's original, which had to repoint it because it sourced a temp COPY of the
 * script and thereby lost extract-fixes.py. The shared harness sources the
 * engine in place, so the extractor next to it resolves on its own.
 */
function review(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  const bodyFile = path.join(h.dir, `body-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(bodyFile, usage ? apiBody(content, usage) : apiBody(content), 'utf8');
  return h.run({
    env: { OPENROUTER_API_KEY: 'fake' },
    body: [
      `call_llm() { cat "${posix(bodyFile)}"; }`,
      'rc=0',
      'review_llm "system prompt" "user content" || rc=$?',
      'echo "rc=$rc"',
      'echo "tier=$LLM_USED_TIER"',
      'echo "prompt_tokens=$LLM_PROMPT_TOKENS completion_tokens=$LLM_COMPLETION_TOKENS"',
    ].join('\n'),
  }).stdout;
}

describe('review_llm validity', () => {
  it('accepts a review with a real summary, recording its usage', () => {
    const out = review('{"summary": "Adds a tooltip to the campaign count.", "fixes": []}');
    expect(out).toContain('rc=0');
    expect(out).toContain('tier=openrouter');
    expect(out).toContain('prompt_tokens=1234 completion_tokens=56');
  });

  it('accepts a plain-text "LGTM"-style reply — the extractor maps it onto a summary', () => {
    // This is why "no summary" is a sound rubber-stamp test: prose replies
    // already arrive WITH a summary, so an empty one cannot be explained away as
    // a model that answered in English.
    expect(review('Looks good, no issues found.')).toContain('rc=0');
  });

  it('rejects substance-free fixes JSON with no summary — the rubber-stamp signature', () => {
    // Pre-fix this counted as "a valid review" and, combined with a broken CI
    // gate, was the only thing between a PR and main.
    const out = review('{"fixes": []}');
    expect(out).toContain('rc=1');
    expect(out).toContain('tier=none');
  });

  it('rejects a whitespace-only summary the same way', () => {
    expect(review('{"summary": "  \\n ", "fixes": []}')).toContain('rc=1');
  });

  it('records the usage it was actually given, not a default', () => {
    // Guards the telemetry itself: numbers that never change are numbers nobody
    // can use to spot a rubber-stamp.
    const out = review('{"summary": "Real review.", "fixes": []}', {
      prompt_tokens: 999,
      completion_tokens: 7,
    });
    expect(out).toContain('prompt_tokens=999 completion_tokens=7');
  });
});
