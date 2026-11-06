// Tests for hook-input.mjs.
//
// readHookInput()/readToolCommand() read fd 0, so these tests exercise them through a real
// child process piping JSON into stdin — a fake in-process stdin cannot be substituted here
// without changing the module's contract (readFileSync(0, ...)).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'hook-input.mjs');

function run(fn, stdin) {
  return spawnSync(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileUrl(LIB))}).then(({ ${fn} }) => {
      try {
        process.stdout.write(JSON.stringify(${fn}()));
      } catch (err) {
        process.stderr.write('THREW: ' + (err?.message ?? err));
        process.exitCode = 1;
      }
    });
  `], { input: stdin, encoding: 'utf8' });
}

function pathToFileUrl(p) {
  return new URL(`file://${p.replace(/\\/g, '/')}`).href;
}

test('readHookInput parses the whole stdin JSON payload', () => {
  const r = run('readHookInput', JSON.stringify({ tool_input: { command: 'echo hi' }, tool_name: 'Bash' }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { tool_input: { command: 'echo hi' }, tool_name: 'Bash' });
});

test('readHookInput throws on unparseable stdin — the caller is expected to catch it', () => {
  const r = run('readHookInput', 'not json');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /THREW/);
});

test('readToolCommand returns the command string', () => {
  const r = run('readToolCommand', JSON.stringify({ tool_input: { command: 'git status' } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), 'git status');
});

test('readToolCommand returns empty string when tool_input.command is absent', () => {
  const r = run('readToolCommand', JSON.stringify({ tool_input: {} }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), '');
});

test('readToolCommand returns empty string when tool_input itself is absent', () => {
  const r = run('readToolCommand', JSON.stringify({}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), '');
});
