import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, posix, type Harness } from '../harness/engine.js';

/**
 * The advisory cross-provider tier (DnD-jc8my) and the chain order it sits in
 * (DnD-cyr7z).
 *
 * WHY IT EXISTS. Both original tiers are OpenRouter — `openrouter`, then
 * `openrouter-free` — so a single provider stall took out the whole chain and
 * every review in the repo failed at once. The new tier is served by a
 * DIFFERENT provider and sits between them.
 *
 * WHAT IS PINNED HERE, and why each is load-bearing:
 *
 *  - Random selection between the two arms, not an ordered fallback. The
 *    product decision (DnD-c38po) is that the draw is what makes the later
 *    provider comparison (DnD-ne83x) a like-for-like sample; an agent tidying
 *    this into "try sasquatch, then GitHub Models" would silently destroy it.
 *  - An arm that fails — 403 from an unprovisioned org, an unreachable host —
 *    degrades to the OTHER arm, not straight to the next tier.
 *  - Both arms failing falls through to openrouter-free.
 *  - The tier is ADVISORY: it is not on the paid list, so it can never
 *    auto-apply a fix.
 *  - Which arm served, and which was drawn, is recorded — otherwise the sample
 *    cannot be attributed at all.
 *  - openrouter-free is LAST.
 *
 * `curl` is overridden as a shell function, as in llm-timeout.test.ts, so the
 * real call_llm — its headers, its payload, its HTTP-status handling — is what
 * runs, per endpoint, with no network.
 */

const script = readFileSync(enginePath, 'utf8');

const PAID = 'paid/model';
const FREE = 'free/model:free';

let h: Harness;
let curlLog: string;
let okBody: string;
let commentFile: string;

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8461 });
  curlLog = path.join(h.dir, 'curl.log');
  okBody = path.join(h.dir, 'ok-body.json');
  commentFile = path.join(h.dir, 'comment.md');
  writeFileSync(
    okBody,
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: 'Reviewed the diff.', fixes: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
    'utf8',
  );
});
afterAll(() => h.cleanup());

/**
 * A curl stand-in that answers per PROVIDER. The status for each comes from
 * STUB_HTTP_<PROVIDER> (default 200); `unreachable` makes curl exit 7 the way a
 * DNS/connect failure does. One line per request goes to the curl log, in
 * order, naming the provider, the Authorization header and the payload knobs.
 */
const CURL_STUB = `
curl() {
  local out="" pay="" prev="" url="" auth="none" a
  for a in "$@"; do
    if [ "$prev" = "-o" ]; then out="$a"; fi
    if [ "$prev" = "-H" ]; then
      case "$a" in Authorization:*) auth="$a" ;; esac
    fi
    case "$a" in
      @*) pay="\${a#@}" ;;
      https://*) url="$a" ;;
    esac
    prev="$a"
  done
  local model provider
  model="$(jq -r '.model' < "$pay")"
  case "$url" in
    *openrouter*) case "$model" in *:free) provider=OPENROUTER_FREE ;; *) provider=OPENROUTER ;; esac ;;
    *sasquatch*) provider=SASQUATCH ;;
    *models.github.ai*) provider=GITHUB_MODELS ;;
    *) provider=UNKNOWN ;;
  esac
  printf '%s auth=%s payload=%s\\n' "$provider" "$auth" "$(jq -c '{model, max_tokens, response_format}' < "$pay")" >> "__CURL_LOG__"
  local var="STUB_HTTP_$provider"
  local code="\${!var:-200}"
  if [ "$code" = "unreachable" ]; then return 7; fi
  if [ "$code" = "200" ]; then cp "__OK_BODY__" "$out"; else printf 'denied' > "$out"; fi
  printf '%s' "$code"
}
`;

function stub(): string {
  return CURL_STUB.replace('__CURL_LOG__', posix(curlLog)).replace('__OK_BODY__', posix(okBody));
}

type ReviewResult = { out: string; requests: string[]; drawn: string; served: string; rc: string };

/** Run review_llm once and report what it did. */
function review(env: Record<string, string> = {}, extraBody = ''): ReviewResult {
  rmSync(curlLog, { force: true });
  const out = h.run({
    env: {
      OPENROUTER_API_KEY: 'or-key',
      OPENROUTER_MODEL: PAID,
      OPENROUTER_FALLBACK_MODEL: FREE,
      // The paid tier is down in most cases — it is what makes the chain reach
      // the tier under test at all.
      STUB_HTTP_OPENROUTER: '503',
      PR_REVIEW_CROSS_PROVIDER: 'true',
      GITHUB_MODELS_TOKEN: 'gm-token',
      ...env,
    },
    body: [
      stub(),
      'rc=0',
      'review_llm "system prompt" "user content" || rc=$?',
      'echo "RC=$rc"',
      'echo "DRAWN=$LLM_ARM_DRAWN"',
      'echo "SERVED=$LLM_USED_TIER"',
      extraBody,
    ].join('\n'),
  }).stdout;
  // No curl log at all is a legitimate outcome — a chain in which every tier
  // was skipped makes no request — so read it as empty rather than throwing.
  const requests = existsSync(curlLog)
    ? readFileSync(curlLog, 'utf8').split('\n').filter(Boolean)
    : [];
  const field = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '';
  return { out, requests, drawn: field('DRAWN'), served: field('SERVED'), rc: field('RC') };
}

const providers = (r: ReviewResult) => r.requests.map((l) => l.split(' ')[0]);

describe('off by default — a caller that wires nothing new gets the old chain', () => {
  it('never contacts either arm unless PR_REVIEW_CROSS_PROVIDER=true', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER: '' });
    expect(providers(r)).toEqual(['OPENROUTER', 'OPENROUTER_FREE']);
    expect(r.served).toBe('openrouter-free');
    expect(r.drawn).toBe('none');
  });

  it('treats any value but `true` as off', () => {
    expect(providers(review({ PR_REVIEW_CROSS_PROVIDER: 'false' }))).toEqual([
      'OPENROUTER',
      'OPENROUTER_FREE',
    ]);
  });

  it('is not reached at all while the paid tier is healthy', () => {
    const r = review({ STUB_HTTP_OPENROUTER: '200' });
    expect(providers(r)).toEqual(['OPENROUTER']);
    expect(r.served).toBe('openrouter');
  });
});

describe('the chain order — openrouter-free LAST (DnD-cyr7z)', () => {
  it('tries openrouter, then the cross-provider arms, then openrouter-free', () => {
    const r = review({
      PR_REVIEW_CROSS_PROVIDER_ARM: 'sasquatch',
      STUB_HTTP_SASQUATCH: '500',
      STUB_HTTP_GITHUB_MODELS: '403',
    });
    expect(providers(r)).toEqual(['OPENROUTER', 'SASQUATCH', 'GITHUB_MODELS', 'OPENROUTER_FREE']);
    expect(r.rc).toBe('0');
    expect(r.served).toBe('openrouter-free');
    // No cross-provider arm served, so none is recorded as drawn-and-served.
    expect(r.drawn).toBe('none');
  });

  it('declares the tiers in that order in the engine source', () => {
    // Static half, so the order is pinned even for a tier whose behavioural
    // case is disabled by configuration.
    const block = script.slice(script.indexOf('\nreview_llm() {'));
    const names = [...block.matchAll(/^\s*"([a-z-]+)\|/gm)].slice(0, 3).map((m) => m[1]);
    expect(names).toEqual(['openrouter', 'cross-provider', 'openrouter-free']);
  });
});

describe('each arm is called the way its provider needs', () => {
  it('sasquatch: no credential, JSON mode on, the full output budget', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'sasquatch' });
    expect(r.served).toBe('cross-provider:sasquatch');
    expect(r.drawn).toBe('sasquatch');
    const sq = r.requests.find((l) => l.startsWith('SASQUATCH'))!;
    expect(sq).toContain('auth=none');
    expect(sq).toContain('"response_format":{"type":"json_object"}');
    expect(sq).toContain('"max_tokens":16384');
    expect(sq).toContain('"model":"Qwen3-Coder-30B-A3B-Instruct-GGUF"');
  });

  it('github-models: the token as a Bearer credential, and a smaller output ask', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'github-models' });
    expect(r.served).toBe('cross-provider:github-models');
    expect(r.drawn).toBe('github-models');
    const gm = r.requests.find((l) => l.startsWith('GITHUB_MODELS'))!;
    expect(gm).toContain('auth=Authorization: Bearer gm-token');
    expect(gm).toContain('"max_tokens":4000');
    expect(gm).toContain('"response_format":null');
  });

  it('honours the model and endpoint inputs', () => {
    const r = review({
      PR_REVIEW_CROSS_PROVIDER_ARM: 'sasquatch',
      SASQUATCH_ENDPOINT: 'https://llm.sasquatch.dev/v1/chat/completions',
      SASQUATCH_MODEL: 'other-coder',
    });
    expect(r.requests.find((l) => l.startsWith('SASQUATCH'))).toContain('"model":"other-coder"');
  });

  it('keeps the engine defaults when an input arrives EMPTY', () => {
    // An unwired action input is the empty string, not an absent name.
    const r = review({
      PR_REVIEW_CROSS_PROVIDER_ARM: 'sasquatch',
      SASQUATCH_ENDPOINT: '',
      SASQUATCH_MODEL: '',
    });
    expect(r.served).toBe('cross-provider:sasquatch');
    expect(r.requests.find((l) => l.startsWith('SASQUATCH'))).toContain(
      '"model":"Qwen3-Coder-30B-A3B-Instruct-GGUF"',
    );
  });
});

describe('a failing arm degrades to the other arm', () => {
  it('an unprovisioned GitHub Models org (403) degrades to sasquatch', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'github-models', STUB_HTTP_GITHUB_MODELS: '403' });
    expect(providers(r)).toEqual(['OPENROUTER', 'GITHUB_MODELS', 'SASQUATCH']);
    expect(r.served).toBe('cross-provider:sasquatch');
    // The draw is recorded separately from the arm that served — this pair is
    // exactly what tells a degraded sample from a clean one.
    expect(r.drawn).toBe('github-models');
    expect(r.out).toContain('HTTP 403');
    expect(r.out).toContain("arm 'github-models' failed");
  });

  it('an unreachable sasquatch degrades to GitHub Models', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'sasquatch', STUB_HTTP_SASQUATCH: 'unreachable' });
    expect(providers(r)).toEqual(['OPENROUTER', 'SASQUATCH', 'GITHUB_MODELS']);
    expect(r.served).toBe('cross-provider:github-models');
    expect(r.drawn).toBe('sasquatch');
    expect(r.out).toContain('NETWORK ERROR');
  });

  it('never reaches openrouter-free while one arm can still serve', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'github-models', STUB_HTTP_GITHUB_MODELS: '403' });
    expect(providers(r)).not.toContain('OPENROUTER_FREE');
  });

  it('fails the whole chain honestly when every tier and both arms fail', () => {
    const r = review({
      STUB_HTTP_SASQUATCH: 'unreachable',
      STUB_HTTP_GITHUB_MODELS: '403',
      STUB_HTTP_OPENROUTER_FREE: '503',
    });
    expect(r.rc).toBe('1');
    expect(r.served).toBe('none');
    expect(providers(r)).toHaveLength(4);
  });
});

describe('an arm without its prerequisite is not in the draw', () => {
  it('leaves github-models out when no token was passed — even when forced', () => {
    // Forcing an unavailable arm must not send a credential-less request to it;
    // the seam only ever chooses among arms that could actually serve.
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'github-models', GITHUB_MODELS_TOKEN: '' });
    expect(providers(r)).toEqual(['OPENROUTER', 'SASQUATCH']);
    expect(r.drawn).toBe('sasquatch');
  });

  it('strips a trailing newline from the token rather than sending a broken header', () => {
    const r = review({ PR_REVIEW_CROSS_PROVIDER_ARM: 'github-models', GITHUB_MODELS_TOKEN: 'gm-token\n' });
    expect(r.requests.find((l) => l.startsWith('GITHUB_MODELS'))).toContain(
      'auth=Authorization: Bearer gm-token payload=',
    );
  });
});

describe('the draw is random, not an ordered fallback (DnD-c38po)', () => {
  it('draws BOTH arms across repeated reviews, and serves the arm it drew', () => {
    // One harness run, many reviews: the draw has to vary within a single
    // process's $RANDOM sequence, which is how a real fleet of runs sees it.
    // P(all 60 draws identical) = 2^-59 — this cannot flake in practice.
    //
    // The per-call transport is stubbed down to "this arm served", because a
    // real call_llm spawns jq/python/mktemp several times and 60 of them take
    // minutes on a Windows runner. What is under test is the draw and the
    // served-arm bookkeeping in review_cross_provider, both of which still run
    // for real; the transport has its own cases above.
    const loop = [
      // The paid tier still fails, so every iteration reaches the draw.
      'attempt_llm_review() { case "$1" in cross-provider:*) LLM_USED_TIER="$1"; return 0 ;; esac; return 1; }',
      'for i in $(seq 60); do',
      '  LLM_ARM_DRAWN=none; LLM_USED_TIER=none',
      '  review_llm "s" "u" >/dev/null 2>&1',
      '  echo "PAIR=$LLM_ARM_DRAWN $LLM_USED_TIER"',
      'done',
    ].join('\n');
    const r = review({}, loop);
    const pairs = [...r.out.matchAll(/^PAIR=(\S+) (\S+)$/gm)].map((m) => [m[1], m[2]]);
    expect(pairs).toHaveLength(60);
    const drawn = new Set(pairs.map(([d]) => d));
    expect(drawn).toEqual(new Set(['sasquatch', 'github-models']));
    for (const [d, served] of pairs) expect(served).toBe(`cross-provider:${d}`);
  });

  it('draws in the engine shell, not a subshell', () => {
    // A $( ) draw gets a subshell copy of $RANDOM; keep the roll where the run's
    // own sequence advances.
    const fn = script.slice(
      script.indexOf('\nreview_cross_provider() {'),
      script.indexOf('\nreview_llm() {'),
    );
    expect(fn).toMatch(/drawn="\$\{arms\[RANDOM % \$\{#arms\[@\]\}\]\}"/);
  });
});

describe('the tier is ADVISORY — it can never auto-apply a fix', () => {
  it('is absent from the paid list', () => {
    const paid = script.match(/^PAID_LLM_TIERS="([^"]*)"/m)?.[1];
    expect(paid).toBe('openrouter');
    expect(paid).not.toMatch(/cross-provider/);
  });

  it.each(['sasquatch', 'github-models'])(
    'a review served by the %s arm is refused by the fix gate, for an allowlisted author',
    (arm) => {
      const r = review(
        { PR_REVIEW_CROSS_PROVIDER_ARM: arm },
        [
          'if llm_tier_is_paid; then echo "PAID=yes"; else echo "PAID=no"; fi',
          'if review_may_apply_fixes true; then echo "APPLY=yes"; else echo "APPLY=no"; fi',
          'echo "REASON=$(fix_skip_reason)"',
          'echo "HEADER=$(llm_tier_header_line)"',
        ].join('\n'),
      );
      expect(r.served).toBe(`cross-provider:${arm}`);
      expect(r.out).toContain('PAID=no');
      expect(r.out).toContain('APPLY=no');
      expect(r.out).toMatch(new RegExp(`REASON=.*cross-provider:${arm}.*never auto-applies`));
      expect(r.out).toMatch(/HEADER=.*ADVISORY cross-provider tier/);
    },
  );
});

describe('which arm served is recorded in the comment metadata', () => {
  it('writes llm_tier and llm_arm_drawn into the metadata block', () => {
    const out = h.run({
      body: [
        `COMMENT_FILE="${posix(commentFile)}"`,
        'LLM_USED_TIER="cross-provider:sasquatch"',
        'LLM_USED_MODEL="Qwen3-Coder-30B-A3B-Instruct-GGUF"',
        'LLM_ARM_DRAWN="github-models"',
        'generate_comment "Review complete." commented 1 >/dev/null',
        'cat "$COMMENT_FILE"',
      ].join('\n'),
    }).stdout;
    const meta = out.slice(out.indexOf('<details>'));
    expect(meta).toContain('llm_tier: cross-provider:sasquatch');
    expect(meta).toContain('llm_arm_drawn: github-models');
    // And the reader sees the tier above the fold too.
    expect(out.slice(0, out.indexOf('<details>'))).toContain('cross-provider:sasquatch');
  });
});
