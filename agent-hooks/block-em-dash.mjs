// Pre-commit hook: block em-dash (U+2014) and en-dash (U+2013) that a commit ADDS to
// authored prose: the .md/.txt files under the path prefixes a repository lists in
// `emDashPaths` in its agent-tooling.json (for example ["content/"]).
//
// Why: em-dashes and en-dashes render as odd punctuation in some readers and terminal clients,
// and are a tell of machine-written prose. The house style is plain ASCII hyphens (-- or -).
//
// Wired into a pre-commit hook. In hook mode it reads the STAGED DIFF and looks only at ADDED
// lines of .md/.txt files under the configured prefixes, so:
//   - a commit that touches a file which already holds dashes is not blocked for text its
//     author never typed;
//   - files outside the configured prefixes (docs, code) are out of scope;
//   - an empty `emDashPaths` (the default) means hook mode checks nothing at all;
//   - a commit with nothing staged under the prefixes does nothing at all.
// It does NOT auto-fix. Escape hatch for a deliberate dash: AGENT_HOOKS_ALLOW_EM_DASH=1.
//
// Standalone check of whole files (every line, not just added ones; no config involved):
//   node <hooks dir>/block-em-dash.mjs [file1] [file2] ...

import { readFileSync, existsSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tryLoadConfig } from './agent-tooling-config.mjs';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const TEXT_EXTS = new Set(['.md', '.txt']);

/** Does repo-relative `file` sit under one of the configured prefixes (a directory or a file)? */
function inScope(file, prefixes) {
  return prefixes.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p || file.startsWith(`${p}/`)));
}

/** Every em/en dash in one line of text, as violations at `file:lineNo`. */
function lineViolations(file, lineNo, line) {
  const out = [];
  for (const [ch, name] of [[EM_DASH, 'em-dash (U+2014)'], [EN_DASH, 'en-dash (U+2013)']]) {
    const idx = line.indexOf(ch);
    if (idx !== -1) {
      out.push({
        file,
        line: lineNo,
        col: idx + 1,
        char: name,
        context: line.trim().slice(Math.max(0, idx - 20), idx + 20),
      });
    }
  }
  return out;
}

function scanFile(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  return lines.flatMap((line, i) => lineViolations(filePath, i + 1, line));
}

/**
 * The ADDED lines of every staged .md/.txt under one of `prefixes`, from `git diff --cached -U0`.
 * Line numbers are the new file's, read off each hunk header. No prefixes, nothing to scan.
 */
function scanStagedAdditions(prefixes) {
  if (prefixes.length === 0) return { scanned: 0, violations: [] };
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR', '--', ...prefixes], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { scanned: 0, violations: [] }; // not in a git context
  }
  const violations = [];
  let file = null;
  let lineNo = 0;
  let scanned = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      file = path && inScope(path, prefixes) && TEXT_EXTS.has(extname(path)) ? path : null;
      if (file) scanned++;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      violations.push(...lineViolations(file, lineNo, raw.slice(1)));
      lineNo++;
    }
  }
  return { scanned, violations };
}

function report(violations, what) {
  console.error(`[block-em-dash] FAIL - found ${violations.length} non-ASCII dash(es) in ${what}:`);
  console.error('');
  for (const v of violations) {
    // Printed as git names it, with forward slashes: on Windows `relative` answers with backslashes.
    console.error(`  ${(relative(process.cwd(), v.file) || v.file).replaceAll('\\', '/')}:${v.line}:${v.col} - ${v.char}`);
    console.error(`    ...${v.context}...`);
    console.error('');
  }
  console.error('Replace em-dashes and en-dashes with a single hyphen (-) in all prose.');
  console.error('Use -- (double hyphen) only for markdown formatting or code flags.');
  console.error('Non-ASCII dashes render incorrectly in some readers and terminal clients.');
}

function main() {
  if (process.argv.length > 2) {
    const files = process.argv.slice(2).filter((f) => TEXT_EXTS.has(extname(f)));
    if (files.length === 0) {
      console.log('[block-em-dash] No .md/.txt files to scan.');
      return;
    }
    const violations = files.flatMap(scanFile);
    if (violations.length === 0) {
      console.log(`[block-em-dash] OK - no em-dashes or en-dashes found in ${files.length} file(s).`);
      return;
    }
    report(violations, `${files.length} file(s)`);
    process.exit(1);
  }

  const { config: cfg, error } = tryLoadConfig({ from: process.cwd() });
  if (error) console.error(`[agent-tooling] ${error}`);
  const prefixes = [...cfg.emDashPaths];
  const { scanned, violations } = scanStagedAdditions(prefixes);
  if (scanned === 0 || violations.length === 0) return; // silent on the common path
  if (process.env.AGENT_HOOKS_ALLOW_EM_DASH === '1') {
    console.error(`[block-em-dash] AGENT_HOOKS_ALLOW_EM_DASH=1 - allowing ${violations.length} added dash(es).`);
    return;
  }
  report(violations, `lines this commit adds under ${prefixes.join(', ')}`);
  console.error('Deliberate? Re-run the commit with AGENT_HOOKS_ALLOW_EM_DASH=1.');
  process.exit(1);
}

main();
