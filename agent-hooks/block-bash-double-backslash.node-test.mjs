import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hook = fileURLToPath(new URL('./block-bash-double-backslash.mjs', import.meta.url));

function runHook(command, { env = {}, toolName = 'Bash' } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH: '', ...env },
  });
}

// JS string literals below: '\\\\' is two backslashes at runtime, '\\' is one.

// ── Blocked: any doubled backslash, wherever it sits ────────────────────────
test('blocks a doubled backslash in a single-quoted argument (the entry-64 probe shape)', () => {
  const r = runHook("printf '%s' '*\\\\*) tr \\'\\\\\\' /'");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /collapses every/);
  assert.match(r.stderr, /Write tool/);
  assert.match(r.stderr, /AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH/);
});

test('blocks a doubled backslash inside a quoted heredoc body', () => {
  const r = runHook("cat > probe.sh <<'EOS'\ncase \"$1\" in *\\\\*) echo has-backslash ;; esac\nEOS");
  assert.equal(r.status, 2);
});

test('blocks a doubled backslash in a sed expression', () => {
  const r = runHook("sed -i 's/\\\\/\\//g' file.txt");
  assert.equal(r.status, 2);
});

test('reports the occurrence count', () => {
  const r = runHook("echo 'a\\\\b' 'c\\\\d' 'e\\\\f'");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /3 occurrences/);
});

// ── Allowed: single backslashes and the escapes that survive the handoff ────
test('allows a single backslash (grep regex, escaped dollar, escaped quote, newline escape)', () => {
  for (const c of [
    "grep -n 'foo\\.bar' src/x.ts",
    "echo 'cost: \\$5'",
    'echo "she said \\"hi\\""',
    "printf 'a\\nb\\n'",
    'git log --format="%H%n%s"',
  ]) {
    assert.equal(runHook(c).status, 0, c);
  }
});

test('allows a plain command with no backslashes at all', () => {
  const r = runHook('npm test > /dev/null 2>&1; echo EXIT:$?');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

// ── Escape hatch, tool scope, fail-open ─────────────────────────────────────
test('escape hatch AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH=1 allows a pre-doubled command', () => {
  const r = runHook("echo 'a\\\\b'", { env: { AGENT_HOOKS_ALLOW_DOUBLE_BACKSLASH: '1' } });
  assert.equal(r.status, 0);
});

test('never blocks the PowerShell tool, which preserves doubled backslashes', () => {
  const r = runHook("Write-Output 'a\\\\b'", { toolName: 'PowerShell' });
  assert.equal(r.status, 0);
});

test('malformed hook input fails open', () => {
  const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
