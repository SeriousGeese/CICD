// Tests for sync.mjs. Every case builds a throwaway git repository shaped like CICD and
// syncs from it with --from, so nothing here touches the network. This file is vendored
// too and must pass in a consumer's hooks directory, so it locates sync.mjs relative to
// itself and never spells the neutral escape-hatch prefix as one literal (sync rewrites
// that literal on the way in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE,
  NEUTRAL_PREFIX,
  SHA_FILE,
  check,
  formatShaFile,
  hooksDest,
  isEnvPrefix,
  isPinnedRef,
  isSafeFileName,
  parseArgs,
  parseManifest,
  parseShaFile,
  selectFiles,
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
  assert.deepEqual(parseArgs(['--into', '.', '--check']), { into: '.', hooksDir: 'scripts/hooks', check: true });
  assert.deepEqual(parseArgs(['--into', '.', '--set', 'core, guards', '--set', 'push']).sets, ['core', 'guards', 'push']);
  assert.throws(() => parseArgs(['--into', '.', '--set', ' , ']), /at least one set/);
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
  const rec = { ref: 'b'.repeat(40), envPrefix: 'ACME_', sets: ['core', 'push'], files: ['a.mjs', 'b.mjs'] };
  assert.deepEqual(parseShaFile(formatShaFile(rec)), rec);
  // The default set alone writes no sets line, so a consumer that never chose a set keeps the
  // exact record it had before named sets; reading it back yields the default set.
  const plain = formatShaFile({ ref: rec.ref, envPrefix: 'ACME_', files: ['a.mjs'] });
  assert.equal(plain.includes('sets:'), false);
  assert.equal(formatShaFile({ ref: rec.ref, envPrefix: 'ACME_', sets: ['core'], files: ['a.mjs'] }), plain);
  assert.deepEqual(parseShaFile(plain).sets, ['core']);
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
    assert.deepEqual(rec, { ref: src.sha, envPrefix: 'ACME_', sets: ['core'], files: ['block-x.mjs', 'lib.mjs'] });
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

// ---- named sets ----------------------------------------------------------------------

/** A CICD-shaped repo whose manifest has named sets. */
function fakeCicdWithSets(sets, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-src-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'core.autocrlf', 'false']);
  mkdirSync(path.join(root, 'agent-hooks'));
  writeFileSync(path.join(root, 'agent-hooks', 'manifest.json'), JSON.stringify({ files: sets.core, sets }));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, 'agent-hooks', name), body);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'hooks']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

const SETS = { core: ['a.mjs', 'shared.mjs'], guards: ['g.mjs', 'shared.mjs'], push: ['p.mjs', 'shared.mjs'] };
const SET_FILES = { 'a.mjs': 'a\n', 'g.mjs': GUARD, 'p.mjs': 'p\n', 'shared.mjs': 's\n' };

test('parseManifest and selectFiles: legacy manifests, union, all, and the guard rails', () => {
  const legacy = parseManifest({ files: ['x.mjs'] });
  assert.deepEqual(legacy, { sets: { core: ['x.mjs'] }, defaultSet: 'core' });
  const m = parseManifest({ files: SETS.core, sets: SETS });
  assert.deepEqual(selectFiles(m, ['core']), ['a.mjs', 'shared.mjs']);
  assert.deepEqual(selectFiles(m, ['guards', 'push']), ['g.mjs', 'p.mjs', 'shared.mjs']);
  assert.deepEqual(selectFiles(m, ['all']), ['a.mjs', 'g.mjs', 'p.mjs', 'shared.mjs']);
  assert.throws(() => selectFiles(m, ['nope']), /unknown set "nope" \(known: core, guards, push, all\)/);
  assert.throws(() => parseManifest({ sets: { ...SETS, all: ['a.mjs'] } }), /must not define "all"/);
  assert.throws(() => parseManifest({ files: ['g.mjs'], sets: SETS }), /"files" must list exactly the default set/);
  assert.throws(() => parseManifest({ sets: { core: [] } }), /lists no files/);
  assert.throws(() => parseManifest({ sets: { core: ['../x'] } }), /unsafe name/);
  assert.throws(() => parseManifest({ sets: { guards: ['g.mjs'] } }), /default set that does not exist: core/);
});

test('--set vendors the union of the named sets, records them, and --check passes', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  try {
    const files = await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['core', 'guards'], hooksDir: 'scripts/hooks', from: src.root });
    assert.deepEqual(files, ['a.mjs', 'g.mjs', 'shared.mjs']);
    const dir = path.join(dst, 'scripts/hooks');
    assert.equal(existsSync(path.join(dir, 'p.mjs')), false);
    assert.match(readFileSync(path.join(dir, 'g.mjs'), 'utf8'), /ACME_ALLOW_X/);
    const rec = parseShaFile(readFileSync(path.join(dir, SHA_FILE), 'utf8'));
    assert.deepEqual(rec.sets, ['core', 'guards']);
    assert.deepEqual(await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root }), []);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('a re-sync without --set keeps the recorded sets; de-selecting a set deletes its files', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  const dir = path.join(dst, 'scripts/hooks');
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['all'], hooksDir: 'scripts/hooks', from: src.root });
    assert.equal(readFileSync(path.join(dir, SHA_FILE), 'utf8').match(/^sets: .*$/m)?.[0], 'sets: all');
    const again = await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: 'scripts/hooks', from: src.root });
    assert.deepEqual(again, ['a.mjs', 'g.mjs', 'p.mjs', 'shared.mjs']);

    writeFileSync(path.join(dir, 'g.hint.txt'), 'consumer-owned\n');
    // Narrowing the selection turns guards off, so it is refused, before writing, without --drop.
    await assert.rejects(
      sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['core'], hooksDir: 'scripts/hooks', from: src.root }),
      /would stop vendoring 2 file\(s\).*g\.mjs, p\.mjs.*--drop/,
    );
    assert.equal(existsSync(path.join(dir, 'g.mjs')), true, 'nothing was deleted by the refused sync');
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['core'], drop: true, hooksDir: 'scripts/hooks', from: src.root });
    assert.equal(existsSync(path.join(dir, 'g.mjs')), false);
    assert.equal(existsSync(path.join(dir, 'p.mjs')), false);
    assert.equal(existsSync(path.join(dir, 'shared.mjs')), true, 'a file still in a selected set stays');
    assert.equal(existsSync(path.join(dir, 'g.hint.txt')), true, 'hint files are never deleted');
    assert.equal(readFileSync(path.join(dir, SHA_FILE), 'utf8').includes('sets:'), false);
    assert.deepEqual(await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root }), []);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('--check on a subset names drift in that subset and a record that no longer matches it', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  const dir = path.join(dst, 'scripts/hooks');
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['guards'], hooksDir: 'scripts/hooks', from: src.root });
    writeFileSync(path.join(dir, 'g.mjs'), 'edited\n');
    writeFileSync(path.join(dir, 'p.mjs'), 'not in the selected set, so not checked\n');
    let problems = await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root });
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /g\.mjs: differs/);

    // Hand-editing the record (adding a set without syncing) is drift too.
    const shaPath = path.join(dir, SHA_FILE);
    writeFileSync(shaPath, readFileSync(shaPath, 'utf8').replace('sets: guards', 'sets: guards,push'));
    problems = await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root });
    assert.ok(problems.some((p) => /file list does not match set\(s\) guards,push/.test(p)), problems.join('\n'));

    writeFileSync(shaPath, readFileSync(shaPath, 'utf8').replace('sets: guards,push', 'sets: gone'));
    problems = await check({ into: dst, hooksDir: 'scripts/hooks', from: src.root });
    assert.match(problems[0], /unknown set "gone"/);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('an unknown --set is refused before anything is written', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  try {
    await assert.rejects(sync({ into: dst, ref: src.sha, sets: ['nope'], hooksDir: 'scripts/hooks', from: src.root }), /unknown set "nope"/);
    assert.equal(existsSync(path.join(dst, 'scripts')), false);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('the env prefix defaults from agent-tooling.json, and an explicit --env-prefix wins', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  try {
    writeFileSync(path.join(dst, CONFIG_FILE), JSON.stringify({ envPrefix: 'WIDGET_' }));
    await sync({ into: dst, ref: src.sha, sets: ['guards'], hooksDir: 'scripts/hooks', from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/hooks/g.mjs'), 'utf8'), /WIDGET_ALLOW_X/);
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: 'scripts/hooks', from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/hooks/g.mjs'), 'utf8'), /ACME_ALLOW_X/);

    writeFileSync(path.join(dst, CONFIG_FILE), JSON.stringify({ envPrefix: 'lower_' }));
    await assert.rejects(sync({ into: dst, ref: src.sha, hooksDir: 'scripts/hooks', from: src.root }), /PREFIX_/);
    // With no config and no flag, the prefix the last sync recorded is kept, never reset to neutral.
    rmSync(path.join(dst, CONFIG_FILE));
    await sync({ into: dst, ref: src.sha, hooksDir: 'scripts/hooks', from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/hooks/g.mjs'), 'utf8'), /ACME_ALLOW_X/);
    assert.match(readFileSync(path.join(dst, 'scripts/hooks', SHA_FILE), 'utf8'), /^env-prefix: ACME_$/m);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('a first sync with no config and no flag keeps the neutral prefix', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, sets: ['guards'], hooksDir: 'scripts/hooks', from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/hooks/g.mjs'), 'utf8'), new RegExp(`${P}ALLOW_X`));
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('the CLI refuses a narrowing --set without --drop, and accepts it with', () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  const cli = (...args) => spawnSync(process.execPath, [SYNC, '--into', dst, '--ref', src.sha, '--from', src.root, ...args], { encoding: 'utf8' });
  try {
    assert.equal(cli('--set', 'all').status, 0);
    const refused = cli('--set', 'core');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /--drop/);
    assert.equal(cli('--set', 'core', '--drop').status, 0, 'and --drop lets it through');
    assert.equal(existsSync(path.join(dst, 'scripts/hooks/g.mjs')), false);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('the CLI takes --set and --check honours the recorded subset', () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  try {
    const r = spawnSync(process.execPath, [SYNC, '--into', dst, '--ref', src.sha, '--set', 'push', '--env-prefix', 'ACME_', '--from', src.root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(path.join(dst, 'scripts/hooks/p.mjs')), true);
    assert.equal(existsSync(path.join(dst, 'scripts/hooks/a.mjs')), false);
    const ok = spawnSync(process.execPath, [SYNC, '--into', dst, '--check', '--from', src.root], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    writeFileSync(path.join(dst, 'scripts/hooks/p.mjs'), 'edited\n');
    const drift = spawnSync(process.execPath, [SYNC, '--into', dst, '--check', '--from', src.root], { encoding: 'utf8' });
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /p\.mjs: differs/);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

// ---- hardening: ownership, containment, atomic writes ---------------------------------
//
// Ported from SeriousGeese/agent-tooling's sync after its security review. Every test here
// imports only what the pre-hardening sync.mjs already exported, so the suite can be run
// against that copy to see each one fail.

const clean = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
const HOOKS = 'scripts/hooks';

/** Removes a symlink or junction itself, never what it points at. */
function unlinkLink(p) {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

/** A file symlink, or null where the host refuses one (Windows without developer mode). */
function fileLink(target, at) {
  try {
    symlinkSync(target, at, 'file');
    return at;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return null;
    throw err;
  }
}

/** Runs `fn` with process.stderr.write captured; returns what it wrote. */
async function captureStderr(fn) {
  const original = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

test('a first sync onto a consumer file it did not write is refused with nothing written; adopt takes it over and says so', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'lib.mjs'), 'the consumer lib\n');
    await assert.rejects(
      sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: HOOKS, from: src.root }),
      /refusing to replace 1 existing file\(s\) the recorded CICD ref did not write.*scripts\/hooks\/lib\.mjs.*--adopt/,
    );
    assert.equal(readFileSync(path.join(dir, 'lib.mjs'), 'utf8'), 'the consumer lib\n');
    assert.equal(existsSync(path.join(dir, 'block-x.mjs')), false, 'not even the files that were free');
    assert.equal(existsSync(path.join(dir, SHA_FILE)), false);

    const err = await captureStderr(() => sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', adopt: true, hooksDir: HOOKS, from: src.root }));
    assert.match(err, /adopting scripts\/hooks\/lib\.mjs: replacing a file the recorded CICD ref did not write/);
    assert.equal(readFileSync(path.join(dir, 'lib.mjs'), 'utf8'), 'lib\n');
    assert.deepEqual(await check({ into: dst, hooksDir: HOOKS, from: src.root }), []);
    // The CLI spells it --adopt.
    assert.equal(parseArgs(['--into', '.', '--adopt']).adopt, true);
  } finally {
    clean(src.root, dst);
  }
});

test('a new set adding a file the consumer already has is refused; one already equal to the new bytes is not', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, sets: ['core'], hooksDir: HOOKS, from: src.root });
    writeFileSync(path.join(dir, 'p.mjs'), 'mine\n');
    await assert.rejects(sync({ into: dst, ref: src.sha, sets: ['core', 'push'], hooksDir: HOOKS, from: src.root }), /did not write.*p\.mjs/);
    assert.equal(readFileSync(path.join(dir, 'p.mjs'), 'utf8'), 'mine\n');
    assert.deepEqual(parseShaFile(readFileSync(path.join(dir, SHA_FILE), 'utf8')).sets, ['core'], 'the record is untouched');
    writeFileSync(path.join(dir, 'p.mjs'), 'p\n');
    await sync({ into: dst, ref: src.sha, sets: ['core', 'push'], hooksDir: HOOKS, from: src.root });
    assert.deepEqual(parseShaFile(readFileSync(path.join(dir, SHA_FILE), 'utf8')).sets, ['core', 'push']);
  } finally {
    clean(src.root, dst);
  }
});

test('a vendored file edited in place blocks a re-sync unless adopt is passed', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: HOOKS, from: src.root });
    writeFileSync(path.join(dir, 'lib.mjs'), 'edited in place\n');
    const sha2 = commitChange(src.root, { 'lib.mjs': 'lib v2\n', 'block-x.mjs': GUARD + '// v2\n' });
    await assert.rejects(sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root }), /scripts\/hooks\/lib\.mjs \(edited since/);
    assert.equal(readFileSync(path.join(dir, 'lib.mjs'), 'utf8'), 'edited in place\n');
    assert.doesNotMatch(readFileSync(path.join(dir, 'block-x.mjs'), 'utf8'), /v2/, 'nothing written');
    assert.equal(parseShaFile(readFileSync(path.join(dir, SHA_FILE), 'utf8')).ref, src.sha);
    await captureStderr(() => sync({ into: dst, ref: sha2, adopt: true, hooksDir: HOOKS, from: src.root }));
    assert.equal(readFileSync(path.join(dir, 'lib.mjs'), 'utf8'), 'lib v2\n');
    assert.match(readFileSync(path.join(dir, 'block-x.mjs'), 'utf8'), /ACME_ALLOW_X[\s\S]*v2/);
  } finally {
    clean(src.root, dst);
  }
});

test('a plain re-sync over what the previous ref wrote needs no flag, even with a ref bump and a prefix change', async () => {
  // The path every consumer takes today: hint files beside the guards, the guards untouched.
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: HOOKS, from: src.root });
    writeFileSync(path.join(dir, 'block-x.hint.txt'), 'consumer-owned\n');
    writeFileSync(path.join(dir, 'lib.mjs'), 'lib\r\n'); // a checkout with autocrlf is not an edit
    const sha2 = commitChange(src.root, { 'block-x.mjs': `// v2: set ${P}ALLOW_Y=1\n` });
    const err = await captureStderr(() => sync({ into: dst, ref: sha2, envPrefix: 'OTHER_', hooksDir: HOOKS, from: src.root }));
    assert.equal(err, '', 'nothing to adopt, nothing kept');
    assert.equal(readFileSync(path.join(dir, 'block-x.mjs'), 'utf8'), '// v2: set OTHER_ALLOW_Y=1\n');
    assert.equal(readFileSync(path.join(dir, 'block-x.hint.txt'), 'utf8'), 'consumer-owned\n');
    assert.deepEqual(await check({ into: dst, hooksDir: HOOKS, from: src.root }), []);
  } finally {
    clean(src.root, dst);
  }
});

test('a stale file the consumer edited is kept and named; an untouched one is deleted, under the recorded prefix too', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'a.mjs': 'a\n', 'b.mjs': 'b\n', 'g.mjs': GUARD });
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', hooksDir: HOOKS, from: src.root });
    assert.match(readFileSync(path.join(dir, 'g.mjs'), 'utf8'), /ACME_ALLOW_X/);
    writeFileSync(path.join(dir, 'a.mjs'), 'a, the consumer version\n');
    const sha2 = commitChange(src.root, { 'manifest.json': JSON.stringify({ files: ['block-x.mjs'] }) });
    const err = await captureStderr(() => sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root }));
    assert.equal(readFileSync(path.join(dir, 'a.mjs'), 'utf8'), 'a, the consumer version\n', 'an edited stale file is kept');
    assert.match(err, /not deleting stale scripts\/hooks\/a\.mjs: it differs from what .* wrote/);
    assert.equal(existsSync(path.join(dir, 'b.mjs')), false, 'an untouched stale file is deleted');
    assert.equal(existsSync(path.join(dir, 'g.mjs')), false, 'the prefix rewrite is part of what sync wrote');
    assert.deepEqual(parseShaFile(readFileSync(path.join(dir, SHA_FILE), 'utf8')).files, ['block-x.mjs']);
    assert.deepEqual(await check({ into: dst, hooksDir: HOOKS, from: src.root }), []);
  } finally {
    clean(src.root, dst);
  }
});

test('a stale name the recorded ref never shipped is kept, so a hand-edited record cannot delete a consumer file', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD });
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    writeFileSync(path.join(dir, 'mine.mjs'), 'consumer-owned\n');
    const shaPath = path.join(dir, SHA_FILE);
    writeFileSync(shaPath, readFileSync(shaPath, 'utf8').replace('files:\n', 'files:\n  mine.mjs\n'));
    const err = await captureStderr(() => sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root }));
    assert.equal(readFileSync(path.join(dir, 'mine.mjs'), 'utf8'), 'consumer-owned\n');
    assert.match(err, /not deleting stale scripts\/hooks\/mine\.mjs: manifest\.json at .* did not ship it/);
  } finally {
    clean(src.root, dst);
  }
});

test('a symlinked hooks directory leading outside --into is refused: nothing written or deleted through it', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'old.mjs': 'old\n' });
  const dst = consumer();
  const outside = consumer();
  const link = path.join(dst, 'scripts', 'hooks');
  try {
    await sync({ into: outside, ref: src.sha, hooksDir: HOOKS, from: src.root });
    mkdirSync(path.join(dst, 'scripts'));
    symlinkSync(path.join(outside, HOOKS), link, 'junction');
    const sha2 = commitChange(src.root, { 'block-x.mjs': GUARD + '// v2\n', 'manifest.json': JSON.stringify({ files: ['block-x.mjs'] }) });
    await assert.rejects(sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root }), /symlink in the path leads outside --into/);
    assert.equal(readFileSync(path.join(outside, HOOKS, 'old.mjs'), 'utf8'), 'old\n', 'nothing deleted through the link');
    assert.doesNotMatch(readFileSync(path.join(outside, HOOKS, 'block-x.mjs'), 'utf8'), /v2/, 'nothing written through the link');
    const problems = await check({ into: dst, hooksDir: HOOKS, from: src.root });
    assert.match(problems.join('\n'), /leads outside --into/);
  } finally {
    if (existsSync(path.join(dst, 'scripts'))) unlinkLink(link);
    clean(src.root, dst, outside);
  }
});

test('a vendored target or the record that is a symlinked file leading outside --into is refused, never written through', async (t) => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const outside = consumer();
  try {
    const dir = path.join(dst, HOOKS);
    mkdirSync(dir, { recursive: true });
    const victim = path.join(outside, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    if (!fileLink(victim, path.join(dir, 'lib.mjs'))) {
      t.skip('this host cannot create a file symlink');
      return;
    }
    await assert.rejects(sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root }), /lib\.mjs: a symlink in the path leads outside --into/);
    assert.equal(readFileSync(victim, 'utf8'), 'untouched\n');
    assert.equal(existsSync(path.join(dir, 'block-x.mjs')), false, 'nothing written');

    // The record: a link to a valid record outside, which a sync would otherwise rewrite.
    unlinkSync(path.join(dir, 'lib.mjs'));
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    const outsideRecord = path.join(outside, 'record');
    const recordText = readFileSync(path.join(dir, SHA_FILE), 'utf8');
    writeFileSync(outsideRecord, recordText);
    unlinkSync(path.join(dir, SHA_FILE));
    fileLink(outsideRecord, path.join(dir, SHA_FILE));
    const sha2 = commitChange(src.root, { 'lib.mjs': 'lib v2\n' });
    await assert.rejects(sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root }), /CICD-HOOKS-SHA: a symlink in the path leads outside --into/);
    assert.equal(readFileSync(outsideRecord, 'utf8'), recordText);
    assert.equal(readFileSync(path.join(dir, 'lib.mjs'), 'utf8'), 'lib\n', 'nothing written');
  } finally {
    clean(src.root, dst, outside);
  }
});

test('a dangling symlink at a vendored target is refused, so a write cannot create its target', async (t) => {
  const src = fakeCicd({ 'block-x.mjs': GUARD });
  const dst = consumer();
  const outside = consumer();
  try {
    mkdirSync(path.join(dst, HOOKS), { recursive: true });
    if (!fileLink(path.join(outside, 'created-by-sync.txt'), path.join(dst, HOOKS, 'block-x.mjs'))) {
      t.skip('this host cannot create a file symlink');
      return;
    }
    await assert.rejects(sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root }), /resolves nowhere/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    clean(src.root, dst, outside);
  }
});

test('a target that is a directory, or a hooks dir under a file, is refused before anything is written', async () => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'lib\n' });
  const dst = consumer();
  try {
    mkdirSync(path.join(dst, HOOKS, 'lib.mjs'), { recursive: true });
    await assert.rejects(sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root }), /scripts\/hooks\/lib\.mjs: it exists and is not a regular file/);
    assert.equal(existsSync(path.join(dst, HOOKS, 'block-x.mjs')), false, 'not half-synced');
    assert.equal(existsSync(path.join(dst, HOOKS, SHA_FILE)), false);
    rmSync(path.join(dst, 'scripts'), { recursive: true });
    writeFileSync(path.join(dst, 'scripts'), 'a file, not a directory\n');
    await assert.rejects(sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root }), /scripts exists and is not a directory/);
    assert.equal(readFileSync(path.join(dst, 'scripts'), 'utf8'), 'a file, not a directory\n');
  } finally {
    clean(src.root, dst);
  }
});

test('a case-only rename in the manifest keeps the file on a case-insensitive filesystem', async (t) => {
  const dst = consumer();
  writeFileSync(path.join(dst, 'probe'), '');
  const insensitive = existsSync(path.join(dst, 'PROBE'));
  rmSync(path.join(dst, 'probe'));
  if (!insensitive) {
    clean(dst);
    t.skip('this filesystem is case-sensitive, so a case-only rename is two files');
    return;
  }
  const src = fakeCicd({ 'Tool.mjs': 'tool\n' });
  try {
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    git(src.root, ['mv', 'agent-hooks/Tool.mjs', 'agent-hooks/tool.mjs']);
    const sha2 = commitChange(src.root, { 'manifest.json': JSON.stringify({ files: ['tool.mjs'] }) });
    await sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root });
    assert.equal(readFileSync(path.join(dst, HOOKS, 'tool.mjs'), 'utf8'), 'tool\n', 'the renamed file survives its own stale delete');
    assert.deepEqual(await check({ into: dst, hooksDir: HOOKS, from: src.root }), []);
  } finally {
    clean(src.root, dst);
  }
});

test('a manifest naming one file twice in different case is refused; an inherited property name is an unknown set', () => {
  assert.throws(() => parseManifest({ files: ['a.mjs', 'A.mjs'] }), /differ only in case/);
  assert.throws(() => parseManifest({ files: ['a.mjs'], sets: { core: ['a.mjs'], push: ['A.mjs'] } }), /differ only in case/);
  assert.throws(() => selectFiles({ sets: { core: ['a.mjs', 'A.mjs'] } }, ['core']), /differ only in case/);
  // The same name in the same case in two sets is fine.
  assert.deepEqual(selectFiles(parseManifest({ files: ['a.mjs'], sets: { core: ['a.mjs'], push: ['a.mjs'] } }), ['all']), ['a.mjs']);
  const m = parseManifest({ files: ['a.mjs'] });
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) assert.throws(() => selectFiles(m, [name]), /unknown set/, name);
});

test('a record with a malformed ref or env-prefix is refused, sync refuses an unpinned ref, and transform never reads $ patterns', async () => {
  const rec = { ref: 'b'.repeat(40), envPrefix: 'ACME_', files: [] };
  for (const bad of ["$'", '$&_', 'acme_', 'ACME']) {
    assert.throws(() => parseShaFile(formatShaFile({ ...rec, envPrefix: bad })), /env-prefix/, bad);
  }
  assert.throws(() => parseShaFile(formatShaFile({ ...rec, ref: '--output=x' })), /not a full 40-hex/);
  assert.equal(transform(`a ${P}X`, '$&'), 'a $&X');
  assert.equal(transform(`a ${P}X b`, "$'"), "a $'X b");
  const dst = consumer();
  try {
    await assert.rejects(sync({ into: dst, ref: 'main', hooksDir: HOOKS, from: dst }), /full 40-hex/);
  } finally {
    clean(dst);
  }
});

test('a selection that vendors a file named like the record is refused before anything is written', async () => {
  const src = fakeCicd({ 'a.mjs': 'a\n', [SHA_FILE]: 'not a record\n' });
  const dst = consumer();
  try {
    await assert.rejects(sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root }), /vendors the record file/);
    assert.deepEqual(readdirSync(dst), [], 'nothing written');
  } finally {
    clean(src.root, dst);
  }
});

test('a hard-linked target is replaced, never written through, so the other link keeps its bytes', async (t) => {
  const src = fakeCicd({ 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const outside = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    const victim = path.join(outside, 'victim.mjs');
    writeFileSync(victim, 'lib\n');
    rmSync(path.join(dir, 'lib.mjs'));
    try {
      linkSync(victim, path.join(dir, 'lib.mjs'));
    } catch (err) {
      t.skip(`this host refuses a hard link (${/** @type {NodeJS.ErrnoException} */ (err).code})`);
      return;
    }
    const sha2 = commitChange(src.root, { 'lib.mjs': 'lib v2\n' });
    await sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root });
    assert.equal(readFileSync(path.join(dir, 'lib.mjs'), 'utf8'), 'lib v2\n');
    assert.equal(readFileSync(victim, 'utf8'), 'lib\n', 'the other link is untouched');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith('.tmp')),
      [],
      'no temp file left behind',
    );
  } finally {
    clean(src.root, dst, outside);
  }
});

test('an existing file keeps its mode across a re-sync', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows has no POSIX mode bits to keep');
    return;
  }
  const src = fakeCicd({ 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const file = path.join(dst, HOOKS, 'lib.mjs');
  try {
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    chmodSync(file, 0o755);
    const sha2 = commitChange(src.root, { 'lib.mjs': 'lib v2\n' });
    await sync({ into: dst, ref: sha2, hooksDir: HOOKS, from: src.root });
    assert.equal(statSync(file).mode & 0o777, 0o755);
  } finally {
    clean(src.root, dst);
  }
});

test('a refs/replace substitution in the --from checkout is ignored', async () => {
  const src = fakeCicd({ 'lib.mjs': 'lib\n' });
  const dst = consumer();
  try {
    const blob = git(src.root, ['rev-parse', `${src.sha}:agent-hooks/lib.mjs`]);
    const evil = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: src.root, input: 'evil\n', encoding: 'utf8' }).trim();
    git(src.root, ['replace', blob, evil]);
    assert.equal(git(src.root, ['show', `${src.sha}:agent-hooks/lib.mjs`]), 'evil', 'the replacement is live for plain git');
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    assert.equal(readFileSync(path.join(dst, HOOKS, 'lib.mjs'), 'utf8'), 'lib\n');
    assert.deepEqual(await check({ into: dst, hooksDir: HOOKS, from: src.root }), []);
  } finally {
    clean(src.root, dst);
  }
});

test('--check reports a directory or a symlink where a vendored file belongs as drift, and does not crash', async (t) => {
  const src = fakeCicd({ 'block-x.mjs': GUARD, 'lib.mjs': 'lib\n' });
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  try {
    await sync({ into: dst, ref: src.sha, hooksDir: HOOKS, from: src.root });
    rmSync(path.join(dir, 'lib.mjs'));
    mkdirSync(path.join(dir, 'lib.mjs'));
    const problems = await check({ into: dst, hooksDir: HOOKS, from: src.root });
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /lib\.mjs: is a directory, not a regular file/);
    const r = spawnSync(process.execPath, [SYNC, '--into', dst, '--check', '--from', src.root], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\[hooks-drift\].*lib\.mjs: is a directory/);

    // A link to an identical file inside --into is still not the vendored file.
    rmSync(path.join(dir, 'lib.mjs'), { recursive: true });
    writeFileSync(path.join(dst, 'lib-copy.mjs'), 'lib\n');
    if (!fileLink(path.join(dst, 'lib-copy.mjs'), path.join(dir, 'lib.mjs'))) {
      t.skip('this host cannot create a file symlink');
      return;
    }
    const linked = await check({ into: dst, hooksDir: HOOKS, from: src.root });
    assert.match(linked.join('\n'), /lib\.mjs: is a symlink, not a regular file/);
  } finally {
    clean(src.root, dst);
  }
});

test('an unreadable recorded ref: a differing target needs adopt and a stale file is kept, each naming the cause', async () => {
  const src = fakeCicdWithSets(SETS, SET_FILES);
  const dst = consumer();
  const dir = path.join(dst, HOOKS);
  const gone = 'd'.repeat(40);
  try {
    await sync({ into: dst, ref: src.sha, sets: ['core', 'push'], hooksDir: HOOKS, from: src.root });
    const shaPath = path.join(dir, SHA_FILE);
    writeFileSync(shaPath, readFileSync(shaPath, 'utf8').replace(`ref: ${src.sha}`, `ref: ${gone}`));
    writeFileSync(path.join(dir, 'a.mjs'), 'edited\n');
    await assert.rejects(
      sync({ into: dst, ref: src.sha, sets: ['core'], drop: true, hooksDir: HOOKS, from: src.root }),
      new RegExp(`scripts/hooks/a\\.mjs \\(cannot read manifest\\.json at ${gone}.*cannot be confirmed unchanged`),
    );
    assert.equal(readFileSync(path.join(dir, 'a.mjs'), 'utf8'), 'edited\n');

    const err = await captureStderr(() => sync({ into: dst, ref: src.sha, sets: ['core'], drop: true, adopt: true, hooksDir: HOOKS, from: src.root }));
    assert.match(err, /adopting scripts\/hooks\/a\.mjs/);
    assert.match(err, new RegExp(`not deleting 1 stale file\\(s\\): cannot read manifest\\.json at ${gone}`));
    assert.equal(readFileSync(path.join(dir, 'p.mjs'), 'utf8'), 'p\n', 'the stale file is kept');
    assert.equal(parseShaFile(readFileSync(shaPath, 'utf8')).files.includes('p.mjs'), false, 'and is no longer recorded: delete it by hand');
  } finally {
    clean(src.root, dst);
  }
});
