/**
 * block-pattern-kill: no killing processes by name or pattern on a machine shared with peer
 * sessions and sibling workers (the recurrence of an earlier incident of the same kind).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandWord, firstReason, segments } from './block-pattern-kill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'block-pattern-kill.mjs');

function run(command, { tool = 'Bash', env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_HOOKS_ALLOW_PATTERN_KILL: '', ...env },
  });
}

test('the incident and its cousins are refused: pkill, killall, taskkill /IM, Stop-Process -Name, pgrep into kill', () => {
  for (const command of [
    'pkill -f "jest --coverage"',
    'pkill node',
    'sudo pkill -9 -f next-server',
    'killall node',
    'taskkill /IM node.exe /F',
    'taskkill /F /im node.exe',
    'Stop-Process -Name node -Force',
    'Get-Process node | Stop-Process -Name node',
    'spps -n node',
    'kill -Name node',
    'kill $(pgrep -f "jest --coverage")',
    'pgrep -f next-server | xargs kill',
    'pgrep node | xargs -r kill -9',
    'npm test; pkill -f jest',
    // The second-pass review's misses (#5302): Git Bash's doubled slash, a path, nested shells,
    // the colon parameter form, a filter, killall5, a selection piped into Stop-Process or kill.
    'taskkill //F //IM node.exe',
    'C:/Windows/System32/taskkill.exe /IM node.exe',
    '/usr/bin/pkill -f jest',
    'bash -c "pkill -f jest"',
    'powershell -Command "Stop-Process -Name node"',
    'pwsh -c "Get-Process node | Stop-Process -Force"',
    'cmd /c taskkill /IM node.exe',
    'Stop-Process -Name:node',
    'taskkill /FI "IMAGENAME eq node.exe"',
    'killall5 -9',
    'Get-Process node | Stop-Process -Force',
    'gps node | kill',
    'kill $(pidof node)',
    'ps aux | grep jest | awk \'{print $2}\' | xargs kill',
  ]) {
    const r = run(command);
    assert.equal(r.status, 2, `${command} should be refused; stderr: ${r.stderr}`);
    assert.match(r.stderr, /Kill only the PIDs you started/);
    assert.match(r.stderr, /NOTHING in this command ran/);
  }
});

test('killing your own PID, and every look-only command, passes', () => {
  for (const command of [
    'kill 12345',
    'kill -9 12345',
    'kill -n 9 12345',
    'kill "$!"',
    'taskkill /PID 4242 /F',
    'Stop-Process -Id 4242',
    'pgrep -fa jest',
    'ps -o pid,args | grep jest',
    'echo "do not pkill here" > notes.txt',
    'git log --grep killall',
    'npm test',
    // Mentions, not kills: quotes keep a separator from splitting a search or a message (review).
    'rg "pkill|killall" scripts/',
    'grep -E "foo|pkill" notes.md',
    'echo "x; pkill foo"',
    'bd note bd-1 "line one\npkill -f jest was the incident"',
    'git commit -m "pgrep lists pids; kill them"',
    'grep -n pgrep f; kill 123',
    'pgrep -fa x && npm run kill-port',
    'kill %1',
    'kill -- -4242',
    'cat my-pids.txt | xargs kill',
    'Get-Process -Name node',
    'Get-Process node | Stop-Process -Id 4242',
  ]) {
    const r = run(command);
    assert.equal(r.status, 0, `${command} should pass; stderr: ${r.stderr}`);
  }
});

test('the guard covers PowerShell and Monitor commands too, and ignores other tools', () => {
  assert.equal(run('Stop-Process -Name node', { tool: 'PowerShell' }).status, 2);
  assert.equal(run('pkill -f jest', { tool: 'Monitor' }).status, 2);
  assert.equal(run('pkill -f jest', { tool: 'Read' }).status, 0);
});

test('the hatch works inline on the segment, or from the environment', () => {
  assert.equal(run('AGENT_HOOKS_ALLOW_PATTERN_KILL=1 pkill -f my-own-unique-server').status, 0);
  assert.equal(run('pkill -f x', { env: { AGENT_HOOKS_ALLOW_PATTERN_KILL: '1' } }).status, 0);
  // Scoped to its own segment: a hatch on one command does not cover the next.
  assert.equal(run('AGENT_HOOKS_ALLOW_PATTERN_KILL=1 echo hi; pkill -f jest').status, 2);
  // PowerShell has no prefix form; an assignment in the same command is its inline hatch.
  assert.equal(run("$env:AGENT_HOOKS_ALLOW_PATTERN_KILL = '1'; Stop-Process -Name my-own-server", { tool: 'PowerShell' }).status, 0);
  assert.match(run('Stop-Process -Name node', { tool: 'PowerShell' }).stderr, /\$env:AGENT_HOOKS_ALLOW_PATTERN_KILL = '1'/);
});

test('the guard still blocks when its directory is reached through a symlink or junction', () => {
  // node resolves import.meta.url through the link but leaves argv[1] as typed; an entry check
  // comparing the two directly made the guard do nothing, so it failed open.
  const parent = mkdtempSync(path.join(tmpdir(), 'agent-hooks-link-'));
  const link = path.join(parent, 'hooks');
  try {
    symlinkSync(HERE, link, 'junction');
    const r = spawnSync(process.execPath, [path.join(link, 'block-pattern-kill.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pkill node' } }),
      encoding: 'utf8',
      env: { ...process.env, AGENT_HOOKS_ALLOW_PATTERN_KILL: '' },
    });
    assert.equal(r.status, 2, r.stderr);
  } finally {
    try {
      unlinkSync(link);
    } catch {
      rmdirSync(link);
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test('unreadable input fails open', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('the quote-aware segmenter: a quoted separator separates nothing, a pipe is remembered', () => {
  assert.deepEqual(segments('rg "a|b" x').map((s) => s.tokens), [['rg', 'a|b', 'x']]);
  assert.deepEqual(segments("echo 'x; y' && ls").map((s) => s.tokens), [['echo', 'x; y'], ['ls']]);
  const piped = segments('pgrep x | xargs kill');
  assert.deepEqual(piped.map((s) => s.pipedIn), [false, true]);
  assert.equal(commandWord('C:\\Windows\\System32\\TASKKILL.EXE'), 'taskkill');
  assert.equal(firstReason('kill 1'), null);
  assert.match(firstReason('pkill -f x'), /pkill/);
});
