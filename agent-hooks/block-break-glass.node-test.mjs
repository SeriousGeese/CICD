#!/usr/bin/env node
// block-break-glass.mjs : the guard that keeps the `break-glass` label,
// BREAK_GLASS* variables and admin merges human-only. Every case runs the real hook as a
// subprocess with a PreToolUse payload on stdin, the way Claude Code invokes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTempDir } from './test-cleanup.mjs';
import { shellSegments, parseGhApi, decide } from './block-break-glass.mjs';

const hook = fileURLToPath(new URL('./block-break-glass.mjs', import.meta.url));

/** @param {object} payload @param {{ cwd?: string, env?: Record<string, string> }} [opts] */
function runPayload(payload, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}

function runCmd(command, toolName = 'Bash', opts = {}) {
  return runPayload({ tool_name: toolName, tool_input: { command } }, opts);
}

const BLOCKED = /HUMAN-ONLY/;

const BLOCKED_COMMANDS = [
  // (a) adding the label
  'gh pr edit 5 --add-label break-glass',
  'gh pr edit 5 --repo acme/widgets --add-label break-glass',
  'gh issue edit 7 --add-label break-glass',
  'gh pr edit 5 --add-label bug,break-glass',
  'gh pr edit 5 --add-label "bug, break-glass"',
  "gh pr edit 5 --add-label 'break-glass'",
  'gh pr edit 5 --add-label=break-glass',
  'gh pr edit 5 --add-label Break-Glass',
  'gh pr create --title x --body-file b.md --label break-glass',
  'gh issue create -t x -l break-glass',
  'gh label create break-glass --color B60205',
  'gh label edit old --name break-glass',
  'gh api repos/acme/widgets/issues/5/labels -f "labels[]=break-glass"',
  'gh api -X POST /repos/acme/widgets/issues/5/labels -f labels[]=break-glass',
  'gh api --method PUT repos/o/r/issues/5/labels -f labels[]=break-glass',
  'gh api repos/o/r/labels -f name=break-glass -f color=B60205',
  'gh api -X PATCH repos/o/r/issues/5 -f labels[]=break-glass',
  'gh api graphql -f query="mutation { createLabel(input:{name:\\"break-glass\\"}) { label { id } } }"',
  // (b) BREAK_GLASS variables
  'gh variable set BREAK_GLASS_PR --body 5',
  'gh variable set break_glass --repo acme/widgets --body 1',
  'gh secret set BREAK_GLASS_TOKEN --body x',
  'gh api -X PUT repos/o/r/actions/variables/BREAK_GLASS -f value=1',
  'gh api repos/o/r/actions/variables -f name=BREAK_GLASS_PR -f value=5',
  // (c) merging past protection
  'gh pr merge 5 --squash --admin',
  'gh pr merge 5 --admin --squash --match-head-commit abc123',
  'gh pr merge --admin=true 5',
  'gh api -X PUT repos/acme/widgets/pulls/5/merge',
  'gh api repos/acme/widgets/pulls/5/merge -f merge_method=squash',
  'gh api /repos/o/r/pulls/5/merge',
  'gh api graphql -f query="mutation { mergePullRequest(input:{pullRequestId:\\"x\\"}) { clientMutationId } }"',
  // (d) changing a ruleset 
  'gh api -X PUT repos/acme/widgets/rulesets/25759788 --input ruleset.json',
  'gh api --method PATCH /repos/o/r/rulesets/25759788 -f name=x',
  'gh api repos/o/r/rulesets -f name=x',
  'gh api -X DELETE repos/o/r/rulesets/25759788',
  'gh api orgs/o/rulesets -f name=x',
  'gh api graphql -f query="mutation { updateRepositoryRuleset(input:{}) { clientMutationId } }"',
  "gh alias set r 'api -X PUT repos/o/r/rulesets/1'",
  // aliases and nested shells
  "gh alias set m 'pr merge --admin'",
  'bash -c "gh pr merge 5 --admin"',
  // wrapper forms
  'env -u GITHUB_TOKEN gh pr merge 5 --repo acme/widgets --squash --admin',
  'timeout 30 gh pr edit 5 --add-label break-glass',
  'rtk proxy gh pr merge 5 --admin',
  'rtk gh pr edit 5 --add-label break-glass',
  'cd /tmp && gh pr edit 5 --add-label break-glass',
  'git fetch origin; gh pr merge 5 --squash --admin',
  'echo ok && (gh pr merge 5 --admin)',
  '/usr/bin/gh pr merge 5 --admin',
  'GH_REPO=acme/widgets gh pr merge 5 --admin',
  'for n in 5 6; do gh pr merge $n --admin; done',
];

const ALLOWED_COMMANDS = [
  'gh pr edit 5 --remove-label break-glass',
  'gh issue edit 7 --remove-label break-glass',
  'gh pr view 5 --json labels',
  'gh pr view 5 --json labels --jq ".labels[].name"',
  'gh label list --search break-glass',
  'gh pr merge 5 --squash',
  'env -u GITHUB_TOKEN gh pr merge 5 --repo acme/widgets --squash --match-head-commit abc123',
  'gh pr merge 5 --squash --auto',
  'gh pr edit 5 --add-label bug',
  'gh pr edit 5 --add-label break-glass-followup',
  'gh api repos/acme/widgets/issues/5/labels',
  'gh api -X DELETE repos/acme/widgets/issues/5/labels/break-glass',
  'gh api repos/o/r/pulls/5',
  'gh api repos/o/r/actions/variables',
  'gh api repos/acme/widgets/rulesets/25759788',
  "env -u GITHUB_TOKEN gh api repos/acme/widgets/rulesets/25759788 --jq '.bypass_actors'",
  'gh api repos/o/r/rulesets',
  'gh api graphql -f query="query { repository(owner:\\"o\\",name:\\"r\\") { rulesets(first:5) { nodes { id } } } }"',
  'gh variable set OTHER_THING --body 1',
  'gh variable list',
  'gh pr comment 5 --body "Break-glass: stage is down; a person runs gh pr merge 5 --admin"',
  'gh pr create --draft --body-file .tmp-gates/pr-body.md',
  'git log --oneline -5',
  'npm run test:hooks',
  'echo gh pr merge --admin',
];

for (const command of BLOCKED_COMMANDS) {
  test(`blocks: ${command}`, () => {
    const r = runCmd(command);
    assert.equal(r.status, 2, `expected a block; stderr:\n${r.stderr}`);
    assert.match(r.stderr, BLOCKED);
    assert.match(r.stderr, /NOTHING in this command ran/);
    assert.match(r.stderr, /break-glass procedure/);
  });
}

for (const command of ALLOWED_COMMANDS) {
  test(`allows: ${command}`, () => {
    const r = runCmd(command);
    assert.equal(r.status, 0, `expected no block; stderr:\n${r.stderr}`);
    assert.equal(r.stderr, '');
  });
}

test('applies to the PowerShell and Monitor tools too', () => {
  assert.equal(runCmd('gh pr merge 5 --admin', 'PowerShell').status, 2);
  assert.equal(runCmd('& gh pr edit 5 --add-label break-glass', 'PowerShell').status, 2);
  assert.equal(runCmd('pwsh -Command "gh pr merge 5 --admin"', 'PowerShell').status, 2);
  assert.equal(runCmd('gh pr merge 5 --admin', 'Monitor').status, 2);
  assert.equal(runCmd('gh pr merge 5 --squash', 'PowerShell').status, 0);
});

test('a payload with no tool_name is judged as a shell command', () => {
  assert.equal(runPayload({ tool_input: { command: 'gh pr merge 5 --admin' } }).status, 2);
});

test('ignores tools it is not about (a Write whose content mentions the commands)', () => {
  const r = runPayload({
    tool_name: 'Write',
    tool_input: { file_path: 'docs/x.md', content: 'gh pr merge 5 --admin', command: 'gh pr merge 5 --admin' },
  });
  assert.equal(r.status, 0);
});

test('has NO escape hatch: no AGENT_HOOKS_ALLOW_* variable, in the env or inline, lets it through', () => {
  for (const name of ['AGENT_HOOKS_ALLOW_BREAK_GLASS', 'AGENT_HOOKS_ALLOW_ADMIN_MERGE', 'AGENT_HOOKS_ALLOW_CLAIM_STEAL']) {
    assert.equal(runCmd('gh pr merge 5 --admin', 'Bash', { env: { [name]: '1' } }).status, 2, `${name} in env`);
    assert.equal(runCmd(`${name}=1 gh pr merge 5 --admin`).status, 2, `${name} inline`);
    assert.equal(runCmd(`env ${name}=1 gh pr edit 5 --add-label break-glass`).status, 2, `env ${name} inline`);
  }
});

test('the refusal says why there is no hatch and tells the agent to ask the person', () => {
  const r = runCmd('gh pr edit 5 --add-label break-glass');
  assert.match(r.stderr, /NO escape hatch on purpose/);
  assert.match(r.stderr, /ask the person/);
  const m = runCmd('gh pr merge 5 --squash --admin');
  // The allowed path arms the merge queue, with no merge method .
  assert.match(m.stderr, /gh pr merge --auto <n>/, 'the merge refusal names the allowed plain merge');
  assert.match(m.stderr, /merge queue/);
});

test('a gh api --input body is judged by its content when the file is readable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hooks-break-glass-'));
  try {
    writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({ labels: ['break-glass'] }));
    writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ labels: ['bug'] }));
    assert.equal(runCmd('gh api repos/o/r/issues/5/labels --input labels.json', 'Bash', { cwd: dir }).status, 2);
    assert.equal(runCmd('gh api repos/o/r/issues/5/labels --input other.json', 'Bash', { cwd: dir }).status, 0);
    assert.equal(runCmd('gh api repos/o/r/issues/5/labels --input missing.json', 'Bash', { cwd: dir }).status, 0);
  } finally {
    removeTempDir(dir, 'block-break-glass.node-test');
  }
});

// ── MCP branch (inert today: no GitHub MCP server is registered) ─────────────────────
test('MCP: adding the label through a GitHub-style tool is blocked', () => {
  const add = { tool_name: 'mcp__github__add_labels', tool_input: { issue_number: 5, labels: ['bug', 'break-glass'] } };
  assert.equal(runPayload(add).status, 2);
  const update = { tool_name: 'mcp__github__update_issue', tool_input: { issue_number: 5, labels: 'break-glass' } };
  assert.equal(runPayload(update).status, 2);
  const objs = { tool_name: 'mcp__github__update_issue', tool_input: { labels: [{ name: 'Break-Glass' }] } };
  assert.equal(runPayload(objs).status, 2);
});

test('MCP: a merge or a BREAK_GLASS variable is blocked; removal and unrelated tools pass', () => {
  assert.equal(
    runPayload({ tool_name: 'mcp__github__merge_pull_request', tool_input: { pull_number: 5, merge_method: 'squash' } })
      .status,
    2,
  );
  assert.equal(
    runPayload({ tool_name: 'mcp__github__set_variable', tool_input: { name: 'BREAK_GLASS_PR', value: '5' } }).status,
    2,
  );
  assert.equal(
    runPayload({ tool_name: 'mcp__github__remove_label', tool_input: { issue_number: 5, labels: ['break-glass'] } })
      .status,
    0,
  );
  assert.equal(runPayload({ tool_name: 'mcp__github__get_pull_request', tool_input: { pull_number: 5 } }).status, 0);
  assert.equal(
    runPayload({ tool_name: 'mcp__chrome-devtools__click', tool_input: { uid: 'x' } }).status,
    0,
    'an unrelated MCP tool is untouched',
  );
});

// ── Fail-open ───────────────────────────────────────────────────────────────
test('fails OPEN on unparseable or empty input', () => {
  assert.equal(runPayload('not json').status, 0);
  assert.equal(runPayload('').status, 0);
  assert.equal(runPayload({}).status, 0);
  assert.equal(runPayload({ tool_name: 'Bash', tool_input: {} }).status, 0);
  assert.equal(runPayload({ tool_name: 'Bash', tool_input: { command: 42 } }).status, 0);
});

// ── Pure helpers ────────────────────────────────────────────────────────────
test('shellSegments keeps quoted text together and splits on unquoted separators', () => {
  assert.deepEqual(shellSegments('a "b; c" && d | e; f'), [['a', 'b; c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(shellSegments("x --add-label 'bug, break-glass'"), [['x', '--add-label', 'bug, break-glass']]);
  assert.deepEqual(shellSegments('a || b\nc'), [['a'], ['b'], ['c']]);
});

test('parseGhApi infers POST from fields and reads an explicit method', () => {
  assert.deepEqual(parseGhApi(['repos/o/r/issues/5/labels', '-f', 'labels[]=x']), {
    endpoint: 'repos/o/r/issues/5/labels',
    method: 'POST',
    payload: 'labels[]=x',
  });
  assert.equal(parseGhApi(['-XDELETE', '/repos/o/r/issues/5/labels/x']).method, 'DELETE');
  assert.equal(parseGhApi(['--method=patch', 'repos/o/r/issues/5']).method, 'PATCH');
  assert.equal(parseGhApi(['repos/o/r/pulls/5?per_page=1']).endpoint, 'repos/o/r/pulls/5');
});

test('decide() agrees with the hook', () => {
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --admin' } }), 'merge');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash' } }), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'gh variable set BREAK_GLASS --body 1' } }), 'variable');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'gh pr edit 5 --add-label break-glass' } }), 'label');
});

test('a consumer break-glass.hint.txt is appended to the refusal, and the guard still has no hatch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hooks-break-glass-hint-'));
  try {
    const here = path.dirname(hook);
    for (const f of ['block-break-glass.mjs', 'refusal-notice.mjs', 'hook-input.mjs', 'wrapper-strip.mjs']) {
      copyFileSync(path.join(here, f), path.join(dir, f));
    }
    writeFileSync(path.join(dir, 'block-break-glass.hint.txt'), 'Runbook: docs/ops/break-glass.md\n');
    const r = spawnSync(process.execPath, [path.join(dir, 'block-break-glass.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr edit 5 --add-label break-glass' } }),
      encoding: 'utf8',
      env: { ...process.env, AGENT_HOOKS_ALLOW_BREAK_GLASS: '1' },
    });
    assert.equal(r.status, 2, 'no env var lifts this guard');
    assert.match(r.stderr, /Runbook: docs\/ops\/break-glass\.md/);
  } finally {
    removeTempDir(dir, 'block-break-glass.node-test');
  }
});
