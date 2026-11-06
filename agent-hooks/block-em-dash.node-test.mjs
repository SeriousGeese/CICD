import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { removeTempDir } from './test-cleanup.mjs';

const HOOK = fileURLToPath(new URL('./block-em-dash.mjs', import.meta.url));
let tmpDir;

describe('block-em-dash.mjs', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'block-em-dash-cli-'));
  });

  afterEach(() => {
    removeTempDir(tmpDir, 'block-em-dash.node-test');
  });

  it('passes when file has no em-dashes or en-dashes', () => {
    const file = join(tmpDir, 'clean.md');
    writeFileSync(file, 'This file uses - for dashes. No problems here.\n');
    const result = execSync(`node ${HOOK} "${file}"`, { encoding: 'utf-8' });
    assert.ok(result.includes('OK'));
  });

  it('fails when file contains an em-dash (U+2014)', () => {
    const file = join(tmpDir, 'bad.md');
    writeFileSync(file, `This has an em-dash \u2014 right here.\n`);
    let exitCode = 0;
    let output;
    try {
      execSync(`node ${HOOK} "${file}"`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      exitCode = e.status || 1;
      output = (e.stdout || '') + (e.stderr || '');
      assert.ok(output.includes('FAIL'), 'should report FAIL');
      assert.ok(output.includes('em-dash'), 'should identify em-dash');
    }
    assert.equal(exitCode, 1, 'should exit non-zero');
  });

  it('fails when file contains an en-dash (U+2013)', () => {
    const file = join(tmpDir, 'bad.md');
    writeFileSync(file, `Range: 1\u20135 pages.\n`);
    let exitCode = 0;
    let output;
    try {
      execSync(`node ${HOOK} "${file}"`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      exitCode = e.status || 1;
      output = (e.stdout || '') + (e.stderr || '');
      assert.ok(output.includes('FAIL'), 'should report FAIL');
      assert.ok(output.includes('en-dash'), 'should identify en-dash');
    }
    assert.equal(exitCode, 1, 'should exit non-zero');
  });

  it('reports file path, line number, and column', () => {
    const file = join(tmpDir, 'bad.md');
    writeFileSync(file, `Line one\nLine two \u2014 with dash\nLine three\n`);
    let output;
    try {
      execSync(`node ${HOOK} "${file}"`, { encoding: 'utf-8', stdio: 'pipe' });
      assert.fail('should have exited non-zero');
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      assert.ok(output.includes(':2:'), 'should report line 2');
    }
  });

  it('ignores non-text files', () => {
    const file = join(tmpDir, 'image.png');
    writeFileSync(file, `\u2014\u2014\u2014`); // binary-ish, wrong extension
    const result = execSync(`node ${HOOK} "${file}"`, { encoding: 'utf-8' });
    assert.ok(result.includes('No .md/.txt files'), 'should skip non-text files');
  });
});

// Hook mode: no file args, so the hook reads the STAGED diff of a real repo. Each test builds a
// throwaway repo whose content/ already holds a dash, so "only ADDED lines count" is what is
// actually being proved. The scope comes from agent-tooling.json (emDashPaths), written by the
// fixture, so the suite also proves the guard reads its scope from config.
describe('block-em-dash.mjs as the pre-commit hook (staged additions only)', () => {
  const EM = String.fromCharCode(0x2014);
  const EN = String.fromCharCode(0x2013);
  const HOOK_ABS = HOOK;
  let repo;

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
  const runHook = (env = {}) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.GIT_DIR;
    delete childEnv.GIT_INDEX_FILE;
    delete childEnv.GIT_WORK_TREE;
    return spawnSync(process.execPath, [HOOK_ABS], { cwd: repo, encoding: 'utf-8', env: childEnv });
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'em-dash-hook-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(repo, 'agent-tooling.json'), JSON.stringify({ emDashPaths: ['content/'] }));
    mkdirSync(join(repo, 'content', 'npc'), { recursive: true });
    writeFileSync(join(repo, 'content', 'npc', 'old.md'), `Line one\nAn old ${EM} dash already here.\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    removeTempDir(repo, 'block-em-dash.node-test');
  });

  it('passes a commit that edits a file with a PRE-EXISTING dash without adding one', () => {
    writeFileSync(join(repo, 'content', 'npc', 'old.md'), `Line one\nAn old ${EM} dash already here.\nA new plain line - fine.\n`);
    git('add', '-A');
    const r = runHook();
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks a commit that ADDS an em-dash or en-dash under content/, naming the new line', () => {
    writeFileSync(join(repo, 'content', 'npc', 'old.md'), `Line one\nAn old ${EM} dash already here.\nNew ${EM} dash.\nPages 1${EN}5.\n`);
    git('add', '-A');
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /content\/npc\/old\.md:3:5 - em-dash/);
    assert.match(r.stderr, /content\/npc\/old\.md:4:8 - en-dash/);
    assert.doesNotMatch(r.stderr, /old\.md:2:/, 'the pre-existing dash on line 2 is not the author\'s');
  });

  it('ignores dashes added outside content/ and in non-text files', () => {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'guide.md'), `Docs ${EM} are not the guide reader.\n`);
    writeFileSync(join(repo, 'content', 'npc', 'data.json'), `{"x": "${EM}"}\n`);
    git('add', '-A');
    assert.equal(runHook().status, 0);
  });

  it('AGENT_HOOKS_ALLOW_EM_DASH=1 lets a deliberate dash through', () => {
    writeFileSync(join(repo, 'content', 'npc', 'new.md'), `Deliberate ${EM} dash.\n`);
    git('add', '-A');
    assert.equal(runHook().status, 1);
    assert.equal(runHook({ AGENT_HOOKS_ALLOW_EM_DASH: '1' }).status, 0);
  });

  it('does nothing when nothing under content/ is staged (no whole-tree fallback)', () => {
    const r = runHook();
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  });

  it('checks nothing in hook mode when emDashPaths is empty or absent', () => {
    writeFileSync(join(repo, 'content', 'npc', 'new.md'), `Deliberate ${EM} dash.\n`);
    git('add', '-A');
    assert.equal(runHook().status, 1, 'baseline: configured scope blocks');
    writeFileSync(join(repo, 'agent-tooling.json'), JSON.stringify({ emDashPaths: [] }));
    assert.equal(runHook().status, 0);
    rmSync(join(repo, 'agent-tooling.json'));
    const r = runHook();
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  });

  it('takes its scope from the configured prefixes, not from content/', () => {
    writeFileSync(join(repo, 'agent-tooling.json'), JSON.stringify({ emDashPaths: ['prose/', 'README.md'] }));
    mkdirSync(join(repo, 'prose'), { recursive: true });
    mkdirSync(join(repo, 'proselike'), { recursive: true });
    writeFileSync(join(repo, 'prose', 'a.md'), `Prose ${EM} here.\n`);
    writeFileSync(join(repo, 'proselike', 'b.md'), `Not in scope ${EM} here.\n`);
    writeFileSync(join(repo, 'content', 'npc', 'c.md'), `Old scope ${EM} here.\n`);
    git('add', '-A');
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /prose\/a\.md:1:7 - em-dash/);
    assert.doesNotMatch(r.stderr, /proselike|c\.md/);
    assert.match(r.stderr, /under prose\/, README\.md/);
    writeFileSync(join(repo, 'README.md'), `Readme ${EN} here.\n`);
    git('add', '-A');
    assert.match(runHook().stderr, /README\.md:1:8 - en-dash/);
  });

  it('a malformed agent-tooling.json is named on stderr and the hook carries on with no scope', () => {
    writeFileSync(join(repo, 'agent-tooling.json'), '{ nope');
    writeFileSync(join(repo, 'content', 'npc', 'new.md'), `Deliberate ${EM} dash.\n`);
    git('add', '-A');
    const r = runHook();
    assert.equal(r.status, 0);
    assert.match(r.stderr, /agent-tooling\.json/);
  });
});
