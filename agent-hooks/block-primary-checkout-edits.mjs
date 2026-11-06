#!/usr/bin/env node
// PreToolUse(Write/Edit/MultiEdit/NotebookEdit) hook: block accidental edits in
// the primary checkout. Feature work should happen in real git worktrees where
// `.git` is a file, not in the shared checkout where `.git` is a directory.
//
// Blocking contract: exit 2 + stderr message (fed back to Claude). Unexpected
// failures fail open so the guard never bricks legitimate editing.
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTHING_RAN_NOTICE, consumerHint } from './refusal-notice.mjs';
import { readHookInput } from './hook-input.mjs';
import { findRoot, tryLoadConfig, worktreeName } from './agent-tooling-config.mjs';

if (process.env.AGENT_HOOKS_ALLOW_MAIN_CHECKOUT_EDITS === '1') {
  process.exit(0);
}

function nearestExistingPath(candidate) {
  let current = path.resolve(candidate);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/**
 * The guard protects the primary checkout of the repository that vendors this hook, and only
 * that one. A sibling repo that is not the consumer (a fresh `git init`, another project) has a
 * `.git` directory too, but the consumer's worktree rule does not cover it and its remedy
 * (`worktree add ... origin/main`) may not even apply. A checkout belongs to the consumer when
 * it carries this hook's own file at the same path, relative to the repo root, that this copy
 * has: true of every clone of the consumer, false of everything else, and needs no git call or
 * remote parsing. The relative path comes from where this file actually sits, so it holds for
 * whatever directory the consumer vendors the hooks into.
 */
function ownMarker() {
  const self = realpathSync(fileURLToPath(import.meta.url));
  return path.relative(findRoot(path.dirname(self)), self);
}

function isConsumerCheckout(root) {
  return existsSync(path.join(root, ownMarker()));
}

function gitRootKindFor(targetPath) {
  const existing = nearestExistingPath(targetPath);
  if (!existing) return null;

  let current = realpathSync(existing);
  const stat = statSync(current);
  if (!stat.isDirectory()) current = path.dirname(current);

  while (true) {
    const gitPath = path.join(current, '.git');
    if (existsSync(gitPath)) {
      const gitStat = statSync(gitPath);
      return {
        root: current,
        kind: gitStat.isDirectory() ? 'primary' : 'worktree',
      };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Paths that are session scaffolding rather than project content, and are therefore
 * allowed in the primary checkout.
 *
 * `.handoffs/` holds the prompts `/promptNextWork` writes for the NEXT session. It needs a
 * stable, repo-scoped home that outlives the session that wrote it: a session scratchpad is
 * named for its own session and is scratch, and a worktree is torn down when its PR merges.
 * It is gitignored, so nothing here is ever tracked project content — which is exactly
 * what this guard exists to protect. The exemption matches the FIRST path segment only, so
 * a nested `src/.handoffs/` or a file merely named `.handoffs-notes.md` is still blocked.
 */
const PRIMARY_CHECKOUT_EXEMPT_DIRS = ['.handoffs'];

function isExempt(filePath, root) {
  const rel = path.relative(root, path.resolve(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const [first] = rel.split(path.sep);
  return PRIMARY_CHECKOUT_EXEMPT_DIRS.includes(first);
}

function extractFilePaths(toolInput) {
  return [
    toolInput?.file_path,
    toolInput?.notebook_path,
    ...(Array.isArray(toolInput?.edits)
      ? toolInput.edits.map((edit) => edit?.file_path).filter(Boolean)
      : []),
  ].filter((value) => typeof value === 'string' && value.length > 0);
}

try {
  const payload = readHookInput();
  const filePaths = extractFilePaths(payload?.tool_input);
  if (filePaths.length === 0) process.exit(0);

  for (const filePath of filePaths) {
    const verdict = gitRootKindFor(filePath);
    if (verdict?.kind !== 'primary') continue;
    if (!isConsumerCheckout(verdict.root)) continue;
    if (isExempt(filePath, verdict.root)) continue;

    // The block is decided; only the advice depends on config, so a failure here must still
    // block (the outer catch fails open), with generic advice.
    let suggested = '../<repo>-<name>';
    try {
      const { config: cfg, error } = tryLoadConfig({ root: verdict.root });
      if (error) process.stderr.write(`[agent-tooling] ${error}\n`);
      suggested = `${cfg.worktreeRoot.replace(/[/\\]+$/, '')}/${worktreeName(cfg, '<name>')}`;
    } catch {
      // keep the generic advice
    }
    process.stderr.write(
      `Blocked: ${filePath} is inside the PRIMARY checkout (${verdict.root}), not an isolated worktree. ` +
        'Feature work must happen in a real worktree. Create one with: ' +
        `git -C ${verdict.root} worktree add ${suggested} -b <branch> origin/main ` +
        'then pass that worktree\'s absolute paths to Write/Edit. ' +
        'If the user explicitly asked to edit the primary checkout, relaunch Claude with AGENT_HOOKS_ALLOW_MAIN_CHECKOUT_EDITS=1. ' +
        NOTHING_RAN_NOTICE +
        consumerHint(import.meta.url),
    );
    process.exit(2);
  }
} catch (err) {
  // Fail open. Malformed hook input stays silent (not this guard's business), but a filesystem
  // error (findRoot now rethrows a stat error that is not "absent", such as EACCES or ELOOP)
  // means an edit went unchecked, so it leaves a trace.
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  if (code) {
    process.stderr.write(
      `[agent-tooling] block-primary-checkout-edits could not check this edit, allowing it: ${/** @type {Error} */ (err).message}\n`,
    );
  }
  process.exit(0);
}

process.exit(0);
