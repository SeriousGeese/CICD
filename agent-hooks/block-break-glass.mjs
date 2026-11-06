#!/usr/bin/env node
// PreToolUse(Bash|PowerShell|Monitor, mcp__.*) hook: keep break-glass HUMAN-ONLY
// (a consumer may point at its own runbook through <guard>.hint.txt).
//
// Break-glass is a PR label, `break-glass`, that a person applies from the GitHub web UI or
// their own terminal to expedite ONE fix (an outage, a security fix, a broken main). Agents
// act through the same GitHub account, so GitHub identity cannot tell an agent's label from a
// human's. This guard is what makes the trigger human-only: it refuses any agent command that
// would
//   (a) ADD the label: `gh pr|issue edit --add-label break-glass` (also inside a comma list,
//       quoted, or `--add-label=`), `gh pr|issue create --label break-glass`, creating or
//       renaming a label to that name (`gh label create|edit`), and `gh api` writes to a
//       `/labels` endpoint or a `PATCH .../issues/<n>` whose payload names `break-glass`;
//   (b) set a repository variable (or secret) whose name starts with `BREAK_GLASS`
//       (`gh variable set`, `gh secret set`, or a `gh api` write to `.../variables`);
//   (c) merge past branch protection: `gh pr merge ... --admin`, any `gh api .../pulls/<n>/merge`
//       (whatever the method; `gh pr view --json mergedAt` is the read), and a GraphQL
//       `mergePullRequest` mutation;
//   (d) change a ruleset: any `gh api` POST/PUT/PATCH/DELETE on a `/rulesets` endpoint
//       and a GraphQL `*RepositoryRuleset` mutation. The `main` ruleset's empty bypass list is the
//       decision (a) to (c) rest on, and a person adds a temporary bypass by hand in an outage;
// and a `gh alias set` whose expansion carries any of the above, plus `bash|sh -c "<string>"`,
// which is judged recursively.
//
// Allowed: `--remove-label break-glass`, reading labels (`gh pr view --json labels`), a DELETE
// on a labels endpoint, reading a ruleset, and a plain `gh pr merge --squash` with or without
// `--match-head-commit`.
//
// NO ESCAPE HATCH, on purpose. Every other guard's hatch is a `AGENT_HOOKS_ALLOW_*` env var that
// works inline on the command (inline-hatch.mjs), which is a string any untrusted text (a PR
// body, an issue comment, a review finding) could tell an agent to prepend. A hatch here would
// make the human-only trigger agent-reachable again. The refusal tells the agent to ask the
// person, who follows the break-glass procedure.
//
// Honest limits (a consumer's runbook may repeat them): this runs only inside Claude Code sessions with this
// repo's current hooks; it parses command TEXT, so `node -e`, Python, `curl` with a token or a
// script that wraps `gh` pass it; and it fails OPEN on anything it cannot parse, like every other
// guard, so a parser bug never blocks unrelated work.
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything unexpected
// fails OPEN (exit 0).
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { readHookInput } from './hook-input.mjs';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';

export const BREAK_GLASS_LABEL = 'break-glass';
const LABEL_RE = /break-glass/i;
const VARIABLE_RE = /^break_glass/i;
const VARIABLE_ANYWHERE_RE = /break_glass/i;
const RULESET_ENDPOINT_RE = /(^|\/)rulesets(\/|$)/;
const RULESET_MUTATION_RE = /(create|update|delete)RepositoryRuleset/;
// PowerShell's call operator leads a segment like a wrapper word.
const EXTRA_WRAPPERS = ['&'];

/**
 * Split a shell command into segments of unquoted tokens. Quote-aware (single and double
 * quotes, backslash escapes outside single quotes), so a label list such as
 * `--add-label "bug, break-glass"` stays one token and a `;` inside a quoted body does not
 * start a new segment. Separators: `&&`, `||`, `;`, `|`, newline.
 * @param {string} cmd
 * @returns {string[][]}
 */
export function shellSegments(cmd) {
  const segments = [];
  let toks = [];
  let cur = '';
  let inTok = false;
  let quote = '';
  const endTok = () => {
    if (inTok) toks.push(cur);
    cur = '';
    inTok = false;
  };
  const endSeg = () => {
    endTok();
    if (toks.length) segments.push(toks);
    toks = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inTok = true;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      if (cmd[i + 1] === '\n') {
        i++;
        continue;
      }
      cur += cmd[++i];
      inTok = true;
      continue;
    }
    if (c === '\n' || c === ';') {
      endSeg();
      continue;
    }
    if (c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if (cmd[i + 1] === c) i++;
      endSeg();
      continue;
    }
    if (/\s/.test(c)) {
      endTok();
      continue;
    }
    cur += c;
    inTok = true;
  }
  endSeg();
  return segments;
}

/** Values of a long/short option: `--opt v`, `--opt=v`, and each listed short alias. */
function optionValues(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (names.includes(a)) {
      if (args[i + 1] !== undefined) out.push(args[i + 1]);
      i++;
      continue;
    }
    for (const n of names) {
      if (n.startsWith('--') && a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1));
    }
  }
  return out;
}

function namesBreakGlassLabel(values) {
  return values.some((v) =>
    String(v)
      .split(',')
      .some((part) => part.trim().toLowerCase() === BREAK_GLASS_LABEL),
  );
}

// gh flags that take a value and can precede the subcommand words.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

/** The first two non-flag words after `gh` (`pr merge`, `api <endpoint>` …) and the rest. */
function ghCommand(args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const a = args[i];
    if (GH_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    words.push(a);
  }
  return { group: words[0] ?? '', sub: words[1] ?? '' };
}

// `gh api` options that consume the next token.
const API_VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview',
]);
const API_FIELD_FLAGS = ['-f', '--raw-field', '-F', '--field'];

/** Parse the tokens after `gh api` into { endpoint, method, payload }. */
export function parseGhApi(args, { cwd = process.cwd() } = {}) {
  let endpoint = '';
  let method = '';
  let hasBody = false;
  const payload = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-X') && a.length > 2) {
      method = a.slice(2);
      continue;
    }
    if (a.startsWith('--method=')) {
      method = a.slice('--method='.length);
      continue;
    }
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (API_VALUE_FLAGS.has(flag)) {
      const value = flag === a ? args[++i] ?? '' : a.slice(eq + 1);
      if (flag === '-X' || flag === '--method') method = value;
      if (API_FIELD_FLAGS.includes(flag)) {
        hasBody = true;
        payload.push(value);
      }
      if (flag === '--input') {
        hasBody = true;
        payload.push(readInputFile(value, cwd));
      }
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!endpoint) endpoint = a;
  }
  if (!method) method = hasBody ? 'POST' : 'GET';
  return {
    endpoint: endpoint.replace(/^\/+/, '').replace(/[?#].*$/, ''),
    method: method.toUpperCase(),
    payload: payload.join('\n'),
  };
}

// Best effort: a `--input <file>` body is judged by its content when the file is readable.
// stdin (`-`) and an unreadable file are unknown, and unknown fails open.
function readInputFile(file, cwd) {
  if (!file || file === '-') return '';
  try {
    return readFileSync(path.resolve(cwd, file), 'utf8');
  } catch {
    return '';
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** The reason a `gh api` call is refused, or null. */
function judgeGhApi(args, ctx) {
  const { endpoint, method, payload } = parseGhApi(args, ctx);
  if (/(^|\/)pulls\/[^/]+\/merge\/?$/.test(endpoint)) return 'merge';
  if (endpoint === 'graphql') {
    if (/mergePullRequest/.test(payload)) return 'merge';
    if (/\bmutation\b/.test(payload) && RULESET_MUTATION_RE.test(payload)) return 'ruleset';
    if (/\bmutation\b/.test(payload) && LABEL_RE.test(payload)) return 'label';
    if (/\bmutation\b/.test(payload) && VARIABLE_ANYWHERE_RE.test(payload)) return 'variable';
    return null;
  }
  if (RULESET_ENDPOINT_RE.test(endpoint) && method !== 'GET') return 'ruleset';
  if (!WRITE_METHODS.has(method)) return null;
  if (/(^|\/)labels(\/[^/]+)?\/?$/.test(endpoint) && LABEL_RE.test(payload)) return 'label';
  if (/(^|\/)(issues|pulls)\/[^/]+\/?$/.test(endpoint) && LABEL_RE.test(payload)) return 'label';
  if (/(^|\/)(variables|secrets)(\/|$)/.test(endpoint) && VARIABLE_ANYWHERE_RE.test(`${endpoint}\n${payload}`)) {
    return 'variable';
  }
  return null;
}

/**
 * Judge the tokens after `gh`. Returns 'label' | 'variable' | 'merge' | 'ruleset' | 'alias' | null.
 * @param {string[]} args
 * @param {{ cwd?: string }} [ctx]
 */
export function judgeGh(args, ctx = {}) {
  const { group, sub } = ghCommand(args);
  if (group === 'api') return judgeGhApi(args.slice(args.indexOf('api') + 1), ctx);
  if ((group === 'pr' || group === 'issue') && sub === 'edit') {
    if (namesBreakGlassLabel(optionValues(args, ['--add-label']))) return 'label';
  }
  if ((group === 'pr' || group === 'issue') && sub === 'create') {
    if (namesBreakGlassLabel(optionValues(args, ['--label', '-l']))) return 'label';
  }
  if (group === 'label' && (sub === 'create' || sub === 'clone')) {
    if (namesBreakGlassLabel(args.slice(args.indexOf(sub) + 1).filter((a) => !a.startsWith('-')).slice(0, 1))) {
      return 'label';
    }
  }
  if (group === 'label' && sub === 'edit') {
    if (namesBreakGlassLabel(optionValues(args, ['--name', '-n']))) return 'label';
  }
  if ((group === 'variable' || group === 'secret') && sub === 'set') {
    const name = args.slice(args.indexOf(sub) + 1).find((a) => !a.startsWith('-')) ?? '';
    if (VARIABLE_RE.test(name)) return 'variable';
  }
  if (group === 'pr' && sub === 'merge') {
    if (args.some((a) => a === '--admin' || a.startsWith('--admin='))) return 'merge';
  }
  if (group === 'alias' && sub === 'set') {
    const expansion = args.slice(args.indexOf(sub) + 1).join(' ');
    if (/--admin\b|rulesets/.test(expansion) || LABEL_RE.test(expansion) || VARIABLE_ANYWHERE_RE.test(expansion)) {
      return 'alias';
    }
  }
  return null;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell']);

/**
 * Judge a whole shell command string. Returns the first refusal reason, or null.
 * @param {string} cmd
 * @param {{ cwd?: string, depth?: number }} [ctx]
 */
export function judgeCommand(cmd, ctx = {}) {
  const depth = ctx.depth ?? 0;
  if (!cmd || depth > 3) return null;
  // Cheap pre-filter: nothing here can matter without one of these words.
  if (!/\bgh\b|gh\.exe/i.test(cmd)) return null;
  for (const raw of shellSegments(cmd)) {
    const toks = stripGroupingParens(raw);
    const i = skipCommandPrefix(toks, { skipCd: true, extraWrappers: EXTRA_WRAPPERS });
    const word = toks[i];
    if (!word) continue;
    const base = path.basename(word).toLowerCase();
    if (base === 'gh' || base === 'gh.exe') {
      const reason = judgeGh(toks.slice(i + 1), ctx);
      if (reason) return reason;
      continue;
    }
    if (SHELLS.has(base.replace(/\.exe$/, ''))) {
      const c = toks.findIndex((t, k) => k > i && /^-(c|Command)$/i.test(t));
      if (c > 0 && toks[c + 1]) {
        const reason = judgeCommand(toks[c + 1], { ...ctx, depth: depth + 1 });
        if (reason) return reason;
      }
    }
  }
  return null;
}

/**
 * Judge an MCP tool call (inert today: no GitHub MCP server is registered). Reads the
 * conventional GitHub MCP fields: `labels`, `merge_method`, and a variable `name`.
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 */
export function judgeMcp(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName);
  if ('merge_method' in input || /merge_pull_request|merge_pr\b/i.test(name)) return 'merge';
  const labels = input.labels ?? input.label;
  const list = Array.isArray(labels) ? labels : labels === undefined ? [] : [labels];
  const labelNames = list.map((l) => (l && typeof l === 'object' ? l.name : l)).filter((l) => l !== undefined);
  if (!/remove/i.test(name) && namesBreakGlassLabel(labelNames.map(String))) return 'label';
  if (/variable|secret/i.test(name) && VARIABLE_RE.test(String(input.name ?? input.variable_name ?? ''))) {
    return 'variable';
  }
  return null;
}

/**
 * Judge a full PreToolUse payload.
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown> }} payload
 * @param {{ cwd?: string }} [ctx]
 */
export function decide(payload, ctx = {}) {
  const toolName = String(payload?.tool_name ?? '');
  const toolInput = payload?.tool_input ?? {};
  if (/^mcp__/i.test(toolName)) return judgeMcp(toolName, toolInput);
  if (toolName && !/^(bash|powershell|monitor)$/i.test(toolName)) return null;
  return judgeCommand(String(toolInput?.command ?? ''), ctx);
}

const WHAT = {
  label: `adds the \`${BREAK_GLASS_LABEL}\` label (or creates a label by that name)`,
  variable: 'sets a `BREAK_GLASS*` repository variable or secret',
  merge:
    'merges past branch protection (`gh pr merge --admin`, `gh api .../pulls/<n>/merge`, or a GraphQL ' +
    '`mergePullRequest`). A normal merge is `env -u GITHUB_TOKEN gh pr merge --auto <n> --repo <owner>/<repo>`: ' +
    'a green required check puts the PR in the merge queue, which sets the merge method. This guard allows that',
  ruleset: 'changes a repository ruleset, which decides what can pass the required checks and who can bypass it',
  alias: 'defines a `gh` alias that would do one of the break-glass actions',
};

export function refusal(reason) {
  return (
    `Blocked: this command ${WHAT[reason] ?? WHAT.label}. Break-glass is HUMAN-ONLY: a person ` +
    'applies it from the GitHub web UI or their own terminal, after reading the diff themselves. This guard ' +
    'has NO escape hatch on purpose: every other hatch is an env var written on the command line, which is ' +
    'exactly what untrusted text (a PR body, a comment, a review finding) could tell an agent to prepend. Do ' +
    `not look for a way around it: ask the person, who follows the break-glass procedure. ${NOTHING_RAN_NOTICE}${consumerHint(import.meta.url)}`
  );
}

function main() {
  try {
    const reason = decide(readHookInput(), { cwd: process.cwd() });
    if (!reason) return 0;
    process.stderr.write(refusal(reason));
    return 2;
  } catch {
    return 0;
  }
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main();
