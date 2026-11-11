#!/usr/bin/env node
// PreToolUse(Bash) hook: refuse a bare `bd update <id> --claim` and name the repository's
// claim helper (agent-tooling.json `claimHelper`, default scripts/claim.sh).
//
// The claim helper is the one claim path: it runs the verified Dolt pull, refuses a
// shared actor identity, refuses another actor's claim younger than 4h
// and publishes the claim. A bare `--claim` does none of that, so a fresh claim another
// session holds could be overwritten. This replaced block-claim-collision.mjs, which ran the
// age check itself and false-refused often; the check now lives in claim.sh.
//
// What is scanned, recursively (depth 4): every command segment outside quotes; the payload
// of `bash|sh|zsh|dash|ksh -c`, `pwsh|powershell -Command`, and `eval`; `$(...)` and backtick
// bodies (also inside double quotes, where they still run); and a script run by path
// (`bash x.sh`, `./x.sh`, `source x.sh`, `node x.mjs`) when it exists and is under 256 KB.
// The claim helper itself is allowed, and so is a JS test file or this hook run by node (they
// name claim argument lists as data). Quoted prose (a commit message, a PR body) and heredoc
// bodies are data, never refused. A script that exists but cannot be verified (unreadable, a
// broken symlink, over 256 KB) and nesting past depth 4 fail CLOSED with their own message;
// only a confirmed ENOENT counts as absent.
// Hatch: AGENT_HOOKS_ALLOW_BARE_CLAIM=1 (inline on the segment, or in the environment).
// Contract: exit 2 + stderr to refuse; anything unexpected fails OPEN (exit 0).
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { DEFAULTS, tryLoadConfig } from './agent-tooling-config.mjs';
import { readToolCommand } from './hook-input.mjs';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';
import { segmentHasInlineHatch } from './inline-hatch.mjs';
import { resolveShellDir, safeCwd } from './shell-path-lib.mjs';

export const HATCH_VAR = 'AGENT_HOOKS_ALLOW_BARE_CLAIM';
export const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_DEPTH = 4;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['pwsh', 'powershell', 'pwsh.exe', 'powershell.exe']);
const NODE_SCRIPT_RE = /\.(?:mjs|cjs|js)$/;

/**
 * Split shell text into segments on `&&`, `||`, `;`, `|` and newlines outside quotes, each
 * with its raw text, its unquoted words, and the `$(...)` / backtick bodies it runs.
 * @returns {{ raw: string, words: string[], substitutions: string[] }[]}
 */
export function shellSegments(text) {
  const segs = [];
  let raw = '';
  let words = [];
  let word = null;
  let subs = [];
  const flushWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const flushSeg = () => {
    flushWord();
    if (raw.trim()) segs.push({ raw: raw.trim(), words: stripGroupingParens(words), substitutions: subs });
    raw = '';
    words = [];
    subs = [];
  };
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      word = (word ?? '') + s.slice(i + 1, stop);
      raw += s.slice(i, stop + 1);
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== '"') {
        // A line continuation (LF or CRLF) inside double quotes is removed, as bash does.
        if (s[j] === '\\' && s[j + 1] === '\r' && s[j + 2] === '\n') {
          j += 3;
          continue;
        }
        if (s[j] === '\\' && j + 1 < s.length && '$`"\\\n'.includes(s[j + 1])) {
          if (s[j + 1] !== '\n') val += s[j + 1];
          j += 2;
          continue;
        }
        const sub = readSubstitution(s, j);
        if (sub) {
          subs.push(sub.body);
          val += s.slice(j, sub.end);
          j = sub.end;
          continue;
        }
        val += s[j];
        j++;
      }
      word = (word ?? '') + val;
      raw += s.slice(i, j + 1);
      i = j;
    } else if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      // A line continuation is removed entirely, from the words AND the raw text: it neither
      // starts nor ends a word, and a leading `\<newline>` must not hide an inline hatch
      // (`... && \<newline>AGENT_HOOKS_ALLOW_BARE_CLAIM=1 bd update X --claim`).
      i += s[i + 1] === '\r' ? 2 : 1;
    } else if (c === '\\' && i + 1 < s.length) {
      word = (word ?? '') + s[i + 1];
      raw += s.slice(i, i + 2);
      i++;
    } else if (readSubstitution(s, i)) {
      const sub = readSubstitution(s, i);
      subs.push(sub.body);
      word = (word ?? '') + s.slice(i, sub.end);
      raw += s.slice(i, sub.end);
      i = sub.end - 1;
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      if ((c === '|' && s[i + 1] === '|') || c === '&') i++;
      flushSeg();
    } else if (c === ' ' || c === '\t') {
      flushWord();
      raw += c;
    } else if (c === '#' && word === null) {
      // A comment runs to the end of the line; its backticks and quotes are prose.
      const nl = s.indexOf('\n', i);
      i = (nl === -1 ? s.length : nl) - 1;
    } else {
      word = (word ?? '') + c;
      raw += c;
    }
  }
  flushSeg();
  return segs;
}

/** A `$(...)` or backtick substitution starting at `i`: its body and the index after it. */
function readSubstitution(s, i) {
  if (s[i] === '`') {
    const end = s.indexOf('`', i + 1);
    return end === -1 ? null : { body: s.slice(i + 1, end), end: end + 1 };
  }
  if (s[i] !== '$' || s[i + 1] !== '(' || s[i + 2] === '(') return null;
  // Parens inside quotes do not count: `$(python -c 'print("(x")')` closes at the last paren.
  let depth = 0;
  let quote = null;
  for (let j = i + 1; j < s.length; j++) {
    if (quote === "'") {
      if (s[j] === "'") quote = null;
      continue;
    }
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (quote === '"') {
      if (s[j] === '"') quote = null;
      continue;
    }
    if (s[j] === "'" || s[j] === '"') quote = s[j];
    else if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) return { body: s.slice(i + 2, j), end: j + 1 };
  }
  return null;
}

/** Drop whole-line shell comments (`# ...`); inline trailing comments are left alone. */
function stripCommentLines(text) {
  return String(text).replace(/^[ \t]*#.*$/gm, '');
}

/** Heredoc bodies are data: drop them before scanning. */
function stripHeredocBodies(text) {
  return String(text).replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?:\n|$)/g, '\n');
}

/** `bd`, `/usr/local/bin/bd`, `./bd`, `C:\...\bd.exe`: the command word, by its basename. */
function isBdCommand(word) {
  return /^bd(?:\.exe|\.cmd)?$/i.test(path.basename(String(word).replace(/\\/g, '/')));
}

function isClaimCall(words) {
  const args = words.slice(1);
  return isBdCommand(words[0] ?? '') && args.includes('update') && args.some((a) => a === '--claim' || a.startsWith('--claim='));
}

/** Interpreters whose inline-code flag runs a string: `node -e`, `python -c`, `perl -e`, `ruby -e`. */
const INLINE_CODE = [
  { re: /^node(?:\.exe)?$/i, flags: /^(?:-e|--eval|-p|--print)$/ },
  { re: /^python(?:3(?:\.\d+)?)?(?:\.exe)?$|^py$/i, flags: /^-c$/ },
  { re: /^perl(?:\.exe)?$/i, flags: /^-[a-zA-Z]*e$/ },
  { re: /^ruby(?:\.exe)?$/i, flags: /^-e$/ },
];

function inlineCode(base, args) {
  const kind = INLINE_CODE.find((k) => k.re.test(base));
  if (!kind) return null;
  const i = args.findIndex((a) => kind.flags.test(a));
  return i === -1 ? null : (args[i + 1] ?? null);
}

/**
 * True when `file` (already a realpath) IS the repository's claim helper: the realpath of
 * `claimHelper` (a repo-relative path) under the repository root `root`, compared for equality.
 * A suffix match would let any `<anywhere>/scripts/claim.sh` pass as the approved helper, such as
 * `/tmp/scripts/claim.sh` holding a bare claim. No root, no match; an escaping or absolute
 * `claimHelper` (the config loader rejects both) never matches.
 *
 * The helper of ANOTHER CHECKOUT OF THE SAME REPOSITORY also matches: `root` is fixed from the
 * hook's own cwd, and a harness may run the hook from the primary checkout while the command
 * does `cd <linked worktree> && bash scripts/claim.sh ...`. That worktree's helper
 * is this repository's file at another checkout, so it is compared against the helper path
 * under the worktree root that holds `file`, but only when that root shares `root`'s git common
 * directory. A checkout of any other repository, or a directory in none, still never matches.
 * Like the helper in the hook's own checkout, it is trusted by identity, not scanned: any
 * registered worktree's copy is approved as it stands, branch edits included.
 */
function isClaimHelper(file, claimHelper = DEFAULTS.claimHelper, root, fs = DEFAULT_FS) {
  if (!claimHelper || !root) return false;
  const rel = String(claimHelper).replace(/\\/g, '/');
  if (path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) return false;
  const norm = (f) => (process.platform === 'win32' ? f.toLowerCase() : f).replace(/\\/g, '/');
  const matchesUnder = (r) => {
    try {
      return norm(file) === norm(fs.realpathSync(path.join(r, rel)));
    } catch {
      return false;
    }
  };
  if (matchesUnder(root)) return true;
  const own = repoRoot(path.dirname(file));
  if (!own || norm(path.resolve(own)) === norm(path.resolve(root))) return false;
  const ownCommon = gitCommonDir(own, fs);
  return ownCommon !== null && ownCommon === gitCommonDir(root, fs) && matchesUnder(own);
}

/**
 * The git common directory of the checkout at `root`, normalized, or null. A primary checkout's
 * `.git` is that directory; a linked worktree's `.git` is a file naming its private git dir,
 * whose `commondir` file points back at the shared one. Read from the files, never by running git.
 *
 * A `.git` FILE is only believed when git's own registration agrees: its private dir must be
 * `<common>/worktrees/<name>`, and that dir's `gitdir` back-pointer must name this `.git` file.
 * Otherwise any directory could claim the repository with one line (`gitdir: <repo>/.git`) and
 * have its own `scripts/claim.sh` approved without a scan.
 */
function gitCommonDir(root, fs = DEFAULT_FS) {
  const dotGit = path.join(root, '.git');
  const norm = (f) => (process.platform === 'win32' ? f.toLowerCase() : f).replace(/\\/g, '/');
  try {
    // lstat, never stat: a `.git` SYMLINK to the repository's `.git` would otherwise pass as the
    // primary checkout itself. Git never creates one; a real `.git` is a directory or a file.
    const st = fs.lstatSync(dotGit);
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) return norm(fs.realpathSync(dotGit));
    if (!st.isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(root, m[1]);
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    const realCommon = fs.realpathSync(common);
    // The private dir must be a registered worktree of that common dir ...
    if (norm(fs.realpathSync(path.dirname(gitDir))) !== norm(path.join(realCommon, 'worktrees'))) return null;
    // ... whose back-pointer (absolute, or relative to the private dir) names this checkout.
    const back = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim());
    if (norm(fs.realpathSync(back)) !== norm(fs.realpathSync(dotGit))) return null;
    return norm(realCommon);
  } catch {
    return null;
  }
}

/**
 * JS files that name claim argument lists as test DATA, never to run them: test files (they
 * drive stubs, never the real bd) and this hook itself.
 */
function isJsDataFile(file) {
  const name = path.basename(file);
  return /\.(?:node-)?test\.[cm]?js$|\.spec\.[cm]?js$/.test(name) || name === 'block-bare-claim.mjs';
}

const DEFAULT_FS = { statSync, lstatSync, realpathSync, readFileSync };

/**
 * What a script run by path holds. Only a confirmed ENOENT (nothing at the path, not even a
 * dangling link) or a non-file is absent; anything else this hook cannot read is
 * `unverifiable`, and the caller refuses it (fail CLOSED: an unread script is not evidence it
 * claims nothing). claim.sh itself is `allowed`.
 * @returns {{ kind: 'absent' | 'allowed' } | { kind: 'text', text: string } | { kind: 'unverifiable', reason: string }}
 */
export function classifyScript(file, fs = DEFAULT_FS, claimHelper = DEFAULTS.claimHelper, root = null) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e?.code !== 'ENOENT') return { kind: 'unverifiable', reason: `it cannot be read (${e?.code ?? 'error'})` };
    try {
      fs.lstatSync(file);
      return { kind: 'unverifiable', reason: 'it is a broken symlink' };
    } catch (le) {
      return le?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unverifiable', reason: `it cannot be read (${le?.code ?? 'error'})` };
    }
  }
  if (!st.isFile()) return { kind: 'absent' }; // a directory runs nothing
  try {
    if (isClaimHelper(fs.realpathSync(file), claimHelper, root, fs)) return { kind: 'allowed' };
    if (st.size > MAX_SCRIPT_BYTES) return { kind: 'unverifiable', reason: `it is over ${MAX_SCRIPT_BYTES / 1024} KB` };
    return { kind: 'text', text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { kind: 'unverifiable', reason: `it cannot be read (${e?.code ?? 'error'})` };
  }
}

/**
 * A JS file claims when, comments removed, a line passes `update` and `--claim` as separate
 * string literals (`execFileSync('bd', ['update', id, '--claim'])`), or hands a
 * `bd ... update ... --claim` string to an exec/spawn call. A test that only names a claim
 * string as data (`runHook('bd update X --claim')`) is not a claim.
 */
// A process-running call in inline code, then the two ways its command can be opaque: a
// non-literal first argument, or a literal the shell fills in with `$VAR` or a substitution.
const INLINE_EXEC = String.raw`\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|execa|system|popen|Popen|run|call|check_call|check_output)\(\s*`;
const INLINE_OPAQUE_RE = [
  new RegExp(INLINE_EXEC + String.raw`(?![\s'"\x60[)])`),
  new RegExp(INLINE_EXEC + String.raw`['"\x60\[][^)]*(?:\$(?:\{|\((?!\()|[A-Za-z_@*0-9])|\x60)`),
];
// Only code that can start a process: `re.exec(s)` and sqlite's `.run(x)` are not one.
const PROCESS_API_RE = /child_process|subprocess|\bos\.(?:system|popen|exec\w*|spawn\w*)|\bexeca\b|Bun\.spawn|\bIPC::|\bOpen3\b|\bKernel\.|^\s*(?:system|exec)\s*\(/m;

/** Index just past the `)` closing a call whose `(` ends before `i`; quotes respected, capped. */
function callSpanEnd(code, i) {
  let depth = 1;
  let quote = null;
  const stop = Math.min(code.length, i + 8000);
  for (let j = i; j < stop; j++) {
    const c = code[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return j + 1;
  }
  return stop;
}

export function jsClaims(text, { backticks = false } = {}) {
  const code = String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const claimText = /\bbd(?:\.exe)?\b[^'"]*\bupdate\b[^'"]*--claim(?![\w-])/;
  // A call's arguments may span lines (`execFileSync('bd', [\n 'update',\n id,\n '--claim'\n])`):
  // each process-running call is also judged as one line, its whole argument list joined.
  const spans = [];
  const callRe = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|execa|execaSync|system|popen|Popen|run|call|check_call|check_output|fork)\s*\(/g;
  for (let m; (m = callRe.exec(code)) !== null; ) {
    const end = callSpanEnd(code, m.index + m[0].length);
    spans.push(code.slice(m.index, end).replace(/\s+/g, ' '));
  }
  return [...code.split('\n'), ...spans].some(
    (line) =>
      (/['"`]update['"`]/.test(line) && /['"`]--claim(?:=[^'"`]*)?['"`]/.test(line)) ||
      (/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|execa|system|popen|Popen|run|call|check_call|check_output)\s*\(/.test(line) &&
        claimText.test(line)) ||
      // perl/ruby backticks run a shell command; in JS they are only a template literal.
      (backticks && /`[^`]*\bbd(?:\.exe)?\b[^`]*\bupdate\b[^`]*--claim(?![\w-])[^`]*`/.test(line)),
  );
}

/**
 * The first segment (at any depth) that runs a bare claim or that this hook could not verify,
 * or null. `kind` is 'claim' or 'unverifiable' (with a reason).
 * @param {string} cmd @param {string} [cwd] @param {number} [depth] @param {object} [fs]
 * @returns {{ seg: string, kind: 'claim' | 'unverifiable', reason?: string } | null}
 */
export function scanCommand(cmd, cwd = safeCwd(), depth = 0, fs = DEFAULT_FS, ctx = topContext()) {
  // The repository the hook runs in, fixed at the top level: the only place the approved helper lives.
  ctx.claimRoot ??= repoRoot(cwd) ?? path.resolve(cwd);
  // In a script's own text a whole-line comment is prose, not a command: a long script that
  // explains its claim handling in comments (worktree-new.sh does) must not count as mentioning
  // one, or an untracked/modified copy fails closed over its own documentation. The agent's own
  // command (argv === null) is never comment-stripped.
  const levelMentions = mentionsClaim(ctx.argv === null ? cmd : stripCommentLines(cmd));
  if (depth > MAX_DEPTH) {
    // Same scope as `unverifiable` below; a tracked, unmodified script is reviewed text.
    const refuse = ctx.argv === null ? ctx.strict || levelMentions : !ctx.trusted && levelMentions;
    if (!refuse) return null;
    return { seg: String(cmd).trim().slice(0, 120), kind: 'unverifiable', reason: `it nests wrappers or scripts more than ${MAX_DEPTH} deep` };
  }
  let dir = cwd;
  // Something the hook cannot resolve statically (a `$VAR` or substitution as the command word
  // or script path, `eval`/`source` of a non-literal) fails CLOSED where a claim could be meant:
  // in the agent's own command or an inline payload, when that text mentions bd or a claim (or
  // an outer level did); in an untracked or modified script, when the script mentions one; in a
  // tracked, unmodified script (reviewed text), when that line mentions a claim (`$BD list` in
  // the nightly hygiene tasks is an ordinary bd read). Otherwise it is skipped, so
  // ordinary shell (`for f in *.sh; do bash -n "$f"; done`, the node_modules/.bin shims) passes.
  const SKIP = Symbol('skip');
  const strictHere = ctx.strict || levelMentions;
  const unverifiable = (seg, reason) => {
    const refuse = ctx.argv === null ? strictHere : ctx.trusted ? /claim/i.test(seg.raw) : levelMentions;
    return refuse ? { seg: seg.raw, kind: 'unverifiable', reason } : SKIP;
  };
  const inner = ctx.argv === null ? { ...ctx, strict: strictHere } : ctx;
  for (const seg of shellSegments(stripHeredocBodies(cmd))) {
    if (segmentHasInlineHatch(seg.raw, HATCH_VAR)) continue;
    for (const body of seg.substitutions) {
      const hit = scanCommand(body, dir, depth + 1, fs, inner);
      if (hit) return hit;
    }
    // Assignments (`X=y`, `export X=y`, `local X=y`) feed the expansion of later script paths.
    const assigns = assignmentWords(stripKeywords(seg.words));
    if (assigns) {
      for (const w of assigns) {
        const eq = w.indexOf('=');
        const raw = w.slice(eq + 1);
        ctx.vars.set(w.slice(0, eq), { value: expandWord(raw, ctx, dir), raw });
      }
      continue;
    }
    const lead = skipCommandPrefix(seg.words);
    // `VAR=x bash child.sh`: the prefix assignments are the child's environment.
    const prefixEnv = {};
    for (const w of seg.words.slice(0, lead)) {
      if (ASSIGN_RE.test(w)) {
        const eq = w.indexOf('=');
        prefixEnv[w.slice(0, eq)] = expandWord(w.slice(eq + 1), ctx, dir) ?? '';
      }
    }
    let words = seg.words.slice(lead);
    if (words[0] !== undefined && /[$`]/.test(words[0])) {
      // `"$@"` as the command word runs the script's own arguments (gate.sh-style wrappers).
      if (/^\$(?:@|\*|\{@\}|\{\*\})$/.test(words[0])) {
        if (ctx.argv === null) {
          const u = unverifiable(seg, `its command word \`${words[0]}\` cannot be resolved`);
          if (u === SKIP) continue;
          return u;
        }
        const hit = scanCommand(ctx.argv.map(shellQuote).join(' '), dir, depth + 1, fs, { ...ctx, argv: null, strict: Boolean(ctx.callerStrict) });
        if (hit) return { ...hit, seg: seg.raw };
        continue;
      }
      const resolved = expandWord(words[0], ctx, dir);
      if (resolved === null) {
        // A variable this script assigned from a command (`GH=$(command -v gh)`) is opaque but
        // known: it is bd only if its assignment says so. Anything else is unverifiable.
        const known = assignedRaw(words[0], ctx);
        if (known === null || /\bbd\b/.test(known)) {
          const u = unverifiable(seg, `its command word \`${words[0]}\` cannot be resolved`);
          if (u !== SKIP) return u;
        }
        continue;
      }
      words = [resolved, ...words.slice(1)];
    }
    const [head = '', ...args] = words;
    if (head === 'cd') {
      if (args[0]) dir = resolveShellDir(dir, expandWord(args[0], ctx, dir) ?? args[0]);
      continue;
    }
    if (isClaimCall(words)) return { seg: seg.raw, kind: 'claim' };

    let payload = null;
    let script = null;
    let js = false;
    let code;
    const base = path.basename(head).toLowerCase();
    if (SHELLS.has(base)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (ci !== -1) payload = args[ci + 1] ?? null;
      else script = args.find((a) => !a.startsWith('-')) ?? null;
    } else if (POWERSHELLS.has(base)) {
      const ci = args.findIndex((a) => /^-(c|command)$/i.test(a));
      if (ci !== -1) payload = args.slice(ci + 1).join(' ');
    } else if (head === 'eval') {
      payload = args.join(' ');
    } else if (head === 'source' || head === '.') {
      script = args[0] ?? null;
    } else if ((code = inlineCode(base, args)) !== null) {
      const backticks = /^(?:perl|ruby)/.test(base);
      if (jsClaims(code, { backticks }) || scanCommandHasClaim(code, dir, depth, fs)) return { seg: seg.raw, kind: 'claim' };
      // Code that runs a command it builds at run time (`execSync(process.env.CMD)`, or a
      // `$VAR`/substitution the shell fills in) cannot be read for a claim: closed where one
      // could be meant.
      if (PROCESS_API_RE.test(code) && INLINE_OPAQUE_RE.some((re) => re.test(code))) {
        const u = unverifiable(seg, 'its inline code runs a command built at run time');
        if (u !== SKIP) return u;
      }
    } else if (base === 'node' || base === 'node.exe') {
      script = args.find((a) => !a.startsWith('-') && NODE_SCRIPT_RE.test(a)) ?? null;
      js = true;
    } else if (/[\\/]/.test(head) && !isBdCommand(head) && isScriptByPath(resolveShellDir(dir, head), fs)) {
      script = head;
      js = NODE_SCRIPT_RE.test(head);
    }

    if (payload !== null) {
      const hit = scanCommand(payload, dir, depth + 1, fs, inner);
      if (hit) return hit;
    }
    if (script && !(js && isJsDataFile(script))) {
      // A path the hook cannot resolve (`bash "$SCRIPT"` with SCRIPT unknown) is unverifiable:
      // treating the literal `$SCRIPT` as a missing file would let any script through.
      const expanded = expandWord(script, ctx, dir);
      if (expanded === null) {
        const u = unverifiable(seg, `the script path \`${script}\` depends on a value it cannot resolve`);
        if (u === SKIP) continue;
        return u;
      }
      const file = resolveShellDir(dir, expanded);
      const found = classifyScript(file, fs, ctx.claimHelper, ctx.claimRoot);
      // A script whose text cannot be read cannot be checked for a mention either: always closed.
      if (found.kind === 'unverifiable') return { seg: seg.raw, kind: 'unverifiable', reason: `\`${script}\`: ${found.reason}` };
      if (found.kind === 'text') {
        if (js) {
          if (jsClaims(found.text)) return { seg: seg.raw, kind: 'claim' };
        } else {
          const at = words.indexOf(script);
          const argv = (at === -1 ? [] : words.slice(at + 1)).map((a) => expandWord(a, ctx, dir) ?? a);
          const childEnv = { ...ctx.env, ...prefixEnv };
          for (const [k, v] of ctx.vars) if (v.value !== null && /^[A-Z_][A-Z0-9_]*$/.test(k)) childEnv[k] ??= v.value;
          // callerStrict: how strictly this script's own arguments are judged when it runs them
          // back (`"$@"`): as strictly as the level that passed them.
          const callerStrict = ctx.argv === null ? strictHere : !ctx.trusted && levelMentions;
          const child = { vars: new Map(), argv, scriptDir: path.dirname(file), env: childEnv, trusted: isTrackedClean(file), callerStrict, claimHelper: ctx.claimHelper, claimRoot: ctx.claimRoot };
          const hit = scanCommand(found.text, path.dirname(file), depth + 1, fs, child);
          if (hit) return { ...hit, seg: seg.raw };
        }
      }
    }
  }
  return null;
}

/** The context of the agent's own command: no script arguments, no script directory. */
export function topContext(env = process.env, claimHelper = DEFAULTS.claimHelper) {
  return { vars: new Map(), argv: null, scriptDir: null, env, trusted: false, claimHelper };
}

/**
 * True when `file` is tracked by git and has no uncommitted change: reviewed text. An untracked,
 * ignored or modified file, a file outside any repo, or a git failure is untrusted.
 */
const trackedCache = new Map();

export function isTrackedClean(file) {
  if (!trackedCache.has(file)) trackedCache.set(file, checkTrackedClean(file));
  return trackedCache.get(file);
}

function checkTrackedClean(file) {
  try {
    const dir = path.dirname(file);
    const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 };
    const tracked = execFileSync('git', ['ls-files', '--', path.basename(file)], opts).trim();
    if (!tracked) return false;
    return execFileSync('git', ['status', '--porcelain', '--', path.basename(file)], opts).trim() === '';
  } catch {
    return false;
  }
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const DECLARE_WORDS = new Set(['export', 'local', 'readonly', 'declare', 'typeset']);

const LEADING_KEYWORDS = new Set(['do', 'then', 'else', '{', '(', '!', 'elif']);

function stripKeywords(words) {
  let i = 0;
  while (i < words.length && LEADING_KEYWORDS.has(words[i])) i++;
  return words.slice(i);
}

/** The raw assignment text of a `$NAME` / `${NAME}` word this script assigned, or null. */
function assignedRaw(word, ctx) {
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(word);
  const v = m ? ctx.vars.get(m[1]) : undefined;
  return v ? v.raw : null;
}

/** The assignment words of a segment that only assigns, or null when it runs a command. */
function assignmentWords(words) {
  if (words.length === 0) return null;
  if (words.every((w) => ASSIGN_RE.test(w))) return words;
  if (DECLARE_WORDS.has(words[0])) return words.slice(1).filter((w) => ASSIGN_RE.test(w));
  return null;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** A substitution or `${...}` that names the running script's own directory. */
const SCRIPT_DIR_IDIOM = /\bdirname\b|BASH_SOURCE|^\$?\{?0%|\bpwd\b|\$PWD/;

/**
 * Expand `$VAR`, `${VAR}`, `${VAR:-default}`, `$1`..`$9`, `$@`, `$0` and the script-directory
 * idioms (`$(dirname "$0")`, `${BASH_SOURCE%/*}`, `$(cd ... && pwd)`) in a word. A name is looked
 * up in this script's assignments, then its arguments, then the environment. Returns null when
 * any part cannot be resolved, so a caller can fail closed.
 */
export function expandWord(word, ctx, dir) {
  const s = String(word);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`' || (c === '$' && s[i + 1] === '(')) {
      const sub = readSubstitution(s, i);
      if (!sub) return null;
      if (/rev-parse\s+--show-toplevel/.test(sub.body)) {
        const root = repoRoot(ctx.scriptDir ?? dir);
        if (root === null) return null;
        out += root;
      } else if (SCRIPT_DIR_IDIOM.test(sub.body)) {
        out += ctx.scriptDir ?? dir;
      } else {
        return null;
      }
      i = sub.end - 1;
      continue;
    }
    if (c !== '$') {
      out += c;
      continue;
    }
    let name;
    let fallback = null;
    let end;
    if (s[i + 1] === '{') {
      end = s.indexOf('}', i + 2);
      if (end === -1) return null;
      const inner = s.slice(i + 2, end);
      if (SCRIPT_DIR_IDIOM.test(inner) || /^0[%#]/.test(inner)) {
        out += ctx.scriptDir ?? dir;
        i = end;
        continue;
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*])(?::?-(.*))?$/.exec(inner);
      if (!m) return null;
      name = m[1];
      fallback = m[2] ?? null;
    } else {
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*])/.exec(s.slice(i + 1));
      if (!m) {
        out += c; // a lone `$`
        continue;
      }
      name = m[1];
      end = i + m[1].length;
    }
    const value = lookupVar(name, ctx);
    const v = value ?? (fallback !== null ? expandWord(fallback, ctx, dir) : null);
    if (v === null) return null;
    out += v;
    i = end;
  }
  return out;
}

/**
 * A name's value: this script's assignment, its arguments, then the environment; null when
 * it cannot be known statically.
 */
function lookupVar(name, ctx) {
  const inScript = ctx.argv !== null;
  if (/^[1-9]$/.test(name)) return inScript ? (ctx.argv[Number(name) - 1] ?? '') : null;
  if (name === '@' || name === '*') return inScript ? ctx.argv.join(' ') : null;
  if (name === '0') return ctx.scriptDir ? path.join(ctx.scriptDir, 'script') : null;
  if (ctx.vars.has(name)) return ctx.vars.get(name).value;
  const env = ctx.env?.[name];
  if (env !== undefined) return String(env);
  // A name this scan never saw assigned may still be set at run time (`read`, `for`, a
  // function, a sourced file), so it is unresolvable; the caller fails closed only where a
  // claim could be meant.
  return null;
}

const MENTION_RE = /\bbd(?:\.exe)?\b|--claim|claim/i;

/** Does this text mention bd or a claim, in its raw form or with quotes removed? */
export function mentionsClaim(text) {
  const s = String(text);
  if (MENTION_RE.test(s)) return true;
  return shellSegments(s).some((seg) => MENTION_RE.test(seg.words.join(' ')));
}

/** The git top-level holding `dir` (the nearest ancestor with a `.git`), or null. */
function repoRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      statSync(path.join(cur, '.git'));
      return cur;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
}

/** Inline code (`python -c "import os; os.system('bd update X --claim')"`) may also be shell text. */
function scanCommandHasClaim(code, dir, depth, fs) {
  return scanCommand(code, dir, depth + 1, fs)?.kind === 'claim';
}

const SCRIPT_EXT_RE = /\.(?:sh|bash|zsh|ksh|mjs|cjs|js)$/i;

/**
 * A command word given as a path is scanned only when it is a script: a script extension, a
 * `#!` first line, or text. A binary (`/usr/bin/git`, `./bd.exe`) runs no shell text, so it is not read,
 * and a missing file is ENOENT as before (classifyScript decides that).
 */
function isScriptByPath(file, fs) {
  if (SCRIPT_EXT_RE.test(file)) return true;
  const open = fs.openSync ?? openSync;
  const read = fs.readSync ?? readSync;
  const close = fs.closeSync ?? closeSync;
  let fd;
  try {
    fd = open(file, 'r');
  } catch (e) {
    return e?.code !== 'ENOENT' && e?.code !== 'EISDIR'; // unreadable: let classifyScript refuse it
  }
  try {
    // Text is a script even without `#!`: bash runs a shebangless executable as shell (its
    // ENOEXEC fallback). Only a binary (ELF, PE `MZ`, Mach-O, or any NUL byte) is skipped.
    const buf = Buffer.alloc(512);
    const n = read(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, n);
    if (head.subarray(0, 2).toString('latin1') === '#!') return true;
    const magic = head.subarray(0, 4).toString('hex');
    if (magic === '7f454c46' || magic.startsWith('4d5a') || /^(?:feedfac[ef]|cffaedfe|cefaedfe|cafebabe)$/.test(magic)) return false;
    return !head.includes(0);
  } catch {
    return true;
  } finally {
    try {
      close(fd);
    } catch {
      /* already closed */
    }
  }
}

/** The segment that runs a bare claim or could not be verified, or null. */
export function bareClaimSegment(cmd, cwd = safeCwd(), depth = 0, fs = DEFAULT_FS) {
  return scanCommand(cmd, cwd, depth, fs)?.seg ?? null;
}

export function unverifiableMessage(reason, claimHelper = DEFAULTS.claimHelper) {
  const name = path.basename(claimHelper ?? DEFAULTS.claimHelper);
  return (
    `Blocked: could not resolve; use ${name} or the hatch. This command may run a bd claim, and ${reason}. ` +
    `A claim must go through \`bash ${claimHelper} <id> --claim-only\` (or \`<id> <branch>\`), which ` +
    "refuses another actor's claim younger than 4h. If the script genuinely claims nothing, prefix " +
    `the SAME command with \`${HATCH_VAR}=1\`; a deliberate takeover of a claimed bead is ` +
    `\`AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bash ${claimHelper} <id> ...\`. ` +
    NOTHING_RAN_NOTICE +
    consumerHint(import.meta.url)
  );
}

export function refusalMessage(claimHelper = DEFAULTS.claimHelper) {
  const name = path.basename(claimHelper ?? DEFAULTS.claimHelper);
  return (
    `Blocked: claim a bead with \`bash ${claimHelper} <id> <branch>\` (new worktree) or ` +
    `\`bash ${claimHelper} <id> --claim-only\` (already in one), never a bare \`bd update --claim\`, ` +
    `including one inside \`bash -c\`, \`eval\`, a substitution or a script. ${name} pulls Dolt first, ` +
    "claims under your per-session id, refuses another actor's claim younger than 4h and publishes " +
    'the claim; a bare --claim does none of that. A deliberate takeover is ' +
    `\`AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bash ${claimHelper} <id> ...\`. If you truly need the bare form, prefix it with \`${HATCH_VAR}=1\`. ` +
    NOTHING_RAN_NOTICE +
    consumerHint(import.meta.url)
  );
}

/** Cheap pre-filter: a claim, or something that might run a script, or a wrapper. */
// Cheap pre-filter. Any path counts: a shebangless text file run by path is a script too.
const WORTH_SCANNING = /--claim(?![\w-])|[\\/]|\.(?:sh|mjs|cjs|js)\b|\beval\b|\b(?:source|bash|sh|zsh|dash|ksh)\b|^\s*\.\s/m;

export function main(env = process.env) {
  try {
    if (env[HATCH_VAR] === '1') return 0;
    const cmd = readToolCommand();
    if (!cmd || !WORTH_SCANNING.test(cmd)) return 0;
    const { config, error } = tryLoadConfig({ from: safeCwd() });
    if (error) process.stderr.write(`agent-tooling config ignored: ${error}\n`);
    const claimHelper = config.claimHelper ?? DEFAULTS.claimHelper;
    const hit = scanCommand(cmd, safeCwd(), 0, DEFAULT_FS, topContext(env, claimHelper));
    if (hit === null) return 0;
    process.stderr.write(hit.kind === 'unverifiable' ? unverifiableMessage(hit.reason, claimHelper) : refusalMessage(claimHelper));
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
