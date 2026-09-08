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

Only `CICD_*` names are honoured, and the file is **parsed as data, never
`source`d** — `source` would hand whoever can write it arbitrary code execution
inside the reviewer.

It is read from the **BASE commit**, not the PR head. That is the opposite of
`quality-gates.sh` next to it, and deliberately so: this file names the required
checks and the feature flags, i.e. it configures the gate that decides whether
*this* PR merges. From the head, a PR author could point
`CICD_REQUIRED_CHECKS_FALLBACK` at a context that does not exist — and
`required_contexts()` **fails open**, so from there every skipped check counts as
a pass and the gate stops gating.

The consequence is the correct one: the PR that first *adds* `config.env` runs
under defaults, and the file takes effect once merged.

```sh
# The context(s) your ruleset or branch protection actually requires.
CICD_REQUIRED_CHECKS_FALLBACK=gate
CICD_STRICT_SKIPPED=false
```

What each repo sets today, and why it differs:

| repo | `CICD_REQUIRED_CHECKS_FALLBACK` | note |
|---|---|---|
| PromptCI | `ci` | one monolithic job |
| promptci-cloud | `gate` | aggregate job over `changes`/`ci`/`e2e`/`audit` |
| DnD | `e2e (Playwright),gate` | **both**, and neither replaces the other |

In DnD this value is not a safety net — it is the answer on **every** run.
`required_contexts()` reads the *rulesets* endpoint, and DnD uses classic branch
protection with its only ruleset disabled, so the lookup always returns empty and
always falls back.

`CICD_DRY_RUN` is deliberately **not** settable here. The action declares it with
a default, so a caller-passed value always wins — which is what keeps a shadow
run impossible to talk out of dry-run from the branch it is reviewing.

### `CICD_STRICT_SKIPPED` — read this before adopting

`ci-status.jq` treats a `skipped` check as a **pass** unless its name is a
*required* context. The retired DnD implementation treated **any** skipped check
as unresolved, and blocked.

**The rule is NOT "strict when the repo has no aggregate `gate` job."** That
shorthand was written here, in the action's input description, and in the test
profiles, and following it would hang PromptCI's reviewer on every single PR:
`auto-merge.yml` carries a job-level `if:` and therefore reports `skipped` on
every human-authored PR, which strict mode waits out every time.

The actual rule has two halves:

- **Strict is safe only when no check in the repo ever legitimately skips.** Ask
  whether any workflow that publishes a check carries a job-level `if:`.
- **Non-strict is safe only when the REQUIRED context itself cannot skip.**

All three repos land on `false`, by three different routes — which is the clearest
evidence available that the aggregate-gate shorthand never described the rule:

| repo | required context | why it cannot skip |
|---|---|---|
| PromptCI | `ci` | a job with no job-level `if:` |
| promptci-cloud | `gate` | aggregate job carrying `if: always()` |
| DnD | `e2e (Playwright)`, `gate` | `gate` is `if: always()`; the e2e context is **published** by `e2e-docs-shim.yml` on path-filtered PRs, so it is *missing*, not skipped — and `required_missing` already blocks on that |

Getting it wrong in the other direction is silent: GitHub counts a skipped
required check as **passing**.

## Rolling out: shadow mode first

`CICD_DRY_RUN=true` makes the engine review and comment exactly as normal while
being incapable of pushing, merging, applying a fix, **or dispatching a
workflow** — each guarded independently, each with its own test.

Run it beside your incumbent reviewer and **diff the two comments**. Fix what
"matches" means *before* any data arrives, or it gets decided afterwards:

**Must agree** — the verdict and its stated reason; the findings, and which got
proposed fixes; the CI classification; the metadata block (tier, model, iteration
count).

**Expected to differ, and not divergences** — `would_merge` where the incumbent
says `merged` (dry-run stops before the merge and says so honestly); and LLM
prose, since these are two non-deterministic calls to the same model. Differing
*findings* are a real divergence; differing wording is not.

### Four things that will bite, all found the hard way

1. **Name the shadow job with the `🤖 Auto-Review` prefix.** Both engines exclude
   the reviewer's own check run by exactly that prefix, and have no other way to
   tell a reviewer's check from a CI one. Outside it, the shadow's *queued* check
   reads to the incumbent as in-progress CI — so the incumbent waits for it while
   it waits for a runner. Only one direction hangs, which is what makes it easy to
   miss.
2. **Gate the comment step on `steps.review.conclusion == 'success'`, and give it
   no fallback path.** A step that *fails* sets none of the outputs the earlier
   guards read, so an `always()` here runs even when the review did not — and the
   default comment path is shared with the incumbent on the same runner. That
   posted the incumbent's review under a shadow banner, and the two "agreed"
   perfectly about a review the shadow never performed.
3. **Accept `MERGED` PRs, and check out `refs/pull/<n>/head`.** When the incumbent
   wins the runner it reviews, merges and exits before the shadow starts — and the
   PRs lost that way are exactly the ones it *merged*, so skipping them draws the
   whole comparison from the failure cases. Label those comments a degraded
   sample: the engine base-syncs against the *current* base, which has moved past
   a merged PR.
4. **Check your `permissions:` keys.** An unrecognised one does not warn — it
   *invalidates* the workflow file, and the run fails with zero jobs and no
   annotation. `administration: read` is a GitHub App scope, not an Actions
   permission, and it killed two runs that way.

Give the shadow a **narrower** `permissions:` block than the incumbent —
`contents: read`, no `actions: write`. Dry-run is a flag inside a 2000-line
script; the permissions block is the guarantee that holds even if the flag is
misread.

Then flip the real workflow over, keep the old script on disk unreferenced for
two clean weeks, and only then delete it and its tests. Rollback at any point is
reverting one workflow file.

## Pinning

Pin both actions by **full commit SHA**, and move them together — a half-updated
pair runs one action's code against another's engine:

```yaml
- uses: SeriousGeese/CICD/actions/resolve-gh@<sha>  # main @ YYYY-MM-DD
- uses: SeriousGeese/CICD/actions/pr-review@<sha>   # main @ YYYY-MM-DD
```

**DnD is the exception and pins `@main` deliberately.** It authors ~74 changes per
90 days against a real 8-runner fleet, so it is the canary; making it wait for a
CICD release before it can ship a fix is the single likeliest way this whole
effort gets abandoned. Its adoption test asserts the pin **is** `main` and **is
not** a SHA, so nobody "fixes" it.

That trade — velocity over pin safety — is real and is stated rather than hidden:
DnD takes this repo's `main` unreviewed by it. It is accepted **there and nowhere
else**, precisely so one bad commit here cannot reach all three consumers at once.

## Verifying an adoption

```bash
# in this repo, before you cut a ref:
npm test && npm run lint && npm run shellcheck

# in the consumer:
bash .cicd/quality-gates.sh run   # must exit 0 green, 1 with the tool's own output
gh pr view <n> --json comments    # the two comments should agree
```

If the hook fails on a tree you did not expect to fail, check your install first —
it only runs `install` when `node_modules` is absent, so a stale local tree gets
reviewed as-is. That is what the `install` verb is for.
