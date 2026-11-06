#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) hook: block `npx <pkg>` (and `npm exec` / `npm x`) when
// <pkg> is not something this repo already has. Both shells: the incident command
// below is byte-identical under PowerShell (`npx.cmd` is what actually runs there), and
// PowerShell chains on the same `;` / `|` / `&&` separators the segment split below
// understands.
//
// Why: `npx` runs a package that is not installed by DOWNLOADING it, and under the
// Bash tool it does so without asking — stdin is not a TTY, and libnpmexec's
// `noTTY() || ciInfo.isCI` branch merely logs "will be installed" and proceeds
// (verified in npm 11.9.0's bundled libnpmexec/lib/index.js). There is no signal
// distinguishing "running the project's formatter" from "downloading a stranger's
// formatter and rewriting the project with it". On 2026-09-03 a worker
// ran `npx prettier --write` as a sanity check: the repo has NO prettier dependency
// (ESLint is the formatter), so npx fetched an unpinned prettier@3.9.6 and
// reformatted 895 lines of ui.test.tsx plus unrelated lines of Tooltip.tsx to
// 80-column defaults. Caught only by `git diff --stat` before committing
// in the diff review.
//
// What is allowed: a package that is a declared dependency (dependencies /
// devDependencies / optionalDependencies / peerDependencies of the nearest
// package.json), or that is already present under node_modules/<name>, or whose
// bin exists under node_modules/.bin/<name> (`npx tsc` → typescript, `npx next`,
// `npx playwright`) — none of those fetch anything. `--no-install` / `--no` forms
// are allowed too, since npx then refuses rather than fetches. No package.json in
// scope → not a repo → allowed.
//
// Escape hatch: AGENT_HOOKS_ALLOW_NPX_FETCH=1 for a deliberate one-off.
//
// Blocking contract: exit 2 + stderr message (fed back to the agent). Anything
// unexpected fails OPEN (exit 0) — this guard must never break Bash.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { readHookInput } from './hook-input.mjs';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';
import { segmentHasInlineHatch } from './inline-hatch.mjs';

const HATCH_VAR = 'AGENT_HOOKS_ALLOW_NPX_FETCH';

// `&` is PowerShell's call operator (`& npx prettier …`), a bare wrapper token there.
// The bash wrappers (sudo/nice/command/time/nohup/exec, …) come from wrapper-strip.mjs.
const EXTRA_WRAPPERS = ['&'];
// npx / npm-exec flags that consume the NEXT token.
const VALUE_FLAGS = new Set([
  '-p', '--package', '-c', '--call', '--shell', '--cache', '--userconfig', '--registry',
  '--loglevel', '--workspace', '-w', '--prefix', '-C',
]);

const PACKAGE_METADATA_ERROR = 'PACKAGE_METADATA_ERROR';

try {
  if (process.env[HATCH_VAR] === '1') process.exit(0);

  const input = readHookInput();
  // Case-insensitive, matching block-masked-gates: a harness casing change must not
  // fail this guard open silently — that is the class this guard exists to close.
  const toolName = String(input?.tool_name ?? '');
  if (toolName && !/^(bash|powershell)$/i.test(toolName)) process.exit(0);
  const cmd = input?.tool_input?.command ?? '';
  if (!/\bnp(x|m)\b/.test(cmd)) process.exit(0);

  const root = findPackageRoot(process.cwd());
  if (!root) process.exit(0);
  const declared = declaredDeps(root);

  for (const rawSeg of cmd.split(/&&|\|\||;|\|(?!\|)|\n/)) {
    const toks = stripGroupingParens(rawSeg.trim().split(/\s+/).filter(Boolean));
    const args = execArgs(toks);
    if (!args) continue;

    const { specs, noInstall } = parseExecArgs(args);
    if (noInstall) continue;

    const unresolved = specs.filter((spec) => !isLocal(spec, root, declared));
    if (unresolved.length === 0) continue;

    // Inline hatch, scoped to THIS segment only: an agent can
    // prefix the npx segment itself (`AGENT_HOOKS_ALLOW_NPX_FETCH=1 npx <pkg>`),
    // which this guard can see, but cannot reach process.env of the
    // PreToolUse hook process the way the old message asked.
    if (segmentHasInlineHatch(rawSeg, HATCH_VAR)) continue;

    const list = unresolved.map((s) => `\`${s}\``).join(', ');
    process.stderr.write(
      `Blocked: ${list} is not a dependency of this repo and is not present under node_modules, so npx ` +
        'would DOWNLOAD an unpinned version from the registry and run it — without a prompt, because stdin ' +
        "is not a TTY (libnpmexec auto-proceeds). On 2026-09-03 `npx prettier --write` fetched a stranger's " +
        'prettier and reformatted 895 lines of a test file to defaults this codebase does not use. ' +
        'Prefer a declared dependency or one of its bins (`npx jest`, `npx tsc`, `npx playwright`), or add the ' +
        `package to package.json deliberately. For a deliberate one-off, prefix the SAME command with ` +
        `\`${HATCH_VAR}=1\` (e.g. \`${HATCH_VAR}=1 npx ${specs[0] ?? '<pkg>'}\`) — that works inline, scoped to ` +
        `this one command; a session/harness env var works too. ${NOTHING_RAN_NOTICE}${consumerHint(import.meta.url)}`,
    );
    process.exit(2);
  }
} catch (error) {
  if (error instanceof Error && error.message === PACKAGE_METADATA_ERROR) throw error;
  process.exit(0);
}
process.exit(0);

// Tokens after `npx` / `npm exec` / `npm x`, skipping the usual leading wrappers
// and shell keywords (VAR=val, env [..], rtk [proxy], sudo/nice/..., timeout, do/then/…)
// via lib/wrapper-strip.mjs, plus PowerShell's `&` call operator. Null when the
// segment is not a package-exec invocation.
function execArgs(toks) {
  const i = skipCommandPrefix(toks, { extraWrappers: EXTRA_WRAPPERS });
  const t = toks[i];
  if (t === 'npx' || t === 'npx.cmd') return toks.slice(i + 1);
  if ((t === 'npm' || t === 'npm.cmd') && (toks[i + 1] === 'exec' || toks[i + 1] === 'x')) return toks.slice(i + 2);
  return null;
}

// The package specs npx would resolve: every `-p/--package` value, else the first
// positional. `--no-install`/`--no` means npx refuses instead of fetching.
function parseExecArgs(args) {
  const packages = [];
  let positional = null;
  let noInstall = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional = args[i + 1] ?? null;
      break;
    }
    if (a === '--no-install' || a === '--no') {
      noInstall = true;
      continue;
    }
    if (a === '-p' || a === '--package') {
      if (args[i + 1]) packages.push(args[i + 1]);
      i++;
      continue;
    }
    if (a.startsWith('--package=')) {
      packages.push(a.slice('--package='.length));
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional = a;
    break;
  }
  const specs = packages.length > 0 ? packages : positional ? [positional] : [];
  return { specs: specs.map(unquote), noInstall };
}

function unquote(s) {
  return s.replace(/^["']|["']$/g, '');
}

// `@scope/name@1.2.3` → `@scope/name`; `name@latest` → `name`. A URL / path / git
// spec has no registry name and can never be "already local".
function packageName(spec) {
  if (/^(\.|\/|[A-Za-z]:[\\/]|file:|github:|git\+|https?:)/.test(spec) || spec.includes('://')) return null;
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

function isLocal(spec, root, declared) {
  const name = packageName(spec);
  if (!name || !isSafePackageName(name)) return false;
  if (declared.has(name)) return true;
  const nm = path.join(root, 'node_modules');
  if (existsSync(path.join(nm, name, 'package.json'))) return true;
  const bin = path.join(nm, '.bin', name);
  return existsSync(bin) || existsSync(`${bin}.cmd`) || existsSync(`${bin}.ps1`);
}

function isSafePackageName(name) {
  return /^(?:@[^/\\]+\/[^/\\]+|[^/\\]+)$/.test(name) && name !== '.' && name !== '..';
}

function findPackageRoot(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function declaredDeps(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const names = new Set();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const k of Object.keys(pkg[field] ?? {})) names.add(k);
    }
    return names;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return new Set();
    throw new Error(PACKAGE_METADATA_ERROR, { cause: error });
  }
}
