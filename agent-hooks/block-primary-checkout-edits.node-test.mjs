#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Every vendored sibling the guard imports. The guard keys on its OWN file existing in a checkout,
// so each fixture installs a real copy of it (and these) inside its primary checkout.
const HOOK_FILES = [
  'block-primary-checkout-edits.mjs',
  'refusal-notice.mjs',
  'hook-input.mjs',
  'agent-tooling-config.mjs',
];
const HOOK_DIR = path.join('tools', 'hooks');
let hook = '';

function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hooks-primary-'));
  const primary = path.join(root, 'primary');
  const worktree = path.join(root, 'worktree');
  const outside = path.join(root, 'scratch');

  mkdirSync(path.join(primary, '.git'), { recursive: true });
  mkdirSync(path.join(primary, 'src'), { recursive: true });
  writeFileSync(path.join(primary, 'src', 'existing.ts'), 'export {};\n');
  // A consumer checkout carries the hook itself; the guard keys on that.
  mkdirSync(path.join(primary, HOOK_DIR), { recursive: true });
  for (const name of HOOK_FILES) copyFileSync(path.join(HERE, name), path.join(primary, HOOK_DIR, name));
  hook = path.join(primary, HOOK_DIR, 'block-primary-checkout-edits.mjs');

  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, '.git'), 'gitdir: ../primary/.git/worktrees/worktree\n');
  mkdirSync(path.join(worktree, 'src'), { recursive: true });
  writeFileSync(path.join(worktree, 'src', 'existing.ts'), 'export {};\n');

  mkdirSync(outside, { recursive: true });

  return { root, primary, worktree, outside };
}

test('blocks file edits inside a primary checkout', () => {
  const f = fixture();
  try {
    const result = runHook({ tool_input: { file_path: path.join(f.primary, 'src', 'existing.ts') } });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /PRIMARY checkout/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('allows file edits inside a real git worktree', () => {
  const f = fixture();
  try {
    const result = runHook({ tool_input: { file_path: path.join(f.worktree, 'src', 'existing.ts') } });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('allows new files inside a real git worktree', () => {
  const f = fixture();
  try {
    const result = runHook({ tool_input: { file_path: path.join(f.worktree, 'src', 'new-file.ts') } });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('allows paths outside git repos', () => {
  const f = fixture();
  try {
    const result = runHook({ tool_input: { file_path: path.join(f.outside, 'note.txt') } });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('allows primary-checkout edits with explicit human escape hatch', () => {
  const f = fixture();
  try {
    const result = runHook(
      { tool_input: { file_path: path.join(f.primary, 'src', 'existing.ts') } },
      { AGENT_HOOKS_ALLOW_MAIN_CHECKOUT_EDITS: '1' },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('allows .handoffs/ inside the primary checkout', () => {
  // /promptNextWork writes the NEXT session's opening prompt here, and it has nowhere else
  // to put it: the scratchpad is per-session and a worktree dies with its PR.
  const f = fixture();
  try {
    const result = runHook({
      tool_input: { file_path: path.join(f.primary, '.handoffs', '20260829-140000-batch.md') },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the .handoffs exemption does not leak to neighbouring paths', () => {
  // The exemption is the FIRST path segment only. A source file that merely mentions the
  // word, or a nested directory of that name, is still ordinary project content.
  const f = fixture();
  try {
    for (const rel of [
      path.join('src', '.handoffs', 'sneaky.ts'),
      path.join('src', 'handoffs.ts'),
      '.handoffs-notes.md',
    ]) {
      const result = runHook({ tool_input: { file_path: path.join(f.primary, rel) } });
      assert.equal(result.status, 2, `${rel} must still be blocked`);
      assert.match(result.stderr, /PRIMARY checkout/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('allows edits in an unrelated git repo, even a fresh one with no commits', () => {
  const f = fixture();
  try {
    const other = path.join(f.root, 'obsidian-sync');
    mkdirSync(other, { recursive: true });
    const init = spawnSync('git', ['init', '-q', other], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    for (const rel of ['note.md', path.join('sub', 'deep', 'new.md')]) {
      const result = runHook({ tool_input: { file_path: path.join(other, rel) } });
      assert.equal(result.status, 0, `${rel}: ${result.stderr}`);
      assert.equal(result.stderr, '');
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('suggests a worktree named from agent-tooling.json, and appends the consumer hint', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.primary, 'agent-tooling.json'),
      JSON.stringify({ worktreeRoot: '/work/trees', worktreeNamePattern: 'wt-<slug>' }),
    );
    writeFileSync(path.join(f.primary, HOOK_DIR, 'block-primary-checkout-edits.hint.txt'), 'See docs/worktrees.md.\n');
    const result = runHook({ tool_input: { file_path: path.join(f.primary, 'src', 'existing.ts') } });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /worktree add \/work\/trees\/wt-<name> -b <branch> origin\/main/);
    assert.match(result.stderr, /AGENT_HOOKS_ALLOW_MAIN_CHECKOUT_EDITS=1/);
    assert.match(result.stderr, /If the user explicitly asked/);
    assert.match(result.stderr, /See docs\/worktrees\.md\./);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the default suggestion is a sibling directory named after the repository', () => {
  const f = fixture();
  try {
    const result = runHook({ tool_input: { file_path: path.join(f.primary, 'src', 'existing.ts') } });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /worktree add \.\.\/primary-<name> -b <branch> origin\/main/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('malformed hook input fails open', () => {
  const f = fixture();
  try {
    const result = runHook('not json');

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
