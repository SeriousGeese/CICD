import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineHarness, enginePath, posix, type Harness } from '../harness/engine.js';

/**
 * LLM call failure reporting — ported from DnD's prReviewLlmTimeout.
 *
 * Twice on 2026-09-01 (PR #2779 run 33511896957, PR #2786 run 33523320415) a
 * review failed with a signature that had nothing to do with the PR:
 *
 *   [pr-review]   Tier 'openrouter': z-ai/glm-5.2 @ ...
 *   [pr-review]     Response has no usable message content     <- ~4 MINUTES later
 *
 * Two defects, pinned separately.
 *
 * 1. Every non-200 outcome collapsed into one of two undifferentiated lines,
 *    neither carrying the elapsed time. "Response has no usable message content"
 *    describes a well-formed response whose `choices[]` was empty — a completely
 *    different condition from a request that never came back — so the reader
 *    goes hunting for a parser bug. Establishing that the paid tier had burned
 *    4m22s required diffing raw log timestamps by hand.
 *
 * 2. `--max-time` was 600s. Measured over six successful runs the same day, the
 *    call takes 44–107s: the cap was six times the slowest real review and a
 *    third of the auto-merge poller's entire 1800s budget.
 *
 * `curl` is overridden as a SHELL FUNCTION rather than stubbed on PATH — no
 * network, and call_llm's real argument construction is what gets exercised
 * rather than a reimplementation of it.
 */

const script = readFileSync(enginePath, 'utf8');

let h: Harness;
let argsFile: string;
let payloadFile: string;

beforeAll(() => {
  h = createEngineHarness({ prNumber: 8401 });
  argsFile = path.join(h.dir, 'curl-args.txt');
  payloadFile = path.join(h.dir, 'curl-payload.json');
});
afterAll(() => h.cleanup());

/**
 * The [pr-review] log stream. call_llm's non-zero return is swallowed and echoed
 * as `rc=`, so the harness always exits 0 and the log is readable from the
 * result rather than through a throw.
 */
function callLlm(env: Record<string, string> = {}): string {
  return h.run({
    env: { OPENROUTER_API_KEY: 'fake', ...env },
    body: `
# Stand in for curl: record the real argv call_llm built, keep a copy of the
# -d @payload file (call_llm deletes it immediately after), honour -o, and
# reproduce whichever failure the case asked for.
curl() {
  printf '%s\\n' "$*" > "${posix(argsFile)}"
  local out="" pay="" prev=""
  for a in "$@"; do
    if [ "$prev" = "-o" ]; then out="$a"; fi
    case "$a" in @*) pay="\${a#@}" ;; esac
    prev="$a"
  done
  if [ -n "$pay" ] && [ -f "$pay" ]; then cp "$pay" "${posix(payloadFile)}"; fi
  [ -n "\${STUB_CURL_SLEEP:-}" ] && sleep "$STUB_CURL_SLEEP"
  [ -n "$out" ] && printf '%s' "\${STUB_CURL_BODY:-}" > "$out"
  if [ "\${STUB_CURL_RC:-0}" != "0" ]; then return "$STUB_CURL_RC"; fi
  printf '%s' "\${STUB_CURL_HTTP:-200}"
}

rc=0
call_llm "https://openrouter.ai/api/v1/chat/completions" "some/model" "key" "sys" "user" false > /dev/null || rc=$?
echo "rc=$rc" >&2
`,
  }).stdout;
}

describe('call_llm failure reporting', () => {
  it('reports a curl timeout AS a timeout, not as an empty response', () => {
    const out = callLlm({ STUB_CURL_RC: '28' });
    expect(out).toMatch(/TIMEOUT after \d+s/);
    expect(out).toContain('This is an upstream/provider problem, not a problem with this PR');
    // The conflation this is about: a request that never returned must NOT be
    // described as a well-formed response carrying no content.
    expect(out).not.toContain('no usable message content');
    expect(out).toContain('rc=1');
  });

  it('distinguishes a connect/DNS failure from a timeout', () => {
    const out = callLlm({ STUB_CURL_RC: '7' });
    expect(out).toMatch(/NETWORK ERROR after \d+s \(curl 7\)/);
    expect(out).not.toContain('TIMEOUT');
    expect(out).toContain('rc=1');
  });

  it('reports a 200-with-no-content as exactly that, with the elapsed time and the body', () => {
    const out = callLlm({
      STUB_CURL_HTTP: '200',
      STUB_CURL_BODY: JSON.stringify({ choices: [{ message: { content: '' } }] }),
    });
    expect(out).toMatch(/HTTP 200 after \d+s but the response carried NO usable message content/);
    expect(out).toContain('body head:');
    expect(out).not.toContain('TIMEOUT');
    expect(out).toContain('rc=1');
  });

  it('names the elapsed time on a non-200 too', () => {
    const out = callLlm({ STUB_CURL_HTTP: '503', STUB_CURL_BODY: 'upstream unavailable' });
    expect(out).toMatch(/HTTP 503 after \d+s/);
    expect(out).toContain('upstream unavailable');
  });
});

describe('the request cap', () => {
  it('caps the request well under the ~4 minutes the real failures took', () => {
    callLlm({ STUB_CURL_RC: '28' });
    const args = readFileSync(argsFile, 'utf8');
    const maxTime = /--max-time (\d+)/.exec(args);
    expect(maxTime).not.toBeNull();
    const seconds = Number(maxTime![1]);
    // 4m07s was the FASTER of the two observed failures; the slowest observed
    // SUCCESS was 107s. Anything in between fails fast and still finishes a real
    // review. 600s — the pre-fix value — is what this rejects.
    expect(seconds).toBeLessThan(240);
    expect(seconds).toBeGreaterThanOrEqual(120);
  });

  it('lets an environment raise the cap for a genuinely larger diff', () => {
    callLlm({ STUB_CURL_RC: '28', PR_REVIEW_LLM_MAX_TIME: '321' });
    expect(readFileSync(argsFile, 'utf8')).toContain('--max-time 321');
  });
});

describe('the request payload', () => {
  /**
   * Run one successful call and return the body call_llm actually handed curl.
   * Reaching curl at all means jq read the user-content temp file and produced a
   * payload — the step that used to fail.
   */
  function payloadOf(env: Record<string, string> = {}): Record<string, unknown> {
    rmSync(payloadFile, { force: true });
    callLlm({
      STUB_CURL_HTTP: '200',
      STUB_CURL_BODY: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      ...env,
    });
    return JSON.parse(readFileSync(payloadFile, 'utf8')) as Record<string, unknown>;
  }

  const expectWellFormed = (payload: Record<string, unknown>) => {
    expect(payload.model).toBe('some/model');
    expect(payload.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
  };

  it('builds a request payload carrying the user content read from disk', () => {
    expectWellFormed(payloadOf());
  });

  it('builds that payload with MSYS argv path conversion suppressed', () => {
    // call_llm passes user_content to jq through a temp file so a 143KB diff
    // does not blow MAX_ARG_STRLEN. It used to NAME that file in argv
    // (`--rawfile user "$user_file"`), and on Git Bash that only ever worked by
    // accident: jq there is typically a NATIVE Windows binary that cannot open
    // an MSYS path like /tmp/pr-review-llm-user-57-XXXXXX, and MSYS was silently
    // rewriting the argument to C:/Users/.../Temp/... on the way in.
    //
    // Suppress that rewrite — MSYS_NO_PATHCONV=1, which is routine in an agent
    // shell — and jq resolved the raw /tmp path drive-relative and bailed before
    // curl, taking every behavioural case above down with it while nothing about
    // the reviewer was actually broken.
    //
    // The fix redirects the file into jq's STDIN, so bash opens it and no path
    // crosses the argv boundary in either direction. On Linux MSYS_NO_PATHCONV
    // is inert and this is simply a second clean run; the static check below is
    // what guards the class here.
    expectWellFormed(payloadOf({ MSYS_NO_PATHCONV: '1' }));
  });

  it('never names the user-content temp file in jq argv', () => {
    // Comment lines are stripped so the prose explaining WHY --rawfile is gone
    // does not read as a reintroduction of it. This is the half of that guard
    // which bites on Linux.
    const code = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toContain('--rawfile');
    expect(code).toMatch(/jq -Rs[\s\S]*?< "\$user_file" > "\$payload_file"/);
  });
});

describe('tier exhaustion is not a verdict on the PR', () => {
  it('tells the operator the PR was not assessed, rather than that it failed review', () => {
    // The rule is already established — a red Auto-Review means the REVIEWER
    // failed, not the PR. The gap this closes is that the operator saw a red X
    // with nothing saying the cause was upstream.
    expect(script).toContain('No reviewer was reachable');
    expect(script).toContain('NOT assessed');
    expect(script).toContain('not a finding about your changes');
    // The documented retrigger recipe, so it is not tribal knowledge.
    expect(script).toContain('gh pr ready ${PR_NUMBER} --undo && gh pr ready ${PR_NUMBER}');
    // And that it is repo-wide while the provider is down.
    expect(script).toContain('blocks merges repo-wide');
  });

  it('still blocks the merge — nothing lands unreviewed', () => {
    expect(script).toContain('"review_failed"');
    expect(script).toMatch(/blocked_infra\|review_failed[^)]*\) exit 1 ;;/);
  });
});
