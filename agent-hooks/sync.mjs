// Vendor the shared Claude Code guard set into a consumer repository, pinned by SHA.
//
//   node <hooks-dir>/sync.mjs --into <repo> --ref <40-hex CICD sha> [--set core,guards] [--env-prefix ACME_]
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
//   - reads agent-hooks/manifest.json at --ref, picks the files of the named sets
//     (`--set`, comma-separated; `all` is every set; default: the sets recorded by the last
//     sync, else the manifest's default set, `core`), then reads every one of them;
//   - rewrites the neutral `AGENT_HOOKS_` escape-hatch prefix to the consumer's prefix, so a
//     consumer keeps the names its docs already teach (`ACME_ALLOW_DOUBLE_BACKSLASH`, …).
//     The prefix is --env-prefix, else `envPrefix` from the consumer's agent-tooling.json,
//     else the prefix the last sync recorded, else the neutral prefix unchanged;
//   - writes them into <repo>/<hooks-dir> (default scripts/hooks) with LF endings, deletes
//     files an earlier sync vendored that the selection no longer lists (a file the manifest
//     dropped, or, only with --drop, a de-selected set), and records the ref, prefix, sets and file list in
//     <hooks-dir>/CICD-HOOKS-SHA;
//   - `--check` re-derives every recorded file from the recorded ref, prefix and sets, and
//     exits 1 naming each one that was edited, deleted, or is missing — run it in the
//     consumer's CI so a local edit to a vendored guard cannot drift silently.
//
// Source: raw.githubusercontent.com (this repository is public, so no token is needed), or
// `--from <local CICD checkout>` to read the ref with `git show` instead (offline, and tests).
// `<guard>.hint.txt` files are the consumer's own and are never read, written or checked.
//
// Dependency-free on purpose: a consumer with no package.json runs this with plain `node`,
// and a first adoption fetches this one file alone, so it imports no sibling either (it reads
// agent-tooling.json's envPrefix itself rather than through agent-tooling-config.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'SeriousGeese/CICD';
export const SOURCE_DIR = 'agent-hooks';
export const SHA_FILE = 'CICD-HOOKS-SHA';
export const CONFIG_FILE = 'agent-tooling.json';
/** The set a consumer gets when it names none: the guard set every consumer had before named sets. */
export const DEFAULT_SET = 'core';
/** Not a manifest entry: the union of every set. */
export const ALL_SET = 'all';
// Assembled, never written as one literal: this file is itself vendored through transform(),
// and a literal here would be rewritten to the consumer's prefix, after which the consumer's
// copy could no longer recognise (or re-derive) the source text it checks against.
export const NEUTRAL_PREFIX = ['AGENT', 'HOOKS', ''].join('_');
const NEUTRAL_PREFIX_RE = new RegExp(String.raw`\b${NEUTRAL_PREFIX}`, 'g');

const USAGE =
  'usage: node sync.mjs --into <repo> --ref <40-hex sha> [--set <name>[,<name>]] [--drop] [--env-prefix PREFIX_] [--hooks-dir scripts/hooks] [--from <cicd checkout>]\n' +
  '       node sync.mjs --into <repo> --check [--hooks-dir scripts/hooks] [--from <cicd checkout>]\n';

/**
 * @param {string[]} argv
 * @returns {{ into?: string, ref?: string, envPrefix?: string, sets?: string[], drop?: boolean, hooksDir: string, from?: string, check: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ into?: string, ref?: string, envPrefix?: string, sets?: string[], drop?: boolean, hooksDir: string, from?: string, check: boolean }} */
  const out = { hooksDir: 'scripts/hooks', check: false };
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
    else if (a === '--set') out.sets = [...(out.sets ?? []), ...parseSetList(next())];
    else if (a === '--hooks-dir') out.hooksDir = next();
    else if (a === '--from') out.from = next();
    else if (a === '--check') out.check = true;
    else if (a === '--drop') out.drop = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** `core, guards` -> ['core', 'guards']; an empty list is an error. */
export function parseSetList(text) {
  const names = String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error('--set needs at least one set name');
  return names;
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

/**
 * The SHA file. A sync of the default set alone writes no `sets:` line, so a consumer that
 * never chose a set gets byte-for-byte the record it got before named sets existed.
 * @param {{ ref: string, envPrefix: string, sets?: string[], files: string[] }} rec
 */
export function formatShaFile(rec) {
  const sets = rec.sets ?? [DEFAULT_SET];
  const defaultOnly = sets.length === 1 && sets[0] === DEFAULT_SET;
  return [
    `# Vendored from ${REPO} ${SOURCE_DIR}/ by sync.mjs. Do not edit these files here:`,
    '# change them in CICD, then re-run sync with the new ref. `sync.mjs --check` fails on drift.',
    `ref: ${rec.ref}`,
    `env-prefix: ${rec.envPrefix}`,
    ...(defaultOnly ? [] : [`sets: ${sets.join(',')}`]),
    'files:',
    ...rec.files.map((f) => `  ${f}`),
    '',
  ].join('\n');
}

/** @param {string} text */
export function parseShaFile(text) {
  const ref = /^ref:\s*(\S+)\s*$/m.exec(text)?.[1];
  const envPrefix = /^env-prefix:\s*(\S+)\s*$/m.exec(text)?.[1];
  const setsLine = /^sets:\s*(\S+)\s*$/m.exec(text)?.[1];
  const block = /^files:\s*\n([\s\S]*)$/m.exec(text)?.[1] ?? '';
  const files = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!ref || !envPrefix) throw new Error(`${SHA_FILE} is missing its ref or env-prefix line`);
  return { ref, envPrefix, sets: setsLine ? parseSetList(setsLine) : [DEFAULT_SET], files };
}

/**
 * The absolute hooks directory, which must sit strictly INSIDE `into`. Sync writes and
 * deletes there, so `--hooks-dir ../elsewhere` (or an absolute path) is refused rather than
 * letting a typo rewrite files outside the consumer's tree.
 * @param {string} into
 * @param {string} hooksDir
 */
export function hooksDest(into, hooksDir) {
  const root = path.resolve(into);
  const dest = path.resolve(root, hooksDir);
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`--hooks-dir must be a subdirectory of --into (${into}), got: ${hooksDir}`);
  }
  return dest;
}

/** A manifest entry must be a bare filename — never a path that could escape the hooks dir. */
export function isSafeFileName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name)) && !String(name).includes('..');
}

/**
 * `envPrefix` from the consumer's agent-tooling.json, or undefined when the file or the key
 * is absent. Only that one key is read here; agent-tooling-config.mjs validates the rest.
 * @param {string} into
 */
export function configEnvPrefix(into) {
  const file = path.join(path.resolve(into), CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${/** @type {Error} */ (err).message})`, { cause: err });
  }
  return typeof raw?.envPrefix === 'string' ? raw.envPrefix : undefined;
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
 * A parsed, validated manifest: its named sets and the legacy `files` list. A manifest from
 * before named sets has only `files`, which is then the one set, `core`.
 * @param {unknown} json
 * @param {string} [where]
 * @returns {{ sets: Record<string, string[]>, defaultSet: string }}
 */
export function parseManifest(json, where = 'manifest.json') {
  const m = /** @type {{ files?: unknown, sets?: unknown, default?: unknown }} */ (json ?? {});
  const rawSets = m.sets === undefined ? { [DEFAULT_SET]: m.files } : m.sets;
  if (!rawSets || typeof rawSets !== 'object' || Array.isArray(rawSets)) throw new Error(`${where} "sets" must be an object`);
  /** @type {Record<string, string[]>} */
  const sets = {};
  for (const [name, files] of Object.entries(rawSets)) {
    if (name === ALL_SET) throw new Error(`${where} must not define "${ALL_SET}": it is the union of every set`);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${where} has an invalid set name: ${name}`);
    if (!Array.isArray(files) || files.length === 0) throw new Error(`${where} set "${name}" lists no files`);
    for (const f of files) if (!isSafeFileName(f)) throw new Error(`${where} lists an unsafe name: ${f}`);
    sets[name] = [...files];
  }
  const defaultSet = typeof m.default === 'string' ? m.default : DEFAULT_SET;
  if (!sets[defaultSet]) throw new Error(`${where} names a default set that does not exist: ${defaultSet}`);
  if (m.sets !== undefined && m.files !== undefined) {
    // An older sync.mjs reads `files` only, so `files` must stay the default set.
    const legacy = Array.isArray(m.files) ? [...m.files].sort().join('\n') : '';
    if (legacy !== [...sets[defaultSet]].sort().join('\n')) {
      throw new Error(`${where} "files" must list exactly the default set "${defaultSet}" (older sync.mjs copies read it)`);
    }
  }
  return { sets, defaultSet };
}

/**
 * The sorted, de-duplicated files of the named sets. `all` is every set.
 * @param {{ sets: Record<string, string[]> }} manifest
 * @param {string[]} names
 */
export function selectFiles(manifest, names) {
  const known = Object.keys(manifest.sets);
  const picked = new Set();
  for (const name of names) {
    const lists = name === ALL_SET ? Object.values(manifest.sets) : [manifest.sets[name]];
    if (!lists[0]) throw new Error(`unknown set "${name}" (known: ${[...known, ALL_SET].join(', ')})`);
    for (const list of lists) for (const f of list) picked.add(f);
  }
  return [...picked].sort();
}

/**
 * @param {string} ref
 * @param {string | undefined} from
 */
async function manifestAt(ref, from) {
  return parseManifest(JSON.parse(await readAtRef(ref, 'manifest.json', from)), `manifest.json at ${ref}`);
}

/**
 * @param {{ into: string, ref: string, envPrefix?: string, sets?: string[], drop?: boolean, hooksDir: string, from?: string }} opts
 * @returns {Promise<string[]>} the files written
 */
export async function sync(opts) {
  const dest = hooksDest(opts.into, opts.hooksDir);
  const shaPath = path.join(dest, SHA_FILE);
  const previous = existsSync(shaPath) ? parseShaFile(readFileSync(shaPath, 'utf8')) : null;
  // The recorded prefix comes before the neutral one, so a consumer that once passed
  // --env-prefix and has no agent-tooling.json keeps its hatch names on a plain re-sync.
  const envPrefix = opts.envPrefix ?? configEnvPrefix(opts.into) ?? previous?.envPrefix ?? NEUTRAL_PREFIX;
  if (!isEnvPrefix(envPrefix)) throw new Error(`env prefix must look like PREFIX_ (upper-case, ending in _): ${envPrefix}`);

  const manifest = await manifestAt(opts.ref, opts.from);
  const sets = opts.sets ?? previous?.sets ?? [manifest.defaultSet];
  const files = selectFiles(manifest, sets);
  // A file the manifest still ships but the new selection leaves out is a guard being turned
  // off, and `.claude/settings.json` may still register it: node then exits 1, which Claude Code
  // treats as a non-blocking error, so the guard fails OPEN with no warning. `--set guards`
  // meaning "core plus guards" is the easy mistake. Refuse unless the caller says --drop.
  if (!opts.drop && previous) {
    const shipped = new Set(selectFiles(manifest, [ALL_SET]));
    const dropped = previous.files.filter((f) => !files.includes(f) && shipped.has(f));
    if (dropped.length > 0) {
      throw new Error(
        `set(s) ${sets.join(',')} would stop vendoring ${dropped.length} file(s) the last sync (sets ${previous.sets.join(',')}) wrote: ${dropped.join(', ')}. ` +
          'Unregister them from .claude/settings.json first, then re-run with --drop, or name every set you still want.',
      );
    }
  }
  const contents = await Promise.all(files.map(async (f) => transform(await readAtRef(opts.ref, f, opts.from), envPrefix)));

  mkdirSync(dest, { recursive: true });
  files.forEach((f, i) => writeFileSync(path.join(dest, f), contents[i]));
  for (const stale of previous?.files ?? []) {
    if (!files.includes(stale) && isSafeFileName(stale)) rmSync(path.join(dest, stale), { force: true });
  }
  writeFileSync(shaPath, formatShaFile({ ref: opts.ref, envPrefix, sets, files }));
  return files;
}

/**
 * @param {{ into: string, hooksDir: string, from?: string }} opts
 * @returns {Promise<string[]>} one line per problem; empty when the vendored copy is exact
 */
export async function check(opts) {
  const dest = hooksDest(opts.into, opts.hooksDir);
  const shaPath = path.join(dest, SHA_FILE);
  if (!existsSync(shaPath)) return [`${path.join(opts.hooksDir, SHA_FILE)} is missing — nothing records what was vendored`];
  const rec = parseShaFile(readFileSync(shaPath, 'utf8'));
  const problems = [];
  const manifest = await manifestAt(rec.ref, opts.from);
  let wanted;
  try {
    wanted = selectFiles(manifest, rec.sets);
  } catch (err) {
    return [`${SHA_FILE} records ${/** @type {Error} */ (err).message} at ${rec.ref}`];
  }
  if ([...rec.files].sort().join('\n') !== wanted.join('\n')) {
    problems.push(`${SHA_FILE} file list does not match set(s) ${rec.sets.join(',')} in manifest.json at ${rec.ref} — re-run sync`);
  }
  for (const f of wanted) {
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
  if (opts.envPrefix !== undefined && !isEnvPrefix(opts.envPrefix)) {
    process.stderr.write(`sync.mjs: --env-prefix must look like PREFIX_ (upper-case, ending in _): ${opts.envPrefix}\n`);
    return 2;
  }
  const files = await sync({
    into: opts.into,
    ref: /** @type {string} */ (opts.ref),
    envPrefix: opts.envPrefix,
    sets: opts.sets,
    drop: opts.drop,
    hooksDir: opts.hooksDir,
    from: opts.from,
  });
  process.stdout.write(`synced ${files.length} files from ${REPO}@${opts.ref} into ${path.join(opts.into, opts.hooksDir)}\n`);
  return 0;
}

/**
 * True when this module is the process entry point. Compared through realpath on both sides:
 * node resolves import.meta.url through symlinks and junctions but leaves argv[1] as typed, so
 * a plain comparison is false whenever the checkout is reached through a link, and the hook
 * then silently does nothing (a guard that fails open).
 */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`sync.mjs: ${err?.message ?? err}\n`);
      process.exit(2);
    },
  );
}
