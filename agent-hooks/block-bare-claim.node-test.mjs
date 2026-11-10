// Tests for block-bare-claim.mjs: a bare `bd update --claim` is refused and
// points at scripts/claim.sh, including one unwrapped from `bash -c`, `eval`, a substitution
// or a script file; prose about a claim and the helper itself are never refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTempDir } from './test-cleanup.mjs';
import {
  bareClaimSegment,
  classifyScript,
  HATCH_VAR,
  jsClaims,
  MAX_SCRIPT_BYTES,
  scanCommand,
  shellSegments,
  topContext,
} from './block-bare-claim.mjs';

const hook = fileURLToPath(new URL('./block-bare-claim.mjs', import.meta.url));
const runHook = (command, env = {}, cwd = undefined) =>
  spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, [HATCH_VAR]: '', ...env },
  });

function withDir(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-bare-claim-')));
  try {
    return fn(dir);
  } finally {
    removeTempDir(dir, 'block-bare-claim.node-test');
  }
}

test('a bare claim is found through the wrappers this repo uses', () => {
  for (const cmd of [
    'bd update bd-6b2ai.1 --claim',
    'bd update --claim bd-6b2ai.1',
    'bd update bd-6b2ai.1 --claim=true',
    'cd /c/git/repo && bd update bd-6b2ai.1 --claim',
    'rtk proxy bd update bd-6b2ai.1 --claim',
    'env -u GITHUB_TOKEN bd update bd-6b2ai.1 --claim',
    'timeout 90 bd update bd-6b2ai.1 --claim --actor "x-bot-11112222"',
    'BEADS_ACTOR=x bd update bd-6b2ai.1 --claim',
    'for id in bd-a bd-b; do bd update "$id" --claim; done',
    '(bd update bd-6b2ai.1 --claim)',
  ]) {
    assert.notEqual(bareClaimSegment(cmd), null, cmd);
  }
});

test('a claim unwrapped from a shell -c payload, eval or a substitution is found', () => {
  for (const cmd of [
    "bash -c 'bd update bd-x --claim'",
    "bash -lc 'cd /tmp && bd update bd-x --claim'",
    'sh -c "bd update bd-x --claim"',
    "zsh -c 'echo hi; bd update bd-x --claim'",
    "pwsh -Command 'bd update bd-x --claim'",
    'powershell -c "bd update bd-x --claim"',
    "eval 'bd update bd-x --claim'",
    'eval bd update bd-x --claim',
    'x=$(bd update bd-x --claim)',
    'echo "$(bd update bd-x --claim)"',
    'x=`bd update bd-x --claim`',
    'echo "`true; bd update bd-x --claim`"',
    "bash -c 'sh -c \"bd update bd-x --claim\"'",
  ]) {
    assert.notEqual(bareClaimSegment(cmd), null, cmd);
  }
});

test('a bd called by path, and a claim in inline node/python/perl/ruby code, are found', () => {
  for (const cmd of [
    '/usr/local/bin/bd update bd-x --claim',
    './bd update bd-x --claim',
    'C:/tools/bd.exe update bd-x --claim',
    "node -e \"execFileSync('bd', ['update', id, '--claim'])\"",
    "node --eval \"require('node:child_process').execSync('bd update bd-x --claim')\"",
    "node -p \"spawnSync('bd', ['update', 'bd-x', '--claim'])\"",
    "python -c \"import subprocess; subprocess.run(['bd', 'update', 'bd-x', '--claim'])\"",
    "python3 -c \"import os; os.system('bd update bd-x --claim')\"",
    "perl -e 'system(\"bd update bd-x --claim\")'",
    "ruby -e '`bd update bd-x --claim`'",
  ]) {
    assert.notEqual(bareClaimSegment(cmd), null, cmd);
  }
  for (const cmd of ['/usr/local/bin/bd update bd-x --claim', "node -e \"execFileSync('bd', ['update', id, '--claim'])\""]) {
    assert.equal(runHook(cmd).status, 2, `end to end: ${cmd}`);
  }
});

test('a binary called by path, and inline code that only names a claim as data, pass', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, 'tool'), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(MAX_SCRIPT_BYTES + 10)]));
    writeFileSync(path.join(dir, 'shebang'), '#!/usr/bin/env bash\nbd update "$1" --claim\n');
    assert.equal(scanCommand('./tool status', dir), null, 'an oversized binary runs no shell text');
    assert.equal(scanCommand('/usr/local/bin/bd show bd-x --json', dir), null);
    assert.notEqual(scanCommand('./shebang bd-x', dir), null, 'an extensionless #! script is scanned');
  });
  for (const cmd of [
    "node -e \"console.log('bd update bd-x --claim')\"",
    'node -e "process.exit(0)"',
    "python -c \"print('use claim.sh, not bd update --claim')\"",
  ]) {
    assert.equal(bareClaimSegment(cmd), null, cmd);
  }
});

test('the helper, other bd commands and prose about a claim are not bare claims', () => {
  for (const cmd of [
    'bash scripts/claim.sh bd-x feat/y',
    'bash scripts/claim.sh bd-x --claim-only',
    'bd update bd-x -a ""',
    'bd show bd-x --json',
    'echo "bd update bd-x --claim"',
    "echo '$(bd update bd-x --claim)'",
    "git commit -q -m 'subject\nbd update bd-65ebd --claim wrote'",
    'git commit -m "bd update bd-x --claim is refused"',
    'gh pr create --body "context\nbd update bd-x --claim is the shape"',
    "cat > notes.md <<'EOF'\nbd update bd-x --claim\nEOF",
    'grep -n "update --claim" AGENTS.md',
    "bash -c 'echo bd update bd-x --claim'",
    '# bd update bd-x --claim',
  ]) {
    assert.equal(bareClaimSegment(cmd), null, cmd);
  }
});

test('a script run by path that claims is refused; claim.sh itself and a clean script pass', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, 'claims.sh'), '#!/usr/bin/env bash\nfor id in "$@"; do\n  bd update "$id" --claim\ndone\n');
    writeFileSync(path.join(dir, 'clean.sh'), '#!/usr/bin/env bash\n# bd update X --claim is what we avoid\nbd show "$1" --json\n');
    writeFileSync(path.join(dir, 'outer.sh'), 'bash ./claims.sh bd-a\n');
    writeFileSync(path.join(dir, 'claims.mjs'), "import { execFileSync } from 'node:child_process';\nexecFileSync('bd', ['update', process.argv[2], '--claim']);\n");
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts', 'claim.sh'), 'bd update "$ISSUE_ID" --claim\n');

    for (const cmd of ['bash claims.sh bd-a', 'sh ./claims.sh bd-a', './claims.sh bd-a', 'source claims.sh', 'bash outer.sh', 'node claims.mjs bd-a']) {
      assert.notEqual(bareClaimSegment(cmd, dir), null, cmd);
    }
    assert.notEqual(bareClaimSegment(`cd "${dir}" && bash claims.sh bd-a`, tmpdir()), null, 'a cd earlier in the command is followed');
    for (const cmd of ['bash clean.sh bd-a', 'bash scripts/claim.sh bd-a --claim-only', './scripts/claim.sh bd-a feat/x', 'bash missing.sh']) {
      assert.equal(bareClaimSegment(cmd, dir), null, cmd);
    }
    assert.equal(runHook('bash claims.sh bd-a', {}, dir).status, 2, 'the hook refuses the script end to end');
  });
});

test('the approved helper is THIS repository\'s file, not any path ending in scripts/claim.sh', () => {
  withDir((outside) => {
    withDir((repo) => {
      mkdirSync(path.join(repo, 'scripts'));
      mkdirSync(path.join(outside, 'scripts'));
      writeFileSync(path.join(repo, 'scripts', 'claim.sh'), 'bd update "$1" --claim\n');
      // A lookalike OUTSIDE the repository, holding a bare claim, must be scanned like any script.
      writeFileSync(path.join(outside, 'scripts', 'claim.sh'), 'bd update "$1" --claim\n');
      const lookalike = path.join(outside, 'scripts', 'claim.sh').replace(/\\/g, '/');
      assert.equal(bareClaimSegment('bash scripts/claim.sh bd-a', repo), null, 'the repository helper itself passes');
      assert.equal(bareClaimSegment(`bash ${lookalike} bd-a`, repo) !== null, true, 'an out-of-repo lookalike is refused');
      assert.equal(bareClaimSegment(`bash ${path.join(repo, 'scripts', 'claim.sh').replace(/\\/g, '/')} bd-a`, repo), null);
      // A configured helper that escapes the repository never matches.
      for (const bad of ['../x/scripts/claim.sh', '/abs/scripts/claim.sh']) {
        assert.equal(classifyScript(path.join(outside, 'scripts', 'claim.sh'), undefined, bad, repo).kind, 'text', bad);
      }
    });
  });
});

test('fail closed: an oversized script is refused as unverifiable, an ordinary clean one is allowed', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, 'big.sh'), 'echo hi\n' + '#'.repeat(MAX_SCRIPT_BYTES));
    writeFileSync(path.join(dir, 'foo.sh'), 'echo hi\n');
    const hit = scanCommand('bash big.sh', dir);
    assert.equal(hit?.kind, 'unverifiable');
    assert.match(hit.reason, /over 256 KB/);
    assert.equal(scanCommand('bash foo.sh', dir), null);
    assert.equal(scanCommand('bash missing.sh', dir), null, 'a confirmed ENOENT is absent');
    const r = runHook('bash big.sh', {}, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /could not resolve; use claim\.sh or the hatch/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_BARE_CLAIM=1/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CLAIM_STEAL=1/);
    assert.equal(runHook('AGENT_HOOKS_ALLOW_BARE_CLAIM=1 bash big.sh', {}, dir).status, 0, 'the inline hatch passes it');
  });
});

test('fail closed: a permission error (mocked fs) is unverifiable; an ENOENT is absent', () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const mock = (statCode, lstatCode = 'ENOENT') => ({
    statSync: () => {
      throw err(statCode);
    },
    lstatSync: () => {
      if (lstatCode) throw err(lstatCode);
      return {};
    },
    realpathSync: (f) => f,
    readFileSync: () => '',
  });
  assert.deepEqual(classifyScript('/x.sh', mock('EACCES')), { kind: 'unverifiable', reason: 'it cannot be read (EACCES)' });
  assert.deepEqual(classifyScript('/x.sh', mock('ENOENT')), { kind: 'absent' });
  assert.deepEqual(classifyScript('/x.sh', mock('ENOENT', null)), { kind: 'unverifiable', reason: 'it is a broken symlink' });
  const readFails = { ...mock('ENOENT'), statSync: () => ({ isFile: () => true, size: 10 }), readFileSync: () => { throw err('EACCES'); } };
  assert.equal(classifyScript('/x.sh', readFails).kind, 'unverifiable');
  assert.equal(scanCommand('bash /x.sh', '/', 0, mock('EPERM'))?.kind, 'unverifiable');
});

test('fail closed: a real chmod 000 script is unverifiable', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'chmod 000 cannot deny read here' : false }, () => {
  withDir((dir) => {
    const f = path.join(dir, 'locked.sh');
    writeFileSync(f, 'echo hi\n');
    chmodSync(f, 0o000);
    try {
      assert.equal(scanCommand('bash locked.sh', dir)?.kind, 'unverifiable');
    } finally {
      chmodSync(f, 0o644);
    }
  });
});

test('fail closed: a broken symlink is unverifiable', (t) => {
  withDir((dir) => {
    try {
      symlinkSync(path.join(dir, 'gone.sh'), path.join(dir, 'link.sh'));
    } catch {
      t.skip('this host cannot create a symlink');
      return;
    }
    const hit = scanCommand('bash link.sh', dir);
    assert.equal(hit?.kind, 'unverifiable');
    assert.match(hit.reason, /broken symlink/);
  });
});

test('fail closed: nesting past MAX_DEPTH is unverifiable; within it a claim is still a claim', () => {
  let deep = "bd update bd-x --claim";
  let shallow = deep;
  for (let i = 0; i < 6; i++) deep = `eval ${JSON.stringify(deep)}`;
  for (let i = 0; i < 2; i++) shallow = `eval ${JSON.stringify(shallow)}`;
  assert.equal(scanCommand(deep)?.kind, 'unverifiable');
  assert.match(scanCommand(deep).reason, /more than 4 deep/);
  assert.equal(scanCommand(shallow)?.kind, 'claim');
  let harmless = 'echo hi';
  for (let i = 0; i < 6; i++) harmless = `eval ${JSON.stringify(harmless)}`;
  assert.equal(scanCommand(harmless), null, 'past the depth cap, text that never mentions bd or a claim passes');
  let hinted = 'echo claim';
  for (let i = 0; i < 6; i++) hinted = `eval ${JSON.stringify(hinted)}`;
  assert.equal(scanCommand(hinted)?.kind, 'unverifiable', 'past the depth cap, a mention of a claim fails closed');
});

test('an untracked script whose COMMENTS explain claiming is not refused for nesting; a real claim in it still is', () => {
  withDir((dir) => {
    const nested = (inner) =>
      ['a=$(', ' b=$(', '  c=$(', '   d=$(', '    e=$(', inner, '    )', '   )', '  )', ' )', ')', ''].join('\n');
    const comment = '     # claim.sh claims a bead; a bare bd update --claim is refused elsewhere';
    writeFileSync(path.join(dir, 'documented.sh'), `${nested(`${comment}\n     echo hi`)}`);
    assert.equal(scanCommand('bash documented.sh --await x', dir, 0, undefined, topContext(process.env)), null);
    writeFileSync(path.join(dir, 'claims.sh'), `${nested(`${comment}\n     bd update bd-x --claim`)}`);
    assert.equal(
      scanCommand('bash claims.sh', dir, 0, undefined, topContext(process.env))?.kind,
      'unverifiable',
      'a real claim this deep still fails closed',
    );
    writeFileSync(path.join(dir, 'claims-shallow.sh'), `${comment.trim()}\nbd update bd-x --claim\n`);
    assert.equal(scanCommand('bash claims-shallow.sh', dir, 0, undefined, topContext(process.env))?.kind, 'claim');
  });
});

test('the agent\'s own command is never comment-stripped: a mention after # still counts', () => {
  let hinted = 'echo hi # claim';
  for (let i = 0; i < 6; i++) hinted = `eval ${JSON.stringify(hinted)}`;
  assert.equal(scanCommand(hinted)?.kind, 'unverifiable');
});

test('jsClaims: an args array or an exec string claims; a test naming a claim string does not', () => {
  assert.equal(jsClaims("execFileSync('bd', ['update', id, '--claim'])"), true);
  assert.equal(jsClaims("execSync('bd update bd-x --claim')"), true);
  assert.equal(jsClaims("const r = runHook('bd update bd-x --claim');"), false);
  assert.equal(jsClaims("//  execFileSync('bd', ['update', id, '--claim'])"), false);
  assert.equal(jsClaims(" * `bd update <id> --claim` -> exit 0"), false);
});

test('a claim whose call arguments span lines is still a claim, in a script and through the hook', () => {
  const multiline = "const { execFileSync } = require('node:child_process');\nexecFileSync('bd', [\n  'update',\n  id,\n  '--claim',\n]);\n";
  assert.equal(jsClaims(multiline), true);
  assert.equal(jsClaims("spawnSync(\n  'bd',\n  ['update', id, '--claim'],\n  { stdio: 'inherit' },\n);"), true);
  assert.equal(jsClaims("execSync(\n  'bd update ' + id + ' --claim'\n);"), false, 'a concatenated string is not a literal claim text');
  assert.equal(jsClaims("spawnSync('bd', [\n  'show',\n  id,\n]);\nconst flag = '--claim-only';"), false);
  withDir((dir) => {
    writeFileSync(path.join(dir, 'claimer.mjs'), multiline);
    assert.equal(scanCommand('node claimer.mjs', dir)?.kind, 'claim');
    assert.equal(runHook('node claimer.mjs', {}, dir).status, 2);
    assert.equal(runHook(`node -e "${multiline.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`, {}, dir).status, 2);
  });
});

test('a shebangless, extensionless text file run by path is read; a binary is not', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, 'claim-script'), 'bd update bd-x --claim\n');
    writeFileSync(path.join(dir, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]));
    writeFileSync(path.join(dir, 'blob'), Buffer.from('bd update bd-x --claim\0\0'));
    for (const cmd of ['./claim-script', 'bash ./claim-script', 'sh claim-script', 'source ./claim-script']) {
      assert.equal(scanCommand(cmd, dir)?.kind, 'claim', cmd);
    }
    assert.equal(runHook('./claim-script', {}, dir).status, 2);
    assert.equal(scanCommand('./tool --version', dir), null, 'an ELF binary is not read');
    assert.equal(scanCommand('./blob', dir), null, 'a file with NUL bytes is binary');
  });
});

test('a JS test file or this hook run by node is data, not a claim', () => {
  withDir((dir) => {
    const body = "hasInlineHatch(['bd', 'update', 'bd-1', '--claim'], 'X');\n";
    for (const name of ['x.node-test.mjs', 'x.test.js', 'x.spec.cjs', 'block-bare-claim.mjs']) writeFileSync(path.join(dir, name), body);
    writeFileSync(path.join(dir, 'real.mjs'), body);
    for (const name of ['x.node-test.mjs', 'x.test.js', 'x.spec.cjs', 'block-bare-claim.mjs']) {
      assert.equal(bareClaimSegment(`node --test ${name}`, dir), null, name);
    }
    assert.notEqual(bareClaimSegment('node real.mjs', dir), null);
  });
});

test('shellSegments keeps quoted words whole and collects substitutions', () => {
  const [seg] = shellSegments('git commit -m "a; b && c" && echo');
  assert.deepEqual(seg.words, ['git', 'commit', '-m', 'a; b && c']);
  const [sub] = shellSegments('echo "$(bd show X)" `date`');
  assert.deepEqual(sub.substitutions, ['bd show X', 'date']);
});

test('the hook refuses with exit 2, names claim.sh and the steal hatch, and carries the nothing-ran notice', () => {
  for (const cmd of ['bd update bd-6b2ai.1 --claim', "bash -c 'bd update bd-6b2ai.1 --claim'", 'eval bd update bd-x --claim']) {
    const r = runHook(cmd);
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /bash scripts\/claim\.sh <id> --claim-only/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CLAIM_STEAL=1/);
    assert.match(r.stderr, /NOTHING in this command ran/);
  }
});

test('the hatch works inline on the segment, inside a payload, and from the environment', () => {
  assert.equal(runHook(`${HATCH_VAR}=1 bd update bd-6b2ai.1 --claim`).status, 0);
  assert.equal(runHook(`bash -c '${HATCH_VAR}=1 bd update bd-6b2ai.1 --claim'`).status, 0);
  assert.equal(runHook('bd update bd-6b2ai.1 --claim', { [HATCH_VAR]: '1' }).status, 0);
});

test('fail closed: each unresolvable form is refused when the segment mentions bd or a claim', () => {
  const env = { ...process.env };
  delete env.CMD;
  delete env.SCRIPT;
  const ctx = () => topContext(env);
  const forms = [
    '$CMD update bd-x --claim',
    '${CMD} update bd-x --claim',
    '"$CMD" update bd-x --claim',
    '$(echo bd) update bd-x --claim',
    '`echo bd` update bd-x --claim',
    'bash "$SCRIPT" bd-x --claim',
    'eval "$CMD" # bd',
    'eval $(cat cmd.txt) # claim',
    'source "$SCRIPT" # bd',
    '. "$SCRIPT" # claim',
    `bash -c '$CMD update bd-x --claim'`,
    `bash -c "eval \\"\\$CMD\\" # bd"`,
    `node -e "require('node:child_process').execSync('$CMD update bd-x --claim')"`,
    `node -e "require('node:child_process').execSync(process.env.CMD)" # bd`,
    `python -c "import os; os.system(os.environ['CMD'])" # claim`,
  ];
  for (const cmd of forms) {
    const hit = scanCommand(cmd, process.cwd(), 0, undefined, ctx());
    assert.ok(hit, `refused: ${cmd}`);
    assert.ok(['unverifiable', 'claim'].includes(hit.kind), cmd);
  }
  const r = runHook('$AGENT_HOOKS_TEST_UNSET_CMD update bd-x --claim');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not resolve; use claim\.sh or the hatch/);
  assert.equal(runHook('$AGENT_HOOKS_TEST_UNSET_CMD update bd-x --claim', { [HATCH_VAR]: '1' }).status, 0);
});

test('unresolvable forms that never mention bd or a claim pass, as do claim.sh and bd reads', () => {
  for (const cmd of [
    'for f in a.sh b.sh; do bash -n "$f"; done',
    '$EDITOR notes.txt',
    'eval "$(ssh-agent -s)"',
    'source "$HOME/.profile"',
    'bash scripts/claim.sh bd-x --claim-only',
    'bash scripts/claim.sh bd-x feat/y',
    'AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bash scripts/claim.sh bd-x --claim-only',
    'bd show bd-x --json',
    'bd ready --exclude-label human-required',
    'X=bd; $X show bd-x',
    'A=$(node scripts/agent-actor-id.mjs) && \\\nID=$(bd create "t" --type task) && \\\r\nbd show "$ID"',
    `node -e "const m=/id: (\\w+)/.exec(s); console.log(m)" # bd`,
    `node -e "db.prepare('UPDATE x SET y=1').run()" # claim`,
    'bash scripts/gate.sh --name t node --test scripts/claim-age.node-test.mjs',
  ]) {
    assert.equal(scanCommand(cmd), null, cmd);
  }
});

test('a substitution with parens inside quotes is read whole', () => {
  assert.equal(scanCommand(`x="$(bd list --json | python -c 'import re; re.search(r"([^)]+)\\)", "")')"`), null);
  assert.equal(scanCommand(`x="$(echo ')' ; bd update bd-x --claim)"`)?.kind, 'claim');
});

// bash removes `\<newline>` before it splits words. A multi-line `&& \` chain is
// one ordinary command, never a script path named `\<newline>timeout`.
const BS = '\\';
const chain = (nl, claim = '') =>
  [`bd note bd-x "first note"`, `timeout 90 bd show bd-x --json`, ...(claim ? [claim] : []), `node scripts/oddity.mjs list`].join(
    ` && ${BS}${nl}  `,
  );

test('a multi-line && \\ chain of bd, timeout and node calls passes (LF and CRLF)', () => {
  for (const nl of ['\n', '\r\n']) {
    const cmd = chain(nl);
    assert.equal(scanCommand(cmd), null, JSON.stringify(cmd));
    const r = runHook(cmd);
    assert.equal(r.status, 0, `${JSON.stringify(cmd)}: ${r.stderr}`);
  }
});

test('the same multi-line chain with a bare claim inside is still refused (LF and CRLF)', () => {
  for (const nl of ['\n', '\r\n']) {
    const cmd = chain(nl, 'bd update bd-x --claim');
    const hit = scanCommand(cmd);
    assert.equal(hit?.kind, 'claim', JSON.stringify(cmd));
    assert.equal(hit.seg, 'bd update bd-x --claim');
    const r = runHook(cmd);
    assert.equal(r.status, 2, JSON.stringify(cmd));
    assert.match(r.stderr, /scripts\/claim\.sh/);
    // A continuation inside a word joins it, as bash does.
    assert.equal(scanCommand(`bd up${BS}${nl}date bd-x --cl${BS}${nl}aim`)?.kind, 'claim');
    // ...and inside double quotes it is removed too.
    assert.equal(scanCommand(`bash -c "bd update bd-x ${BS}${nl}--claim"`)?.kind, 'claim');
  }
});

test('an inline hatch on a continued line still applies (LF and CRLF)', () => {
  for (const nl of ['\n', '\r\n']) {
    assert.equal(scanCommand(chain(nl, `${HATCH_VAR}=1 bd update bd-x --claim`)), null);
    assert.equal(scanCommand(`${HATCH_VAR}=1 ${BS}${nl}  bd update bd-x --claim`), null);
  }
});

test('a backslash-newline inside single quotes is data, not a continuation', () => {
  for (const nl of ['\n', '\r\n']) {
    // The quoted text is an argument to echo: nothing in it runs.
    assert.equal(scanCommand(`echo 'line one ${BS}${nl}bd update bd-x --claim'`), null);
    // A single-quoted -c payload keeps its backslash, so the inner shell sees the continuation:
    // `echo hi bd update ...` is one echo, while a real newline there runs the claim.
    assert.equal(scanCommand(`bash -c 'echo hi ${BS}${nl}bd update bd-x --claim'`), null);
    assert.equal(scanCommand(`bash -c 'echo hi${nl}bd update bd-x --claim'`)?.kind, 'claim');
    const words = shellSegments(`printf '%s' 'a ${BS}${nl}b'`)[0].words;
    assert.equal(words[2], `a ${BS}${nl}b`);
  }
});

test('a command with no claim, and malformed input, pass', () => {
  assert.equal(runHook('npm run lint').status, 0);
  assert.equal(runHook('bd show bd-x --json').status, 0);
  const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

// ── agent-tooling.json: the claim helper is the consumer's, not a literal ──────────────
test('the refusal names the default claim helper when no agent-tooling.json exists', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, '.git'));
    const r = runHook('bd update bd-x --claim', {}, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /bash scripts\/claim\.sh <id> <branch>/);
    assert.match(r.stderr, /bash scripts\/claim\.sh <id> --claim-only/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_BARE_CLAIM=1/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bash scripts\/claim\.sh/);
  });
});

test('a configured claimHelper is what the refusal names, and the default path is not', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, 'agent-tooling.json'), JSON.stringify({ claimHelper: 'tools/claim.sh' }));
    const r = runHook('bd update bd-x --claim', {}, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /bash tools\/claim\.sh <id> <branch>/);
    assert.match(r.stderr, /bash tools\/claim\.sh <id> --claim-only/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bash tools\/claim\.sh/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_BARE_CLAIM=1/);
    assert.doesNotMatch(r.stderr, /scripts\/claim\.sh/);
  });
});

test('the unverifiable refusal also names the configured claimHelper and both hatches', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, 'agent-tooling.json'), JSON.stringify({ claimHelper: 'tools/claim.sh' }));
    const r = runHook('bd show bd-x; $UNSET_CMD update bd-x --claim', {}, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /use claim\.sh or the hatch/);
    assert.match(r.stderr, /bash tools\/claim\.sh <id> --claim-only/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_BARE_CLAIM=1/);
    assert.match(r.stderr, /AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bash tools\/claim\.sh/);
  });
});

test('the configured claim helper itself is allowed; the default path no longer is', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, '.git'));
    mkdirSync(path.join(dir, 'tools'));
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'agent-tooling.json'), JSON.stringify({ claimHelper: 'tools/claim.sh' }));
    writeFileSync(path.join(dir, 'tools', 'claim.sh'), 'bd update "$ISSUE_ID" --claim\n');
    writeFileSync(path.join(dir, 'scripts', 'claim.sh'), 'bd update "$ISSUE_ID" --claim\n');
    assert.equal(runHook('bash tools/claim.sh bd-x --claim-only', {}, dir).status, 0);
    assert.equal(runHook('bash scripts/claim.sh bd-x --claim-only', {}, dir).status, 2);
    // The same split through the exported API.
    const ctx = () => topContext(process.env, 'tools/claim.sh');
    assert.equal(scanCommand('bash tools/claim.sh bd-x', dir, 0, undefined, ctx()), null);
    assert.equal(scanCommand('bash scripts/claim.sh bd-x', dir, 0, undefined, ctx())?.kind, 'claim');
    assert.equal(classifyScript(path.join(dir, 'tools', 'claim.sh'), undefined, 'tools/claim.sh', dir).kind, 'allowed');
    assert.equal(classifyScript(path.join(dir, 'tools', 'claim.sh'), undefined, undefined, dir).kind, 'text');
    assert.equal(classifyScript(path.join(dir, 'tools', 'claim.sh'), undefined, 'tools/claim.sh').kind, 'text', 'no repository root, no approved helper');
  });
});

test('a broken agent-tooling.json fails open to the defaults and says so on stderr', () => {
  withDir((dir) => {
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, 'agent-tooling.json'), '{ "claimHelperr": "x" }');
    const r = runHook('bd update bd-x --claim', {}, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /agent-tooling config ignored/);
    assert.match(r.stderr, /bash scripts\/claim\.sh <id> --claim-only/);
  });
});
