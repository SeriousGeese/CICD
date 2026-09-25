import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, posix, type Harness } from '../harness/engine.js';

/**
 * LLM credentials never ride curl's argv (DnD-g5eiv).
 *
 * call_llm used to build `-H "Authorization: Bearer <key>"` into curl's command
 * line. A process's argv is world-readable on Linux (/proc/<pid>/cmdline, `ps`)
 * for as long as it runs — up to PR_REVIEW_LLM_MAX_TIME seconds per call — and
 * the runner host that runs this engine also runs CI jobs executing untrusted
 * PR code. So every in-flight review published OPENROUTER_API_KEY (and, since
 * the cross-provider tier, GITHUB_MODELS_TOKEN) to every other process on it.
 *
 * Each case asserts BOTH halves, because either alone is vacuous: the key is
 * absent from argv (a call that dropped the header entirely would pass that),
 * AND the header still reached curl through the channel curl really reads —
 * `-H @-` from stdin, `-H @file`, or inline.
 *
 * `curl` is a shell function, as in llm-timeout.test.ts, so the real call_llm
 * builds the real argument list and the real redirection.
 */

const script = readFileSync(enginePath, 'utf8');

const OR_KEY = 'sk-or-v1-ARGVCANARY-7f3a91c0';
const GM_TOKEN = 'github_pat_ARGVCANARY_4be2d8';

let h: Harness;
let argvLog: string;
let headerLog: string;

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8471 });
  argvLog = path.join(h.dir, 'curl-argv.log');
  headerLog = path.join(h.dir, 'curl-headers.log');
});
afterAll(() => h.cleanup());

/**
 * Records every argv element on its own line, and every header curl would
 * send (resolving `@-` and `@file`) to a separate log. Answers 200 with a
 * well-formed review, except for URLs matching STUB_FAIL_URL (503).
 */
function stub(): string {
  return `
curl() {
  printf '%s\\n' "$@" >> "${posix(argvLog)}"
  local out="" prev="" url="" a hdr
  for a in "$@"; do
    if [ "$prev" = "-o" ]; then out="$a"; fi
    if [ "$prev" = "-H" ]; then
      case "$a" in
        @-) hdr="$(cat)" ;;
        @*) hdr="$(cat "\${a#@}")" ;;
        *) hdr="$a" ;;
      esac
      printf '%s\\n' "$hdr" >> "${posix(headerLog)}"
    fi
    case "$a" in https://*) url="$a" ;; esac
    prev="$a"
  done
  if [ -n "\${STUB_FAIL_URL:-}" ] && [[ "$url" == *"$STUB_FAIL_URL"* ]]; then
    printf 'down' > "$out"; printf '503'; return 0
  fi
  printf '%s' '{"choices":[{"message":{"content":"{\\"summary\\":\\"ok\\",\\"fixes\\":[]}"}}]}' > "$out"
  printf '200'
}
`;
}

type Captured = { out: string; argv: string; headers: string };

function capture(env: Record<string, string>, body: string): Captured {
  rmSync(argvLog, { force: true });
  rmSync(headerLog, { force: true });
  const out = h.run({ env, body: [stub(), body].join('\n') }).stdout;
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return { out, argv: read(argvLog), headers: read(headerLog) };
}

describe('call_llm keeps the key out of argv and still sends it', () => {
  it('passes the Authorization header without naming the key on the command line', () => {
    const r = capture(
      {},
      `call_llm "https://openrouter.ai/api/v1/chat/completions" "m" "${OR_KEY}" "sys" "user" false > /dev/null; echo "RC=$?"`,
    );
    expect(r.out).toMatch(/^RC=0$/m);
    // The request was actually made — an empty argv log would make the next
    // assertion pass for the wrong reason.
    expect(r.argv).toContain('https://openrouter.ai/api/v1/chat/completions');
    expect(r.argv).not.toContain(OR_KEY);
    expect(r.argv).not.toMatch(/Bearer/);
    expect(r.headers).toContain(`Authorization: Bearer ${OR_KEY}`);
  });

  it('does not print the key on the traced curl line under set -x', () => {
    // xtrace echoes every command's WORDS; the here-string that carries the
    // header is a redirection and is not traced. A printf/echo of the key into
    // a file, or an assignment of the header to a variable, would be.
    //
    // Scope, honestly: this pins the CURL invocation only. With xtrace on, the
    // key is still visible on call_llm's own `local ... api_key=` line (and on
    // the caller's line), so set -x must stay off in the engine regardless —
    // it is not enabled anywhere today.
    const r = capture(
      {},
      `set -x; call_llm "https://openrouter.ai/api/v1/chat/completions" "m" "${OR_KEY}" "sys" "user" false > /dev/null; set +x`,
    );
    expect(r.headers).toContain(`Authorization: Bearer ${OR_KEY}`);
    // The curl call runs inside $( ), so its trace line carries the doubled
    // `++` prefix. It was traced (so this is not vacuous) and never names the key.
    const curlLines = r.out.split('\n').filter((l) => /^\+{2,} curl /.test(l));
    expect(curlLines.length).toBeGreaterThan(0);
    expect(curlLines.filter((l) => l.includes(OR_KEY) || l.includes('Bearer'))).toEqual([]);
  });

  it('sends no Authorization header, and reads nothing from stdin, when there is no key', () => {
    const r = capture(
      {},
      `call_llm "https://llm.sasquatch.dev/v1/chat/completions" "m" "" "sys" "user" true > /dev/null; echo "RC=$?"`,
    );
    expect(r.out).toMatch(/^RC=0$/m);
    expect(r.argv).toContain('https://llm.sasquatch.dev/v1/chat/completions');
    expect(r.argv).not.toContain('@-');
    expect(r.headers).not.toMatch(/Authorization/);
  });
});

describe('through the real tier chain', () => {
  it('OPENROUTER_API_KEY never appears in argv on the openrouter tier', () => {
    const r = capture(
      { OPENROUTER_API_KEY: OR_KEY, PR_REVIEW_CROSS_PROVIDER: '' },
      'review_llm "system prompt" "user content" > /dev/null; echo "SERVED=$LLM_USED_TIER"',
    );
    expect(r.out).toMatch(/^SERVED=openrouter$/m);
    expect(r.argv).toContain('openrouter.ai');
    expect(r.argv).not.toContain(OR_KEY);
    expect(r.headers).toContain(`Authorization: Bearer ${OR_KEY}`);
  });

  it('GITHUB_MODELS_TOKEN never appears in argv on the github-models arm', () => {
    const r = capture(
      {
        OPENROUTER_API_KEY: OR_KEY,
        STUB_FAIL_URL: 'openrouter.ai',
        PR_REVIEW_CROSS_PROVIDER: 'true',
        PR_REVIEW_CROSS_PROVIDER_ARM: 'github-models',
        GITHUB_MODELS_TOKEN: GM_TOKEN,
      },
      'review_llm "system prompt" "user content" > /dev/null; echo "SERVED=$LLM_USED_TIER"',
    );
    expect(r.out).toMatch(/^SERVED=cross-provider:github-models$/m);
    expect(r.argv).toContain('models.github.ai');
    expect(r.argv).not.toContain(GM_TOKEN);
    // The failed openrouter attempt came first; its key must not leak either.
    expect(r.argv).not.toContain(OR_KEY);
    expect(r.headers).toContain(`Authorization: Bearer ${GM_TOKEN}`);
  });
});

describe('static guard', () => {
  it('builds no inline Authorization header anywhere in the engine', () => {
    // Comment lines are stripped: the prose explaining why the inline form is
    // gone must not read as a reintroduction of it.
    const code = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/-H\s+["']Authorization/);
    expect(code).toMatch(/curl_args\+=\(-H @-\)/);
  });
});
