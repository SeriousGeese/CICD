import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, posix, repoRoot, type Harness } from '../harness/engine.js';

/**
 * pcic-ndyi: say WHY the paid tier did not answer.
 *
 * On 2026-11-14 from about 06:55Z every review job failed with "Review was
 * answered by tier openrouter-free ..., which may not issue a verdict", and the
 * job log held nothing about the paid call, so nobody could tell out-of-credits
 * from a bad key, a renamed model or a slow provider. Pinned here:
 *  1. one log line (provider, model, HTTP status or "timeout after N s", the
 *     provider's error code) and LLM_PAID_FAILURE for library consumers, never
 *     carrying the key or the prompt;
 *  2. the kinds are worded apart: "refused (402 no credits)" vs "timed out";
 *  3. engine/llm-canary.sh, the daily one-call canary.
 *
 * `curl` is a shell function: no network, and call_llm's real code runs.
 */

const KEY = 'sk-or-SECRET-KEY-DO-NOT-LOG';
const PROMPT_MARK = 'PROMPT-TEXT-DO-NOT-LOG';
const PAID = 'paid/model';
const FREE = 'free/model:free';
const REVIEW = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Reviewed.', fixes: [] }) } }] });

/**
 * A curl stand-in: the paid model gets PAID_HTTP / PAID_BODY / PAID_RC, every
 * other model a valid review. Writes -o, prints the HTTP code like -w does.
 */
const CURL_STUB = `
curl() {
  local out="" pay="" prev="" a
  for a in "$@"; do
    if [ "$prev" = "-o" ]; then out="$a"; fi
    if [ "$prev" = "-d" ]; then pay="\${a#@}"; fi
    prev="$a"
  done
  cat > /dev/null
  local model; model="$(jq -r '.model' < "$pay")"
  if [ "$model" = "\${OPENROUTER_MODEL}" ]; then
    printf '%s' "\${PAID_BODY:-}" > "$out"
    if [ "\${PAID_RC:-0}" != "0" ]; then return "$PAID_RC"; fi
    printf '%s' "\${PAID_HTTP:-200}"
    return 0
  fi
  printf '%s' "$FREE_BODY" > "$out"
  printf '200'
}
`;

let h: Harness;
beforeAll(() => {
  h = createEngineHarness({ prNumber: 8502 });
});
afterAll(() => h.cleanup());

function review(env: Record<string, string>): string {
  return h.run({
    env: {
      OPENROUTER_API_KEY: KEY,
      OPENROUTER_MODEL: PAID,
      OPENROUTER_FALLBACK_MODEL: FREE,
      PR_REVIEW_CROSS_PROVIDER: 'false',
      FREE_BODY: REVIEW,
      ...env,
    },
    body: `${CURL_STUB}
rc=0
review_llm "system ${PROMPT_MARK}" "user ${PROMPT_MARK}" || rc=$?
echo "rc=$rc tier=$LLM_USED_TIER" >&2
echo "PAID_FAILURE=[$LLM_PAID_FAILURE]" >&2
`,
  }).stdout;
}

const paidLine = (out: string): string => out.split('\n').find((l) => l.includes('PAID TIER DID NOT ANSWER')) ?? '';
const recorded = (out: string): string => out.match(/PAID_FAILURE=\[(.*)\]/)?.[1] ?? '<none>';

describe('why the paid tier did not answer', () => {
  it.each<[string, Record<string, string>, string]>([
    [
      '402 out of credits',
      { PAID_HTTP: '402', PAID_BODY: `{"error":{"code":402,"message":"Insufficient credits for ${PROMPT_MARK}"}}` },
      'paid tier refused (402 no credits); provider openrouter, model paid/model, status HTTP 402, error code 402',
    ],
    [
      '401 bad key',
      { PAID_HTTP: '401', PAID_BODY: '{"error":{"code":401,"message":"No auth credentials found"}}' },
      'paid tier refused (401: key rejected); provider openrouter, model paid/model, status HTTP 401, error code 401',
    ],
    [
      '404 renamed model',
      { PAID_HTTP: '404', PAID_BODY: '{"error":{"code":404,"message":"No endpoints found"}}' },
      'paid tier refused (404 model not found); provider openrouter, model paid/model, status HTTP 404, error code 404',
    ],
    [
      '429 with a string error type',
      { PAID_HTTP: '429', PAID_BODY: '{"error":{"type":"rate_limit_exceeded"}}' },
      'paid tier rate-limited (429); provider openrouter, model paid/model, status HTTP 429, error code rate_limit_exceeded',
    ],
    [
      '503 with a non-JSON body',
      { PAID_HTTP: '503', PAID_BODY: '<html>Service Unavailable</html>' },
      'paid tier provider error (HTTP 503); provider openrouter, model paid/model, status HTTP 503, error code none',
    ],
    ['network failure', { PAID_RC: '6' }, 'paid tier unreachable (network error (curl 6)); provider openrouter, model paid/model, status network error (curl 6), error code none'],
    [
      'a 200 with no content',
      { PAID_HTTP: '200', PAID_BODY: '{"choices":[{"message":{"content":""}}]}' },
      'paid tier answered without a usable review (HTTP 200 with no usable content after 0s); provider openrouter, model paid/model, status HTTP 200 with no usable content after 0s, error code none',
    ],
    [
      'an error code carrying shell and spaces',
      { PAID_HTTP: '400', PAID_BODY: '{"error":{"code":"bad request; $(id) `x`"}}' },
      'paid tier refused (HTTP 400); provider openrouter, model paid/model, status HTTP 400, error code badrequestidx',
    ],
  ])('%s', (_name, env, expected) => {
    const out = review(env);
    expect(out).toContain('rc=0 tier=openrouter-free');
    expect(paidLine(out)).toBe(`[pr-review] PAID TIER DID NOT ANSWER: ${expected}`);
    expect(recorded(out)).toBe(expected);
    expect(paidLine(out)).not.toContain(PROMPT_MARK);
    expect(out).not.toContain(KEY);
  });

  it('words a timeout apart from a refusal', () => {
    const out = review({ PAID_RC: '28' });
    expect(recorded(out)).toMatch(/^paid tier timed out \(timeout after \d+s\); provider openrouter, model paid\/model, status timeout after \d+s, error code none$/);
  });

  it('says the paid tier was not tried when there is no key, and nothing else answers', () => {
    const out = review({ OPENROUTER_API_KEY: '' });
    expect(out).toContain('rc=1 tier=none');
    expect(recorded(out)).toBe('paid tier not tried (no API key); provider openrouter, model paid/model, status no API key, error code none');
  });

  it('records nothing when the paid tier answers', () => {
    const out = review({ PAID_HTTP: '200', PAID_BODY: REVIEW });
    expect(out).toContain('rc=0 tier=openrouter');
    expect(recorded(out)).toBe('');
    expect(paidLine(out)).toBe('');
  });

  it('does not carry a failure from an earlier review into the next one', () => {
    const out = h.run({
      env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: PAID, OPENROUTER_FALLBACK_MODEL: FREE, PR_REVIEW_CROSS_PROVIDER: 'false', FREE_BODY: REVIEW },
      body: `${CURL_STUB}
PAID_HTTP=402 PAID_BODY='{"error":{"code":402}}' review_llm s u || true
PAID_HTTP=200 PAID_BODY='${REVIEW}' review_llm s u || true
echo "SECOND=[$LLM_PAID_FAILURE] tier=$LLM_USED_TIER" >&2
`,
    }).stdout;
    expect(out).toContain('SECOND=[] tier=openrouter');
  });

  it('puts the reason, quoted, in the comment metadata', () => {
    const script = readFileSync(path.join(repoRoot, 'engine', 'pr-review.sh'), 'utf8');
    expect(script).toContain(`  paid_tier_failure: $(jq -Rn --arg v "\${LLM_PAID_FAILURE:-none}" '$v')`);
  });
});

/** Run engine/llm-canary.sh with the curl stand-in exported into it. */
function canary(env: Record<string, string>): { out: string; status: number; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cicd-canary-'));
  const ghOutput = path.join(dir, 'gh_output');
  writeFileSync(ghOutput, '');
  const wrapper = path.join(dir, 'run.sh');
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
${CURL_STUB}
export -f curl
bash "${posix(path.join(repoRoot, 'engine', 'llm-canary.sh'))}"
`,
  );
  chmodSync(wrapper, 0o755);
  let out: string;
  let status = 0;
  try {
    out = execFileSync('bash', ['-c', `"${posix(wrapper)}" 2>&1`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: PAID, GITHUB_OUTPUT: posix(ghOutput), FREE_BODY: REVIEW, ...env },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = (err.stdout ?? '') + (err.stderr ?? '');
    status = err.status ?? 1;
  }
  const output = readFileSync(ghOutput, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { out, status, output };
}

describe('engine/llm-canary.sh', { timeout: 120_000 }, () => {
  it('passes when the paid tier answers', () => {
    const r = canary({ PAID_HTTP: '200', PAID_BODY: REVIEW });
    expect(r.status).toBe(0);
    expect(r.out).toContain('CANARY OK: provider openrouter, model paid/model answered');
    expect(r.output).toContain('result=ok');
  });

  it('passes on a 200 with empty content (key, credits and model all worked)', () => {
    const r = canary({ PAID_HTTP: '200', PAID_BODY: '{"choices":[{"message":{"content":""}}]}' });
    expect(r.status).toBe(0);
  });

  it('fails with the reason when the paid tier is refused, and never prints the key', () => {
    const r = canary({ PAID_HTTP: '402', PAID_BODY: '{"error":{"code":402,"message":"Insufficient credits"}}' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('CANARY FAILED: paid tier refused (402 no credits); provider openrouter, model paid/model, status HTTP 402, error code 402');
    expect(r.output).toContain('result=failed');
    expect(r.output).toContain('reason=paid tier refused (402 no credits)');
    expect(r.out + r.output).not.toContain(KEY);
  });

  it('fails on a timeout, worded as a timeout', () => {
    const r = canary({ PAID_RC: '28' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/CANARY FAILED: paid tier timed out/);
  });

  it('is misconfigured, not failed, without a key', () => {
    const r = canary({ OPENROUTER_API_KEY: '' });
    expect(r.status).toBe(2);
    expect(r.output).toContain('result=misconfigured');
  });

  it('asks for one small completion', () => {
    const script = readFileSync(path.join(repoRoot, 'engine', 'llm-canary.sh'), 'utf8');
    expect(script).toMatch(/false "\$\{CANARY_MAX_TOKENS:-256\}"/);
  });
});
