// Vendor the shared Claude Code guard set into a consumer repository, pinned by SHA.
//
//   node <hooks-dir>/sync.mjs --into <repo> --ref <40-hex CICD sha> [--set core,guards] [--env-prefix ACME_] [--drop] [--adopt]
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
//   - REFUSES, before writing anything, to replace an existing file sync did not write: a
//     target must be absent, already the new bytes, or still exactly what the recorded ref
//     wrote there under the recorded prefix. A consumer's own file at a manifest name, or a
//     vendored file edited in place, is listed and the whole sync stops, unless --adopt says
//     this sync may take such files over (each adopted path is named on stderr). A plain
//     re-sync over files the previous ref wrote needs no flag;
//   - checks and reads everything first (a target or record that is a symlink, a directory or
//     any other non-regular file, a target under a non-directory, or a path whose real
//     location is outside --into is refused), then mutates in a fixed order: each file is
//     written through a temp file in its own directory renamed over it (a hard link is
//     replaced, never written through; an existing file keeps its mode), then the record, then
//     the stale deletes, so a failure never leaves a half-synced tree behind a record that
//     claims otherwise;
//   - writes them into <repo>/<hooks-dir> (default scripts/hooks) with LF endings, deletes
//     files an earlier sync vendored that the selection no longer lists (a file the manifest
//     dropped, or, only with --drop, a de-selected set), and records the ref, prefix, sets and file list in
//     <hooks-dir>/CICD-HOOKS-SHA. A stale file is deleted only while its bytes are still
//     exactly what the recorded ref wrote under the recorded prefix; an edited one is kept,
//     and sync says so on stderr (it is then the consumer's, and no longer recorded);
//   - `--check` re-derives every recorded file from the recorded ref, prefix and sets, and
//     exits 1 naming each one that was edited, deleted, is missing, or is not a regular file.
//     Run it in the consumer's CI so a local edit to a vendored guard cannot drift silently.
//
// Source: raw.githubusercontent.com (this repository is public, so no token is needed), or
// `--from <local CICD checkout>` to read the ref with `git show` instead (offline, and tests).
// `<guard>.hint.txt` files are the consumer's own and are never read, written or checked.
//
// Dependency-free on purpose: a consumer with no package.json runs this with plain `node`,
// and a first adoption fetches this one file alone, so it imports no sibling either (it reads
// agent-tooling.json's envPrefix itself rather than through agent-tooling-config.mjs).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  'usage: node sync.mjs --into <repo> --ref <40-hex sha> [--set <name>[,<name>]] [--drop] [--adopt] [--env-prefix PREFIX_] [--hooks-dir scripts/hooks] [--from <cicd checkout>]\n' +
  '       node sync.mjs --into <repo> --check [--hooks-dir scripts/hooks] [--from <cicd checkout>]\n' +
  '  --adopt  this sync may replace existing files the recorded CICD ref did not write (each is named on stderr)\n';

/**
 * @param {string[]} argv
 * @returns {{ into?: string, ref?: string, envPrefix?: string, sets?: string[], drop?: boolean, adopt?: boolean, hooksDir: string, from?: string, check: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ into?: string, ref?: string, envPrefix?: string, sets?: string[], drop?: boolean, adopt?: boolean, hooksDir: string, from?: string, check: boolean }} */
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
    else if (a === '--adopt') out.adopt = true;
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
  // A function replacer: a string one would read `$&`, `$'` and friends as patterns.
  return envPrefix === NEUTRAL_PREFIX ? lf : lf.replace(NEUTRAL_PREFIX_RE, () => envPrefix);
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
  // The record is plain text a hand edit can change. Its ref reaches git and a URL, and its
  // prefix is rewritten into files and compared against them: only a pinned SHA and a plain
  // PREFIX_ are accepted.
  if (!isPinnedRef(ref)) throw new Error(`${SHA_FILE} records a ref that is not a full 40-hex commit SHA: ${ref}`);
  if (!isEnvPrefix(envPrefix)) throw new Error(`${SHA_FILE} records an env-prefix that is not PREFIX_ (upper-case, ending in _): ${envPrefix}`);
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

/** Lower-cased, so a case-insensitive filesystem cannot give one file two names here. */
const caseKey = (name) => String(name).toLowerCase();

/**
 * Refuses a name list that one filesystem could not hold as listed: two names equal but for
 * case are one file on Windows and macOS, so a sync would write it twice and a case-only
 * rename would delete it. (A name that is a directory of another cannot occur: a manifest
 * entry is a bare filename, isSafeFileName refuses a `/`.)
 * @param {Iterable<string>} names
 * @param {string} where
 */
function assertDistinctNames(names, where) {
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const n of names) {
    const prior = byKey.get(caseKey(n));
    if (prior !== undefined && prior !== n) throw new Error(`${where} lists two files that differ only in case: ${prior}, ${n}`);
    byKey.set(caseKey(n), n);
  }
}

/** True when `p` exists as a directory entry, including a symlink whose target is missing. */
function entryExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * hooksDest() and isSafeFileName() are lexical. A symlinked directory in the consumer's tree
 * (`scripts -> /elsewhere`) would still carry a read, write or delete out of `--into`, and so
 * would a target that is itself a symlinked file (writeFileSync follows it). So before any of
 * those, the target when it exists (as an entry: a dangling link counts), or else its nearest
 * existing ancestor, must resolve through every link to somewhere inside the real `--into`.
 * A link that resolves nowhere is refused too: writing through it would create its target,
 * wherever that is.
 * @param {string} into
 * @param {string} abs
 * @param {string} label for messages
 */
function assertRealInside(into, abs, label) {
  const root = realpathSync(path.resolve(into));
  let probe = abs;
  while (!entryExists(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error(`refusing ${label}: a symlink in the path resolves nowhere`);
  }
  const r = path.relative(root, real);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`refusing ${label}: a symlink in the path leads outside --into`);
}

/**
 * A write target must be a regular file or absent, and every existing ancestor up to `--into`
 * a directory: renaming over a directory, or creating under a file, fails halfway through a
 * sync. Run after assertRealInside(), so every ancestor already resolves inside `--into`.
 * @param {string} into
 * @param {string} abs
 * @param {string} label
 */
function assertWritableTarget(into, abs, label) {
  const root = path.resolve(into);
  for (let dir = path.dirname(abs); dir.length > root.length && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (!entryExists(dir)) continue;
    let isDir;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`refusing ${label}: ${path.relative(root, dir).split(path.sep).join('/')} exists and is not a directory`);
  }
  if (entryExists(abs) && !lstatSync(abs).isFile()) throw new Error(`refusing ${label}: it exists and is not a regular file`);
}

/**
 * Write `content` at `abs` through a temp file in the same directory renamed over it. The
 * rename replaces the directory entry, so a hard link at `abs` is replaced, never written
 * through, and a reader never sees half a file. (A symlinked or otherwise non-regular target
 * never gets here: assertWritableTarget refuses it up front.) The containment check is re-run
 * immediately before the mkdir, the temp write and the rename, so a directory swapped for a
 * link after the up-front checks is still refused. An existing file's mode is kept (an
 * executable hook stays executable).
 * @param {string} into
 * @param {string} abs
 * @param {string} label
 * @param {string} content
 */
function writeFileAtomic(into, abs, label, content) {
  assertRealInside(into, abs, label);
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${randomBytes(6).toString('hex')}.cicd-hooks-sync.tmp`);
  let mode;
  try {
    const st = lstatSync(abs);
    if (st.isFile()) mode = st.mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    assertRealInside(into, tmp, label);
    // `wx`: never open an entry that is already there (a planted link at the temp name).
    writeFileSync(tmp, content, { flag: 'wx' });
    if (mode !== undefined) chmodSync(tmp, mode);
    assertRealInside(into, abs, label);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** A file's text with CRLF read as LF, the form transform() produces and --check compares. */
const readLf = (abs) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

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
    // A pinned SHA must mean the same bytes everywhere: refs/replace in the --from checkout
    // could otherwise substitute any object, and an fsmonitor hook would run its code.
    try {
      return execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', from, 'show', `${ref}:${SOURCE_DIR}/${name}`], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MSYS_NO_PATHCONV: '1', GIT_NO_REPLACE_OBJECTS: '1' },
      });
    } catch (err) {
      // One line, so a reason quoted inside a refusal or a note stays readable.
      const e = /** @type {Error & { stderr?: string }} */ (err);
      const why = String(e.stderr ?? '').trim().split('\n').pop() || e.message.split('\n')[0];
      throw new Error(`git show ${ref}:${SOURCE_DIR}/${name} in ${from} failed: ${why}`, { cause: err });
    }
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
  assertDistinctNames(Object.values(sets).flat(), where);
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
    // Own properties only: `constructor` or `toString` is an unknown set, not a crash.
    if (name !== ALL_SET && !Object.hasOwn(manifest.sets, name)) {
      throw new Error(`unknown set "${name}" (known: ${[...known, ALL_SET].join(', ')})`);
    }
    const lists = name === ALL_SET ? Object.values(manifest.sets) : [manifest.sets[name]];
    for (const list of lists) for (const f of list) picked.add(f);
  }
  const files = [...picked].sort();
  assertDistinctNames(files, 'the selected files');
  return files;
}

/**
 * @param {string} ref
 * @param {string | undefined} from
 */
async function manifestAt(ref, from) {
  return parseManifest(JSON.parse(await readAtRef(ref, 'manifest.json', from)), `manifest.json at ${ref}`);
}

/**
 * @param {{ into: string, ref: string, envPrefix?: string, sets?: string[], drop?: boolean, adopt?: boolean, hooksDir: string, from?: string }} opts
 *   `adopt`: this sync may replace existing files the recorded ref did not write (each one is
 *   named on stderr). Without it such a file stops the whole sync before anything is written.
 * @returns {Promise<string[]>} the files written
 */
export async function sync(opts) {
  if (!isPinnedRef(opts.ref)) throw new Error(`ref must be a full 40-hex commit SHA (a branch or tag can move): ${opts.ref}`);
  const root = path.resolve(opts.into);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--into is not a directory: ${opts.into}`);
  const dest = hooksDest(opts.into, opts.hooksDir);
  const destRel = path.relative(root, dest).split(path.sep).join('/');
  /** @param {string} f */
  const label = (f) => `${destRel}/${f}`;
  const shaPath = path.join(dest, SHA_FILE);
  const shaLabel = label(SHA_FILE);
  // The record is read, then rewritten: it is checked like any target before either.
  assertRealInside(opts.into, shaPath, shaLabel);
  assertWritableTarget(opts.into, shaPath, shaLabel);
  const previous = entryExists(shaPath) ? parseShaFile(readFileSync(shaPath, 'utf8')) : null;
  // The recorded prefix comes before the neutral one, so a consumer that once passed
  // --env-prefix and has no agent-tooling.json keeps its hatch names on a plain re-sync.
  const envPrefix = opts.envPrefix ?? configEnvPrefix(opts.into) ?? previous?.envPrefix ?? NEUTRAL_PREFIX;
  if (!isEnvPrefix(envPrefix)) throw new Error(`env prefix must look like PREFIX_ (upper-case, ending in _): ${envPrefix}`);

  const manifest = await manifestAt(opts.ref, opts.from);
  const sets = opts.sets ?? previous?.sets ?? [manifest.defaultSet];
  const files = selectFiles(manifest, sets);
  const selected = new Set(files.map(caseKey));
  // A vendored file named like the record would be overwritten by it: the record is nobody's
  // vendored file.
  if (selected.has(caseKey(SHA_FILE))) throw new Error(`refusing a selection that vendors the record file ${SHA_FILE}`);
  // A file the manifest still ships but the new selection leaves out is a guard being turned
  // off, and `.claude/settings.json` may still register it: node then exits 1, which Claude Code
  // treats as a non-blocking error, so the guard fails OPEN with no warning. `--set guards`
  // meaning "core plus guards" is the easy mistake. Refuse unless the caller says --drop.
  if (!opts.drop && previous) {
    const shipped = new Set(selectFiles(manifest, [ALL_SET]));
    const dropped = previous.files.filter((f) => !selected.has(caseKey(f)) && shipped.has(f));
    if (dropped.length > 0) {
      throw new Error(
        `set(s) ${sets.join(',')} would stop vendoring ${dropped.length} file(s) the last sync (sets ${previous.sets.join(',')}) wrote: ${dropped.join(', ')}. ` +
          'Unregister them from .claude/settings.json first, then re-run with --drop, or name every set you still want.',
      );
    }
  }

  // Every read and every check happens before the first mutation, so a refusal or a failed
  // read leaves the tree exactly as it was.
  const contents = await Promise.all(files.map(async (f) => transform(await readAtRef(opts.ref, f, opts.from), envPrefix)));
  const targets = files.map((f) => path.join(dest, f));
  targets.forEach((abs, i) => {
    assertRealInside(opts.into, abs, label(files[i]));
    assertWritableTarget(opts.into, abs, label(files[i]));
  });

  /** @type {Promise<{ shipped: Set<string>, error?: undefined } | { error: Error }> | undefined} */
  let before;
  // The manifest at the recorded ref, read once and only when something needs it.
  const shippedBefore = () =>
    (before ??= manifestAt(/** @type {{ ref: string }} */ (previous).ref, opts.from)
      .then((m) => ({ shipped: new Set(selectFiles(m, [ALL_SET])) }))
      .catch((error) => ({ error })));
  /**
   * The bytes the recorded ref wrote at `f` under the recorded prefix, or why that is unknown.
   * The record's file list alone is plain text a hand edit could point anywhere, so the old
   * manifest must have shipped the name too.
   * @param {string} f
   * @returns {Promise<{ text: string } | { text?: undefined, why: string }>}
   */
  const wroteBefore = async (f) => {
    const rec = /** @type {{ ref: string, envPrefix: string }} */ (previous);
    const b = await shippedBefore();
    if (b.error) return { why: `cannot read manifest.json at ${rec.ref} (${b.error.message})` };
    if (!b.shipped.has(f)) return { why: `manifest.json at ${rec.ref.slice(0, 12)} did not ship it` };
    try {
      return { text: transform(await readAtRef(rec.ref, f, opts.from), rec.envPrefix) };
    } catch (err) {
      return { why: `cannot read it at ${rec.ref} (${/** @type {Error} */ (err).message})` };
    }
  };

  // Ownership: a target that exists must be the new bytes already, or still exactly what the
  // recorded ref wrote. Anything else is the consumer's (its own file at a name the manifest
  // now claims, or a vendored file edited in place) and is replaced only with --adopt.
  const recorded = new Map((previous?.files ?? []).filter(isSafeFileName).map((f) => [caseKey(f), f]));
  /** @type {{ f: string, why: string }[]} */
  const foreign = [];
  /** @type {{ f: string, have: string, was: string }[]} */
  const differing = [];
  for (let i = 0; i < files.length; i++) {
    if (!entryExists(targets[i])) continue;
    const have = readLf(targets[i]);
    if (have === contents[i]) continue;
    const was = recorded.get(caseKey(files[i]));
    if (!previous || was === undefined) foreign.push({ f: files[i], why: `no ${SHA_FILE} records sync writing it` });
    else differing.push({ f: files[i], have, was });
  }
  // The old-ref reads run together; wroteBefore() turns each failure into a per-file reason.
  const wroteDiffering = await Promise.all(differing.map(({ was }) => wroteBefore(was)));
  differing.forEach(({ f, have }, i) => {
    const wrote = wroteDiffering[i];
    if (wrote.text === undefined) foreign.push({ f, why: `${wrote.why}, so it cannot be confirmed unchanged` });
    else if (have !== wrote.text) foreign.push({ f, why: `edited since ${REPO}@${previous?.ref.slice(0, 12)} wrote it` });
  });
  foreign.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  if (foreign.length && !opts.adopt) {
    throw new Error(
      `refusing to replace ${foreign.length} existing file(s) the recorded CICD ref did not write; nothing was written: ` +
        `${foreign.map(({ f, why }) => `${label(f)} (${why})`).join(', ')}. ` +
        'If this sync should take them over (the consumer is replacing its own copy with the CICD one), re-run with --adopt; ' +
        'if a vendored file was edited in place, move the change into CICD first. ' +
        'A file that "cannot be confirmed unchanged" was not read at the recorded ref: re-run with --from a CICD checkout that has it, or once GitHub is reachable, before reaching for --adopt.',
    );
  }

  // The record and the old manifest only say a file WAS vendored; the consumer may have taken
  // it over since. So a stale file is deleted only when its bytes are still exactly what the
  // recorded ref wrote, under the recorded prefix. Anything else is kept, and the sync says
  // so. A name still selected under another case is the same file on a case-insensitive
  // filesystem (a case-only rename), so it is not stale: deleting it would delete the file
  // this sync just wrote.
  const stale = (previous?.files ?? []).filter((f) => isSafeFileName(f) && !selected.has(caseKey(f)) && caseKey(f) !== caseKey(SHA_FILE));
  /** @type {string[]} */
  const notes = [];
  /** @type {{ f: string, abs: string, wrote: string }[]} */
  const deletions = [];
  if (stale.length) {
    const b = await shippedBefore();
    if (b.error) {
      notes.push(`not deleting ${stale.length} stale file(s): cannot read manifest.json at ${previous?.ref} (${b.error.message})`);
    } else {
      /** @type {{ keep?: string, deletion?: { f: string, abs: string, wrote: string } }[]} */
      const outcomes = await Promise.all(
        stale.map(async (f) => {
          const abs = path.join(dest, f);
          try {
            assertRealInside(opts.into, abs, label(f));
          } catch (err) {
            return { keep: /** @type {Error} */ (err).message };
          }
          if (!entryExists(abs)) return {};
          if (!lstatSync(abs).isFile()) return { keep: 'it is not a regular file' };
          const wrote = await wroteBefore(f);
          if (wrote.text === undefined) return { keep: `${wrote.why}, so it cannot be confirmed unchanged` };
          if (readLf(abs) !== wrote.text) {
            return { keep: `it differs from what ${REPO}@${previous?.ref.slice(0, 12)} wrote, so it is treated as the consumer's; delete it by hand if it is not` };
          }
          return { deletion: { f, abs, wrote: wrote.text } };
        }),
      );
      outcomes.forEach(({ keep, deletion }, i) => {
        if (keep) notes.push(`not deleting stale ${label(stale[i])}: ${keep}`);
        if (deletion) deletions.push(deletion);
      });
    }
  }

  // Mutate, in order: the files, then the record, then the stale deletes. A stale delete that
  // fails keeps its file and says so; it never throws past a record that is already written.
  const say = (line) => process.stderr.write(`sync.mjs: ${line}\n`);
  for (const { f } of foreign) say(`adopting ${label(f)}: replacing a file the recorded CICD ref did not write`);
  targets.forEach((abs, i) => writeFileAtomic(opts.into, abs, label(files[i]), contents[i]));
  writeFileAtomic(opts.into, shaPath, shaLabel, formatShaFile({ ref: opts.ref, envPrefix, sets, files }));
  notes.forEach(say);
  for (const { f, abs, wrote } of deletions) {
    try {
      assertRealInside(opts.into, abs, label(f));
      if (!entryExists(abs)) continue;
      if (!lstatSync(abs).isFile() || readLf(abs) !== wrote) {
        say(`not deleting stale ${label(f)}: it changed while this sync ran`);
        continue;
      }
      rmSync(abs);
    } catch (err) {
      say(`not deleting stale ${label(f)}: ${/** @type {Error} */ (err).message}`);
    }
  }
  return files;
}

/** What a non-regular entry is, for a drift line. */
function entryKind(abs) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return 'a symlink';
  if (st.isDirectory()) return 'a directory';
  return 'a special file';
}

/**
 * @param {{ into: string, hooksDir: string, from?: string }} opts
 * @returns {Promise<string[]>} one line per problem; empty when the vendored copy is exact
 */
export async function check(opts) {
  const dest = hooksDest(opts.into, opts.hooksDir);
  const shaPath = path.join(dest, SHA_FILE);
  const shaShown = path.join(opts.hooksDir, SHA_FILE);
  try {
    assertRealInside(opts.into, shaPath, shaShown);
  } catch (err) {
    return [/** @type {Error} */ (err).message];
  }
  if (!entryExists(shaPath)) return [`${shaShown} is missing: nothing records what was vendored`];
  if (!lstatSync(shaPath).isFile()) return [`${shaShown}: is ${entryKind(shaPath)}, not the record file`];
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
    problems.push(`${SHA_FILE} file list does not match set(s) ${rec.sets.join(',')} in manifest.json at ${rec.ref}: re-run sync`);
  }
  for (const f of wanted) {
    const local = path.join(dest, f);
    const shown = path.join(opts.hooksDir, f);
    try {
      assertRealInside(opts.into, local, shown);
    } catch (err) {
      problems.push(`${shown}: ${/** @type {Error} */ (err).message}`);
      continue;
    }
    if (!entryExists(local)) {
      problems.push(`${shown}: missing`);
      continue;
    }
    // A directory or a link where a vendored file belongs is drift, never a crash.
    if (!lstatSync(local).isFile()) {
      problems.push(`${shown}: is ${entryKind(local)}, not a regular file`);
      continue;
    }
    const want = transform(await readAtRef(rec.ref, f, opts.from), rec.envPrefix);
    if (readLf(local) !== want) problems.push(`${shown}: differs from ${REPO}@${rec.ref.slice(0, 12)}`);
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
      `[hooks-drift] ${problems.length} problem(s): vendored hooks are edited in CICD, never in place:\n` +
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
    adopt: opts.adopt,
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
  // process.exitCode, never process.exit(code): a hard exit can drop the tail of a report
  // still queued on a piped stdout while the status stays 0.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`sync.mjs: ${err?.message ?? err}\n`);
      process.exitCode = 2;
    },
  );
}
