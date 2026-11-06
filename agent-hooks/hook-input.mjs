/**
 * readHookInput() / readToolCommand().
 *
 * The guards in the `guards` set (block-uncommitted-restore.mjs,
 * block-worktree-branch-switch.mjs, block-primary-checkout-edits.mjs, block-npx-unlisted.mjs,
 * block-bare-claim.mjs and others) each read the Claude Code tool-call JSON from stdin with
 * `JSON.parse(readFileSync(0,'utf8'))?.tool_input?.command ?? ''`. This is that one-liner,
 * shared. The `core` guards carry their own copy so the `core` set stays as it was.
 *
 * Every caller here already runs inside its own top-level try/catch and fails OPEN on an
 * unreadable/unparseable stdin, so these deliberately do NOT swallow a JSON.parse failure —
 * that is the caller's contract to keep, not this module's to change.
 */
import { readFileSync } from 'node:fs';

/** Parse the Claude Code PreToolUse JSON payload off stdin (fd 0). Throws on bad input. */
export function readHookInput() {
  return JSON.parse(readFileSync(0, 'utf8'));
}

/** The `tool_input.command` string off stdin, or `''` when absent. Throws on bad input. */
export function readToolCommand() {
  return readHookInput()?.tool_input?.command ?? '';
}
