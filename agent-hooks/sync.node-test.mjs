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
