// Vendor the shared Claude Code guard set into a consumer repository, pinned by SHA.
//
//   node <hooks-dir>/sync.mjs --into <repo> --ref <40-hex CICD sha> [--env-prefix ACME_]
//   node <hooks-dir>/sync.mjs --into <repo> --check
//
// Why vendoring, not a GitHub Action: Claude Code hooks run LOCALLY, from
// `.claude/settings.json`, resolved against the session's working directory. A composite
// action only exists inside a GitHub Actions run, so the files have to be on disk in the
// consumer's own tree — and a hook must not import from outside that tree, because a git
// worktree carries the hook files it was cut with. So the distribution unit is a copy, and
// the pin is a commit SHA, the same way this repository's actions are consumed.
//
// What it does:
//   - reads agent-hooks/manifest.json at --ref, then every file it lists;
//   - rewrites the neutral `AGENT_HOOKS_` escape-hatch prefix to --env-prefix, so a consumer
//     keeps the names its docs already teach (`ACME_ALLOW_DOUBLE_BACKSLASH`, …);
//   - writes them into <repo>/<hooks-dir> (default scripts/hooks) with LF endings, deletes
//     files an earlier sync vendored that the manifest no longer lists, and records the ref,
//     prefix and file list in <hooks-dir>/CICD-HOOKS-SHA;
//   - `--check` re-derives every recorded file from the recorded ref and prefix and exits 1
//     naming each one that was edited, deleted, or is missing — run it in the consumer's CI
//     so a local edit to a vendored guard cannot drift silently.
//
// Source: raw.githubusercontent.com (this repository is public, so no token is needed), or
// `--from <local CICD checkout>` to read the ref with `git show` instead (offline, and tests).
// `<guard>.hint.txt` files are the consumer's own and are never read, written or checked.
//
// Dependency-free on purpose: a consumer with no package.json runs this with plain `node`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'SeriousGeese/CICD';
export const SOURCE_DIR = 'agent-hooks';
export const SHA_FILE = 'CICD-HOOKS-SHA';
// Assembled, never written as one literal: this file is itself vendored through transform(),
// and a literal here would be rewritten to the consumer's prefix, after which the consumer's
// copy could no longer recognise (or re-derive) the source text it checks against.
export const NEUTRAL_PREFIX = ['AGENT', 'HOOKS', ''].join('_');
const NEUTRAL_PREFIX_RE = new RegExp(String.raw`\b${NEUTRAL_PREFIX}`, 'g');

const USAGE =
  'usage: node sync.mjs --into <repo> --ref <40-hex sha> [--env-prefix PREFIX_] [--hooks-dir scripts/hooks] [--from <cicd checkout>]\n' +
  '       node sync.mjs --into <repo> --check [--hooks-dir scripts/hooks] [--from <cicd checkout>]\n';

/**
 * @param {string[]} argv
 * @returns {{ into?: string, ref?: string, envPrefix: string, hooksDir: string, from?: string, check: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ into?: string, ref?: string, envPrefix: string, hooksDir: string, from?: string, check: boolean }} */
  const out = { envPrefix: NEUTRAL_PREFIX, hooksDir: 'scripts/hooks', check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--into') out.into = next();
    else if (a === '--ref') out.ref = next();
    else if (a === '--env-prefix') out.envPrefix = next();
    else if (a === '--hooks-dir') out.hooksDir = next();
    else if (a === '--from') out.from = next();
    else if (a === '--check') out.check = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** A full commit SHA. A branch or tag is a mutable pointer and is refused. */
export function isPinnedRef(ref) {
  return /^[0-9a-f]{40}$/.test(String(ref));
}

/** An env-var prefix: upper-case identifier ending in `_`. */
export function isEnvPrefix(prefix) {
  return /^[A-Z][A-Z0-9_]*_$/.test(String(prefix));
}

/**
 * The exact bytes a consumer should have for one vendored file.
 * @param {string} text source text at the ref
 * @param {string} envPrefix
 */
export function transform(text, envPrefix) {
  const lf = text.replace(/\r\n/g, '\n');
  return envPrefix === NEUTRAL_PREFIX ? lf : lf.replace(NEUTRAL_PREFIX_RE, envPrefix);
}

/** @param {{ ref: string, envPrefix: string, files: string[] }} rec */
export function formatShaFile(rec) {
  return [
    `# Vendored from ${REPO} ${SOURCE_DIR}/ by sync.mjs. Do not edit these files here:`,
    '# change them in CICD, then re-run sync with the new ref. `sync.mjs --check` fails on drift.',
    `ref: ${rec.ref}`,
    `env-prefix: ${rec.envPrefix}`,
    'files:',
    ...rec.files.map((f) => `  ${f}`),
    '',
  ].join('\n');
}

/** @param {string} text */
export function parseShaFile(text) {
  const ref = /^ref:\s*(\S+)\s*$/m.exec(text)?.[1];
  const envPrefix = /^env-prefix:\s*(\S+)\s*$/m.exec(text)?.[1];
  const block = /^files:\s*\n([\s\S]*)$/m.exec(text)?.[1] ?? '';
  const files = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!ref || !envPrefix) throw new Error(`${SHA_FILE} is missing its ref or env-prefix line`);
  return { ref, envPrefix, files };
}

/** A manifest entry must be a bare filename — never a path that could escape the hooks dir. */
export function isSafeFileName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name)) && !String(name).includes('..');
}

/**
 * Read `agent-hooks/<name>` at `ref`.
 * @param {string} ref
 * @param {string} name
 * @param {string | undefined} from
 * @returns {Promise<string>}
 */
async function readAtRef(ref, name, from) {
  if (from) {
    return execFileSync('git', ['-C', from, 'show', `${ref}:${SOURCE_DIR}/${name}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${SOURCE_DIR}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

/**
 * The manifest file list at `ref`, validated.
 * @param {string} ref
 * @param {string | undefined} from
 * @returns {Promise<string[]>}
 */
async function manifestAt(ref, from) {
  const files = JSON.parse(await readAtRef(ref, 'manifest.json', from))?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error(`manifest.json at ${ref} lists no files`);
  for (const f of files) if (!isSafeFileName(f)) throw new Error(`manifest.json at ${ref} lists an unsafe name: ${f}`);
  return files;
}

/**
 * @param {{ into: string, ref: string, envPrefix: string, hooksDir: string, from?: string }} opts
 * @returns {Promise<string[]>} the files written
 */
export async function sync(opts) {
  const dest = path.resolve(opts.into, opts.hooksDir);
  const files = await manifestAt(opts.ref, opts.from);
  const contents = await Promise.all(files.map(async (f) => transform(await readAtRef(opts.ref, f, opts.from), opts.envPrefix)));

  const shaPath = path.join(dest, SHA_FILE);
  const previous = existsSync(shaPath) ? parseShaFile(readFileSync(shaPath, 'utf8')).files : [];

  mkdirSync(dest, { recursive: true });
  files.forEach((f, i) => writeFileSync(path.join(dest, f), contents[i]));
  for (const stale of previous) {
    if (!files.includes(stale) && isSafeFileName(stale)) rmSync(path.join(dest, stale), { force: true });
  }
  writeFileSync(shaPath, formatShaFile({ ref: opts.ref, envPrefix: opts.envPrefix, files }));
  return files;
}

/**
 * @param {{ into: string, hooksDir: string, from?: string }} opts
 * @returns {Promise<string[]>} one line per problem; empty when the vendored copy is exact
 */
export async function check(opts) {
  const dest = path.resolve(opts.into, opts.hooksDir);
  const shaPath = path.join(dest, SHA_FILE);
  if (!existsSync(shaPath)) return [`${path.join(opts.hooksDir, SHA_FILE)} is missing — nothing records what was vendored`];
  const rec = parseShaFile(readFileSync(shaPath, 'utf8'));
  const problems = [];
  const manifest = await manifestAt(rec.ref, opts.from);
  if (manifest.join('\n') !== rec.files.join('\n')) {
    problems.push(`${SHA_FILE} file list does not match manifest.json at ${rec.ref} — re-run sync`);
  }
  for (const f of manifest) {
    const local = path.join(dest, f);
    if (!existsSync(local)) {
      problems.push(`${path.join(opts.hooksDir, f)}: missing`);
      continue;
    }
    const want = transform(await readAtRef(rec.ref, f, opts.from), rec.envPrefix);
    const have = readFileSync(local, 'utf8').replace(/\r\n/g, '\n');
    if (have !== want) problems.push(`${path.join(opts.hooksDir, f)}: differs from ${REPO}@${rec.ref.slice(0, 12)}`);
  }
  return problems;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`sync.mjs: ${/** @type {Error} */ (err).message}\n${USAGE}`);
    return 2;
  }
  if (!opts.into) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (opts.check) {
    const problems = await check({ into: opts.into, hooksDir: opts.hooksDir, from: opts.from });
    if (problems.length === 0) {
      process.stdout.write('[hooks-drift] vendored agent hooks match their recorded CICD ref.\n');
      return 0;
    }
    process.stdout.write(
      `[hooks-drift] ${problems.length} problem(s) — vendored hooks are edited in CICD, never in place:\n` +
        problems.map((p) => `[hooks-drift]   ${p}\n`).join(''),
    );
    return 1;
  }
  if (!isPinnedRef(opts.ref)) {
    process.stderr.write(`sync.mjs: --ref must be a full 40-hex commit SHA (a branch or tag can move): ${opts.ref}\n`);
    return 2;
  }
  if (!isEnvPrefix(opts.envPrefix)) {
    process.stderr.write(`sync.mjs: --env-prefix must look like PREFIX_ (upper-case, ending in _): ${opts.envPrefix}\n`);
    return 2;
  }
  const files = await sync({ into: opts.into, ref: /** @type {string} */ (opts.ref), envPrefix: opts.envPrefix, hooksDir: opts.hooksDir, from: opts.from });
  process.stdout.write(`synced ${files.length} files from ${REPO}@${opts.ref} into ${path.join(opts.into, opts.hooksDir)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`sync.mjs: ${err?.message ?? err}\n`);
      process.exit(2);
    },
  );
}
