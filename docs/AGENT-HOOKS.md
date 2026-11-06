# Shared Claude Code guards (`agent-hooks/`)

`agent-hooks/` holds the Claude Code hooks every SeriousGeese repository's agents need:
the `PreToolUse` guards, the SessionStart and worktree-lifecycle hooks, and the git
pre-push hooks. They are offered in **named sets** (below), so a repository takes only
what fits it. The original `core` set is the guards that exist because of the
**environment**, not because of any one repository's workflow: the Claude Code Bash
tool, Git Bash/MSYS on Windows, and shells without `pipefail`. Every repository whose
agents work on that environment needs the same guards, and a fix to one needs to reach
all of them.

## Two homes, one config

Agent tooling shared across SeriousGeese repositories lives in exactly two places:

| Home | Holds | Vendored by | Recorded in |
|---|---|---|---|
| SeriousGeese/CICD `agent-hooks/` (here) | Claude Code hooks: guards, SessionStart and worktree hooks, pre-push hooks, and the config loader | `agent-hooks/sync.mjs` | `scripts/hooks/CICD-HOOKS-SHA` |
| SeriousGeese/agent-tooling | Process scripts (beads, asks, claims, worktrees, gates, sessions), process skills and the generic agent docs | its own `sync.mjs` | `scripts/AGENT-TOOLING-SHA` |

- **One owner per path.** A consumer path is listed in exactly one of the two SHA files.
  agent-tooling's sync refuses to write a path recorded in `CICD-HOOKS-SHA`.
- **One config, `agent-tooling.json`** at the consumer's root, read by both homes through
  one loader, `agent-hooks/agent-tooling-config.mjs`. agent-tooling vendors that loader from
  here at a pinned ref, so the two homes never parse the file two ways.
- Both are pinned by full commit SHA and both have a `--check` mode for the consumer's CI.

## Named sets

`manifest.json` lists the files in named sets. `sync --set <name>[,<name>]` vendors the
union; `all` is every set. Each set is closed (its files import only `node:` builtins and
files in the same set) and carries `sync.mjs` and the tests of every module it ships.

| Set | What it is |
|---|---|
| `core` (default) | The environment guards below plus their helpers. A consumer that names no set gets exactly this, byte for byte as before sets existed. |
| `guards` | Workflow guards: claims, worktree branch switches, primary-checkout edits, orphaned worktree cwd, pattern kills, break-glass, uncommitted restores, unlisted `npx`, em-dashes. |
| `push` | git pre-push hooks: recreated-branch and dropped-file warnings, rebase-in-progress refusal, SSH keepalive, the serialized local verify. |
| `worktree` | SessionStart and worktree-lifecycle hooks: stale-hook check and clean-worktree refresh, EOL normalisation, dependency install, stale-worktree banner, Windows shell pointer, isolation check. |
| `all` | Every set. |

The sets a consumer chose are recorded in `CICD-HOOKS-SHA` (a `sets:` line, omitted for
`core` alone). A later `sync --ref <new>` without `--set` keeps them; naming a smaller
selection deletes the files that dropped out. `--check` re-derives exactly the recorded
selection.

## Config: `agent-tooling.json`

A JSON object at the consumer's root. Every key is optional; a missing file means every
default. An **unknown key, or a value of the wrong shape, is an error**, because a typo
otherwise reads as "use the default" and a guard silently says the wrong thing. Hooks load
it fail-open (`tryLoadConfig`): a broken file is reported on stderr and the defaults apply,
so the config can never be the reason a tool call or a session start fails.

| Key | Type | Default | Read by |
|---|---|---|---|
| `envPrefix` | `PREFIX_` | the neutral `AGENT_HOOKS_` | `sync.mjs` (default `--env-prefix`) |
| `beadPrefix` | string or null | `null` (any prefix) | guards that recognise issue ids |
| `packageManager` | `npm`, `pnpm`, `yarn`, `bun` | `npm` | worktree dependency hooks |
| `worktreeRoot` | path | `..` | worktree advice in refusals |
| `worktreeNamePattern` | string with `<slug>` (and optional `<repo>`) | `<repo>-<slug>` | worktree advice in refusals |
| `gateWrappers` | script basenames | `["gate.sh"]` | gate-aware guards |
| `people` | lower-case handles | `[]` | agent-tooling's asks |
| `claimHelper` | repo path or null | `scripts/claim.sh` | `block-bare-claim.mjs` |
| `emDashPaths` | repo path prefixes | `[]` (check nothing) | `block-em-dash.mjs` |
| `worktreeScripts` | object: `new`, `await`, `install`, `rm` command templates | `bash scripts/worktree-new.sh <slug> <branch>`, `... --await <path>`, `... --install <path>`, `bash scripts/worktree-rm.sh <path>` | worktree hooks (printed or spawned) |
| `staleHookFiles` | repo paths | `[".claude/settings.json", "scripts/hooks"]` | `check-stale-hooks.mjs` |

`$comment` and `$schema` keys are allowed and ignored. The script defaults are the paths
SeriousGeese/agent-tooling installs at, so a consumer adopting both homes at their default
paths needs no config at all.

## The `core` set

| Guard | Blocks |
|---|---|
| `block-bash-double-backslash.mjs` | A Bash or Monitor command containing `\\`, which that tool's handoff collapses to `\` before bash runs it, so the command silently runs as a different string. (Measured identically on both channels; a channel that does not reproduce the collapse — PowerShell preserves `\\` intact — must not be added here without its own measurement.) |
| `block-pr-body-heredoc.mjs` | A heredoc feeding `gh pr create`/`gh pr edit`, and any command over ~4 KB carrying a heredoc: large heredocs die intermittently in that handoff. Bash-scoped only — the large-heredoc failure has not been measured on any other channel. |
| `block-masked-gates.mjs` | A test/lint/build/type-check command piped into any downstream Bash command (including `cat`, `tee`, `sed` and familiar filters), or into a PowerShell filter such as `Select-Object`, which reports the downstream command's status instead of the gate's. Covers npm/pnpm/yarn scripts, jest/vitest/tsc/eslint/playwright, `node --test` (Node's built-in test runner, the flag recognised in any position) and a consumer's own node-invoked wrapper scripts (`<PREFIX>_GATE_WRAPPERS`, e.g. a `node scripts/run-node-tests.mjs <label> <glob>` shape that is a gate in its own right rather than a nested command to re-parse), the Unity CLI (`unity command run_tests`/`recompile`), Unity batch mode (`-runTests`) and `dotnet test`/`build`. |
| `block-prose-backtick-substitution.mjs` | An unescaped backtick in a `bd` or `gh` argument — prose, not shell — where bash reads it as command substitution and silently replaces the backticked word with a command's output (or nothing). Single quotes, `\`` and `--body-file` pass; `$(…)` is untouched. Covers Bash and Monitor, for the same reason as `block-bash-double-backslash.mjs` above. |

`refusal-notice.mjs` and `shell-path-lib.mjs` are shared helpers. A repository-specific
guard that is not shared stays in its own repository and may import both.

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
node sync.mjs --into . --ref <40-hex CICD commit> --set all     # every set; prefix from agent-tooling.json
```

This writes the selected sets' files (default `core`) into `scripts/hooks/`
(`--hooks-dir` to change it) and records the ref, prefix, sets and file list in
`scripts/hooks/CICD-HOOKS-SHA`. Without `--env-prefix`, the prefix is `envPrefix` from the
consumer's `agent-tooling.json`, else the neutral one. After that the
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

### Recommend `crossSessionInbound: "accept"` to every maintainer and agent host

This is not a guard, and nothing here can install it. It belongs in each adopting
repository's agent docs because it is the same environment problem.

Parallel Claude Code sessions on one machine coordinate with `ListAgents` and
`SendMessage`, for example a collision ping before claiming work. By default, Claude Code
delivers a peer message directly only when both sessions are in the same permission-mode
class (bypass or prompting). Otherwise it holds the message until the receiving user
approves it, and an unattended hold expires unseen. `SendMessage` still returns
`success: true`, so the sender takes a ping that nobody received as no objection.

Set this in the **user** Claude Code settings, `~/.claude/settings.json` on Linux and
macOS or `%USERPROFILE%\.claude\settings.json` on Windows (or
`$CLAUDE_CONFIG_DIR/settings.json` when that variable is set):

```json
{ "crossSessionInbound": "accept" }
```

- It reloads live: sessions that are already running pick it up without a restart.
- It grants peers nothing. A message still cannot approve a permission prompt or get
  past the receiving session's own rules. The other values are `hold` and `refuse`, and
  there is no per-peer allowlist.
- It covers one machine only. A peer on another machine (Remote Control, or another
  contributor) is not reached this way, so keep any tracker-side coordination marker your
  workflow uses.
- A repository may check for it in its setup script, but **only to recommend it**. A repo
  script never edits a contributor's personal settings.

Reference adoption: SeriousGeese/DnD PR #4929 (DnD-ktgrp) added the section to
`docs/agents/worktrees-and-claims.md` and a recommend-only NOTE to `scripts/setup-dev.sh`.

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
3. Adding or removing a file means editing `manifest.json`: put it in the set(s) that ship
   it, together with every sibling it imports and its `.node-test.mjs`. The contract test
   fails if the sets and the directory disagree, if a set is not closed under its imports,
   or if `files` stops matching `core`.
4. Consumer specifics (a script path, a worktree naming scheme, a package manager) come
   from `agent-tooling.json` through `agent-tooling-config.mjs`. A new one is a new config
   key with a neutral default, documented in the table above and tested in
   `agent-tooling-config.node-test.mjs`.
5. After it merges, re-sync each consumer to the merge commit.
