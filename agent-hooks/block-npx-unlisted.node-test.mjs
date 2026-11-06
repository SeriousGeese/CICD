#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTempDir } from './test-cleanup.mjs';

const hook = fileURLToPath(new URL('./block-npx-unlisted.mjs', import.meta.url));

// A hermetic stand-in for the repo: jest declared, typescript installed (with its
// `tsc` bin) but NOT declared, nothing else. Running the hook against the real
// checkout would make the assertions depend on whatever `npm ci` last produced.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hook-npx-guard-'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'x', devDependencies: { jest: '^30.0.0', '@playwright/test': '^1.0.0' } }),
  );
  mkdirSync(path.join(root, 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript"}');
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n');
  mkdirSync(path.join(root, 'src'));
  return root;
}

function runHook(cwd, command, { env = {}, toolName = 'Bash' } = {}) {
  return spawnSync(process.execPath, [hook], {
    cwd,
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_HOOKS_ALLOW_NPX_FETCH: '', ...env },
  });
}

const root = fixture();
test.after(() => removeTempDir(root, 'block-npx-unlisted.node-test'));

// ── Blocked: anything npx would have to download ────────────────────────────
test('blocks npx of a package that is neither declared nor installed (the entry-66 shape)', () => {
  const r = runHook(root, 'npx prettier --write src/a.ts src/b.tsx');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /`prettier` is not a dependency/);
  assert.match(r.stderr, /DOWNLOAD/);
  assert.match(r.stderr, /AGENT_HOOKS_ALLOW_NPX_FETCH/);
});

test('blocks a versioned spec, a scoped spec, and -y/--yes (which only silence the prompt)', () => {
  for (const c of [
    'npx prettier@3.9.6 --check .',
    'npx @biomejs/biome format .',
    'npx -y prettier --write .',
    'npx --yes prettier --write .',
  ]) {
    assert.equal(runHook(root, c).status, 2, c);
  }
});

test('blocks through -p/--package, npm exec, npm x, npx.cmd, and the rtk/env wrappers', () => {
  for (const c of [
    "npx -p prettier -c 'prettier --write .'",
    'npx --package=prettier prettier --write .',
    'npm exec prettier -- --write .',
    'npm exec -- prettier --write .',
    'npm x prettier',
    'npx.cmd prettier --write .',
    'rtk npx prettier --write .',
    'env -u GITHUB_TOKEN npx prettier --write .',
    'CI=1 npx prettier --write .',
  ]) {
    assert.equal(runHook(root, c).status, 2, c);
  }
});

test('blocks the npx segment of a compound command', () => {
  const r = runHook(root, 'npm run lint && npx prettier --write . && git diff --stat');
  assert.equal(r.status, 2);
});

test('blocks from a subdirectory of the package root', () => {
  const r = runHook(path.join(root, 'src'), 'npx prettier --write .');
  assert.equal(r.status, 2);
});

// ── Allowed: declared, installed, bins, no-install forms ────────────────────
test('allows a declared dependency, an installed package, and a node_modules/.bin bin', () => {
  for (const c of [
    'npx jest --testPathPatterns foo',
    'npx jest@30 --version',
    'npx @playwright/test --version',
    'npx typescript --version',
    'npx tsc --noEmit',
    'npm exec -- jest',
    'npm x tsc',
  ]) {
    const r = runHook(root, c);
    assert.equal(r.status, 0, `${c}: ${r.stderr}`);
  }
});

test('allows --no-install / --no forms, which refuse rather than fetch', () => {
  for (const c of ['npx --no-install prettier --version', 'npx --no prettier --version']) {
    assert.equal(runHook(root, c).status, 0, c);
  }
});

test('allows commands that merely mention npm/npx without exec-ing a package', () => {
  for (const c of [
    'npm run lint',
    'npm ci --ignore-scripts',
    'echo "use npx jest"',
    'npx',
    'npx --version',
  ]) {
    assert.equal(runHook(root, c).status, 0, c);
  }
});

test('allows everything outside a package root (no package.json up the tree)', () => {
  const bare = mkdtempSync(path.join(tmpdir(), 'hook-npx-guard-bare-'));
  try {
    // A temp dir under the OS tmpdir has no package.json above it.
    assert.equal(runHook(bare, 'npx prettier --write .').status, 0);
  } finally {
    removeTempDir(bare, 'block-npx-unlisted.node-test');
  }
});

// ── Escape hatch, tool scope, fail-open ─────────────────────────────────────
test('escape hatch AGENT_HOOKS_ALLOW_NPX_FETCH=1 allows a deliberate one-off', () => {
  const r = runHook(root, 'npx prettier --write .', { env: { AGENT_HOOKS_ALLOW_NPX_FETCH: '1' } });
  assert.equal(r.status, 0);
});

// ── Inline hatch ─────────────────────────────────────────────────
// The refusal message tells an agent to set the escape hatch, which only
// works if written as a leading assignment on the SAME segment as the npx
// command — process.env of the PreToolUse hook process is unreachable from
// the agent's own Bash command text.

test('inline hatch: a leading VAR=1 on the SAME command allows the fetch', () => {
  const r = runHook(root, 'AGENT_HOOKS_ALLOW_NPX_FETCH=1 npx prettier --write .');
  assert.equal(r.status, 0);
});

test('inline hatch: an assignment on an UNRELATED segment does not leak in', () => {
  const r = runHook(root, 'AGENT_HOOKS_ALLOW_NPX_FETCH=1 echo hi && npx prettier --write .');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /`prettier` is not a dependency/);
});

test('inline hatch: the refusal message shows the exact inline form', () => {
  const r = runHook(root, 'npx prettier --write .');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /AGENT_HOOKS_ALLOW_NPX_FETCH=1 npx prettier/);
});

test('guards the PowerShell tool too — the incident command is byte-identical there', () => {
  const r = runHook(root, 'npx prettier --write .', { toolName: 'PowerShell' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /`prettier` is not a dependency/);
  // PowerShell chains on the same separators; a declared bin after a `;` is still fine.
  assert.equal(runHook(root, 'npm run lint; npx jest --ci', { toolName: 'PowerShell' }).status, 0);
  // The call operator is a bare wrapper token, not a different command.
  assert.equal(runHook(root, '& npx prettier --write .', { toolName: 'PowerShell' }).status, 2);
  // Tool-name match is case-insensitive, as block-masked-gates' is.
  assert.equal(runHook(root, 'npx prettier --write .', { toolName: 'powershell' }).status, 2);
  assert.equal(runHook(root, 'npx prettier --write .', { toolName: 'bash' }).status, 2);
});

test('ignores tools that are not a shell', () => {
  assert.equal(runHook(root, 'npx prettier --write .', { toolName: 'Write' }).status, 0);
});

test('malformed hook input fails open', () => {
  const r = spawnSync(process.execPath, [hook], { cwd: root, input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

// ── Loop / conditional / grouping bodies ──────────────────────
test('blocks an unlisted npx inside a for/if/while/group/subshell body', () => {
  for (const command of [
    'for f in a; do npx prettier --write f; done',
    'if true; then npx prettier --write f; fi',
    'while true; do npx prettier --write f; break; done',
    '{ npx prettier --write f; }',
    '(npx prettier --write f)',
    'timeout 60 npx prettier --write f',
  ]) {
    const r = runHook(root, command);
    assert.equal(r.status, 2, `expected a block for ${JSON.stringify(command)}`);
  }
});

test('allows a declared package inside a loop body', () => {
  const r = runHook(root, 'for f in a; do npx jest f; done');
  assert.equal(r.status, 0, r.stderr);
});
