// Every shared guard's refusal carries NOTHING_RAN_NOTICE, and appends the consumer's
// `<guard>.hint.txt` when one sits beside it. Each guard runs from a scratch copy of the
// set so a hint file never touches the real hooks directory. (A consumer's own per-repo
// guards are covered by that consumer's tests, not this file.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A command each shared guard is known to block. */
const TRIGGERS = {
  'block-bash-double-backslash.mjs': { tool_name: 'Bash', tool_input: { command: "printf 'a\\\\b'" } },
  'block-pr-body-heredoc.mjs': { tool_name: 'Bash', tool_input: { command: "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\n)\"" } },
  'block-masked-gates.mjs': { tool_name: 'Bash', tool_input: { command: 'npm test | tail -3' } },
};

function scratchCopy(guard) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-notice-'));
  for (const f of [guard, 'refusal-notice.mjs']) copyFileSync(path.join(HERE, f), path.join(dir, f));
  return dir;
}

function run(dir, guard) {
  return spawnSync(process.execPath, [path.join(dir, guard)], {
    input: JSON.stringify(TRIGGERS[guard]),
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_ALLOW_/.test(k))),
  });
}

for (const guard of Object.keys(TRIGGERS)) {
  test(`${guard}: refusal carries the nothing-ran notice, and no hint when none exists`, () => {
    const dir = scratchCopy(guard);
    try {
      const r = run(dir, guard);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes(NOTHING_RAN_NOTICE), r.stderr);
      assert.equal(r.stderr.includes('HINT-MARKER'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${guard}: a consumer hint file beside the guard is appended to the refusal`, () => {
    const dir = scratchCopy(guard);
    try {
      writeFileSync(path.join(dir, guard.replace(/\.mjs$/, '.hint.txt')), '  HINT-MARKER: use the local wrapper.\n');
      const r = run(dir, guard);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes(`${NOTHING_RAN_NOTICE}`), r.stderr);
      assert.match(r.stderr, / HINT-MARKER: use the local wrapper\.$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('consumerHint is empty for a guard with no hint, and never throws', () => {
  assert.equal(consumerHint(new URL('./no-such-guard.mjs', import.meta.url).href), '');
  assert.equal(consumerHint(pathToFileURL(path.join(tmpdir(), 'agent-hooks-no-such-dir', 'guard.mjs')).href), '');
});

test('an unreadable hint is named in the refusal, not silently dropped', () => {
  // A directory where the hint file should be: readFileSync throws EISDIR on every platform.
  const dir = scratchCopy('block-masked-gates.mjs');
  try {
    mkdirSync(path.join(dir, 'block-masked-gates.hint.txt'));
    const hint = consumerHint(pathToFileURL(path.join(dir, 'block-masked-gates.mjs')).href);
    assert.match(hint, /block-masked-gates\.hint\.txt exists but could not be read: E[A-Z]+/);
    const r = run(dir, 'block-masked-gates.mjs');
    assert.equal(r.status, 2, 'an unreadable hint must never turn a refusal into an allow');
    assert.match(r.stderr, /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
