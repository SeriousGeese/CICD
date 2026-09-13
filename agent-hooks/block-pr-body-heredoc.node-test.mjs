import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hook = fileURLToPath(new URL('./block-pr-body-heredoc.mjs', import.meta.url));

function runHook(command, { env = {} } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const BLOCKED = /heredoc feeding/;

// ── Blocked: the five-occurrence failure shape ──────────────────────────────
test('blocks gh pr create with a body-substitution heredoc', () => {
  const r = runHook(
    'gh pr create --title "feat: x" --body "$(cat <<\'EOF\'\nlong body\nEOF\n)"',
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, BLOCKED);
  assert.match(r.stderr, /--body-file/);
});

test('blocks gh pr create fed by a bare heredoc', () => {
  const r = runHook("gh pr create --title x --body-file - <<'EOF'\nbody\nEOF");
  assert.equal(r.status, 2);
});

test('blocks gh pr edit with a heredoc', () => {
  const r = runHook('gh pr edit 123 --body "$(cat <<EOF\nbody\nEOF\n)"');
  assert.equal(r.status, 2);
});

test('blocks the <<- indented-heredoc form', () => {
  const r = runHook("gh pr create --title x --body \"$(cat <<-'EOF'\n\tbody\n\tEOF\n)\"");
  assert.equal(r.status, 2);
});

test('blocks through the env -u GITHUB_TOKEN wrapper', () => {
  const r = runHook("env -u GITHUB_TOKEN gh pr create --title x --body \"$(cat <<'EOF'\nb\nEOF\n)\"");
  assert.equal(r.status, 2);
});

test('blocks through the rtk wrapper', () => {
  const r = runHook("rtk gh pr create --title x --body \"$(cat <<'EOF'\nb\nEOF\n)\"");
  assert.equal(r.status, 2);
});

test('blocks with a --repo global flag before the subcommand', () => {
  const r = runHook("gh --repo example/app pr create --title x --body \"$(cat <<'EOF'\nb\nEOF\n)\"");
  assert.equal(r.status, 2);
});

// ── Allowed: the prescribed pattern and non-matching shapes ─────────────────
test('allows gh pr create --body-file with no heredoc', () => {
  const r = runHook('env -u GITHUB_TOKEN gh pr create --title x --body-file /tmp/body.md');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('allows a short inline --body string', () => {
  const r = runHook('gh pr create --title x --body "one-line body"');
  assert.equal(r.status, 0);
});

test('allows a heredoc in a DIFFERENT segment of the same command', () => {
  // Writing the file via heredoc then passing --body-file: the gh segment itself
  // carries no heredoc, so this passes (the Write tool is still the better move).
  const r = runHook("cat > body.md <<'EOF'\nbody\nEOF\ngh pr create --title x --body-file body.md");
  assert.equal(r.status, 0);
});

test('allows a herestring (<<<) — different mechanism, never failed', () => {
  const r = runHook('gh pr create --title x --body "$(cat <<<"$BODY")"');
  assert.equal(r.status, 0);
});

test('allows gh subcommands other than pr create/edit with heredocs', () => {
  for (const c of [
    "gh pr comment 5 --body-file - <<'EOF'\nhi\nEOF",
    "gh api graphql -f query=@- <<'EOF'\nquery {}\nEOF",
    "gh pr view 5 <<'EOF'\nx\nEOF",
  ]) {
    assert.equal(runHook(c).status, 0, c);
  }
});

test('allows SMALL non-gh heredocs entirely', () => {
  const r = runHook("cat <<'EOF'\nnot a pr\nEOF");
  assert.equal(r.status, 0);
});

// ── Rule 2: any LARGE command carrying a heredoc  ─
// The EOF failure reproduced on a plain `cat >>` heredoc with ~10 KB of ASCII
// and rtk was exonerated — the class is command size, not `gh pr`. The guard
// triggers above LARGE_COMMAND_BYTES (4000), well below the observed ~9 KB floor.
const LARGE_BODY = 'x'.repeat(4200);

test('blocks a large non-gh heredoc (the entry-57 cat >> shape)', () => {
  const r = runHook(`cat >> notes.md <<'ODDITIES'\n${LARGE_BODY}\nODDITIES`);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /carries a heredoc/);
  assert.match(r.stderr, /Write tool/);
  assert.match(r.stderr, /AGENT_HOOKS_ALLOW_LARGE_HEREDOC/);
});

test('blocks a large gh pr heredoc even when the PR-body hatch is set', () => {
  const r = runHook(`gh pr create --title x --body "$(cat <<'EOF'\n${LARGE_BODY}\nEOF\n)"`, {
    env: { AGENT_HOOKS_ALLOW_PR_BODY_HEREDOC: '1' },
  });
  assert.equal(r.status, 2);
});

test('escape hatch AGENT_HOOKS_ALLOW_LARGE_HEREDOC=1 allows a large heredoc', () => {
  const r = runHook(`cat >> notes.md <<'ODDITIES'\n${LARGE_BODY}\nODDITIES`, {
    env: { AGENT_HOOKS_ALLOW_LARGE_HEREDOC: '1' },
  });
  assert.equal(r.status, 0);
});

test('allows a large command whose << is a bit-shift, not a heredoc', () => {
  const r = runHook(`node -e "const x = 1<<2; console.log(x)" # ${LARGE_BODY}`);
  assert.equal(r.status, 0);
});

test('allows a large command with no heredoc at all', () => {
  const r = runHook(`echo start && echo ${LARGE_BODY}`);
  assert.equal(r.status, 0);
});

// ── Escape hatch + fail-open ────────────────────────────────────────────────
test('escape hatch AGENT_HOOKS_ALLOW_PR_BODY_HEREDOC=1 allows a blockable command', () => {
  const r = runHook("gh pr create --title x --body \"$(cat <<'EOF'\nb\nEOF\n)\"", {
    env: { AGENT_HOOKS_ALLOW_PR_BODY_HEREDOC: '1' },
  });
  assert.equal(r.status, 0);
});

test('malformed hook input fails open', () => {
  const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
