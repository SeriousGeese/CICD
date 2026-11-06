#!/usr/bin/env node
// SessionStart hook: on a Windows host, print a short banner about the shell traps there.
//
// A repository that keeps its Windows shell rules in a doc (rather than loading them into
// every session on every host) wants a Windows session pointed at that doc. The doc is the
// consumer's, so the pointer is too: a consumer drops `windows-shell-pointer.hint.txt` beside
// this file and its trimmed contents are appended to the banner (see consumerHint in
// refusal-notice.mjs). Without a hint the banner carries only the generic advice below.
// It prints nothing on any other platform.
//
// Same contract as the other SessionStart hooks: plain text on STDOUT, always exit 0, and never
// the reason a session fails to start.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { consumerHint } from './refusal-notice.mjs';

/** The banner for `platform`, or an empty string when the host is not Windows. */
export function windowsShellPointer(platform = process.platform) {
  if (platform !== 'win32') return '';
  return (
    '[windows-shell] This is a Windows host. Check the shell you are in before your first command: ' +
    'forward-slash paths in Bash, MSYS path mangling of arguments that mix a colon with slashes, ' +
    '.cmd shims, and CRLF line endings before a byte comparison.' +
    consumerHint(import.meta.url)
  );
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
  const banner = windowsShellPointer();
  if (banner) console.log(banner);
}
