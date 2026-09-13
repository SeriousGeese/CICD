// Shared refusal-message pieces for every PreToolUse guard in this set.
//
// NOTHING_RAN_NOTICE: a PreToolUse hook is all-or-nothing over the WHOLE command
// string handed to the Bash/PowerShell/Write/Edit tool. When it exits 2, NONE of
// that string ran, not even a step that looked like it would succeed on its own:
// `rm -f X && git checkout -- Y` blocked on the checkout half means the `rm` never
// happened either. A refusal that does not say so reads like "this part is wrong",
// and an agent then reasons from a tree state that never existed. Every guard
// appends this sentence to every refusal it emits, so the wording cannot drift.
//
// consumerHint: this set is vendored into several repositories, and a repository
// sometimes has a better local answer than the generic refusal can name (a gate
// wrapper script, a doc section). Rather than teach the shared source about any
// one repository, a consumer drops `<guard>.hint.txt` beside the vendored guard
// and its trimmed contents are appended to that guard's refusals. The hint file
// is the consumer's own, so `sync.mjs --check` ignores it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NOTHING_RAN_NOTICE =
  'NOTHING in this command ran — a PreToolUse hook rejects the WHOLE command string before any of it ' +
  'executes, so anything chained with the blocked part (&&, ;, |, or a step before it) never ran either.';

/**
 * The consumer's `<guard>.hint.txt` beside the guard file, as ` <text>`, or `''` when there
 * is none.
 *
 * Never throws, deliberately: every guard wraps its work in a fail-OPEN catch, so a throw
 * from here would turn a refusal into an ALLOWED command. But only a missing file is
 * silent. Any other failure (permissions, a directory where the file should be) is named in
 * the refusal, because a hint that exists and cannot be read is a problem someone should see.
 * @param {string} guardUrl the guard's `import.meta.url`
 * @returns {string}
 */
export function consumerHint(guardUrl) {
  let hintPath = '';
  try {
    hintPath = fileURLToPath(guardUrl).replace(/\.mjs$/, '.hint.txt');
    const text = readFileSync(hintPath, 'utf8').trim();
    return text ? ` ${text}` : '';
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err)?.code;
    if (code === 'ENOENT') return '';
    const name = hintPath ? hintPath.split(/[\\/]/).pop() : 'hint file';
    return ` [${name} exists but could not be read: ${code ?? String(err)}]`;
  }
}
