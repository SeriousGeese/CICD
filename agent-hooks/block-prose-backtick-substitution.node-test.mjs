import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, segmentCommand, liveBacktickCount } from './block-prose-backtick-substitution.mjs';

const hook = fileURLToPath(new URL('./block-prose-backtick-substitution.mjs', import.meta.url));

function runHook(command, { env = {}, toolName = 'Bash' } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_HOOKS_ALLOW_PROSE_BACKTICK: '', ...env },
  });
}

// ── Blocked: the original loss ──────────────────────────────────────────────
test('blocks a backticked identifier in a bd create description', () => {
  const r = runHook('bd create "Show keyboard shortcuts" -d "The cheat sheet works around this with its own `mod` variable."');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /COMMAND SUBSTITUTION/);
  assert.match(r.stderr, /AGENT_HOOKS_ALLOW_PROSE_BACKTICK/);
  // Two, because a pair of backticks is two characters — the message counts what bash sees.
  assert.match(r.stderr, /2 unescaped backticks outside single quotes/);
});

test('blocks the SILENT half — a backticked word that is a real command', () => {
  // `date` succeeds, so bash prints nothing and injects a timestamp mid-sentence.
  const r = runHook('bd note bead-abc "the sweep runs on `date` boundaries"');
  assert.equal(r.status, 2);
});

test('blocks a backtick in a gh pr body, and reports the count', () => {
  const r = runHook('gh pr create --title "fix" --body "touches `a.ts` and `b.ts`"');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /4 unescaped backticks/);
});

test('blocks a bd segment reached through a chain or a wrapper', () => {
  for (const c of [
    'cd /tmp && bd create "x" -d "see `foo`"',
    'timeout 120 bd create "x" -d "see `foo`"',
    'FOO_X=1 bd create "x" -d "see `foo`"',
    'rtk bd note bead-x "see `foo`"',
  ]) {
    assert.equal(runHook(c).status, 2, c);
  }
});

test('blocks an UNQUOTED backtick too — quoting is not what makes it substitution', () => {
  assert.equal(runHook('bd create Title -d see-`foo`-here').status, 2);
});

// ── Allowed: every documented way to pass the text intact ──────────────────
test('allows single quotes, which is the cheapest real fix', () => {
  const r = runHook("bd create 'Show shortcuts' -d 'its own `mod` variable.'");
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('allows backslash-escaped backticks inside double quotes', () => {
  const r = runHook('gh pr comment 3161 --body "regenerated via \\`npm run generate\\`"');
  assert.equal(r.status, 0);
});

test('allows $(…) substitution, including the per-session actor idiom a claim uses', () => {
  const r = runHook('bd update bead-x --claim --actor "$(node scripts/agent-actor-id.mjs)"');
  assert.equal(r.status, 0);
});

test('allows --body-file, the fix for anything long', () => {
  const r = runHook('gh pr create --title "fix" --body-file /tmp/body.md');
  assert.equal(r.status, 0);
});

// ── Allowed: out of scope. Every other command takes shell, not prose ──────
test('leaves non-prose commands alone even when they legitimately use backticks', () => {
  for (const c of [
    'echo "today is `date`"',
    'grep -n "`foo`" src/x.ts',
    'git commit -m "see `foo`"',
    'npm test > /dev/null 2>&1; echo EXIT:$?',
  ]) {
    assert.equal(runHook(c).status, 0, c);
  }
});

test('does not fire on a bd command with no backtick at all', () => {
  assert.equal(runHook('bd ready -n 60').status, 0);
  assert.equal(runHook('bd show bead-abc --json').status, 0);
});

test('ignores a non-Bash/non-Monitor tool, and honours the escape hatch', () => {
  const cmd = 'bd create "x" -d "see `foo`"';
  assert.equal(runHook(cmd, { toolName: 'PowerShell' }).status, 0);
  assert.equal(runHook(cmd, { env: { AGENT_HOOKS_ALLOW_PROSE_BACKTICK: '1' } }).status, 0);
});

// Monitor is a separate channel measured (block-bash-double-backslash.mjs) to hand
// its command to a real shell with the same semantics as the Bash tool — a backtick
// in a Monitor-run bd/gh segment is command substitution there too.
test('blocks a Monitor command exactly like Bash', () => {
  const r = runHook('bd create "x" -d "see `foo`"', { toolName: 'Monitor' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /COMMAND SUBSTITUTION/);
});

test('Monitor with no backtick is allowed', () => {
  assert.equal(runHook('bd ready -n 60', { toolName: 'Monitor' }).status, 0);
});

test('fails OPEN on malformed input — the guard must never break Bash', () => {
  const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

// ── Unit level: the three pieces the decision is built from ────────────────
test('segmentCommand strips wrappers, assignments, paths and timeout durations', () => {
  assert.equal(segmentCommand('bd create "x"'), 'bd');
  assert.equal(segmentCommand('  timeout 90 bd create "x"'), 'bd');
  assert.equal(segmentCommand('env FOO=1 /usr/bin/gh pr view 1'), 'gh');
  assert.equal(segmentCommand('npm test'), 'npm');
  assert.equal(segmentCommand('   '), '');
});

test('liveBacktickCount counts only what bash would substitute', () => {
  assert.equal(liveBacktickCount("echo 'a `b` c'"), 0);        // single-quoted: literal
  assert.equal(liveBacktickCount('echo "a \\` b"'), 0);        // escaped: literal
  assert.equal(liveBacktickCount('echo "a `b` c"'), 2);
  assert.equal(liveBacktickCount('echo a `b` c'), 2);          // unquoted: still substitution
});

test('decide judges the bd segment, not the whole command line', () => {
  // The backtick is in the `echo`, which is out of scope; the bd segment is clean.
  assert.equal(decide('echo "built at `date`" && bd ready'), null);
  // And the reverse: a clean echo does not excuse the bd segment.
  assert.deepEqual(decide('echo hi && bd note bead-x "see `foo`"'), { command: 'bd', count: 2 });
});
