# Shared Claude Code guards (`agent-hooks/`)

`agent-hooks/` holds the Claude Code `PreToolUse` guards that exist because of the
**environment**, not because of any one repository's workflow: the Claude Code Bash
tool, Git Bash/MSYS on Windows, and shells without `pipefail`. Every repository whose
agents work on that environment needs the same guards, and a fix to one needs to reach
all of them.

| Guard | Blocks |
|---|---|
| `block-bash-double-backslash.mjs` | A Bash or Monitor command containing `\\`, which that tool's handoff collapses to `\` before bash runs it, so the command silently runs as a different string. (Measured identically on both channels; a channel that does not reproduce the collapse — PowerShell preserves `\\` intact — must not be added here without its own measurement.) |
| `block-pr-body-heredoc.mjs` | A heredoc feeding `gh pr create`/`gh pr edit`, and any command over ~4 KB carrying a heredoc: large heredocs die intermittently in that handoff. Bash-scoped only — the large-heredoc failure has not been measured on any other channel. |
| `block-masked-gates.mjs` | A test/lint/build/type-check command piped into `tail`/`head`/`grep`/`Select-Object`/…, which reports the filter's exit code instead of the gate's. Covers npm/pnpm/yarn scripts, jest/vitest/tsc/eslint/playwright, `node --test` (Node's built-in test runner, the flag recognised in any position) and a consumer's own node-invoked wrapper scripts (`<PREFIX>_GATE_WRAPPERS`, e.g. a `node scripts/run-node-tests.mjs <label> <glob>` shape that is a gate in its own right rather than a nested command to re-parse), the Unity CLI (`unity command run_tests`/`recompile`), Unity batch mode (`-runTests`) and `dotnet test`/`build`. |
| `block-prose-backtick-substitution.mjs` | An unescaped backtick in a `bd` or `gh` argument — prose, not shell — where bash reads it as command substitution and silently replaces the backticked word with a command's output (or nothing). Single quotes, `\`` and `--body-file` pass; `$(…)` is untouched. Covers Bash and Monitor, for the same reason as `block-bash-double-backslash.mjs` above. |

`refusal-notice.mjs` and `shell-path-lib.mjs` are shared helpers. Repository-specific
guards (claims, worktrees, issue tracker) stay in their own repositories and may import
both.

## Why these are copied, not referenced

Claude Code runs hooks **locally**, from the consumer's `.claude/settings.json`,
resolved against the session's working directory. A composite action only exists inside
a GitHub Actions run, so it cannot carry these. The files have to be on disk in the
consumer's tree, and a hook must not import from outside that tree, because a git
worktree carries the hook files it was cut with.

So the unit of distribution is a copy pinned by commit SHA, the same way this
repository's actions are pinned. `tests/contract/agent-hooks-dependency-free.test.ts`
keeps every file importable in a consumer with no package manager at all: only `node:`
builtins and files listed in `agent-hooks/manifest.json`.

## Adopting

From the consumer's root, with any copy of `sync.mjs` (a first adoption can fetch it from
`https://raw.githubusercontent.com/SeriousGeese/CICD/<sha>/agent-hooks/sync.mjs`):

```bash
node sync.mjs --into . --ref <40-hex CICD commit> --env-prefix MYREPO_
```

This writes the manifest's files into `scripts/hooks/` (`--hooks-dir` to change it) and
records the ref, prefix and file list in `scripts/hooks/CICD-HOOKS-SHA`. After that the
consumer runs its own vendored copy: `node scripts/hooks/sync.mjs …`. A branch or tag is
refused as `--ref`: it can move.

Then register the guards in `.claude/settings.json`:

| Matcher | Guards |
|---|---|
| `Bash\|Monitor` | `block-bash-double-backslash.mjs`, `block-prose-backtick-substitution.mjs` |
| `Bash` | `block-pr-body-heredoc.mjs` |
| `Bash\|PowerShell` | `block-masked-gates.mjs` |

A consumer that does not use the Monitor tool at all can register the first row on
`Bash` alone — the guards themselves fail open (exit 0) on any unrecognised
`tool_name`, so an unused matcher entry costs nothing either way. A consumer whose
own agents DO use a Monitor-shaped tool should register it on `Bash|Monitor` to get
the coverage; `block-pr-body-heredoc.mjs` and the PowerShell branch of
`block-masked-gates.mjs` were not measured against Monitor and are not claimed to
cover it — see `agent-hooks/block-bash-double-backslash.mjs`'s header comment for
the measurement methodology if you want to extend one of them.

and run the node:test suites wherever the consumer runs tests:
`node --test "scripts/hooks/*.node-test.mjs"`.

### Escape-hatch names

Each guard has an escape hatch, written here as `AGENT_HOOKS_ALLOW_…`. `--env-prefix`
rewrites that prefix on the way in, so a consumer keeps the names its own documentation
already teaches (`--env-prefix MYREPO_` gives `MYREPO_ALLOW_DOUBLE_BACKSLASH`). Omit it to
keep the neutral names.

### Local advice: `<guard>.hint.txt`

A refusal here is generic. When a consumer has a better local answer (a gate-capture
wrapper, a doc section), it puts that sentence in `scripts/hooks/<guard>.hint.txt`, and the
guard appends it to its refusals. Hint files belong to the consumer: sync never writes
them and `--check` never reads them.

## Staying in sync

Run this as a step in the consumer's CI (a step in an existing job, not a new job):

```bash
node scripts/hooks/sync.mjs --into . --check
```

It re-derives every vendored file from the recorded ref and prefix and exits 1, naming
each file that was edited in place, deleted, or is missing. A vendored guard is changed
**here**, then each consumer re-runs sync with the new ref; the diff in the consumer is
the change plus the ref line. It fetches from `raw.githubusercontent.com` (this repository
is public, so no token is needed); `--from <local CICD checkout>` reads the ref with
`git show` instead.

## Changing a guard

1. Change it here, with its `.node-test.mjs`. `pnpm test:agent-hooks` runs them, and CI
   runs that as a step.
2. Keep it neutral: no consumer names, no consumer escape-hatch prefix. The contract test
   fails otherwise.
3. Adding or removing a file means editing `manifest.json`; the contract test fails if the
   manifest and the directory disagree.
4. After it merges, re-sync each consumer to the merge commit.
