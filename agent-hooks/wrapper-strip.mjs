/**
 * skipCommandPrefix() / stripGroupingParens().
 *
 * Every guard in the `guards` set splits a Bash command on `&&`, `||`, `;`, `|` and
 * newlines and then asks "what is the command word of this segment?". Getting there means
 * skipping whatever LEADS the segment without being the command: `VAR=val` assignments,
 * `env [-u X] …`, `rtk [proxy]`, sudo/nice/command/time/nohup/exec, `timeout [opts] <dur>`,
 * and the loop / conditional / grouping keywords a `;` split leaves at the front of a
 * segment — `for f in a; do git checkout -- f; done` yields the segment
 * `do git checkout -- f`, and `if …; then git restore x; fi` yields `then git restore x`.
 *
 * The claim guard learned the keyword half first. The other guards each carried their own
 * copy of the wrapper loop WITHOUT it, so a dirty-file restore inside a `for`/`if`/`while`
 * body sailed past block-uncommitted-restore.mjs and discarded the edit. This is the one copy
 * now; the guards agree because they share it. (The `core` guards keep their own stripping,
 * so the `core` set stays as it was.)
 */

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER_WORDS = new Set(['sudo', 'nice', 'command', 'time', 'nohup', 'exec']);
// Keywords that lead a segment once the command is split on `;`.
const KEYWORD_WORDS = new Set(['do', 'then', 'else', '{', '(', '!']);

/**
 * Index of the first token in `toks` that is the segment's actual command word, after
 * skipping assignments, wrappers and shell keywords.
 *
 * @param {string[]} toks tokens of ONE segment
 * @param {{ skipCd?: boolean, extraWrappers?: Iterable<string> }} [opts]
 *   skipCd: also skip a `cd <dir>` prefix (for a guard that does not care about the
 *     directory). Guards that TRACK the directory leave this off and look at
 *     `toks[i] === 'cd'` themselves.
 *   extraWrappers: further bare wrapper words to skip (e.g. PowerShell's `&`).
 * @returns {number}
 */
export function skipCommandPrefix(toks, { skipCd = false, extraWrappers = [] } = {}) {
  const extra = new Set(extraWrappers);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (ASSIGNMENT_RE.test(t)) {
      i++;
      continue;
    }
    if (skipCd && t === 'cd') {
      i += 2;
      continue;
    }
    if (WRAPPER_WORDS.has(t) || extra.has(t)) {
      i++;
      continue;
    }
    // `timeout 90 bd create …` is the wrapper AGENTS.md prescribes for every bd
    // write: skip the options that take a value, the flags, then the duration.
    if (t === 'timeout') {
      i++;
      while (i < toks.length && toks[i].startsWith('-')) {
        i += toks[i] === '-s' || toks[i] === '-k' || toks[i] === '--signal' || toks[i] === '--kill-after' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (KEYWORD_WORDS.has(t)) {
      i++;
      continue;
    }
    if (t === 'rtk') {
      i++;
      if (toks[i] === 'proxy') i++;
      continue;
    }
    if (t === 'env') {
      i++;
      while (i < toks.length) {
        const e = toks[i];
        if (e === '-u' || e === '--unset') {
          i += 2;
          continue;
        }
        if (e === '-i' || e === '--ignore-environment' || e === '-') {
          i++;
          continue;
        }
        if (ASSIGNMENT_RE.test(e)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return i;
}

/**
 * Detach subshell parentheses glued to a segment's words, for a whitespace tokenizer.
 * `(cd x && git checkout -- f.txt)` splits into the segments `(cd x` and
 * `git checkout -- f.txt)`; without this the first segment's command word is `(cd` and the
 * second one's last path is `f.txt)`, a file that does not exist and so reads as clean.
 *
 * Leading `(` characters on the first token become their own `(` tokens (which
 * skipCommandPrefix then skips); trailing `)` characters on the last token are dropped
 * when that token has more `)` than `(` (so `$(pwd)` and `f(1).txt` are left alone), and a
 * bare trailing `)` token is dropped. `$(` and the arithmetic `((` are not touched.
 *
 * @param {string[]} toks
 * @returns {string[]}
 */
export function stripGroupingParens(toks) {
  const out = [...toks];
  if (out.length > 0) {
    const first = out[0];
    const m = /^\((?!\()/.exec(first);
    if (m && first.length > 1) out.splice(0, 1, '(', first.slice(1));
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === ')') {
      out.pop();
      continue;
    }
    const opens = (last.match(/\(/g) ?? []).length;
    let closes = (last.match(/\)/g) ?? []).length;
    let trimmed = last;
    while (closes > opens && trimmed.endsWith(')')) {
      trimmed = trimmed.slice(0, -1);
      closes--;
    }
    if (trimmed === last) break;
    if (trimmed === '') out.pop();
    else out[out.length - 1] = trimmed;
    break;
  }
  return out;
}
