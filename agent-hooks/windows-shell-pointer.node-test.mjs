#!/usr/bin/env node
// Tests for windows-shell-pointer.mjs: the SessionStart banner that keeps a Windows session from
// missing the shell traps there. The consumer's own pointer (a doc path) rides in a hint file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-cleanup.mjs';

import { windowsShellPointer } from './windows-shell-pointer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('prints a banner on win32', () => {
  const banner = windowsShellPointer('win32');
  assert.match(banner, /^\[windows-shell\] /);
  assert.match(banner, /Windows host/);
  assert.equal(banner.includes('\n'), false);
});

test('prints nothing on any other platform', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.equal(windowsShellPointer(platform), '');
  }
});

test('names no consumer-specific document', () => {
  assert.doesNotMatch(windowsShellPointer('win32'), /docs\/|AGENTS\.md/);
});

// The hint file is the consumer's own and sits beside the vendored hook, so the test copies the hook
// (and the module it imports) into a scratch directory and drops a hint there.
test('a consumer hint file is appended to the banner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-win-pointer-'));
  try {
    for (const f of ['windows-shell-pointer.mjs', 'refusal-notice.mjs']) copyFileSync(path.join(here, f), path.join(dir, f));
    writeFileSync(path.join(dir, 'windows-shell-pointer.hint.txt'), 'Read docs/shell-notes.md first.\n');
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { windowsShellPointer } from ${JSON.stringify(`file:///${path.join(dir, 'windows-shell-pointer.mjs').replace(/\\/g, '/')}`)}; console.log(windowsShellPointer('win32'));`],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\[windows-shell\] This is a Windows host\./);
    assert.match(r.stdout, /Read docs\/shell-notes\.md first\.$/m);
  } finally {
    removeTempDir(dir, 'windows-shell-pointer.node-test');
  }
});

test('run directly it prints the banner only on win32', () => {
  const r = spawnSync(process.execPath, [path.join(here, 'windows-shell-pointer.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  if (process.platform === 'win32') assert.match(r.stdout, /^\[windows-shell\] /);
  else assert.equal(r.stdout, '');
});
