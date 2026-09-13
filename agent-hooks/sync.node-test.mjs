// Tests for sync.mjs. Every case builds a throwaway git repository shaped like CICD and
// syncs from it with --from, so nothing here touches the network. This file is vendored
// too and must pass in a consumer's hooks directory, so it locates sync.mjs relative to
// itself and never spells the neutral escape-hatch prefix as one literal (sync rewrites
// that literal on the way in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NEUTRAL_PREFIX,
  SHA_FILE,
  check,
  formatShaFile,
  hooksDest,
  isEnvPrefix,
  isPinnedRef,
  isSafeFileName,
  parseArgs,
  parseShaFile,
  sync,
  transform,
} from './sync.mjs';

const SYNC = fileURLToPath(new URL('./sync.mjs', import.meta.url));
const P = NEUTRAL_PREFIX; // the neutral prefix, assembled at runtime

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
}

/** A CICD-shaped repo with one commit; returns { root, sha }. */
function fakeCicd(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-src-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'core.autocrlf', 'false']);
  mkdirSync(path.join(root, 'agent-hooks'));
  const all = { 'manifest.json': JSON.stringify({ files: Object.keys(files) }), ...files };
  for (const [name, body] of Object.entries(all)) writeFileSync(path.join(root, 'agent-hooks', name), body);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'hooks']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

function commitChange(root, files) {
  const manifestPath = path.join(root, 'agent-hooks', 'manifest.json');
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, 'agent-hooks', name), body);
  if (files['manifest.json'] === undefined) {
    const names = new Set(JSON.parse(readFileSync(manifestPath, 'utf8')).files);
    for (const name of Object.keys(files)) names.add(name);
    writeFileSync(manifestPath, JSON.stringify({ files: [...names] }));
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'change']);
  return git(root, ['rev-parse', 'HEAD']);
}

function consumer() {
  return mkdtempSync(path.join(tmpdir(), 'agent-hooks-dst-'));
}

const GUARD = `if (process.env.${P}ALLOW_X === '1') process.exit(0);\n// set ${P}ALLOW_X=1\n`;

test('pure helpers', () => {
  assert.equal(isPinnedRef('a'.repeat(40)), true);
  assert.equal(isPinnedRef('main'), false);
  assert.equal(isPinnedRef('v1.2.3'), false);
  assert.equal(isPinnedRef('abc123'), false);
  assert.equal(isEnvPrefix('ACME_'), true);
  assert.equal(isEnvPrefix('WIDGET_'), true);
  assert.equal(isEnvPrefix('acme_'), false);
  assert.equal(isEnvPrefix('ACME'), false);
  assert.equal(isSafeFileName('block-x.mjs'), true);
  assert.equal(isSafeFileName('../x.mjs'), false);
  assert.equal(isSafeFileName('sub/x.mjs'), false);
  assert.equal(isSafeFileName('.hidden'), false);
  assert.deepEqual(parseArgs(['--into', '.', '--check']), { into: '.', envPrefix: P, hooksDir: 'scripts/hooks', check: true });
  assert.throws(() => parseArgs(['--into']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('--hooks-dir must stay inside --into', () => {
  const into = path.join(tmpdir(), 'consumer');
  assert.equal(hooksDest(into, 'scripts/hooks'), path.resolve(into, 'scripts/hooks'));
  for (const bad of ['..', '../elsewhere', 'scripts/../../x', '.', '', path.resolve(tmpdir(), 'abs')]) {
    assert.throws(() => hooksDest(into, bad), /must be a subdirectory of --into/, JSON.stringify(bad));
  }
});

test('transform normalises CRLF and rewrites only the neutral prefix', () => {
  const src = `a ${P}ALLOW_X\r\nb X${P}NOT\r\n`;
  assert.equal(transform(src, 'ACME_'), `a ACME_ALLOW_X\nb X${P}NOT\n`);
  assert.equal(transform(src, P), `a ${P}ALLOW_X\nb X${P}NOT\n`);
});

test('the SHA file round-trips', () => {
  const rec = { ref: 'b'.repeat(40), envPrefix: 'ACME_', files: ['a.mjs', 'b.mjs'] };
  assert.deepEqual(parseShaFile(formatShaFile(rec)), rec);
  assert.throws(() => parseShaFile('files:\n  a.mjs\n'), /missing its ref/);
});

test('sync vendors the manifest with the consumer prefix, and --check passes on the result', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'export const y = 1;\n' });
  const dst = consumer();
  try {
    const files = await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: 'scripts/hooks', from: src.root });
    assert.deepEqual(files, ['block-x.mjs', 'lib.mjs']);
    const guard = readFileSync(path.join(dst, 'scripts/hooks/block-x.mjs'), 'utf8');
    assert.match(guard, /process\.env\.ACME_ALLOW_X/);
    assert.equal(guard.includes(P), false);
    const rec = parseShaFile(readFileSync(path.join(dst, 'scripts/hooks', SHA_FILE), 'utf8'));
    assert.deepEqual(rec, { ref: src.sha, envPrefix: 'ACME_', files: ['block-x.mjs', 'lib.mjs'] });
    assert.deepEqual(await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root }), []);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('--check names a locally edited, a deleted, and a CRLF-only file correctly', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'export const y = 1;\n', 'c.mjs': 'c\n' });
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: 'scripts/hooks', from: src.root });
    const dir = path.join(dst, 'scripts/hooks');
    writeFileSync(path.join(dir, 'block-x.mjs'), readFileSync(path.join(dir, 'block-x.mjs'), 'utf8') + '// local tweak\n');
    rmSync(path.join(dir, 'lib.mjs'));
    writeFileSync(path.join(dir, 'c.mjs'), 'c\r\n'); // a checkout with autocrlf is not drift
    writeFileSync(path.join(dir, 'block-x.hint.txt'), 'consumer-owned, never checked\n');
    const problems = await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root });
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /block-x\.mjs: differs/);
    assert.match(problems[1], /lib\.mjs: missing/);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('re-syncing to a newer ref updates files and removes ones the manifest dropped', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'old.mjs': 'old\n' });
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'WIDGET_', hooksDir: 'scripts/hooks', from: src.root });
    const sha2 = commitChange(src.root, {
      'block-x.mjs': GUARD + '// v2\n',
      'manifest.json': JSON.stringify({ files: ['block-x.mjs'] }),
    });
    await sync({ into: dst, ref: sha2, envPrefix: 'WIDGET_', hooksDir: 'scripts/hooks', from: src.root });
    const dir = path.join(dst, 'scripts/hooks');
    assert.match(readFileSync(path.join(dir, 'block-x.mjs'), 'utf8'), /v2/);
    assert.equal(existsSync(path.join(dir, 'old.mjs')), false);
    assert.deepEqual(await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root }), []);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('an unsafe manifest name is refused before anything is written', async () => {
  const src = fakeCicd({ 'a.mjs': 'a\n' });
  commitChange(src.root, { 'manifest.json': JSON.stringify({ files: ['../escape.mjs'] }) });
  const sha = git(src.root, ['rev-parse', 'HEAD']);
  const dst = consumer();
  try {
    await assert.rejects(sync({ into: dst, ref: sha, envPrefix: 'ACME_', hooksDir: 'scripts/hooks', from: src.root }), /unsafe name/);
    assert.equal(existsSync(path.join(dst, 'scripts')), false);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('sync.mjs survives being vendored through its own prefix rewrite', async () => {
  // The trap: a literal neutral prefix inside sync.mjs would be rewritten in the consumer's
  // copy, and that copy's --check would then compare against the wrong text forever.
  const self = readFileSync(SYNC, 'utf8');
  const src = fakeCicd({ 'sync.mjs': self });
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: 'scripts/hooks', from: src.root });
    const vendored = path.join(dst, 'scripts/hooks/sync.mjs');
    const r = spawnSync(process.execPath, [vendored, '--into', dst, '--check', '--from', src.root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /match their recorded CICD ref/);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('the CLI refuses a movable ref and a malformed prefix, and --check exits 1 on drift', () => {
  const dst = consumer();
  try {
    const branch = spawnSync(process.execPath, [SYNC, '--into', dst, '--ref', 'main'], { encoding: 'utf8' });
    assert.equal(branch.status, 2);
    assert.match(branch.stderr, /40-hex/);
    const prefix = spawnSync(process.execPath, [SYNC, '--into', dst, '--ref', 'a'.repeat(40), '--env-prefix', 'acme'], { encoding: 'utf8' });
    assert.equal(prefix.status, 2);
    assert.match(prefix.stderr, /PREFIX_/);
    const none = spawnSync(process.execPath, [SYNC, '--into', dst, '--check'], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /\[hooks-drift\].*CICD-HOOKS-SHA is missing/);
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});
