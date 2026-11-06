#!/usr/bin/env bash
# SessionStart hook: verify this session directory is a real, isolated git
# worktree BEFORE any git-mutating command runs.
#
# .claude/worktrees/<name> dirs have been observed to spawn WITHOUT a .git
# link of their own — every git command then silently walks up to the PARENT
# checkout (shared by concurrent sessions) while file edits land in the
# session dir. This has caused real near-data-loss.
#
# Output goes into the session's starting context, so no agent has to
# remember to run the check by hand. Always exits 0 (a SessionStart hook
# cannot usefully block; the banner is the mechanism).
#
# Consumer settings: the example worktree path in the BROKEN banner comes from the
# consumer's agent-tooling.json (worktreeRoot, worktreeNamePattern), read through
# agent-tooling-config.mjs beside this file. A consumer's own advice (a doc section, a
# manual checklist) goes in `verify-worktree-isolation.hint.txt` beside this file, and its
# contents are appended to every banner. Both are best effort: without node or the config the
# banner still prints, with a generic example.
set -u

here="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

# The consumer's own advice, appended to a banner. Empty when there is no hint file.
hint=""
if [ -f "$here/verify-worktree-isolation.hint.txt" ]; then
  hint="$(cat "$here/verify-worktree-isolation.hint.txt" 2>/dev/null)" || hint=""
fi
print_hint() {
  if [ -n "$hint" ]; then printf '%s\n' "$hint"; fi
}

# The session directory is the hook input's `cwd`, not this process's cwd. A Claude Code
# desktop session on a harness-created .claude/worktrees/<name> worktree runs SessionStart
# hooks with process cwd = the PRIMARY checkout while stdin names the worktree, so `pwd` alone
# told that session it was "the SHARED main checkout". Fall back to `pwd` when there is no
# input (a hand run, or a harness that sends none) or it names no directory.
hook_cwd=""
if [ ! -t 0 ]; then
  # The timer bounds a caller that leaves stdin open without ever writing to it.
  hook_cwd="$(node -e '
    let s = "";
    const t = setTimeout(() => process.exit(0), 3000);
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      clearTimeout(t);
      try {
        const c = JSON.parse(s).cwd;
        if (typeof c === "string") process.stdout.write(c);
      } catch {}
    });
  ' 2>/dev/null)" || hook_cwd=""
fi
if [ -n "$hook_cwd" ] && command -v cygpath >/dev/null 2>&1; then
  hook_cwd="$(cygpath -u "$hook_cwd" 2>/dev/null || printf '%s' "$hook_cwd")"
fi
if [ -n "$hook_cwd" ] && [ -d "$hook_cwd" ]; then
  cd "$hook_cwd" || true
fi

top="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[worktree-check] not a git repo — skipped"
  exit 0
}
cwd="$(pwd -W 2>/dev/null || pwd)"

# Normalize for comparison: backslashes -> slashes, lowercase, and Git Bash
# "/c/..." mount style -> "c:/..." drive style so pwd and rev-parse agree.
norm() { printf '%s' "$1" | tr '\\' '/' | tr '[:upper:]' '[:lower:]' | sed -E 's|^/([a-z])/|\1:/|'; }

# Physical path, symlinks in every component resolved. On Fedora Atomic images
# (Silverblue/Kinoite/Bazzite) /home is a symlink to var/home, so the harness
# reports cwd as /home/<user>/... while `git rev-parse --show-toplevel` answers
# /var/home/<user>/... for the SAME directory — a pure string compare then calls
# every session on such a host BROKEN, which trains agents to ignore the one
# banner that means stop-everything.
# Falls back to the input when the directory cannot be entered, so a genuinely
# missing/!unreadable path still compares unequal and still reports BROKEN.
resolve() { ( cd -P "$1" 2>/dev/null && { pwd -W 2>/dev/null || pwd -P; } ) || printf '%s' "$1"; }

# Where a replacement worktree would go, per the consumer's config. Only the broken banner
# needs it. Falls back to a generic example when node or the config is unavailable.
example_worktree() {
  local out
  out="$(node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const lib = await import(pathToFileURL(process.argv[1]).href);
    const { config } = lib.tryLoadConfig({ root: process.argv[2] });
    const root = config.worktreeRoot.replace(/\/+$/, "");
    process.stdout.write(root + "/" + lib.worktreeName(config, "<name>"));
  ' "$here/agent-tooling-config.mjs" "$top" 2>/dev/null)" || out=""
  if [ -n "$out" ]; then printf '%s' "$out"; else printf '%s' "../<repo>-<name>"; fi
}

# Cheap compare first; only pay the two subshells when it disagrees. Both must
# differ to report BROKEN — a real shared-checkout session still differs after
# resolution, because its toplevel is a genuinely different directory.
if [ "$(norm "$top")" != "$(norm "$cwd")" ] &&
   [ "$(norm "$(resolve "$top")")" != "$(norm "$(resolve "$cwd")")" ]; then
  example="$(example_worktree)"
  cat <<EOF
[worktree-check] BROKEN ISOLATION — this directory is NOT its own git checkout.
  session cwd : $cwd
  git toplevel: $top
Every git command run here silently operates on the PARENT checkout, which is
shared by concurrent sessions. Do NOT commit, branch, or checkout until fixed.
Recover: if git commands already ran, check git -C "$top" reflog and restore
the parent's branch; then create a real worktree
(git -C "$top" worktree add $example -b <branch> origin/main) and do all
further work there via absolute paths.
EOF
  print_hint
  exit 0
fi

if [ -f "$top/.git" ]; then
  echo "[worktree-check] OK — isolated worktree: $cwd"
  echo "[worktree-check] Pass THIS directory's absolute paths to Read/Edit/Write — the parent checkout has near-identical paths and may hold other sessions' uncommitted work."
else
  echo "[worktree-check] NOTE — this is the SHARED main checkout ($cwd). Do not switch branches or commit here; create a worktree for feature work."
fi
print_hint
exit 0
