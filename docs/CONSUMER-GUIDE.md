# Consuming the shared PR auto-review engine

This repo holds one PR auto-review engine, shared by `DnD`, `PromptCI` and
`PromptCI-Cloud`. Before it existed each repo carried its own fork — 3226, 1559
and 2160 lines, with only 19 functions common to all three and only 7 of those
identical. Fixes did not propagate: DnD landed ~74 changes to its copy in 90 days
while PromptCI's sat frozen for three weeks, failing every run.

## Why this repo is public

GitHub does **not** allow a public repository to consume workflows or composite
actions from a private one. `PromptCI` is public, so a shared repo that serves all
three has to be public too.

This costs no new exposure: `PromptCI/scripts/pr-review.sh` has always been
world-readable. Secrets live in GitHub Secrets and never in this repo, and the
product-specific material — each repo's `review-prompt.md` — stays in that repo.

## What stays in your repo

| Path | Why |
|---|---|
| `scripts/review-prompt.md` | Product knowledge. DnD's names Adventure Packs and DM/Player/Admin; PromptCI's names detector determinism. Reaches the engine via `SYSTEM_PROMPT_FILE`. |
| `.cicd/quality-gates.sh` | Your build. Read from the **PR head**, not from a pinned CICD ref — see below. |
| `.cicd/config.env` | Feature flags and required-check identity. |
| `.github/workflows/pr-auto-review.yml` | ~60 lines: triggers, `concurrency`, `permissions`, `runs-on`, the fork guard, and one `uses:`. |

### Why the hook comes from the PR head

Everything else the engine runs comes from a pinned CICD ref, precisely so a PR
cannot edit the reviewer that decides whether it merges. `.cicd/quality-gates.sh`
is the deliberate exception: it *is* product code, and a PR that changes how the
project builds has to be reviewable as part of that PR.

## The quality-gates hook

```bash
.cicd/quality-gates.sh install   # 0 = installed | 1 = real failure | 2 = network/infra
.cicd/quality-gates.sh run       # 0 = pass | 1 = a gate failed | 2 = infra
```

On `1`, print the failure context to **stdout** — the engine feeds it back to the
model verbatim as the next iteration's input, so it must be the compiler's or test
runner's own words rather than a summary.

**Exit 2 is not a nicety.** It is how a registry outage is stopped from looking
like a code defect. The engine blocks on infra rather than merging a PR whose
review never ran — collapsing that into `fail` once merged 3 of 40 PRs over an
unrun review.

This hook is why the engine contains no package manager. DnD's wraps `npm ci` and
jest shards; the two PromptCI repos' wrap `pnpm install --frozen-lockfile` and
vitest. A contract test fails the build if `npm`/`pnpm`/`node_modules` reappears
in `engine/`.

## `.cicd/config.env`

Only `CICD_*` names are honoured, and the file is read as **data, not sourced** —
it arrives from the PR under review, and `source`ing it would hand a PR author
arbitrary code execution inside the reviewer.

```sh
CICD_REQUIRED_CHECKS_FALLBACK=gate   # PromptCI: ci | DnD: lint,type-check,build
CICD_STRICT_SKIPPED=false            # see below — DnD must set this to true
CICD_DRY_RUN=false
```

### `CICD_STRICT_SKIPPED` — read this before adopting

`ci-status.jq` treats a `skipped` check as a **pass** unless its name is a
*required* context. DnD's retired implementation treated **any** skipped check as
unresolved and blocked.

The precise rule is better — but it depends on `required_contexts()`, which **fails
open**. A repo whose required set comes back empty therefore treats every skipped
check as a pass, and the merge gate quietly stops gating.

**A repo without an aggregate `gate` job must set `CICD_STRICT_SKIPPED=true`.**
That is DnD today. `tests/engine/check-ci-status-equivalence.test.ts` pins the
difference in both directions.

## Rolling out: shadow mode first

`CICD_DRY_RUN=true` makes the engine review and comment exactly as normal while
being incapable of pushing, merging, or applying a fix — guarded at three
independent points, each with its own test.

Run it beside your incumbent reviewer for ~10 PRs and **diff the two comments**:
same verdict, same fix list, same CI classification. Any divergence is a config
bug found on live traffic, for free, before anything acts on it. Then flip the
real workflow over and keep the old script on disk, unreferenced, until you have
had two clean weeks.

Rollback at any point is reverting one workflow file.

## Pinning

Pin by SHA, with the version in a trailing comment:

```yaml
- uses: SeriousGeese/CICD/actions/pr-review@<sha>  # v0.1.0
```

**DnD is the exception and pins `@main` deliberately.** It authors ~74 changes per
90 days against a real 8-runner fleet, so it is the canary; making it wait for a
CICD release before it can ship a fix is the single likeliest way this whole effort
gets abandoned. That trade — velocity over pin safety — is a choice, recorded here
so it does not read as an oversight.

## Verifying an adoption

```bash
pnpm test && pnpm lint          # in this repo, before you cut a ref
# in the consumer, after the shadow run:
gh pr view <n> --json comments  # the two comments should agree
```
