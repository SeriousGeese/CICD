#!/usr/bin/env bash
# Re-run the auto-review for a PR that is GREEN EVERYWHERE and will never merge
# itself, because the review already looked and left before CI settled.
#
# The union of DnD's sweep (620 lines, three triggers) and promptci-cloud's
# (302 lines, two triggers but a much better definition of "green"). Neither was
# a superset of the other, so this takes cloud's structure and grafts DnD's
# third trigger onto it — see "WHAT CAME FROM WHERE" at the end of this header.
#
# ── THE GAP THIS FILLS ──────────────────────────────────────────────────────
# pr-review.sh reaches a CI verdict ONCE, inside one run:
#   * a red is terminal (fail fast, so a lint failure at ~40s is not sat on
#     behind a 20-minute browser matrix), and
#   * a poll that outlives POLL_TIMEOUT reports a blocked verdict.
# Neither verdict is ever revisited. Whatever happens to the SHA afterwards —
# most commonly `gh run rerun --failed` on a flaky job, or CI simply finishing
# late — nobody is looking any more, so the PR sits green and unmergeable. The
# only escapes were a new SHA (rebase + force-push) or a human re-running the
# review by hand.
#
# The same PR read three ways in ~6h on 2026-09-03 in DnD: #2879 (red, then a
# rerun went green 6 min after the review left), #2889 (the 1800s poller timed
# out while e2e still ran), #2899 (red, rerun green, never re-polled). 5 of the
# last 100 review runs at that point were manual re-runs — that is the toil.
#
# pr-review.sh's own half of this covers the case where the rerun is ALREADY in
# flight when the review polls (it keeps polling instead of blocking). This
# script covers the other half: a rerun that starts after the review has exited.
# The two are complements, not alternatives.
#
# ── THE SECOND GAP: A REVIEW THAT LOOKED AND FAILED ITSELF ─────────────────
# The check above ("did the newest review run START before CI settled") only
# catches a review that never got a chance to see the current green state. It
# misses the reviewer-fault class: a review run that started AFTER CI settled —
# so by the letter of that check it "already saw this state" — but whose OWN run
# then ended `cancelled`/`failure`/`timed_out` instead of reaching a verdict (a
# runner died, `gh` flaked, the LLM call errored). That is not a real PR-state
# verdict at all, so treating it as "already seen" strands the PR exactly the
# same way, permanently: nothing about CI changing again is what is needed here,
# the review itself needs another try.
#
# ── THE THIRD GAP: A WEDGED MERGEABILITY VERDICT ───────────────────────────
# Both checks above ask about the REVIEW: did it see the current CI state, and
# did it reach a verdict at all. Neither asks about the MERGE. DnD PR #2983 on
# 2026-09-06 was the shape that falls through both: CI fully green, the review
# started after CI settled, the reviewer found no defects, the run concluded
# `success` — and the merge was refused with
#
#   CI passed but the merge was refused after 0 merge attempt(s). GitHub
#   reported: mergeStateStatus=BLOCKED after 300s
#
# Nothing was actually blocking it. Measured at the time: `mergeable: MERGEABLE`;
# the single required context reporting completed/success from the exact app id
# branch protection pins; `strict: false`; `required_approving_review_count: 0`;
# `required_conversation_resolution: false`; no rulesets; no reviews; no legacy
# commit statuses. GitHub's mergeability computation was simply wedged on that
# head SHA.
#
# The old final branch logged "it has already seen this state" and continued.
# That sentence is true of CI and false of MERGEABILITY, and that was the bug:
# the PR sat forever while the sweep reported a clean tick.
#
# ── WHAT IT DOES ABOUT IT, AND WHY THAT AND NOT MORE ───────────────────────
# Exactly one re-run, then one comment, then it stops touching the PR.
#   * One re-run is cheap and genuinely works sometimes: DnD #2984 was BLOCKED
#     in the same window and cleared itself.
#   * It does not work reliably. On #2983 a retrigger produced a SECOND review
#     run that also concluded `success` and refused the merge with the identical
#     message ~40 minutes later. What cleared it was a rebase onto the current
#     base plus a force-push — a new head SHA gets a fresh mergeability
#     computation. So after the one re-run the sweep says that, in a comment,
#     and leaves the PR alone.
#   * THE SWEEP MUST NEVER MODIFY A BRANCH. Rebasing or force-pushing from a
#     cron was explicitly rejected: it can clobber unpushed work and it races any
#     session mid-edit on that branch. Do not add it, not even behind a flag.
#
# ── HOW IT AVOIDS SWEEPING A PR WHOSE `BLOCKED` IS REAL ────────────────────
# Getting this wrong turns the sweep into a machine for re-running genuinely
# blocked PRs forever, so every one of these must hold before it acts:
#   1. GitHub says BLOCKED *right now* (`mergeStateStatus` from the PR list — a
#      free field on a call already being made, and it re-reads GitHub's live
#      verdict rather than trusting the stale one in the comment).
#   2. CI on the head SHA is fully green and settled. Delegated to ci-lib.sh, so
#      this rules out "something required is RED" using the same verdict the bot
#      itself merges on.
#   3. Every required context on the PR's BASE branch actually REPORTED on this
#      SHA. This is what rules out "something required is MISSING", which green
#      CI cannot see: a context that never produced a check run is not a red one.
#      If branch protection cannot be read, or names no required context, the PR
#      is SKIPPED — the block is then either real or unknowable, and both mean
#      hands off. This path fails CLOSED on purpose, which is why §1b probes it
#      once per sweep and announces it when it cannot fire.
#   4. The bot's own structured metadata agrees: the newest review-summary
#      comment describes THIS head SHA, records `merge_attempts: 0` (the merge
#      mutation was never attempted, so nothing about the PR was judged wrong)
#      and a `merge_error` naming `mergeStateStatus=BLOCKED`. Reading the YAML
#      block is deliberate — it is written for exactly this — rather than
#      re-deriving mergeability and reaching a different answer than the run did.
#      DIRTY is excluded by that match: it is a real conflict, and no number of
#      re-runs resolves one.
#
# ── CAN GUARD 3 READ BRANCH PROTECTION AT ALL? ─────────────────────────────
# Guard 3 fails CLOSED, so if `repos/<repo>/branches/<base>` does not hand this
# job's token a populated `.protection`, the whole wedged-mergeability trigger is
# inert on EVERY PR — while logging a per-PR warning that reads like an ordinary
# skip. A trigger that cannot fire and does not announce it is the exact failure
# class this trigger exists to remove, so it is not allowed to be something a
# later session discovers by accident. What is known:
#
# ESTABLISHED (measured 2026-09-06):
#   * `GET /repos/{o}/{r}/branches/{b}` and `GET .../branches/{b}/protection`
#     are DIFFERENT endpoints with different requirements. This script calls the
#     FORMER. pr-review.sh's `BASE_REQUIRES_UP_TO_DATE_HEAD` comment — "that
#     endpoint requires ADMIN access, GITHUB_TOKEN cannot have it" — is about
#     the LATTER and does not transfer here, however similar the two look.
#   * The former returns a fully populated
#     `.protection.required_status_checks.{contexts,checks}` to an identity with
#     no repository role at all. `cli/cli` and `microsoft/vscode` both answered
#     with their complete required-context lists to a token holding only
#     `pull: true`, and `cli/cli` answered identically with NO Authorization
#     header at all. The field is not admin-gated on this endpoint; read access
#     to the repository is the entire bar.
#   * GitHub documents this endpoint under repository permission "Contents"
#     (read), supported for installation access tokens — which is what
#     `secrets.GITHUB_TOKEN` is — while `.../protection` is documented under
#     "Administration" (read).
#
# INFERRED, NOT ESTABLISHED:
#   * That the same holds for a PRIVATE repository read by an INSTALLATION
#     token. Every measurement above is a public repo or a user token.
#
# So the guard STAYS — removing it on an inference is how `administration: read`
# got added and killed the workflow for 40 minutes — and the residual ambiguity
# is made LOUD instead: §1b probes the read once per sweep, independent of
# whether any PR is stranded, and warns when the trigger cannot fire. If §1b ever
# warns, that is a real regression to act on, never routine noise to filter.
#
# ── HOW THE STOP STAYS IDEMPOTENT ──────────────────────────────────────────
# Two bounds, each doing what it is good at, and neither redundant:
#   * `run_attempt` bounds the RE-RUNS to one: GitHub increments it on the run id
#     when we `/rerun`, and it is monotonic and permanent, so
#     `run_attempt < WEDGED_MERGE_MAX_ATTEMPTS` is false on every later tick.
#   * A marker in the sweep's own comment bounds the COMMENT to one, because
#     `run_attempt` cannot: it stays at 2 forever, so on its own it would
#     re-comment on every tick. The comment list is already being read for the
#     metadata above, so this costs no extra API call — which is why this and not
#     a state file. The marker carries the head SHA, so a genuinely new SHA that
#     wedges again gets a fresh budget rather than inheriting a permanent silence.
#
# ── WHY IT RE-RUNS THE REVIEW RUN RATHER THAN DISPATCHING A NEW ONE ────────
# Two reasons, both load-bearing:
#   1. A consumer's pr-auto-review.yml may carry `if: github.actor !=
#      'github-actions[bot]'`, which would SKIP a token-driven workflow_dispatch.
#      On a re-run GitHub keeps `github.actor` as the ORIGINAL actor and reports
#      the re-runner in `github.triggering_actor`, so any such guard passes.
#   2. A dispatch on the wrong ref reviews the wrong thing — DnD's
#      infinite-re-dispatch loop (67 runs, 68 duplicate comments, one paid LLM
#      call each) came from `--ref main` instead of the PR branch. A re-run
#      replays the original event, so there is no ref to get wrong.
# A re-run replays a possibly-stale payload, which pr-review.sh already handles:
# it polls the LIVE branch tip, never the event's HEAD_SHA.
#
# ── WHY IT CANNOT LOOP ──────────────────────────────────────────────────────
# The started-before-settle trigger: "the newest review run for this SHA STARTED
# BEFORE CI finished settling on it". A re-run bumps that run's
# `run_started_at` to the new attempt's start (verified against DnD runs
# 33699464161/33699724250/33699763661 — `created_at` stays, `run_started_at`
# moves), so after one re-run the condition is false until CI changes again.
#
# The non-success-conclusion trigger cannot lean on `run_started_at` the same
# way — a persistently broken reviewer would bump it on every rerun and fail
# again immediately, so time-since-start never disqualifies it. It is bounded
# instead by `run_attempt`, which GitHub maintains on the RUN ITSELF and which
# no event, CI change, or elapsed time ever decreases. Once
# `run_attempt >= MAX_RERUN_ATTEMPTS` this script stops re-running that run,
# unconditionally, and only a genuinely NEW review run (a fresh commit, or a
# human dispatching one) resets the counter. So a persistently-failing reviewer
# costs at most `MAX_RERUN_ATTEMPTS - 1` extra re-runs, ever, for that run id.
#
# Both triggers are also skipped while any review run for the SHA is still
# going, and a PR that merges is no longer open.
#
# ── WHAT "GREEN" MEANS HERE ─────────────────────────────────────────────────
# Delegated entirely to ci-lib.sh's ci_status_json() + required_contexts()
# rather than reimplemented. `all_success` already folds in required-context
# presence (a required check with zero runs is `required_missing`, a hard block)
# and required-context conclusion (a required check that ran but did not conclude
# exactly `success` is `required_not_passing`) — not merely "every check that
# exists passed". That is the same verdict the bot itself merges on, so this
# sweep can never disagree with it about what counts as green.
#
# ── EXIT POLICY ─────────────────────────────────────────────────────────────
# Infrastructure failures (no gh, no jq, unreadable PR list) exit 1 — loudly.
# A single PR that cannot be assessed or re-run is a ::warning:: and exit 0:
# this is a scheduled backstop, the next run retries, and a permanently-red cron
# gets muted by humans, which would cost more than it saves.
#
# ── WHAT CAME FROM WHERE ────────────────────────────────────────────────────
# From promptci-cloud: the ci-lib.sh delegation for "green" (DnD reimplemented
# it inline and its version could not see a MISSING required context, which is
# the one thing guard 3 has to rule out), and AUTOMERGE_AUTHORS defaulting EMPTY.
# From DnD: the entire third trigger, load_protection_contexts, the §1b
# self-check, and the one-rerun-then-comment policy.
# Neither: REVIEWER_CHECK_PREFIX, which both hard-coded. See the note on it below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ci-lib.sh
source "${SCRIPT_DIR}/ci-lib.sh"

GH_CLI="${GH_CLI:-gh}"
REPO="${REPO:-}"
DRY_RUN="${DRY_RUN:-0}"
# A cap, not a queue: the next tick picks up whatever this one left. Keeps one
# bad afternoon from firing dozens of paid review runs at once.
MAX_PRS="${MAX_PRS:-10}"
# How long CI must have been settled before a PR counts as stranded. Guards the
# race where a review run has been created but has not yet reached its CI poll.
MIN_SETTLE_SECONDS="${MIN_SETTLE_SECONDS:-300}"
# Bound on the non-success-conclusion trigger: the newest review run may be
# re-run while its own GitHub-maintained run_attempt stays under this.
MAX_RERUN_ATTEMPTS="${MAX_RERUN_ATTEMPTS:-3}"
# Bound on the wedged-mergeability trigger, read the same way. Default 2 =
# exactly ONE re-run (attempt 1 -> 2), after which the sweep comments once with
# the recovery and stops. Deliberately TIGHTER than MAX_RERUN_ATTEMPTS: a re-run
# demonstrably does not fix this one (DnD #2983's second review run refused the
# merge identically), so a second try is waste.
WEDGED_MERGE_MAX_ATTEMPTS="${WEDGED_MERGE_MAX_ATTEMPTS:-2}"
# Written into the sweep's own comment and looked for on every later tick. The
# head SHA is part of it so a NEW wedged SHA is not silenced by the old comment.
WEDGED_MARKER_PREFIX='<!-- stranded-review-sweep:wedged-merge sha='
WEDGED_MARKER_SUFFIX=' -->'
# EMPTY by default: the bot merges nobody unless a consumer opts in. An empty
# allowlist makes `index($pr.author.login)` never match, which is exactly "sweep
# nothing" until a repo sets it. It must mirror that repo's own
# AUTOMERGE_AUTHORS so the sweep and the reviewer can never disagree about whose
# PRs the bot may touch — re-running a review for an author the bot will not
# merge for is pure waste.
AUTOMERGE_AUTHORS="${AUTOMERGE_AUTHORS:-}"
DO_NOT_MERGE_LABELS="${DO_NOT_MERGE_LABELS:-do-not-merge,hold,blocked}"
REVIEW_WORKFLOW_PATH="${REVIEW_WORKFLOW_PATH:-.github/workflows/pr-auto-review.yml}"
PR_LIMIT="${PR_LIMIT:-50}"
# The name prefix that identifies a REVIEWER's check run rather than a CI one.
# Both source scripts hard-coded this string, and so does ci-status.jq. It is a
# variable here because it is not free-form naming: a reviewer job named outside
# the prefix is invisible as a reviewer and therefore counts as CI, so the
# reviewer waits for ITSELF. That deadlock was observed while adding a second
# reviewer to PromptCI in shadow mode — the shadow's queued check run read to
# the incumbent as an in-progress CI check while it sat queued behind the
# incumbent on the same single runner.
#
# ci-status.jq still hard-codes it, so a consumer changing this ALONE would
# diverge the two. Parameterizing that file is a separate change against the
# highest-risk file in the engine; this one does not pretend to have made it.
REVIEWER_CHECK_PREFIX="${REVIEWER_CHECK_PREFIX:-🤖 Auto-Review}"

log() { echo "[review-sweep] $*"; }
warn() { echo "::warning::[review-sweep] $*"; }
die() { echo "::error::[review-sweep] $*" >&2; exit 1; }

command -v "$GH_CLI" >/dev/null 2>&1 || die "gh not found (GH_CLI=${GH_CLI})"
command -v jq >/dev/null 2>&1 || die "jq not found"
[ -n "$REPO" ] || die "REPO is required (owner/name)"

# ── 1. Candidate PRs ────────────────────────────────────────────────────────
# `mergeStateStatus` and `baseRefName` ride along on this one call: they are what
# the wedged-mergeability trigger gates on, and asking for them here costs
# nothing extra, whereas a per-PR `gh pr view` on every tick would.
prs_json=""
if ! prs_json="$($GH_CLI pr list --repo "$REPO" --state open --limit "$PR_LIMIT" \
  --json number,headRefName,headRefOid,baseRefName,mergeStateStatus,isDraft,author,labels 2>&1)"; then
  die "could not list open PRs: $(printf '%s' "$prs_json" | head -c 300)"
fi

candidates="$(printf '%s' "$prs_json" | jq -r \
  --arg authors "$AUTOMERGE_AUTHORS" \
  --arg holds "$DO_NOT_MERGE_LABELS" '
  # `select(length > 0)` drops the empty entry a trailing comma leaves behind
  # ("alice," -> ["alice", ""]). It is belt-and-braces, not load-bearing, and
  # is marked so deliberately: an empty allowlist already sweeps nothing without
  # it (jq splits "" to [], and the empty string matches no GitHub login, which
  # cannot be empty). It survives mutation for that reason. Kept because it
  # costs nothing and makes the intent of the list explicit; do not read its
  # presence as evidence that some input needs it.
  ($authors | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length > 0))) as $allowed
  | ($holds | split(",") | map(gsub("^\\s+|\\s+$";"") | ascii_downcase)) as $hold
  | .[]
  # Bind the PR before any `$array | index(...)`: inside the parens `.` is the
  # ARRAY, so `index(.author.login)` indexes $allowed with a field of $allowed
  # and dies with "Cannot index array with string".
  | . as $pr
  | select($pr.isDraft == false)
  | select(($allowed | index("*")) != null or ($allowed | index($pr.author.login)) != null)
  | select([$pr.labels[].name | ascii_downcase] | any(. as $l | ($hold | index($l)) != null) | not)
  | "\(.number)\t\(.headRefOid)\t\(.headRefName)\t\(.baseRefName // "")\t\(.mergeStateStatus // "")"
' 2>/dev/null)" || die "could not parse the PR list"

if [ -z "$candidates" ]; then
  log "no open, non-draft, auto-mergeable PRs to assess"
  exit 0
fi

now_epoch="$(date -u +%s)"
assessed=0
rerun=0
commented=0
# Branch protection is read at most once per base ref per sweep.
protection_ref=""
protection_contexts=""
protection_state=""

# Read `<base>`'s required status contexts into the single-slot cache and
# classify the answer into four outcomes that must never be conflated.
# Collapsing them is what would let an inert guard read as a routine skip:
#   ok         — the read succeeded and named at least one required context.
#   none       — `.protection` came back, and the base requires NO context.
#   redacted   — the branch came back but carried no `.protection` object at
#                all, i.e. this token may not see protection on this repo.
#   unreadable — the API call itself, or the parse, failed.
load_protection_contexts() {
  local base="$1"
  if [ "$protection_ref" = "$base" ] && [ -n "$protection_state" ]; then
    return 0
  fi
  protection_ref="$base"
  protection_contexts=""
  protection_state="unreadable"

  local prot_json=""
  prot_json="$($GH_CLI api "repos/${REPO}/branches/${base}" 2>&1)" || return 0

  local seen=""
  seen="$(printf '%s' "$prot_json" | jq -r '
    if (.protection | type) == "object" then "yes" else "no" end
  ' 2>/dev/null)" || return 0
  if [ "$seen" != "yes" ]; then
    protection_state="redacted"
    return 0
  fi

  local parsed=""
  parsed="$(printf '%s' "$prot_json" | jq -r '
    [((.protection.required_status_checks.contexts // [])[]),
     ((.protection.required_status_checks.checks // [])[] | .context)]
    | map(select(. != null)) | unique | .[]
  ' 2>/dev/null)" || return 0

  protection_contexts="$parsed"
  if [ -n "$protection_contexts" ]; then
    protection_state="ok"
  else
    protection_state="none"
  fi
}

# ── 1b. Self-check: can the wedged-mergeability guard fire AT ALL? ──────────
# Guard 3 below only runs for a PR that is green, reviewed `success` and
# currently BLOCKED — rare enough that a permanently broken protection read
# could sit undetected for weeks, warning once in a while in a shape that looks
# like an ordinary "leave it alone" skip. Probing once per sweep costs one
# `gh api` call per distinct base ref and turns that silence into a per-tick,
# greppable statement of whether the trigger is alive.
while IFS= read -r base_probe; do
  [ -n "$base_probe" ] || continue
  load_protection_contexts "$base_probe"
  case "$protection_state" in
    ok)
      log "self-check: '${base_probe}' requires $(printf '%s\n' "$protection_contexts" | grep -c .) status context(s), readable by this token — the wedged-mergeability trigger can fire" ;;
    none)
      warn "SELF-CHECK: '${base_probe}' branch protection is readable but requires NO status context — the wedged-mergeability trigger is INERT for PRs based on it and will skip every BLOCKED PR. That is correct behaviour for an unprotected base, not a bug; it is said out loud so an inert trigger is never mistaken for a working one." ;;
    redacted)
      warn "SELF-CHECK FAILED: repos/${REPO}/branches/${base_probe} returned no .protection object to this token — the wedged-mergeability trigger is INERT and will skip every BLOCKED PR based on '${base_probe}'. The two other triggers are unaffected. Do NOT 'fix' this with an administration: permission key: it is a GitHub App permission, invalid in a workflow, and adding it takes the whole sweep down." ;;
    *)
      warn "SELF-CHECK FAILED: could not read repos/${REPO}/branches/${base_probe} — the wedged-mergeability trigger is INERT this tick. The two other triggers are unaffected." ;;
  esac
done <<< "$(printf '%s\n' "$candidates" | cut -f4 | sort -u)"

# ── 2. Assess each PR ───────────────────────────────────────────────────────
while IFS=$'\t' read -r pr sha head_ref base_ref merge_state; do
  [ -n "$pr" ] || continue
  if [ "$assessed" -ge "$MAX_PRS" ]; then
    # Never silent about a cap: a truncated sweep that says nothing reads as
    # "everything was fine".
    log "MAX_PRS=${MAX_PRS} reached — stopping; the next sweep continues from here"
    break
  fi
  assessed=$((assessed + 1))

  # "Green" is delegated to ci-lib.sh so this sweep can never disagree with the
  # bot about what counts as passing — including required-context PRESENCE,
  # which a naive "every check that exists is success" read would miss, and
  # which guard 3 below then has to rule out for the wedged trigger.
  required_json="$(required_contexts "$base_ref")"
  status_json="$(ci_status_json "$sha" '[]' "$required_json")"

  ci_api_failed="$(printf '%s' "$status_json" | jq -r '.api_failed')"
  if [ "$ci_api_failed" = "true" ]; then
    warn "PR #${pr}: could not read CI status for ${sha:0:12} — skipping"
    continue
  fi

  ci_total="$(printf '%s' "$status_json" | jq -r '.total')"
  ci_all_success="$(printf '%s' "$status_json" | jq -r '.all_success')"

  if [ "$ci_all_success" != "true" ]; then
    log "PR #${pr}: CI on ${sha:0:12} is not fully green (${ci_total} checks) — nothing to recover"
    continue
  fi

  # ci-status.jq deliberately carries no timestamp (it is a pure reduction of
  # the check-run set), so the settle time comes from one extra raw fetch of the
  # same endpoint — paid only for a PR that is ALREADY green, which is the rare
  # case this sweep exists for. The same fetch serves guard 3's check-name list.
  checks_json=""
  if ! checks_json="$($GH_CLI api --paginate "repos/${REPO}/commits/${sha}/check-runs?per_page=100" 2>&1)"; then
    warn "PR #${pr}: could not re-read check runs for ${sha:0:12} to compute settle time — skipping"
    continue
  fi
  ci_settled="$(printf '%s' "$checks_json" | jq -s -r --arg reviewer "$REVIEWER_CHECK_PREFIX" '
    [.[] | if .check_runs then .check_runs[] else empty end]
    | map(select(.name | startswith($reviewer) | not))
    | group_by(.name)
    | map(max_by(.id))
    | ([.[] | .completed_at] | map(select(. != null)) | sort | last) // empty
  ' 2>/dev/null)" || ci_settled=""
  if [ -z "$ci_settled" ]; then
    warn "PR #${pr}: CI reads green but no completion timestamp — skipping"
    continue
  fi

  settled_epoch=0
  settled_epoch="$(date -u -d "$ci_settled" +%s 2>/dev/null)" || settled_epoch=0
  if [ "$settled_epoch" -eq 0 ]; then
    warn "PR #${pr}: unparseable CI completion timestamp '${ci_settled}' — skipping"
    continue
  fi
  if [ $((now_epoch - settled_epoch)) -lt "$MIN_SETTLE_SECONDS" ]; then
    log "PR #${pr}: CI went green $((now_epoch - settled_epoch))s ago — under MIN_SETTLE_SECONDS=${MIN_SETTLE_SECONDS}, giving the review its own chance first"
    continue
  fi

  runs_json=""
  if ! runs_json="$($GH_CLI api "repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100" 2>&1)"; then
    warn "PR #${pr}: could not list workflow runs for ${sha:0:12} — skipping"
    continue
  fi
  review="$(printf '%s' "$runs_json" | jq -r --arg path "$REVIEW_WORKFLOW_PATH" '
    [.workflow_runs[] | select(.path == $path)]
    | {
        live: ([.[] | select(.status != "completed")] | length),
        newest: (if length > 0 then (max_by(.id)) else null end)
      }
    | "\(.live)\t\(if .newest then .newest.id else "" end)\t\(if .newest then .newest.run_started_at else "" end)\t\(if .newest then (.newest.conclusion // "") else "" end)\t\(if .newest then (.newest.run_attempt // 1) else "" end)"
  ' 2>/dev/null)" || review=""
  if [ -z "$review" ]; then
    warn "PR #${pr}: could not parse workflow runs for ${sha:0:12} — skipping"
    continue
  fi
  IFS=$'\t' read -r review_live review_id review_started review_conclusion review_attempt <<< "$review"

  if [ "${review_live:-0}" != "0" ]; then
    log "PR #${pr}: a review run for ${sha:0:12} is still in flight — leaving it to finish"
    continue
  fi
  if [ -z "$review_id" ]; then
    # Nothing to re-run. Dispatching one instead is deliberately NOT done here:
    # this case means the review never started at all, which is a different
    # fault class and wants a human, not a silent workaround.
    log "PR #${pr}: no auto-review run exists for ${sha:0:12} — not this sweep's business"
    continue
  fi
  if [ -z "$review_started" ]; then
    warn "PR #${pr}: review run ${review_id} has no run_started_at — skipping"
    continue
  fi

  # Compared as epochs, not as strings: both are UTC ISO-8601 from the same API
  # so a lexicographic compare would usually agree, but "usually" under a
  # locale-dependent collation is not a property worth relying on for the test
  # that decides whether to spend a review run.
  started_epoch=0
  started_epoch="$(date -u -d "$review_started" +%s 2>/dev/null)" || started_epoch=0
  if [ "$started_epoch" -eq 0 ]; then
    warn "PR #${pr}: unparseable review start timestamp '${review_started}' — skipping"
    continue
  fi

  if ! [[ "$review_attempt" =~ ^[0-9]+$ ]]; then
    review_attempt=1
  fi

  reason=""
  if [ "$settled_epoch" -gt "$started_epoch" ]; then
    reason="the newest review run ${review_id} started ${review_started} — before that"
  elif [ -n "$review_conclusion" ] && [ "$review_conclusion" != "success" ]; then
    # A red review run means the REVIEWER failed, not the PR. This run DID start
    # after CI settled — so the started-before-settle trigger correctly says
    # nothing new happened to CI — but the run itself never reached a verdict.
    # Bounded by run_attempt rather than run_started_at; see "WHY IT CANNOT LOOP".
    if [ "$review_attempt" -lt "$MAX_RERUN_ATTEMPTS" ]; then
      reason="the newest review run ${review_id} started ${review_started} (after CI settled ${ci_settled}) but itself concluded '${review_conclusion}' on attempt ${review_attempt}/${MAX_RERUN_ATTEMPTS}"
    else
      log "PR #${pr}: review run ${review_id} concluded '${review_conclusion}' but is already at attempt ${review_attempt}/${MAX_RERUN_ATTEMPTS} — leaving it for a human instead of re-running forever"
      continue
    fi
  elif [ "$merge_state" = "BLOCKED" ] && [ "$review_conclusion" = "success" ]; then
    # ── THE THIRD SHAPE: wedged mergeability ────────────────────────────────
    # The review ran, saw this exact green CI, found nothing, and concluded
    # `success` — so both triggers above are correctly silent — and GitHub STILL
    # refuses the merge. See "THE THIRD GAP" for the measurement, and for why
    # every guard below fails CLOSED.

    # (3) Does every context branch protection REQUIRES actually report on this
    # SHA? Green CI cannot answer that — a context that never produced a check
    # run is missing, not red — and a missing required context is a REAL block.
    # A required context satisfied only by a legacy commit status reads as
    # missing here and the PR is skipped: conservative on purpose.
    # §1b has normally already loaded this ref, so this is a cache hit. The
    # outcomes stay distinct here too — "the read is broken" and "this base
    # requires nothing" want different fixes from whoever reads the log.
    load_protection_contexts "$base_ref"
    case "$protection_state" in
      ok) : ;;
      none)
        warn "PR #${pr}: reads BLOCKED with green CI, but ${base_ref} requires no status context, so this guard cannot rule out a real block — not guessing; a real block must never be swept"
        continue ;;
      *)
        warn "PR #${pr}: reads BLOCKED with green CI, but ${base_ref}'s required contexts could not be read (${protection_state}; see the SELF-CHECK line above) — not guessing; a real block must never be swept"
        continue ;;
    esac

    check_names="$(printf '%s' "$checks_json" | jq -s -r --arg reviewer "$REVIEWER_CHECK_PREFIX" '
      [.[] | if .check_runs then .check_runs[] else empty end]
      | map(select(.name | startswith($reviewer) | not))
      | .[].name
    ' 2>/dev/null)" || check_names=""
    missing_context=""
    while IFS= read -r ctx; do
      [ -n "$ctx" ] || continue
      if ! printf '%s\n' "$check_names" | grep -Fxq -- "$ctx"; then
        missing_context="$ctx"
        break
      fi
    done <<< "$protection_contexts"
    if [ -n "$missing_context" ]; then
      log "PR #${pr}: reads BLOCKED and the required context '${missing_context}' never reported on ${sha:0:12} — that block is REAL, leaving it alone"
      continue
    fi

    # (4) The bot's own metadata, plus the sweep's own marker. One read serves
    # both, which is why the comment is what makes the stop idempotent.
    comments_json=""
    if ! comments_json="$($GH_CLI api --paginate "repos/${REPO}/issues/${pr}/comments?per_page=100" 2>&1)"; then
      warn "PR #${pr}: reads BLOCKED with green CI but its comments could not be read — skipping"
      continue
    fi
    wedged=""
    wedged="$(printf '%s' "$comments_json" | jq -s -r \
      --arg marker "${WEDGED_MARKER_PREFIX}${sha}${WEDGED_MARKER_SUFFIX}" '
      def val($lines; $k):
        ([$lines[] | select(startswith("  " + $k + ": "))] | last // ("  " + $k + ": "))
        | ltrimstr("  " + $k + ": ");
      [.[] | .[]?] as $all
      | (if ($all | map(select(.body | contains($marker))) | length) > 0 then "yes" else "no" end) as $marked
      | ($all | map(select(.body | contains("PR Auto-Review Summary"))) | sort_by(.id) | last) as $summary
      | (if $summary then ($summary.body | split("\n")) else [] end) as $lines
      | [$marked,
         val($lines; "merge_attempts"),
         val($lines; "pr_head_sha"),
         (val($lines; "merge_error") | gsub("\t"; " "))]
      | @tsv
    ' 2>/dev/null)" || wedged=""
    if [ -z "$wedged" ]; then
      warn "PR #${pr}: could not parse the review comments for ${sha:0:12} — skipping"
      continue
    fi
    IFS=$'\t' read -r wedged_marked wedged_attempts wedged_head_sha wedged_error <<< "$wedged"

    if [ "$wedged_marked" = "yes" ]; then
      log "PR #${pr}: already told about the wedged merge on ${sha:0:12} — not re-running and not commenting again"
      continue
    fi
    if [ "$wedged_head_sha" != "$sha" ]; then
      log "PR #${pr}: reads BLOCKED, but the newest review summary describes ${wedged_head_sha:-none}, not ${sha:0:12} — skipping"
      continue
    fi
    if [ "$wedged_attempts" != "0" ]; then
      log "PR #${pr}: reads BLOCKED after ${wedged_attempts:-unknown} merge attempt(s) — GitHub judged the merge itself, not this sweep's business"
      continue
    fi
    case "$wedged_error" in
      *"mergeStateStatus=BLOCKED"*) : ;;
      *)
        log "PR #${pr}: reads BLOCKED but the review recorded no BLOCKED mergeability error ('${wedged_error:-none}') — skipping"
        continue ;;
    esac

    if [ "$review_attempt" -lt "$WEDGED_MERGE_MAX_ATTEMPTS" ]; then
      reason="the newest review run ${review_id} concluded 'success' but GitHub refused the merge with a wedged mergeability verdict (${wedged_error}) on attempt ${review_attempt}/${WEDGED_MERGE_MAX_ATTEMPTS}"
    else
      log "PR #${pr}: still WEDGED on ${sha:0:12} after ${review_attempt} review attempt(s) — commenting with the recovery and leaving this PR alone"
      if [ "$DRY_RUN" = "1" ]; then
        log "PR #${pr}: DRY_RUN — would comment with the rebase + force-push recovery"
        commented=$((commented + 1))
        continue
      fi
      body_file=""
      body_file="$(mktemp)"
      {
        printf '%s\n\n' "### 🤖 Stranded review sweep — this PR's merge is wedged, and only you can clear it"
        printf '%s\n\n' "CI on \`${sha:0:12}\` is green, every context \`${base_ref}\` requires has reported, and the auto-review concluded \`success\` — but GitHub still answers \`mergeStateStatus=BLOCKED\` and refuses the merge. The sweep already re-ran the review once and got the same answer, so it will not touch this PR again."
        printf '%s\n\n' "**Recovery — rebase onto current \`origin/${base_ref}\` and force-push.** A new head SHA gets a fresh mergeability computation from GitHub, which is what cleared the PR this trigger was built for, immediately after two review runs had both refused:"
        printf '%s\n' '```bash'
        printf '%s\n' "git fetch origin ${base_ref}"
        printf '%s\n' "git rebase origin/${base_ref}"
        printf '%s\n' "git push --force-with-lease"
        printf '%s\n\n' '```'
        printf '%s\n\n' "Re-triggering the review (\`gh pr ready --undo && gh pr ready\`) is **not** the recovery — it produced a second run that concluded \`success\` and refused the merge identically. This sweep deliberately never rebases or force-pushes for you: it would clobber unpushed work and race any session editing this branch."
        printf '%s\n' "${WEDGED_MARKER_PREFIX}${sha}${WEDGED_MARKER_SUFFIX}"
      } > "$body_file"
      comment_out=""
      if ! comment_out="$($GH_CLI pr comment "$pr" --repo "$REPO" --body-file "$body_file" 2>&1)"; then
        warn "PR #${pr}: could not post the wedged-merge comment: $(printf '%s' "$comment_out" | head -c 300)"
      else
        commented=$((commented + 1))
      fi
      rm -f "$body_file"
      continue
    fi
  else
    log "PR #${pr}: review run ${review_id} started ${review_started}, after CI settled ${ci_settled} — it has already seen this state"
    continue
  fi

  log "PR #${pr} (${head_ref}) is STRANDED: ${ci_total} checks green on ${sha:0:12} as of ${ci_settled}, but ${reason}. Re-running it."
  if [ "$DRY_RUN" = "1" ]; then
    log "PR #${pr}: DRY_RUN — would re-run review run ${review_id}"
    rerun=$((rerun + 1))
    continue
  fi
  rerun_out=""
  if ! rerun_out="$($GH_CLI api -X POST "repos/${REPO}/actions/runs/${review_id}/rerun" 2>&1)"; then
    warn "PR #${pr}: could not re-run review run ${review_id}: $(printf '%s' "$rerun_out" | head -c 300)"
    continue
  fi
  rerun=$((rerun + 1))
done <<< "$candidates"

log "assessed ${assessed} PR(s); re-ran ${rerun} stranded review(s); commented on ${commented} wedged merge(s)$([ "$DRY_RUN" = "1" ] && echo ' (dry run)' || true)"
