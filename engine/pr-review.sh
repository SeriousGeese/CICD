#!/usr/bin/env bash
# PR Auto-Review Script
# Called from .github/workflows/pr-auto-review.yml
# Runs on a self-hosted runner with pr-review label.
#
# Environment (set by workflow):
#   PR_NUMBER, PR_HEAD_REF, PR_BASE_REF, PR_TITLE, PR_BODY, PR_AUTHOR
#   HEAD_SHA, BASE_SHA, REPO, WORK_DIR
#   OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL (optional)
#   AUTOMERGE_AUTHORS (comma-separated logins; "*" = everyone)
#   GH_TOKEN, GITHUB_WORKSPACE, GITHUB_OUTPUT, GITHUB_RUN_ID
#   GH_CLI (optional — default: "gh")
#   RUNNER_HOST, RUNNER_NAME (optional — for comment metadata)
#
# Exit codes: 0 = merged / reviewed / comment-only; 1 = action required
# (review failed, sync conflict, CI failures) — the red check is the merge
# block. Bypass instructions are included in the PR comment.

set -euo pipefail

# gh CLI: allow override via env var (workflow sets the right path per runner)
GH_CLI="${GH_CLI:-gh}"

# ── Configuration ──────────────────────────────────────────────────────────
: "${PR_NUMBER:?}" "${PR_HEAD_REF:?}" "${PR_BASE_REF:?}" "${PR_AUTHOR:?}"
: "${REPO:?}" "${WORK_DIR:?}"
: "${GH_TOKEN:?}"

# LLM chain: OpenRouter primary (paid) → OpenRouter free fallback. The former
# local (Lemonade/llama.cpp) reviewer tier was removed — running inference on
# the runner host caused local system instability, and OpenRouter already
# covered every prompt the local tier could not.
: "${OPENROUTER_ENDPOINT:=https://openrouter.ai/api/v1/chat/completions}"
: "${OPENROUTER_MODEL:=deepseek/deepseek-v4-flash}"
: "${OPENROUTER_FALLBACK_MODEL:=nvidia/nemotron-3-super-120b-a12b:free}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

# Authors whose PRs get auto-fix pushes and auto-merge. Everyone else gets a
# review comment only (no pushes to their branch, no merge). "*" opens it up.
: "${AUTOMERGE_AUTHORS:=strickdd,dependabot[bot]}"

# Labels that forbid an automated merge outright, regardless of author, review
# verdict or CI state. Comma-separated; matched case-insensitively.
#
# WHY (DnD-0g0ok follow-up, 2026-07-19): draft status is NOT a durable hold. Any
# concurrent session or human can flip a PR out of draft with `gh pr ready`, and
# the bot will then happily merge work a human deliberately parked. That happened
# for real: PR #1443 held a socket authorization change awaiting live stage
# verification, another account marked it ready at 02:18Z, and only an unrelated
# manual check seven minutes later stopped it from merging unverified. A label is
# the durable signal — it survives ready/draft toggles and is visible in the PR UI.
: "${DO_NOT_MERGE_LABELS:=do-not-merge,hold,blocked}"

# gh CLI location — override via GH_CLI env var (workflow sets per runner)
GH_CLI="${GH_CLI:-gh}"

# EVERY $GH_CLI call must pass --repo "$REPO" (DnD-m3uj3). Without it, gh infers
# the repository from the git remote of the CURRENT WORKING DIRECTORY — and this
# workflow deliberately runs no actions/checkout, so the step's default cwd
# ($GITHUB_WORKSPACE) is not a git repo at all. Any gh call made before the first
# `cd` therefore exits non-zero, while the identical call after `cd
# "$WORKTREE_PATH"` succeeds. That is not hypothetical: it silently disabled
# auto-merge repo-wide. has_do_not_merge_label() runs at the very top of main(),
# fails closed by design, and so held every PR on a phantom label, while the
# metadata line in the PR comment — rendered later, from inside the worktree —
# reported "do_not_merge_label: none" and hid the cause. Run 29692359992:
# HOLD at 15:12:22 (pre-cd), `pr view --json commits` fine at 15:12:25 (post-cd).

BOT_NAME="Strickdd Bot"
BOT_EMAIL="strickdd@gmail.com"
WORK_DIR="${WORK_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Strips CR/LF/tab/stray whitespace from OPENROUTER_API_KEY. curl silently drops a
# header containing a newline, which presents as a 401 from the provider — a real
# incident in promptci-cloud (#142) that cost a day, and one neither DnD nor
# PromptCI is protected from today.
# shellcheck source=./sanitize-secret.sh
source "${SCRIPT_DIR}/sanitize-secret.sh"

# Provides required_contexts() and ci_status_json() — the two shell-side seams
# around ci-status.jq, which is now the single reduction every CI verdict in this
# file is computed from. Sourced here, BEFORE log() is defined below, on purpose:
# ci-lib.sh defines its own log() only when the name is unbound, so this file's
# definition further down then wins for both.
#
# SCRIPT_DIR is the extracted tools dir at runtime, not a repo path, so every file
# sourced here must be shipped alongside pr-review.sh by the composite action. A
# missing one aborts the whole review under `set -e`.
# shellcheck source=./ci-lib.sh
source "${SCRIPT_DIR}/ci-lib.sh"

# The required-context set, as JSON. main() replaces this with the live ruleset via
# required_contexts(); the default keeps every ci_status_json() call below valid
# when it has not run yet (and in library mode, where main() never runs at all).
: "${REQUIRED_CONTEXTS_JSON:=[]}"
find_python_bin() {
  local candidate
  for candidate in "${PYTHON_BIN:-}" python3.11 python3 python; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" -c 'import sys' >/dev/null 2>&1 || continue
    printf '%s\n' "$candidate"
    return 0
  done
  printf '%s\n' python3
}

PYTHON_BIN="$(find_python_bin)"
PYTHON_NEEDS_WIN_PATHS=0
if "$PYTHON_BIN" -c 'import os, sys; sys.exit(0 if os.name == "nt" else 1)' >/dev/null 2>&1; then
  PYTHON_NEEDS_WIN_PATHS=1
fi

python_path() {
  if [ "$PYTHON_NEEDS_WIN_PATHS" = "1" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}
# The review prompt is PER-REPO and deliberately not in this repo: DnD's names
# Adventure Packs and DM/Player/Admin roles, PromptCI's names detector determinism.
# It is product knowledge, so it lives with the product and arrives via
# SYSTEM_PROMPT_FILE (the composite action points this at the PR's own
# scripts/review-prompt.md). SCRIPT_DIR remains the fallback so a repo that ships
# the prompt beside the engine still works.
PROMPT_FILE="${SYSTEM_PROMPT_FILE:-${SCRIPT_DIR}/review-prompt.md}"
MAX_ITERATIONS=3
MAX_DIFF_LINES=5000
# `: "${VAR:=default}"`, not a bare assignment, for all four poll clocks.
#
# That is a testability investment, not a style choice: every timing case in
# tests/engine/wait-for-ci.test.ts drives the real loop over compressed
# timescales, and a bare assignment makes that impossible — the suite would have
# to wait out a 30-minute timeout or reimplement the loop it is meant to be
# testing. Production behaviour is unchanged; the defaults are the old values.
: "${POLL_INTERVAL:=30}"    # seconds between CI status checks
: "${POLL_TIMEOUT:=1800}"   # 30 min total timeout for CI

# GitHub creates a check-run within seconds of a workflow actually triggering, so
# if none exists after this grace, none is coming for this SHA.
#
# This USED to also excuse a docs-only PR whose paths-ignore suppressed every
# workflow — the return-3 grace. That is gone: every consumer now publishes an
# aggregate context on every PR (DnD via ci-docs-shim.yml), so zero checks is a
# fault rather than a legitimate state, and this grace only absorbs the startup
# window.
: "${ZERO_CHECKS_GRACE:=120}"

# A SEPARATE, LONGER clock for "a required context has not registered yet", and
# separate on purpose. Some checks exist while a required one is still queueing,
# so the zero-checks grace has already been satisfied and would never re-arm —
# wiring both to one constant means the required-context wait effectively does not
# exist. The test asserts the two are distinct by driving them apart.
: "${MISSING_REQUIRED_GRACE:=300}"
# Checks that FINISHED without a verdict on the last poll, rendered as
# `<name> [conclusion=<c>]; …` (DnD-7aqcv). wait_for_ci sets it alongside its
# return-5 verdict so the PR comment can name them; unresolved_ci_message() is
# the only reader. A global rather than a return value because bash functions
# return an exit status, and this one already uses every code it has.
LAST_UNRESOLVED_CHECKS=""
LAST_MISSING_REQUIRED=""   # return 6 — `<context>, <context>`
# The checks that were RED on the poll wait_for_ci blocked on, same rendering
# and same reason (DnD-85jir): the PR comment names them instead of reporting a
# bare count nobody can act on.
LAST_FAILED_CHECKS=""

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# COMMENT_FILE is a CONTRACT with .github/workflows/pr-auto-review.yml, which
# reads `/tmp/pr-review-comment-${PR_NUMBER}.md` back in a later workflow step
# (a different process). Its name must stay keyed on PR_NUMBER alone.
COMMENT_FILE="/tmp/pr-review-comment-${PR_NUMBER}.md"
# The four files below are the opposite: internal scratch for ONE run of this
# script, which cleanup() deletes on EXIT and nothing outside this process ever
# reads. So they are keyed on the pid as well (DnD-gpeej).
#
# PR_NUMBER alone is not unique on a developer box. Nine prReview* jest suites
# source this script with PR_NUMBER=42, jest runs them in parallel workers, and
# several agent sessions run `npm test` concurrently on the same machine
# besides — all sharing one /tmp. One harness's EXIT trap then `rm -f`s another
# harness's response file mid-read, and a review body written by one suite gets
# parsed by another. Reproduced 2026-09-06 by running two full suites at once:
# prReviewLlmValidity parsed the OTHER run's stub body and reported
# `rc=1 tier=none` against an input that is valid.
#
# `$$` is the invoking shell's pid even inside the command-substitution subshell
# apply_fixes runs in (only $BASHPID differs there), so the write-here/read-there
# handoff across that boundary still resolves to one file.
RESPONSE_FILE="/tmp/pr-review-response-${PR_NUMBER}-$$.json"
FIXES_FILE="/tmp/pr-review-fixes-${PR_NUMBER}-$$.json"
# Markdown bullet lists accumulated by apply_fixes (which runs in a command
# substitution subshell, so shell variables can't carry this state out) and
# surfaced in the final PR comment — the owner must be able to see what the
# bot changed or dropped without digging through runner logs (DnD-pchr6).
APPLIED_FIXES_FILE="/tmp/pr-review-applied-${PR_NUMBER}-$$.md"
DROPPED_FIXES_FILE="/tmp/pr-review-dropped-${PR_NUMBER}-$$.md"
: > "$APPLIED_FIXES_FILE"
: > "$DROPPED_FIXES_FILE"
CONVERGE_ATTEMPTS="[]"
FIXES_PUSHED=false

# Sentinel that has_do_not_merge_label() emits instead of a label name when the
# labels could not be read at all. Callers must treat it as a hold (fail closed)
# AND as an infrastructure fault worth shouting about — a real hold is one human
# parking one PR; this one silently holds every PR in the repo (DnD-m3uj3).
LABEL_LOOKUP_FAILED='<label lookup failed>'
# The hold in force for this run: a real label name, $LABEL_LOOKUP_FAILED, or "".
# Recorded by the callers so the PR comment reports the same answer the merge
# decision actually used, rather than re-querying and quietly disagreeing with it.
HOLD_LABEL=""

# ── Stacked-PR holds (DnD-iji9r / DnD-pb4ur) ────────────────────────────────
# Recorded by the guards for the same reason HOLD_LABEL is: the comment must
# report the answer the merge decision actually used.
HOLD_STACKED_BASE=""   # the non-default base ref this PR targets
HOLD_UNMET_DEPS=""     # space-separated "#N" refs that are not merged yet
HOLD_ORPHANS=""        # space-separated "#N" open PRs based on THIS head

# ── Why the merge did not happen, in GitHub's own words (DnD-4an04) ─────────
# The comment used to guess among three causes ("conflicts with main, a required
# check not yet reported, or the base moved") while the real GraphQL error was
# in hand, so every triage started by looking for conflicts that did not exist.
# Recorded by merge_pr / wait_for_mergeable; rendered by merge_error_block.
MERGE_ERROR=""
MERGE_ATTEMPTS_MADE=0

# Resolved once per run — the default branch is constant for the run, and
# re-reading it per guard would triple the API calls for no information.
DEFAULT_BRANCH_CACHE=""

# Which LLM tier actually produced the review (set by review_llm)
LLM_USED_TIER="none"
LLM_USED_MODEL="none"
LLM_USED_ENDPOINT="none"
# Review-call telemetry (set by review_llm; surfaced in the PR comment's
# metadata YAML). A review that "passed" in 3 seconds on 40 prompt tokens is
# a rubber stamp — these make that visible per PR instead of only in runner
# logs (DnD-gbw3s).
LLM_PROMPT_TOKENS=0
LLM_COMPLETION_TOKENS=0
LLM_CALL_SECONDS=0

# ── Free-tier reviewers may COMMENT but never auto-APPLY (DnD-8fbkq) ────────
# On PR #2747 the free-tier reviewer reported a tier-limit bug that did not
# exist — the clone action already inserts the gate's clamped
# `resolvedPlayerSlots`, not the source run's raw value — and generated an
# auto-appliable patch that would have CREATED the regression it claimed to
# prevent. This bot auto-applies suggested fixes and then merges them for
# allowlisted authors, so the only thing between that patch and `main`, on a
# billing-adjacent tier-limit guard, was a `do-not-merge` label that happened to
# be on for an unrelated reason.
#
# Competence varies by tier per run (#2747 `openrouter-free` /
# `nvidia/nemotron-3-super-120b-a12b:free` was wrong; #2746 `openrouter` /
# `z-ai/glm-5.2` in the same batch was right), and it was not a truncation
# artifact — the free run burned 59272 prompt / 9892 completion tokens. So a
# free-tier finding is advisory: it is reported in full, and a paid-tier run or
# a human has to be the one that applies it.
#
# The list is the set of tier names that MAY auto-apply. Everything else is
# refused, which makes this fail CLOSED the same way the do-not-merge label
# lookup does: "none", an empty tier, a tier added to the chain later and not
# listed here, and a listed tier that resolved to a `:free` model id are all
# treated as free. Widening it is a deliberate act, not an oversight.
PAID_LLM_TIERS="openrouter"

# 0 when $LLM_USED_TIER is positively identified as a tier allowed to auto-apply.
llm_tier_is_paid() {
  local candidate
  # A paid tier pointed at a `:free` OpenRouter model id is a free review
  # wearing the paid tier's name — OPENROUTER_MODEL is an Actions variable and
  # can be repointed without touching this script.
  case "${LLM_USED_MODEL:-}" in
    *:free) return 1 ;;
  esac
  for candidate in $PAID_LLM_TIERS; do
    [ "${LLM_USED_TIER:-}" = "$candidate" ] && return 0
  done
  return 1
}

# One line naming the tier that produced this review, for the TOP of the PR
# comment (DnD-8fbkq). The tier is the single best predictor of how much to
# trust the verdict, and it used to live only inside the collapsed "Review
# Metadata" block — so a human skimming the PR page saw a confident review and
# no indication of which model wrote it. Anything a reader needs in order to
# calibrate trust belongs above the fold.
llm_tier_header_line() {
  case "${LLM_USED_TIER:-none}" in
    ''|none)
      printf '**Reviewer:** ⚠️ no LLM tier completed a review.'
      ;;
    *)
      if llm_tier_is_paid; then
        printf '**Reviewer:** `%s` tier — `%s` (paid tier: may auto-apply fixes).' \
          "$LLM_USED_TIER" "${LLM_USED_MODEL:-none}"
      else
        printf '**Reviewer:** ⚠️ `%s` tier — `%s` (FREE tier: findings are advisory and are NEVER auto-applied — weigh them yourself before acting).' \
          "$LLM_USED_TIER" "${LLM_USED_MODEL:-none}"
      fi
      ;;
  esac
}

# ── Helper functions ───────────────────────────────────────────────────────

log()  { echo >&2 "[pr-review] $*"; }
die()  { log "FATAL: $*"; exit 1; }

# jq parses every merge-affecting decision in this script (check-run counts,
# LLM review JSON, converge metadata). Without it those parses degrade into
# their fallbacks — which read as "zero check runs" and can steer the merge
# logic — so refuse to start at all rather than limp (DnD-4drs9).
command -v jq >/dev/null 2>&1 || die "jq not found on PATH — install jq on this runner"

# GitHub workflow annotation — surfaces in the run summary and the Actions UI
# rather than only in the log body, which nobody reads on a green run. Goes to
# STDOUT (where the runner parses ::commands::), so it must only ever be called
# from a context whose stdout is not captured by a command substitution.
annotate() { printf '::%s::%s\n' "$1" "$2"; }

cleanup() {
  if [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR" 2>/dev/null || true
    log "Cleaned up working directory: ${WORK_DIR}"
  fi
  rm -f "$RESPONSE_FILE" "$FIXES_FILE" "$APPLIED_FIXES_FILE" "$DROPPED_FIXES_FILE" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

is_automerge_author() {
  local entry
  IFS=',' read -ra _allowed <<< "$AUTOMERGE_AUTHORS"
  for entry in "${_allowed[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"  # trim leading whitespace
    entry="${entry%"${entry##*[![:space:]]}"}"  # trim trailing whitespace
    if [ "$entry" = "*" ] || [ "$entry" = "$PR_AUTHOR" ]; then
      return 0
    fi
  done
  return 1
}

# Returns 0 (block the merge) when the PR carries any DO_NOT_MERGE_LABELS label.
#
# FAILS CLOSED. If the labels cannot be read — API error, rate limit, network —
# this blocks the merge rather than assuming there is no hold. A transient failure
# costs one deferred merge that the next run retries; guessing the other way merges
# work a human parked, which is the failure this whole guard exists to prevent.
# The blocked label name is echoed on stdout so callers can name it in the log.
has_do_not_merge_label() {
  local labels rc=0 entry lower_labels lower_entry err_file
  # Keep stderr instead of discarding it: swallowing the real gh error is what
  # made this failure take a full batch of PRs to diagnose (DnD-m3uj3).
  err_file="$(mktemp "/tmp/pr-review-labels-${PR_NUMBER}-XXXXXX")"
  labels="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json labels \
    --jq '[.labels[].name] | join(",")' 2>"$err_file")" || rc=$?
  # An empty string is a legitimate "no labels" answer, so distinguish it from a
  # failed call by exit code rather than by emptiness.
  if [ "$rc" -ne 0 ]; then
    log "label lookup FAILED (rc=${rc}): $(tr '\n' ' ' < "$err_file" | cut -c1-300)"
    rm -f "$err_file"
    echo "$LABEL_LOOKUP_FAILED"
    return 0
  fi
  rm -f "$err_file"
  lower_labels=",$(printf '%s' "$labels" | tr '[:upper:]' '[:lower:]'),"
  IFS=',' read -ra _blocking <<< "$DO_NOT_MERGE_LABELS"
  for entry in "${_blocking[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [ -z "$entry" ] && continue
    lower_entry="$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')"
    case "$lower_labels" in
      *",${lower_entry},"*) echo "$entry"; return 0 ;;
    esac
  done
  return 1
}

# ── Stacked PRs are unsupported in this repo (DnD-iji9r / DnD-pb4ur) ────────
#
# On 2026-08-30 a three-PR stack cost three PR numbers for one bead. Merging a
# PR deletes its head branch (this repo sets delete_branch_on_merge, and
# merge_pr deletes the ref explicitly too), and GitHub responds to a deleted
# base by CLOSING every PR that targeted it — verified on #2699 and #2701, whose
# event logs show `base_ref_deleted` and `closed` in the same second. It does not
# retarget them, and the close is unrecoverable in place: GitHub refuses both
# `gh pr edit --base` and `gh pr reopen` on a closed PR whose base is gone.
#
# A `do-not-merge` label does NOT help — it stops the bot merging the CHILD, not
# the PARENT's merge deleting the base out from under it. #2701 carried the label
# when it was orphaned.
#
# So ordering is declared, never structural: branch from the default branch and
# write `Depends-on: #<pr>` in the body. The three guards below enforce that.
#
# ── Why these read LIVE state instead of $PR_BASE_REF / $PR_BODY ────────────
# Both env vars are captured when the run starts, and a review can last ~30 min
# while CI polls. In that window a human can retarget the PR (fixing the
# violation — stale env would still block it) or edit the body to add or remove a
# Depends-on line (stale env would miss it). This is exactly the reasoning
# merge_pr's comment gives for re-reading labels at merge time.

# The repo's default branch, resolved once and cached. Falls back to main — the
# historical value — so a lookup failure can never make every base look wrong.
# "Once" holds because main() primes the cache with a bare call in the parent
# shell; a $( ) call site alone populates only its own subshell's copy.
default_branch() {
  if [ -z "$DEFAULT_BRANCH_CACHE" ]; then
    DEFAULT_BRANCH_CACHE="$($GH_CLI api "repos/${REPO}" --jq .default_branch 2>/dev/null || true)"
    [ -n "$DEFAULT_BRANCH_CACHE" ] || DEFAULT_BRANCH_CACHE="main"
  fi
  printf '%s' "$DEFAULT_BRANCH_CACHE"
}

# Returns 0 (block) when this PR targets anything but the default branch, echoing
# the offending base. FAILS CLOSED on a read error, like the label guard: a
# transient failure costs one deferred merge, and the next run retries.
stacked_base_violation() {
  # no violation to report when the repo does not police stacked PRs
  [ "$CICD_FEATURE_STACKED_PRS" = "true" ] || { return 1; }
  local base rc=0
  base="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json baseRefName \
    --jq .baseRefName 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$base" ]; then
    log "base ref lookup FAILED (rc=${rc}) — failing closed"
    echo "$LABEL_LOOKUP_FAILED"
    return 0
  fi
  if [ "$base" != "$(default_branch)" ]; then
    echo "$base"
    return 0
  fi
  return 1
}

# Echoes the "#N" refs on this PR's Depends-on:/Blocked-by: lines that are not
# MERGED yet; returns 0 when at least one is unmet.
#
# Anchored to line starts and to the BODY, never the title — the same rule
# close-beads.sh uses, and for the same reason: a title naturally names things it
# does not mean to automate.
#
# The `#N` extraction is anchored to a bare ref on purpose. A loose match would
# read `Depends-on: SeriousGeese/Other#12` as this repo's PR 12 — some ancient
# merged PR — and report the dependency SATISFIED. That is a wrong-direction
# failure, the exact class these guards exist to prevent, so cross-repo refs are
# unsupported rather than silently mis-resolved.
#
# A dependency that is CLOSED but not merged counts as UNMET: it may itself have
# been orphaned by this very bug, and merging past it would compound the damage.
unmet_dependencies() {
  # no Depends-on holds when the repo does not use them
  [ "$CICD_FEATURE_STACKED_PRS" = "true" ] || { return 1; }
  local body refs num state rc=0 unmet=""
  body="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json body --jq .body 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "body lookup FAILED (rc=${rc}) — failing closed"
    echo "$LABEL_LOOKUP_FAILED"
    return 0
  fi
  local lines
  lines="$(grep -iE '^[[:space:]]*(depends-on|blocked-by):' <<<"$body" || true)"
  [ -n "$lines" ] || return 1

  refs="$(grep -oE '(^|[[:space:]])#[0-9]+' <<<"$lines" | tr -d ' #' | sort -u || true)"
  if [ -z "$refs" ]; then
    # The author DECLARED a dependency and we could not parse a bare `#N` out of
    # it — a cross-repo `owner/repo#12`, a bare URL, a prose sentence. Holding is
    # the only safe answer: ignoring the line silently merges past a dependency
    # somebody deliberately wrote down, which is the wrong-direction failure this
    # guard exists to prevent. (Resolving `owner/repo#12` against THIS repo would
    # be worse still — it would name an unrelated PR and usually read as merged.)
    echo "#?(unparseable — use a bare '#N' in this repo)"
    return 0
  fi

  for num in $refs; do
    # A PR cannot depend on itself; treat it as a typo rather than a deadlock.
    [ "$num" = "$PR_NUMBER" ] && continue
    rc=0
    state="$($GH_CLI pr view "$num" --repo "$REPO" --json state --jq .state 2>/dev/null)" || rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$state" ]; then
      # DELIBERATELY a green hold, not a red run. `gh pr view` fails identically
      # for a typo, an issue number and a deleted PR — all deterministic, all
      # PR-caused. Failing closed red here would make one typo redden every
      # subsequent review of that PR forever, which is precisely the "a red run
      # means the REVIEWER failed" contract (DnD-xqpyv) inverted.
      unmet+=" #${num}(unresolvable)"
      continue
    fi
    [ "$state" = "MERGED" ] || unmet+=" #${num}(${state})"
  done

  [ -n "$unmet" ] || return 1
  echo "${unmet# }"
  return 0
}

# Echoes the open PRs based on THIS PR's head branch; returns 0 when any exist.
# Merging would delete that head and close every one of them.
#
# NOT fail-closed: an API failure here leaves the ordinary merge path intact
# rather than blocking every merge in the repo on a transient error. The guard is
# a safety net over a stack that should not exist in the first place — the base
# guard above is what prevents one forming — so failing OPEN keeps a read outage
# from wedging the queue.
would_orphan_children() {
  # nothing to orphan when the repo does not police stacked PRs
  [ "$CICD_FEATURE_STACKED_PRS" = "true" ] || { return 1; }
  local children
  children="$($GH_CLI pr list --repo "$REPO" --state open --base "$PR_HEAD_REF" \
    --json number --jq '[.[].number | "#\(.)"] | join(" ")' 2>/dev/null || true)"
  [ -n "$children" ] || return 1
  echo "$children"
  return 0
}

# Stage is CONTINUOUSLY DEPLOYED again (DnD-6kaz2), and this dispatch is what makes that true
# for bot merges. A `gh pr merge` performed with GITHUB_TOKEN fires NO push event — GitHub
# suppresses it to prevent recursive workflow runs — so deploy-stage.yml's `push` trigger only
# ever sees the handful of merges a HUMAN performs. Measured on the pre-nightly topology: 73
# merges on 2026-08-23 produced just 4 push-triggered deploys. Without this call, "CD" would
# silently mean "CD for 5% of merges".
#
# This was removed under DnD-smcxa because per-merge deploys on HOSTED runners tripped the org's
# Actions budget cap. That cost is gone: deploy-stage.yml's build job now runs on
# vars.STAGE_BUILD_RUNNER (self-hosted), and its `concurrency: deploy-stage` group collapses a
# merge burst to one build at a time, so this dispatch no longer scales spend with merge rate.
#
# BEST-EFFORT, like dispatch_close_beads and unlike dispatch_ci: the PR is already merged by the
# time this runs, so a failed dispatch must never fail the review. Stage simply stays one merge
# behind until the next merge dispatches, and a human can always dispatch "Deploy to Stage"
# manually.
#
# GATED on pr_touches_deploy_paths, for the same reason dispatch_e2e_gate is gated: a
# workflow_dispatch run IGNORES deploy-stage.yml's paths-ignore (that list filters the push
# trigger only), so an unconditional dispatch made every docs-only bot merge rebuild and
# restart stage. The gate fails toward DEPLOYING: on a files-list read failure it dispatches
# anyway, because a redundant rebuild is cheap while a missed deploy leaves stage silently
# stale (DnD-himhn).
dispatch_stage_deploy() {
  # the consumer has no deploy-stage workflow
  [ "$CICD_FEATURE_STAGE_DEPLOY" = "true" ] || { return 0; }
  local dispatch_out
  if [ "$(pr_touches_deploy_paths)" = "false" ]; then
    log "  Skipping stage deploy dispatch: PR #${PR_NUMBER} only touches paths deploy-stage.yml ignores (markdown/docs/.beads)"
    return
  fi
  if dispatch_out="$($GH_CLI workflow run deploy-stage.yml --repo "$REPO" --ref main 2>&1)"; then
    log "  Dispatched stage deploy on main (bot merges don't fire push triggers)"
  else
    log "  Note: could not dispatch stage deploy (stage will catch up on the next merge)"
    log "  dispatch error: $(printf '%s' "$dispatch_out" | head -c 300)"
  fi
}

# The same GITHUB_TOKEN suppression applies to this pipeline's own branch
# pushes (base-sync merges, auto-review fixes): the pushed SHA never fires
# pull_request-triggered CI, so ci.yml must be dispatched explicitly on the
# PR head ref (ci.yml carries a workflow_dispatch trigger for exactly this
# call; DnD-4drs9). Unlike dispatch_close_beads this is NOT best-effort —
# wait_for_ci() fails closed when the dispatched checks never appear, so a
# failed dispatch here blocks the merge rather than letting it through.
dispatch_ci() {
  local dispatch_out
  if dispatch_out="$($GH_CLI workflow run ci.yml --repo "$REPO" --ref "$PR_HEAD_REF" 2>&1)"; then
    log "  Dispatched CI on ${PR_HEAD_REF} (bot pushes don't fire pull_request triggers)"
  else
    # Most common cause: the branch's ci.yml predates the workflow_dispatch
    # trigger (422) — the dispatch API validates the workflow file at the
    # given ref. The §3 base-sync heals that for the main path; a stale
    # branch hitting this via the §2 short-circuit needs main merged in.
    log "  WARNING: could not dispatch CI on ${PR_HEAD_REF} — the zero-checks grace will fail closed and block the merge"
    log "  dispatch error: $(printf '%s' "$dispatch_out" | head -c 300)"
  fi
}

# The Playwright half of the same GITHUB_TOKEN story (DnD-vvtuu, retargeted by DnD-d9os6).
#
# Pull requests are gated by e2e.yml, whose `gate` job publishes the `e2e (Playwright)`
# check that is the REQUIRED context in branch protection. (It was e2e-smoke.yml's
# `e2e smoke (Playwright)` between DnD-vvtuu and DnD-d9os6; that file is now deleted.) Like ci.yml, that workflow triggers on
# `pull_request` — and a GITHUB_TOKEN push (this pipeline's base-sync merges and
# auto-review fixes) fires no pull_request trigger at all. So without this dispatch the
# required context is simply ABSENT on the very SHA the bot then tries to merge, and the
# merge is blocked by branch protection with nothing in the check list to explain it:
# an absent context looks identical to one that has not started.
#
# Fired alongside dispatch_ci(), from the same zero-checks branch, for the same reason
# and with the same failure posture. The cost of a redundant dispatch (the PR-triggered
# run also registering, so two runs publish the same context name — GitHub honours the
# last) is ~8 runner-minutes; the cost of a missing one is a permanently unmergeable PR.
# That asymmetry is why the DISPATCH itself is unconditional — one of the two below always
# fires; only WHICH one is decided by the file list. The redundant-dispatch cost went UP
# under DnD-d9os6, from an 11-spec smoke job to the full 4-shard matrix; the asymmetry is
# unchanged, because a permanently unmergeable PR still costs more than a duplicate run.
#
# Which of the two publishers to fire is decided here (DnD-f40ki). A dispatched run
# IGNORES paths-ignore, so dispatching the suite unconditionally — DnD-vvtuu's original,
# correct-at-the-time behaviour — made a docs-only bot-pushed PR burn a whole suite to
# publish a context the shim publishes in ~15 seconds. What blocked the cheaper split was that e2e-docs-shim.yml only triggered
# on `pull_request`, which a bot push does not fire either; it now takes the PR number as a
# workflow_dispatch input, so exactly one of the two can be fired per SHA:
#
#   PR touches paths e2e.yml runs for  -> dispatch e2e.yml            (the real gate)
#   docs-only                          -> dispatch e2e-docs-shim.yml
#
# The branch is `pr_touches_e2e_paths`, which already encodes e2e.yml's ignore globs
# and — importantly — fails SAFE to "true" on an API error or an empty file list, so every
# uncertainty runs the real suite rather than shimming past it. Belt and braces on the other
# side too: the shim declines to publish onto any SHA that already has an e2e.yml run,
# so even a hand-dispatched suite cannot be masked by a shim publish.
#
# The shim is dispatched on `main`, not on the PR branch. The ref decides which copy of the
# workflow file runs, and a branch cut before the `pr_number` input existed would 422 on an
# unexpected input — unlike ci.yml there is no base-sync guaranteed to have healed it before
# this fires. Nothing in the shim reads the PR's code: only main's e2e.yml paths-ignore
# and the PR's file list, both of which are what branch protection actually cares about.
dispatch_e2e_gate() {
  # the consumer has no e2e workflow to dispatch
  [ "$CICD_FEATURE_E2E_GATE" = "true" ] || { return 0; }
  local dispatch_out
  if [ "$(pr_touches_e2e_paths)" = "false" ]; then
    if dispatch_out="$($GH_CLI workflow run e2e-docs-shim.yml --repo "$REPO" --ref main -f pr_number="$PR_NUMBER" 2>&1)"; then
      log "  Dispatched the E2E docs shim for PR #${PR_NUMBER} (docs-only — no need for a full suite run)"
    else
      log "  WARNING: could not dispatch the E2E docs shim for PR #${PR_NUMBER} — the required 'e2e (Playwright)' context may never report and branch protection will block the merge"
      log "  dispatch error: $(printf '%s' "$dispatch_out" | head -c 300)"
    fi
    return
  fi
  if dispatch_out="$($GH_CLI workflow run e2e.yml --repo "$REPO" --ref "$PR_HEAD_REF" 2>&1)"; then
    log "  Dispatched the E2E suite on ${PR_HEAD_REF} (bot pushes don't fire pull_request triggers)"
  else
    # Most likely cause, exactly as for ci.yml: the branch predates this workflow shape, so
    # the dispatch API cannot find it at that ref (422). The base-sync heals it.
    log "  WARNING: could not dispatch the E2E suite on ${PR_HEAD_REF} — the required 'e2e (Playwright)' context may never report and branch protection will block the merge"
    log "  dispatch error: $(printf '%s' "$dispatch_out" | head -c 300)"
  fi
}

# Companion to dispatch_ci() for the OTHER half of the GITHUB_TOKEN story
# (DnD-k06w2).
#
# dispatch_ci's comment says a GITHUB_TOKEN push "never fires
# pull_request-triggered CI". That holds for the JOBS but not for the RUNS:
# GitHub still creates a workflow run for each pull_request-triggered workflow
# and parks it unstarted as `status: completed, conclusion: action_required`,
# waiting for someone to click "Approve and run". Observed 2026-08-22 on PR
# #2298 (runs 32543429313 CI / 32543429359 E2E / 32543429312 PR Auto-Review, on
# bot-pushed head 9e38b683) and again minutes later on PR #2312 (32544110043 /
# 32544110042 / 32544110019). Every one cleared instantly on approve, and both
# PRs then went green and auto-merged.
#
# Why this has to be handled here rather than left to a human:
#   * A held run publishes NO check runs at all, so `gh pr checks` reports "no
#     checks reported on the '<branch>' branch" — byte-identical to "CI has not
#     started yet". wait_for_ci() then burns the whole ZERO_CHECKS_GRACE and
#     fails closed blaming a failed ci.yml dispatch that in fact succeeded.
#   * dispatch_ci() cannot heal it. That only re-runs ci.yml; a held E2E run —
#     or a held run of THIS workflow — has no dispatch path, so the required
#     check simply never appears.
#   * The PR is left mergeStateStatus BLOCKED on required checks that will never
#     run, and nothing in the logs, the check list, or the posted comment names
#     the cause.
#
# SECURITY — deliberately NOT unconditional. Approving a held run is precisely
# the gate GitHub uses to stop untrusted pull-request code from executing on a
# self-hosted runner, and this repo's reviewers ARE self-hosted (`runs-on:
# [self-hosted, pr-review]`). Approval is therefore limited to authors already
# trusted with auto-fix pushes and auto-merge (AUTOMERGE_AUTHORS). For anyone
# else the hold is reported loudly and left standing for a human to decide.
#
# Returns 0 when at least one run was NEWLY approved (the caller restarts its
# zero-checks grace so the newly-started runs get a full window to register a
# check), 1 otherwise. Never fails the review: an unreachable Actions API is
# logged and treated as "nothing to approve", leaving the pre-existing
# fail-closed CI paths to make the merge decision.
#
# Every run id is acted on exactly ONCE per review, tracked in
# $_HELD_RUNS_SEEN. That is load-bearing, not tidiness: a successful approval
# resets the caller's zero-checks grace, so re-approving the same still-held
# run on every poll would reset that grace forever and convert a 120s
# fail-closed (rc=4) into a 30-minute POLL_TIMEOUT (rc=2) — the generic
# "polling timed out" outcome this bead exists to eliminate. The cost is that a
# TRANSIENT approve failure is not retried; it is logged loudly instead, which
# is the better trade when the realistic cause is a missing permission.
_HELD_RUNS_SEEN=""

approve_held_runs() {
  # Disabled: approve nothing, and report NOTHING APPROVED.
  #
  # `return 1`, not 0. The contract is "did I approve something", not "did I
  # succeed" — the live function returns 1 when it found nothing to approve. Its
  # only caller is
  #     if approve_held_runs "$sha"; then zero_checks_elapsed=0; fi
  # so returning 0 here would reset the zero-checks grace on EVERY poll, and the
  # fail-closed that stops a checkless SHA merging could never fire. A disabled
  # feature must be inert, not quietly permissive.
  [ "$CICD_FEATURE_APPROVE_HELD_RUNS" = "true" ] || { return 1; }
  local sha="$1"
  local held api_exit=0 err_file
  # stderr goes to its own file rather than into $held: a `2>&1` capture would
  # fold a gh/jq diagnostic into the data and this loop would then treat the
  # error text itself as a run id.
  err_file="$(mktemp)"

  held="$($GH_CLI api "repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100" \
    --jq '.workflow_runs[] | select(.status == "waiting" or .conclusion == "action_required") | "\(.id)\t\(.name)"' 2>"$err_file")" || api_exit=$?
  if [ "$api_exit" -ne 0 ]; then
    log "  could not list workflow runs for ${sha} (exit=${api_exit}) — assuming none are held for approval: $(head -c 200 "$err_file" 2>/dev/null)"
    rm -f "$err_file"
    return 1
  fi
  rm -f "$err_file"
  [ -z "$held" ] && return 1

  local count=0 run_id run_name
  while IFS=$'\t' read -r run_id run_name; do
    # Belt and braces: only ever POST to a numeric run id, so nothing that is
    # not a run id can be interpolated into the approve path.
    case "$run_id" in ''|*[!0-9]*) continue ;; esac
    # Once per run id per review — see the $_HELD_RUNS_SEEN note above.
    case " $_HELD_RUNS_SEEN " in *" $run_id "*) continue ;; esac
    _HELD_RUNS_SEEN="$_HELD_RUNS_SEEN $run_id"
    if ! is_automerge_author; then
      # Report every held run by name; a human still has to approve them.
      log "  CI: run ${run_id} (${run_name}) is HELD FOR APPROVAL and author '${PR_AUTHOR}' is not in AUTOMERGE_AUTHORS — leaving it for a human. Approve at ${PR_HTML_URL:-the PR}'s checks, or: gh api -X POST repos/${REPO}/actions/runs/${run_id}/approve"
      continue
    fi
    local approve_out approve_exit=0
    approve_out="$($GH_CLI api -X POST "repos/${REPO}/actions/runs/${run_id}/approve" 2>&1)" || approve_exit=$?
    if [ "$approve_exit" -eq 0 ]; then
      log "  CI: approved held run ${run_id} (${run_name}) — a GITHUB_TOKEN push parked it as action_required (DnD-k06w2)"
      count=$((count + 1))
    else
      # Most likely cause is a missing `actions: write` permission on the job.
      log "  CI: WARNING — could not approve held run ${run_id} (${run_name}) (exit=${approve_exit}); its required check will never appear: $(printf '%s' "$approve_out" | head -c 200)"
    fi
  done <<< "$held"

  [ "$count" -gt 0 ]
}

# Does this PR touch any path ci.yml would actually build or test? (DnD-7k9o0)
#
# ci.yml's push/pull_request triggers carry paths-ignore: **.md, docs/**,
# content/** — GitHub skips CI iff EVERY changed file matches one of those
# globs. So the PR is "CI-relevant" exactly when at least one changed file falls
# OUTSIDE them. This is the missing half of wait_for_ci's docs-only shortcut:
# "zero check runs" is only safe to read as "no CI applies" when this returns
# "false". For a CI-relevant PR, zero checks means "CI has not registered yet"
# (a second commit pushed as the review starts, or a run cancelled by ci.yml's
# cancel-in-progress concurrency) — NEVER "docs-only". Reading it as docs-only
# is how PR #1566 merged over a red shard-2 guardrail on 2026-07-20.
#
# Prints "true" (CI applies — never take the docs-only path) or "false"
# (docs/content-only — the docs-only grace is legal). Fails SAFE to "true" when
# the changed-file list cannot be read: an unverifiable PR must not get the
# docs-only pass. Keep the case globs in sync with ci.yml's paths-ignore.
pr_touches_ci_paths() {
  local files api_exit=0
  files="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json files --jq '.files[].path' 2>&1)" || api_exit=$?
  if [ "$api_exit" -ne 0 ]; then
    log "  could not read PR changed files (exit=${api_exit}) — assuming CI applies (fail safe): $(printf '%s' "$files" | head -c 200)"
    echo "true"; return
  fi
  # An empty list is not a real PR state; treat it as CI-relevant rather than
  # waving the change through as docs-only.
  if [ -z "$files" ]; then
    log "  PR reports zero changed files — assuming CI applies (fail safe)"
    echo "true"; return
  fi
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      # Mirrors ci.yml's paths-ignore EXACTLY (pinned by prReviewCiGate.test.ts).
      # *.md and docs/* were removed from both in DnD-9zzso: markdown now runs CI,
      # because the tests that validate markdown live in the Jest suite.
      content/*) ;;  # content/**
      .beads/*)  ;;  # .beads/**
      *) echo "true"; return ;;  # a file ci.yml builds/tests → CI applies
    esac
  done <<< "$files"
  echo "false"
}

# Does this PR touch any path the E2E suite is meant to protect? (DnD-yepkx)
#
# Sibling of pr_touches_ci_paths, and it needs
# its own arms because e2e.yml's push paths-ignore is a THIRD list: **.md,
# docs/**, content/**, .beads/** — CI's list plus .beads/**, and unlike the
# deploy it does ignore content/** (no Playwright spec reads the compendium).
# Keep these globs in sync with e2e.yml's paths-ignore.
#
# dispatch_e2e_gate() needs this gate because workflow_dispatch runs IGNORE
# paths-ignore, so without it every
# docs-only bot push would fire a full suite run the paths-ignore was meant to skip.
# (The full post-merge suite no longer dispatches from here at all — the
# debounced scheduler e2e-main-dispatcher.yml owns that, with its own copy of
# these globs applied via the compare API; DnD-qjctn.)
#
# Prints "true" (dispatch it) or "false" (only ignored paths — skip). Fails SAFE
# to "true": a skipped run is a regression nobody hears about, which is the very
# bug this dispatch exists to fix.
pr_touches_e2e_paths() {
  local files api_exit=0
  files="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json files --jq '.files[].path' 2>&1)" || api_exit=$?
  if [ "$api_exit" -ne 0 ]; then
    log "  could not read PR changed files (exit=${api_exit}) — assuming E2E applies (fail safe): $(printf '%s' "$files" | head -c 200)"
    echo "true"; return
  fi
  # An empty list is not a real PR state; run the suite rather than skip it.
  if [ -z "$files" ]; then
    log "  PR reports zero changed files — assuming E2E applies (fail safe)"
    echo "true"; return
  fi
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.md)      ;;  # **.md      — docs at any depth
      docs/*)    ;;  # docs/**
      content/*) ;;  # content/**
      .beads/*)  ;;  # .beads/**
      *) echo "true"; return ;;  # a file the suite exercises → dispatch
    esac
  done <<< "$files"
  echo "false"
}

# Does this PR touch any path a stage deploy would actually ship? (sibling of
# pr_touches_ci_paths / pr_touches_e2e_paths, consumed by dispatch_stage_deploy)
#
# deploy-stage.yml's push trigger carries paths-ignore: **.md, docs/**,
# .beads/** so a human-pushed docs-only merge never rebuilds and restarts
# stage. But a workflow_dispatch run IGNORES paths-ignore (that list is scoped
# to the push trigger alone), so without this gate every docs-only BOT merge
# would still cost a full image rebuild plus a container restart that can
# interrupt live QA. Keep these globs in sync with deploy-stage.yml's
# paths-ignore (pinned by stageDeployContinuous.test.ts).
#
# Prints "true" (dispatch the deploy) or "false" (deploy-ignored paths only:
# skip). Fails SAFE to "true", i.e. toward DEPLOYING: a redundant rebuild is
# cheap and self-hosted, while a missed deploy leaves stage silently stale,
# the DnD-himhn failure nobody notices for days.
pr_touches_deploy_paths() {
  local files api_exit=0
  files="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json files --jq '.files[].path' 2>&1)" || api_exit=$?
  if [ "$api_exit" -ne 0 ]; then
    log "  could not read PR changed files (exit=${api_exit}) - assuming the deploy applies (fail safe): $(printf '%s' "$files" | head -c 200)"
    echo "true"; return
  fi
  # An empty list is not a real PR state; deploy rather than leave stage stale.
  if [ -z "$files" ]; then
    log "  PR reports zero changed files - assuming the deploy applies (fail safe)"
    echo "true"; return
  fi
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.md)      ;;  # **.md      (docs at any depth)
      docs/*)    ;;  # docs/**
      .beads/*)  ;;  # .beads/**
      *) echo "true"; return ;;  # a file the deployed image ships: dispatch
    esac
  done <<< "$files"
  echo "false"
}

# True when BOTH the PR branch and the base have touched the Drizzle migration
# journal since they diverged (DnD-pk3ex).
#
# A same-numbered migration collision is not a conflict a text merge can settle. Both
# sides append an entry at the same idx in meta/_journal.json and both add a
# meta/NNNN_snapshot.json at the same path, and the only correct resolution is to KEEP
# BOTH — take the base's file, snapshot and journal entry at the contested number, then
# REGENERATE this branch's migration at the next free number. Picking a side silently
# DROPS one migration: its .sql leaves src/drizzle/ and its journal entry leaves the
# journal together, which every local gate then passes (the journal stays internally
# consistent, and nothing builds a database from the chain) until it surfaces on deploy
# as `no such column`.
#
# So the bot does not attempt the sync merge at all here — it holds for a human. That
# is deliberately broader than "git reported a conflict": whether git conflicts depends
# on where in the file each side's entry landed, and a clean auto-merge of two
# same-numbered entries is the WORSE outcome, not the safe one.
#
# `git diff --quiet` exits 0 when a path is unchanged and 1 when it changed, so both
# non-zero exits mean "both sides moved it". Any other failure (bad ref, unreadable
# tree) leaves the answer "false" and the normal merge path runs — this is an extra
# guard, not the merge's correctness gate.
migration_journal_collision() {
  # no collision: only DnD has a Drizzle migration journal
  [ "$CICD_FEATURE_MIGRATION_JOURNAL" = "true" ] || { return 1; }
  local journal='src/drizzle/meta/_journal.json'
  local mb
  mb="$(git merge-base HEAD "origin/${PR_BASE_REF}" 2>/dev/null)" || return 1
  [ -n "$mb" ] || return 1
  git diff --quiet "$mb" HEAD -- "$journal" 2>/dev/null && return 1
  git diff --quiet "$mb" "origin/${PR_BASE_REF}" -- "$journal" 2>/dev/null && return 1
  return 0
}

# The PR's CURRENT remote tip. The event's HEAD_SHA goes stale the moment
# anything is pushed — including our own fix/sync commits — and a re-run of a
# pull_request-triggered job replays the ORIGINAL payload, so HEAD_SHA can
# point at an author commit with green CI while the real tip is an unverified
# bot commit. Every merge decision must poll the live tip, never the event
# SHA. Fails (non-zero) when the tip cannot be read — callers must fail
# closed, not fall back to HEAD_SHA.
resolve_live_tip() {
  local tip
  tip="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq '.headRefOid' 2>&1)" || {
    log "  could not resolve live branch tip: $(printf '%s' "$tip" | head -c 200)"
    return 1
  }
  [ -n "$tip" ] || return 1
  echo "$tip"
}

# Bead auto-close (DnD-91ye4): bot merges never fire pull_request:closed, so
# dispatch the close-beads workflow explicitly, same pattern as the deploy.
dispatch_close_beads() {
  # the consumer does not use the beads tracker
  [ "$CICD_FEATURE_BEADS" = "true" ] || { return 0; }
  if $GH_CLI workflow run close-beads.yml --repo "$REPO" --ref main -f pr_number="$PR_NUMBER" 2>&1; then
    log "Dispatched close-beads for PR #${PR_NUMBER}"
  else
    log "WARNING: could not dispatch close-beads — bead(s) referenced by PR #${PR_NUMBER} must be closed manually"
  fi
}

# Post-merge E2E is NOT dispatched from here any more (DnD-qjctn). It used to
# be — dispatch_e2e(), one full 4-shard run per bot merge (DnD-yepkx), because
# GITHUB_TOKEN merges never fire e2e.yml's `push: branches: [main]` trigger.
# That cost ~$47/mo (393 August runs), so the per-merge dispatch moved to the
# debounced scheduler .github/workflows/e2e-main-dispatcher.yml: every ~30 min
# it dispatches e2e.yml iff main's tip has no run yet and the diff since the
# last covered SHA isn't docs-only. The DnD-yepkx guarantee survives — every
# merged commit still gets a full-suite result, just within a tick instead of
# immediately — and a burst of merges costs one run instead of one each.

# dispatch_stranded_review() lived here until 2026-09-02 (DnD-y6ez1). It re-fired
# ONE cancelled review per run, because pr-auto-review.yml used a GLOBAL
# `concurrency: group: pr-review` and GitHub keeps only one PENDING run per
# group — so a third PR arriving while one review ran and another waited
# CANCELLED the waiting one, and no pull_request trigger type re-fires by
# itself (DnD-9fb3r: ~14% of runs when filed, ~29% on 2026-07-18).
#
# The group has been PER-PR since 2026-07-19, so no PR can be cancelled by a
# DIFFERENT PR and the premise is gone. What survived was a detector whose
# condition ("the latest run for this headBranch was cancelled") now mostly
# means a human re-pushed and a newer review superseded the old one — a
# redundant re-dispatch, one paid LLM call each.
#
# What it used is NOT dead and must stay. pr-auto-review.yml's workflow_dispatch
# trigger is still the manual/scripted re-review entry point, and its
# `actions: write` permission is what lets this script dispatch close-beads.yml
# and deploy-stage.yml after a bot merge (GITHUB_TOKEN merges fire neither
# `pull_request: closed` nor `push`). Both are pinned by
# src/__tests__/prAutoReviewSweep.test.ts — do not drop either as "dead too".
#
# Dispatching by hand still goes on the PR's OWN head branch, never main
# (DnD-0g0ok — a `--ref main` dispatch reviews main, not the PR):
#   gh workflow run pr-auto-review.yml --ref <pr-head-branch> -f pr_number=1387

# Poll GitHub's own mergeability verdict until it is a state `gh pr merge` will
# accept. Returns 0 on CLEAN / HAS_HOOKS / UNSTABLE (UNSTABLE = a non-required
# check is red; required ones are green, which is the bar branch protection
# sets). DIRTY (conflicts with base) and a still-BLOCKED/BEHIND/UNKNOWN verdict
# after the budget return 1 — the caller reports a PR-caused `blocked`, never a
# red run. Transient read failures count against the budget rather than
# aborting, so one flaky API call does not cost the merge.
MERGEABLE_POLL_INTERVAL=${MERGEABLE_POLL_INTERVAL:-15}
MERGEABLE_POLL_TIMEOUT=${MERGEABLE_POLL_TIMEOUT:-300}
wait_for_mergeable() {
  # Optional $1 overrides the poll budget. merge_pr passes a shorter one on a
  # RETRY: the first pass already absorbed the "a required check has not
  # registered yet" wait, and a retry is only waiting for GitHub to recompute
  # mergeability after a base move (DnD-4an04).
  local budget="${1:-$MERGEABLE_POLL_TIMEOUT}"
  local waited=0 state=""
  while :; do
    state="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null || echo "")"
    case "$state" in
      CLEAN|HAS_HOOKS|UNSTABLE)
        log "  Mergeability: ${state} after ${waited}s"
        return 0 ;;
      DIRTY)
        log "  Mergeability: DIRTY — the branch conflicts with ${PR_BASE_REF}; not merging"
        MERGE_ERROR="GitHub reports mergeStateStatus=DIRTY: this branch genuinely conflicts with ${PR_BASE_REF} and needs a manual resolution."
        return 1 ;;
      *)
        # BLOCKED: a required check has not reported yet (or is red).
        # BEHIND: base moved since the sync merge. UNKNOWN/"": GitHub is still
        # computing, or the read failed. All worth waiting on.
        if [ "$waited" -ge "$budget" ]; then
          log "  Mergeability: still '${state:-unknown}' after ${budget}s — not merging"
          MERGE_ERROR="GitHub still reports mergeStateStatus=${state:-unknown} after ${budget}s (BLOCKED = a required check has not reported or is red; BEHIND = the base moved; UNKNOWN = GitHub had not finished computing)."
          return 1
        fi
        log "  Mergeability: ${state:-unknown} — waiting (${waited}s elapsed)"
        sleep "$MERGEABLE_POLL_INTERVAL"
        waited=$((waited + MERGEABLE_POLL_INTERVAL)) ;;
    esac
  done
}

# ── Retrying a merge GitHub refused because the base moved (DnD-4an04) ──────
#
# `mergeStateStatus` is computed ASYNCHRONOUSLY by GitHub, so wait_for_mergeable
# can return a perfectly honest "mergeable" verdict that is already stale by the
# time the mergePullRequest mutation runs three seconds later. Run 33329508795
# attempt 1, PR #2713:
#
#   19:09:37  CI: ALL CHECKS PASSED
#   19:09:39  Mergeability: UNSTABLE after 0s          <- succeeded, first read
#   19:09:42  GraphQL: Base branch was modified. Review and try the merge again.
#   19:09:42  === PR Auto-Review Complete: #2713 -> blocked ===
#
# Nothing retried. A human ran `gh run rerun` later and it merged immediately,
# unchanged. That gap CANNOT be closed by reading harder — only by retrying the
# mutation, which is literally what GitHub's own error text asks for.
#
# It is structural in a bulk flow: readying N PRs together means every merge
# invalidates the base of every other open PR, so the slowest review in a batch
# is the most likely to lose. That batch merged five; the fifth lost.
#
# ONE message is retryable, deliberately. "Base branch was modified" is the only
# refusal whose meaning is unambiguously "your read was stale, re-read and try
# again" — the PR itself is unchanged and nothing about it was judged wrong.
# Every other refusal either describes a DURABLE property of the PR (a real
# conflict, a red required check, a branch-protection policy) that no number of
# retries can change, or is ambiguous between transient and durable. A wrongly
# retried merge is far worse than a stuck PR — the next review picks a stuck PR
# up on its own — so anything in doubt stays terminal.
#
# A conflict introduced BY the base move is still caught: every retry re-runs
# wait_for_mergeable, and DIRTY returns 1 from there without ever reaching the
# mutation. DIRTY is terminal on every attempt, never retried.
MERGE_RETRYABLE_ERROR='Base branch was modified'
is_retryable_merge_error() {
  case "$1" in
    *"$MERGE_RETRYABLE_ERROR"*) return 0 ;;
  esac
  return 1
}

# Bounded so a run can never spin: at most MERGE_MAX_ATTEMPTS mutations, with a
# short backoff and a short mergeability re-poll between them.
MERGE_MAX_ATTEMPTS=${MERGE_MAX_ATTEMPTS:-3}
MERGE_RETRY_INTERVAL=${MERGE_RETRY_INTERVAL:-15}
MERGE_RETRY_MERGEABLE_TIMEOUT=${MERGE_RETRY_MERGEABLE_TIMEOUT:-60}

# Renders MERGE_ERROR for the PR comment.
merge_error_block() {
  if [ -z "$MERGE_ERROR" ]; then
    printf 'GitHub returned no error text — see the run log for the Mergeability lines.'
    return 0
  fi
  printf 'GitHub reported:\n\n```\n%s\n```\n' "$MERGE_ERROR"
  return 0
}

# Same value flattened to one line, for the metadata YAML block.
merge_error_oneline() {
  if [ -z "$MERGE_ERROR" ]; then
    printf 'none'
    return 0
  fi
  printf '%s' "$MERGE_ERROR" | tr '\n"' '  ' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-300
  return 0
}

# Squash-merge the PR and clean up the remote branch. `gh pr merge
# --delete-branch` exits nonzero when its local-branch cleanup fails (we run
# inside a worktree that is on a different branch) even though the merge
# itself landed — PR #1124 was merged but reported "blocked" that way. So:
# merge without --delete-branch, verify the PR state on any failure, then
# clean up the remote branch — but see the DnD-jhr26 block below: that cleanup is
# now a CONDITIONAL fallback, because an unconditional ref delete closes dependent
# PRs that GitHub's own merge-time auto-delete would have retargeted.
merge_pr() {
  # Shadow mode never merges. Belt-and-braces with review_may_apply_fixes(): a
  # merge is the one action that cannot be walked back, so it is guarded at the
  # gate AND at the door.
  if [ "$CICD_DRY_RUN" = "true" ]; then
    log "DRY RUN: would merge PR #${PR_NUMBER}; not merging."
    return 1
  fi
  local merged=false
  local blocking_label stacked_base unmet orphans
  local attempt=1 merge_out="" state=""

  MERGE_ERROR=""
  MERGE_ATTEMPTS_MADE=0

  # EVERY guard below is re-read on EVERY attempt, not hoisted out of the loop.
  # That is the point of a retry: the world moved between the mergeability read
  # and the mutation, so anything read before the mutation is now suspect. The
  # label gate especially — a human who adds `do-not-merge` while the bot is
  # mid-retry must stop it, and the reason the gate lives at merge time in the
  # first place is that this is exactly when they notice the bot is about to
  # take something they wanted held (DnD-4an04).
  while :; do
    # Last line of defence, deliberately INSIDE merge_pr rather than at the call
    # sites: there are two of them today and a third would silently miss the check.
    # Re-read at merge time, not at review start — a human may add the label while
    # the review is still running, which is exactly when they would notice the bot
    # is about to take something they wanted held.
    if blocking_label="$(has_do_not_merge_label)"; then
      HOLD_LABEL="$blocking_label"
      if [ "$blocking_label" = "$LABEL_LOOKUP_FAILED" ]; then
        annotate error "PR #${PR_NUMBER} was not auto-merged: its labels could not be read, so the do-not-merge guard failed closed. This is an infrastructure fault affecting every PR, not a property of this one — see DnD-m3uj3."
        log "MERGE BLOCKED: PR #${PR_NUMBER} — label lookup failed, failing closed."
      else
        log "MERGE BLOCKED: PR #${PR_NUMBER} carries the '${blocking_label}' label — leaving it open for a human."
      fi
      return 1
    fi

    # Same placement rationale as the label gate above: inside merge_pr, re-read at
    # merge time. Ordered before wait_for_mergeable so a blocked PR never burns the
    # mergeability poll.
    if stacked_base="$(stacked_base_violation)"; then
      HOLD_STACKED_BASE="$stacked_base"
      if [ "$stacked_base" = "$LABEL_LOOKUP_FAILED" ]; then
        annotate error "PR #${PR_NUMBER} was not auto-merged: its base ref could not be read, so the stacked-PR guard failed closed. This is an infrastructure fault affecting every PR, not a property of this one."
        log "MERGE BLOCKED: PR #${PR_NUMBER} — base ref lookup failed, failing closed."
      else
        log "MERGE BLOCKED: PR #${PR_NUMBER} targets '${stacked_base}', not '$(default_branch)' — stacked PRs are unsupported."
      fi
      return 1
    fi

    if unmet="$(unmet_dependencies)"; then
      HOLD_UNMET_DEPS="$unmet"
      if [ "$unmet" = "$LABEL_LOOKUP_FAILED" ]; then
        annotate error "PR #${PR_NUMBER} was not auto-merged: its body could not be read, so the Depends-on guard failed closed."
        log "MERGE BLOCKED: PR #${PR_NUMBER} — body lookup failed, failing closed."
      else
        log "MERGE HELD: PR #${PR_NUMBER} declares Depends-on ${unmet} — waiting for those to merge."
      fi
      return 1
    fi

    # Last: merging deletes this head branch, and GitHub closes every PR that
    # targeted it (it does NOT retarget). Refuse rather than repair.
    if orphans="$(would_orphan_children)"; then
      HOLD_ORPHANS="$orphans"
      log "MERGE BLOCKED: PR #${PR_NUMBER} — merging would delete '${PR_HEAD_REF}' and orphan ${orphans}."
      return 1
    fi

    # check_ci_status only proves every REGISTERED check-run is green — it cannot
    # see a required context (the e2e shards) that has not registered yet, and it
    # cannot see the base moving under the PR. Both produced "CI all green" followed
    # by a `gh pr merge` refusal on 2026-08-22 (#2338: "base branch policy prohibits
    # the merge"; #2357: "merge commit cannot be cleanly created"). Ask GitHub for
    # its own verdict and give it a few minutes to settle before merging.
    #
    # DIRTY returns 1 from in here on EVERY attempt — a genuine conflict is
    # terminal and is never retried, including a conflict the base move just
    # created (DnD-4an04).
    if [ "$attempt" -eq 1 ]; then
      wait_for_mergeable || return 1
    else
      wait_for_mergeable "$MERGE_RETRY_MERGEABLE_TIMEOUT" || return 1
    fi

    MERGE_ATTEMPTS_MADE="$attempt"
    if merge_out="$($GH_CLI pr merge "$PR_NUMBER" --repo "$REPO" --squash 2>&1)"; then
      if [ -n "$merge_out" ]; then log "$merge_out"; fi
      MERGE_ERROR=""
      merged=true
      break
    fi
    if [ -n "$merge_out" ]; then log "$merge_out"; fi
    MERGE_ERROR="$merge_out"

    state="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json state --jq .state 2>/dev/null || echo "")"
    if [ "$state" = "MERGED" ]; then
      log "gh pr merge exited nonzero but the PR is merged — treating as success"
      MERGE_ERROR=""
      merged=true
      break
    fi

    if ! is_retryable_merge_error "$merge_out"; then
      log "MERGE REFUSED (attempt ${attempt}/${MERGE_MAX_ATTEMPTS}): GitHub's refusal is not retryable — ${merge_out}"
      break
    fi

    if [ "$attempt" -ge "$MERGE_MAX_ATTEMPTS" ]; then
      log "MERGE REFUSED: '${MERGE_RETRYABLE_ERROR}' on all ${MERGE_MAX_ATTEMPTS} attempts — giving up. ${PR_BASE_REF} is moving faster than this run can merge; the next review retries."
      break
    fi

    log "MERGE RACE (attempt ${attempt}/${MERGE_MAX_ATTEMPTS}): ${merge_out}"
    log "  ${PR_BASE_REF} moved between the mergeability read and the merge mutation — re-checking and retrying in ${MERGE_RETRY_INTERVAL}s"
    sleep "$MERGE_RETRY_INTERVAL"
    attempt=$((attempt + 1))
  done

  if [ "$merged" = "true" ]; then
    # ── Do NOT delete the ref unconditionally (DnD-jhr26) ────────────────────
    #
    # This delete was the ACTUAL CAUSE of the DnD-iji9r orphaning, not merely a
    # redundant sibling of the repo's `delete_branch_on_merge` setting. Proven by
    # two live experiments on throwaway branches, 2026-08-30:
    #
    #   RAW ref delete (this call): the dependent PR gets `base_ref_deleted` and
    #     `closed` in the same second. GitHub does NOT retarget it, and the close
    #     is unrecoverable — `gh pr edit --base` and `gh pr reopen` both refuse.
    #   MERGE-TIME auto-delete (the repo setting, with no explicit delete): the
    #     dependent PR STAYS OPEN and is automatically retargeted to the merged
    #     PR's base. Event: `automatic_base_change_succeeded`.
    #
    # The two differ in exactly one variable, and the incident fits: #2696 merged
    # at 14:43:22 and `base_ref_deleted`+`closed` landed at 14:43:24 — this call
    # won the race against GitHub's own retarget.
    #
    # So: let the merge-time auto-delete do the work whenever it can. Keep an
    # explicit delete only as a FALLBACK for the case the setting is off (the ref
    # would otherwise linger forever, which is what this call was added for) — and
    # never when an open PR is based on this branch, because that is precisely the
    # case where deleting destroys someone's PR instead of retargeting it.
    if ! $GH_CLI api "repos/${REPO}/git/refs/heads/${PR_HEAD_REF}" >/dev/null 2>&1; then
      log "Branch ${PR_HEAD_REF} was already removed by the merge (delete_branch_on_merge) — dependent PRs, if any, were retargeted."
    elif orphans="$(would_orphan_children)"; then
      # Reachable only by a race: the pre-merge guard found no children, and one
      # appeared between that check and here. Leaving the branch is strictly
      # better than closing a PR nobody can reopen; stale-branch hygiene will
      # collect it later, and it too refuses to delete an open PR's base.
      log "NOT deleting ${PR_HEAD_REF}: ${orphans} still based on it — deleting would CLOSE them (DnD-jhr26). Leaving the branch for hygiene."
      annotate warning "Left branch ${PR_HEAD_REF} in place after merging PR #${PR_NUMBER}: ${orphans} are based on it and a ref deletion would close them outright. Retarget them with 'gh pr edit <n> --base $(default_branch)'."
    else
      $GH_CLI api -X DELETE "repos/${REPO}/git/refs/heads/${PR_HEAD_REF}" >/dev/null 2>&1 \
        || log "Note: could not delete remote branch ${PR_HEAD_REF} (may already be gone)"
    fi
    dispatch_close_beads
    dispatch_stage_deploy
    # Full post-merge e2e arrives via e2e-main-dispatcher.yml's next tick
    # (DnD-qjctn) — deliberately no per-merge dispatch here any more.
    return 0
  fi
  return 1
}

# ── The `.github/workflows/` push restriction (DnD-rufjg) ──────────────────
#
# GitHub REFUSES a push made with an Actions GITHUB_TOKEN when the pushed ref
# creates or updates any file under `.github/workflows/`, unless the App holds
# the `workflows` permission — which GITHUB_TOKEN cannot be granted. Verbatim:
#
#    ! [remote rejected]   HEAD -> feat/x
#      (refusing to allow a GitHub App to create or update workflow
#       `.github/workflows/e2e-baselines.yml` without `workflows` permission)
#
# It is DETERMINISTIC, not a race, and it keys off the CONTENTS OF THE PUSHED
# REF — not off what the PR author changed. So a base-sync merge that brings
# main's workflow edits onto the branch trips it too. Before this fix the
# rejection was reported as "concurrent push", which is doubly wrong: there was
# no concurrent writer, and no later run could ever succeed. PR #2637 sat
# green-but-unmerged for ~6 hours emitting `result: blocked` on a loop.
#
# The bot can MERGE such a PR perfectly well — it just cannot PUSH to it. Both
# halves below follow from that.

# Half one: does branch protection on the base actually require an up-to-date
# head? When it does not, the base-sync merge is a convenience, not a gate, and
# pushing it buys nothing worth an unmergeable PR — so we keep the merge
# LOCALLY (the review and the quality gates want the merged tree) and simply
# never push it.
#
# THIS IS A CONSTANT, DELIBERATELY, AND IT IS NOT READ AT RUNTIME.
#
#   `main` has `required_status_checks.strict: false` — an out-of-date branch is
#   already mergeable here. Verify with an ADMIN credential (a personal token or
#   App installation token with repo-admin rights):
#
#     gh api repos/SeriousGeese/DnD/branches/main/protection \
#       --jq '.required_status_checks.strict'
#
#   WHY NOT READ IT FROM THE RUNNER: that endpoint requires ADMIN access to the
#   repository. `GITHUB_TOKEN` cannot have it, and there is NO `permissions:`
#   key that grants it — `administration` is a GitHub App / fine-grained-PAT
#   scope, not an Actions permission, and writing it into pr-auto-review.yml
#   invalidates the workflow file outright (runs 33286696652 / 33286801434 died
#   with zero jobs and no annotation). So a runtime read could only ever 403 and
#   take its fallback: dead code that always looks like it works.
#
#   IF PROTECTION EVER BECOMES STRICT on a base branch this bot merges into,
#   flip this to `true` and the base-sync push resumes for every PR.
#
#   FAILURE MODE IF SOMEONE FORGETS: the bot skips a push that WAS required,
#   GitHub then refuses the merge as out-of-date, and the run reports `blocked`
#   with the mergeability state in its log. That is visible and self-announcing —
#   a stuck PR someone chases, never a silent wrong merge — which is the whole
#   reason a constant is acceptable here.
#
#   WHY A SINGLE GLOBAL IS ENOUGH, AND WHAT MUST CHANGE WITH IT (DnD-r8p02).
#
#   This constant has no per-base dimension, and the verification above names
#   `main` specifically, while its own phrasing says "a base branch this bot
#   merges into" — plural. That reads like an oversight. It is not: the set of
#   bases it can ever be asked about has exactly one member, and the stacked-base
#   guard (DnD-iji9r) is what keeps it that way. Three links, all in this file:
#
#     1. stacked_base_violation() sets `automerge_eligible=false` for ANY base
#        that is not the repo default branch.
#     2. The base-sync merge in "── 3. Sync with base branch" runs only inside
#        `if [ "$automerge_eligible" = "true" ]`, so `synced_with_base` cannot
#        become true for a non-default base.
#     3. should_skip_base_sync_push() returns early unless `synced_with_base` is
#        true, so base_branch_requires_up_to_date() is never consulted at all for
#        a non-default base.
#
#   `automerge_eligible` is set true exactly once (the author allowlist) and is
#   only ever cleared by the guards after it, never re-enabled — which is what
#   makes that narrowing hold rather than merely usually hold.
#
#   THE CONSEQUENCE, AND THE POINT: these are not two assumptions, they are one.
#   Relaxing the stacked-base guard to allow a release/hotfix flow would, on its
#   own and silently, start applying `main`'s protection answer to a branch whose
#   protection nobody checked. So if that day comes, both change together:
#
#     * make this a per-base lookup (a `case` over the base ref, or a repo
#       variable), defaulting to `true` — pushing a sync that was not required
#       costs nothing, skipping one that WAS required leaves a stuck PR; and
#     * give stacked_base_violation() an explicit allowlist of mergeable bases
#       rather than "anything but the default branch".
#
#   src/__tests__/prReviewStackedPr.test.ts pins all three links, so loosening
#   one without the other fails a test instead of shipping quietly.
BASE_REQUIRES_UP_TO_DATE_HEAD=false
base_branch_requires_up_to_date() {
  [ "$BASE_REQUIRES_UP_TO_DATE_HEAD" = "true" ]
}

# Should the pending commits stay LOCAL instead of being pushed to the PR
# branch? Only when all three hold:
#   * no auto-fix commit was made — a real fix has to land on the branch or the
#     review did nothing, and no amount of skipping avoids that push (which is
#     precisely why the honest-hold half below exists);
#   * the base-sync merge is the thing that put us ahead of the remote; and
#   * protection does not require an up-to-date head.
should_skip_base_sync_push() {
  local fixes_committed="$1" synced_with_base="$2"
  [ "$fixes_committed" != "true" ] || return 1
  [ "$synced_with_base" = "true" ] || return 1
  ! base_branch_requires_up_to_date
}

# Half two: tell the truth when a push IS genuinely required (a real auto-fix
# commit — no amount of skipping avoids that) and GitHub rejects it on this
# restriction. Matching is done on a backtick-stripped copy because git quotes
# `workflows` in the message; the OAuth-App wording ("without `workflow`
# scope") is covered by the same arms.
is_workflow_permission_rejection() {
  local msg="${1//\`/}"
  case "$msg" in
    *"without workflows permission"*|\
    *"without workflow scope"*|\
    *"create or update workflow"*) return 0 ;;
  esac
  return 1
}

# Push the pending commits (auto-fix and/or base sync) to the PR branch and
# classify any rejection. Sets FIXES_PUSHED on success; on rejection it never
# returns — finish() reports a `blocked` result naming the ACTUAL cause.
#
# --no-verify skips the standard git-lfs pre-push hook that git-lfs installs
# into every fresh _work clone's .git/hooks. That hook aborts the push with
# "git-lfs was not found on your path" on any runner where git-lfs is not on
# the job PATH (artemis's immutable-OS podman sandbox strips it; see DnD-isup8
# / DnD-krocc for the same absolute-vs-PATH problem with gh). The review push
# only moves code refs — it never changes LFS content — so the LFS pre-push
# hook is pure overhead here and safe to skip.
push_review_commits() {
  local iterations="${1:-0}"
  if [ "$CICD_DRY_RUN" = "true" ]; then
    log "DRY RUN: would push auto-review commits to ${PR_HEAD_REF}; not pushing."
    return 0
  fi
  local push_output="" push_rc=0
  push_output="$(git push --no-verify origin "HEAD:${PR_HEAD_REF}" 2>&1)" || push_rc=$?
  printf '%s\n' "$push_output" >&2
  if [ "$push_rc" -eq 0 ]; then
    FIXES_PUSHED=true
    log "Pushed to ${PR_HEAD_REF}"
    return 0
  fi
  if is_workflow_permission_rejection "$push_output"; then
    # NOT a race, and never reported as one (DnD-rufjg). Re-running changes
    # nothing: GITHUB_TOKEN can never hold the `workflows` permission, so only
    # a human push can land these commits.
    log "Push rejected by GitHub's workflow-permission restriction — GITHUB_TOKEN may not create or update files under .github/workflows/. This is permanent; a re-review cannot clear it. A human must push."
    finish "🚧 Could not push auto-review commits: GitHub refuses a push from the Actions \`GITHUB_TOKEN\` whose ref creates or updates any file under \`.github/workflows/\` — *\"refusing to allow a GitHub App to create or update workflow … without \\\`workflows\\\` permission\"*. **This is not a race with another writer, and re-running this review cannot clear it** — \`GITHUB_TOKEN\` can never hold that permission. A human has to push these commits: bring the branch level with \`${PR_BASE_REF}\` yourself (e.g. \`git rebase origin/${PR_BASE_REF} && git push --force-with-lease\`), then the next auto-review run can merge normally — the restriction applies to the PUSH, not to the merge." "blocked" "$iterations"
  fi
  # Non-fast-forward = someone pushed concurrently. Never force; the new
  # synchronize event will trigger a fresh review of their commit.
  log "Push rejected (concurrent push to branch?) — the next auto-review run will pick it up"
  finish "⚠️ Could not push auto-review commits (concurrent push to the branch). A new review will run on the latest commit." "blocked" "$iterations"
}

# Call one LLM endpoint. Writes the raw API response body to stdout.
# Fails (nonzero) on network error, non-200 status, or empty content.
call_llm() {
  local endpoint="$1" model="$2" api_key="$3" system_prompt="$4" user_content="$5"
  local json_mode="${6:-false}"
  local http_code body_file user_file payload_file
  body_file="$(mktemp "/tmp/pr-review-llm-body-${PR_NUMBER}-XXXXXX")"
  user_file="$(mktemp "/tmp/pr-review-llm-user-${PR_NUMBER}-XXXXXX")"
  payload_file="$(mktemp "/tmp/pr-review-llm-payload-${PR_NUMBER}-XXXXXX")"
  printf '%s' "$user_content" > "$user_file"

  # user_content reaches jq through a FILE rather than a shell argument: Linux
  # caps individual execve args at 128KB (MAX_ARG_STRLEN) and large diffs (e.g.
  # 143KB) exceed that, causing "Argument list too long". Payload is written to
  # a file so curl uses -d @file, same reason.
  #
  # The file arrives on jq's STDIN (`-Rs` slurps it as one raw string), NOT as
  # `--rawfile user "$user_file"`. Both read the same bytes, but a file PATH in
  # argv has to survive the MSYS argv boundary on Git Bash, and it does not
  # survive it reliably (DnD-l1kkc). `jq` on Windows is typically a NATIVE
  # binary that cannot open an MSYS path like /tmp/pr-review-llm-user-57-XXXXXX
  # at all; it only ever worked because MSYS silently rewrites such an argument
  # to C:/Users/.../Temp/... on the way in. Any caller that suppresses that
  # rewrite — MSYS_NO_PATHCONV=1, which this repo's own tooling guidance tells
  # agents to export for `git show <rev>:<path>` and friends — hands jq the raw
  # /tmp path, which it resolves drive-relative and cannot find:
  #   jq: Bad JSON in --rawfile user /tmp/pr-review-llm-user-57-9L5wEw:
  #       Could not open ...: No such file or directory
  # A `<` redirection is opened by BASH, so no path crosses the argv boundary
  # in either direction and the conversion setting stops mattering. Do not
  # "simplify" this back to --rawfile.
  #
  # response_format json_object is left off for the OpenRouter tiers —
  # DeepSeek via OpenRouter returns empty content with it (see PR history).
  jq -Rs \
    --arg model "$model" \
    --arg system "$system_prompt" \
    --argjson json_mode "$json_mode" \
    '{
      model: $model,
      messages: [
        {role: "system", content: $system},
        {role: "user", content: .}
      ],
      temperature: 0.1,
      max_tokens: 16384
    } + (if $json_mode then {response_format: {type: "json_object"}} else {} end)' \
  < "$user_file" > "$payload_file" || { rm -f "$body_file" "$user_file" "$payload_file"; return 1; }
  rm -f "$user_file"

  # --max-time was 600s: six times the slowest review this repo has ever
  # actually completed. Measured over six successful runs on 2026-09-01 the LLM
  # call takes 44-107s (median ~95s), while the DnD-u1eog failures burned ~250s
  # each before giving up — so the cap was never the thing that stopped them,
  # and 600s of a 1800s auto-merge poll budget can be spent on one dead tier.
  # 180s is ~1.7x the slowest observed success and fails fast enough that the
  # next tier still gets a real chance. Override per environment if a genuinely
  # larger diff needs longer.
  local max_time="${PR_REVIEW_LLM_MAX_TIME:-180}"
  local -a curl_args=(-s --connect-timeout 15 --max-time "$max_time" -o "$body_file" -w '%{http_code}')
  if [ -n "$api_key" ]; then
    curl_args+=(-H "Authorization: Bearer ${api_key}")
  fi

  local curl_started="$SECONDS" curl_rc=0
  # `|| curl_rc=$?`, not `if ! ...; then curl_rc=$?`: inside the then-branch of
  # a negated `if`, `$?` is the status of the negation (always 0), so the real
  # curl exit code — the whole point of telling a timeout apart from an empty
  # response — is lost.
  http_code="$(curl "${curl_args[@]}" "$endpoint" -H "Content-Type: application/json" -d "@${payload_file}")" || curl_rc=$?
  local elapsed=$((SECONDS - curl_started))
  rm -f "$payload_file"

  if [ "$curl_rc" -ne 0 ]; then
    # curl 28 is "operation timed out". Naming it is the point of this bead:
    # a request that never came back and a well-formed response carrying no
    # content are opposite conditions, and lumping them together sent the
    # reader hunting for a parser bug that does not exist.
    case "$curl_rc" in
      28) log "    TIMEOUT after ${elapsed}s (curl --max-time ${max_time}) — the endpoint did not respond in time. This is an upstream/provider problem, not a problem with this PR." ;;
      6|7) log "    NETWORK ERROR after ${elapsed}s (curl ${curl_rc}) — could not resolve or connect to ${endpoint}." ;;
      *)  log "    curl failed after ${elapsed}s (exit ${curl_rc})" ;;
    esac
    rm -f "$body_file"
    return 1
  fi

  if [ "$http_code" != "200" ]; then
    log "    HTTP ${http_code} after ${elapsed}s — $(head -c 300 "$body_file" | tr '\n' ' ')"
    rm -f "$body_file"
    return 1
  fi

  # Reject responses with missing/empty message content (e.g. provider error
  # bodies that still return 200) — these must not count as a completed review.
  if ! "$PYTHON_BIN" -c "
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    c = d['choices'][0]['message']['content']
except Exception:
    sys.exit(1)
sys.exit(0 if c and c.strip() else 1)
" "$(python_path "$body_file")"; then
    # Say how long it took and show what actually arrived. A 200 that took
    # minutes is an unhealthy provider draining the review budget, not a
    # malformed-parse bug — and without the elapsed time the two read
    # identically in the log (DnD-u1eog).
    log "    HTTP 200 after ${elapsed}s but the response carried NO usable message content"
    log "      body head: $(head -c 300 "$body_file" | tr '\n' ' ')"
    rm -f "$body_file"
    return 1
  fi

  cat "$body_file"
  rm -f "$body_file"
}

# Run the review through the fallback chain. On success, writes the parsed
# fixes JSON (guaranteed to have a "fixes" key) to $FIXES_FILE and sets
# LLM_USED_*. Fails only when every tier fails.
review_llm() {
  local system_prompt="$1" user_content="$2"
  local tier name endpoint model key json_mode json

  # tier format: name|endpoint|model|api_key|json_mode
  local -a tiers=(
    "openrouter|${OPENROUTER_ENDPOINT}|${OPENROUTER_MODEL}|${OPENROUTER_API_KEY}|false"
    "openrouter-free|${OPENROUTER_ENDPOINT}|${OPENROUTER_FALLBACK_MODEL}|${OPENROUTER_API_KEY}|false"
  )

  for tier in "${tiers[@]}"; do
    IFS='|' read -r name endpoint model key json_mode <<< "$tier"
    case "$name" in
      openrouter*)
        if [ -z "$key" ]; then
          log "  Tier '${name}' (${model}): skipped — OPENROUTER_API_KEY not set"
          continue
        fi
        ;;
    esac

    log "  Tier '${name}': ${model} @ ${endpoint}"
    local call_started="$SECONDS"
    if ! call_llm "$endpoint" "$model" "$key" "$system_prompt" "$user_content" "$json_mode" > "$RESPONSE_FILE"; then
      log "  Tier '${name}' failed after $((SECONDS - call_started))s — trying next tier"
      continue
    fi
    local call_seconds=$((SECONDS - call_started))

    json="$("$PYTHON_BIN" "$(python_path "$SCRIPT_DIR/extract-fixes.py")" "$(python_path "$RESPONSE_FILE")" 2>/dev/null || echo '{}')"
    if echo "$json" | jq -e 'has("fixes")' >/dev/null 2>&1 && [ -n "$json" ] && [ "$json" != "{}" ]; then
      # Structural validity beyond "JSON with a fixes key" (DnD-gbw3s): a
      # review that returns fixes:[] AND cannot even summarize what the PR
      # does did not read the diff — treat it as no review and fall through
      # to the next tier rather than rubber-stamping the merge gate.
      local summary_text
      summary_text="$(echo "$json" | jq -r '.summary // ""' 2>/dev/null | tr -d '[:space:]')"
      if [ -z "$summary_text" ]; then
        log "  Tier '${name}' returned review JSON with an empty summary — not a credible review, trying next tier"
        continue
      fi
      printf '%s' "$json" > "$FIXES_FILE"
      LLM_USED_TIER="$name"
      LLM_USED_MODEL="$model"
      LLM_USED_ENDPOINT="$endpoint"
      LLM_CALL_SECONDS="$call_seconds"
      local response_tool_path
      response_tool_path="$(python_path "$RESPONSE_FILE")"
      LLM_PROMPT_TOKENS="$(jq -r '.usage.prompt_tokens // 0' "$response_tool_path" 2>/dev/null || echo 0)"
      LLM_COMPLETION_TOKENS="$(jq -r '.usage.completion_tokens // 0' "$response_tool_path" 2>/dev/null || echo 0)"
      log "  Tier '${name}' produced a valid review (${call_seconds}s, ${LLM_PROMPT_TOKENS} prompt / ${LLM_COMPLETION_TOKENS} completion tokens)"
      return 0
    fi

    log "  Tier '${name}' returned 200 but no parseable review JSON — trying next tier"
    "$PYTHON_BIN" -c "
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    print(d['choices'][0]['message']['content'][:300])
except Exception:
    pass
" "$(python_path "$RESPONSE_FILE")" 2>/dev/null | while IFS= read -r line; do log "    | ${line}"; done
  done

  return 1
}

# Ask the consumer's hook to make dependencies match the manifest.
#
# Replaces npm_ci_resilient(), which hard-coded `npm ci` plus npm-specific
# transport hardening and a network-error regex. All of that is package-manager
# knowledge, and it now lives in each consumer's .cicd/quality-gates.sh alongside
# the gates that need it — DnD's wraps npm, the two PromptCI repos' wrap pnpm.
#
# The property the retired version existed to protect is PRESERVED, just moved:
# a transient registry failure is not a defect in the PR, so the hook reports it
# as 2 (infra) and the engine BLOCKS rather than discarding the review's fixes and
# merging the PR unreviewed. That failure mode caused 3 of 40 reviews to merge
# over an unrun review before it was found (DnD-1sux0), which is why the exit-2
# channel exists at all rather than a plain pass/fail.
#
# Returns the hook's own status so the caller can tell a real failure (lockfile
# drift — a defect in the PR) from an infra one.
run_install_hook() {
  local hook="${WORK_DIR}/.cicd/quality-gates.sh"
  [ -f "$hook" ] || hook="${SCRIPT_DIR}/hooks/default-quality-gates.sh"
  [ -f "$hook" ] || { log "  no quality-gates hook available for install"; return 2; }
  local out rc=0
  out="$(bash "$hook" install 2>&1)" || rc=$?
  printf '%s\n' "$out" | tail -20 >&2
  return "$rc"
}

# Run the consumer repo's quality gates.
#
# The gates themselves are NOT in this repo. Each consumer supplies
# `.cicd/quality-gates.sh`, and it is taken from the PR HEAD rather than from a
# pinned CICD ref, deliberately: it is product code, and a PR that changes how the
# project builds must be reviewable as part of that PR. Everything else the engine
# runs comes from a trusted ref precisely because it must NOT be PR-authored.
#
# This is also the seam that dissolves npm-vs-pnpm. DnD ran `npm ci` + jest shards;
# PromptCI and promptci-cloud run `pnpm install --frozen-lockfile` + vitest. Rather
# than merge three package-manager-specific gate blocks into one script, the engine
# stops knowing about package managers at all.
#
# Hook contract:
#   .cicd/quality-gates.sh run   0 = pass | 1 = a gate failed | 2 = infra/network
#     on 1, failure context on STDOUT — fed back to the LLM verbatim as the next
#     iteration's input, so it must be the tool's own output, not a summary.
#
# The engine's OWN contract to its callers is unchanged and deliberately so: stdout
# is the failure context, and the LAST LINE is one of pass|fail|infra_fail. Every
# caller downstream (the converge loop, the discard-fixes branch, the merge gate)
# reads it that way, so this stays an adapter rather than a refactor.
run_quality_gates() {
  local hook="${WORK_DIR}/.cicd/quality-gates.sh"
  local output="" rc=0

  cd "$WORK_DIR" || { echo "=== END ==="; echo "infra_fail"; return; }

  if [ ! -f "$hook" ]; then
    # No consumer hook: fall back to the bundled default. SCRIPT_DIR is the
    # extracted tools dir at runtime, so hooks/ ships with the engine.
    hook="${SCRIPT_DIR}/hooks/default-quality-gates.sh"
    if [ ! -f "$hook" ]; then
      log "  [gates] no .cicd/quality-gates.sh and no bundled default — cannot verify this PR"
      echo "=== END ==="
      # infra_fail, NOT fail: nothing was run, so nothing is known about the PR.
      # `fail` would read as "the code is broken" and discard the LLM's fixes.
      echo "infra_fail"
      return
    fi
  fi

  log "Running quality gates via ${hook#"${WORK_DIR}/"} ..."
  output="$(bash "$hook" run 2>&1)" || rc=$?

  printf '%s\n' "$output" | tail -60
  echo "=== END ==="
  case "$rc" in
    0) log "  [gates] PASS"; echo "pass" ;;
    2) log "  [gates] INFRA FAILURE — not a defect in this PR"; echo "infra_fail" ;;
    *) log "  [gates] FAILED (exit ${rc})"; echo "fail" ;;
  esac
}

# ── Version-pin guard (DnD-iu4qj) ─────────────────────────────────────────────
# Masks version-ish tokens so two strings can be compared "modulo versions":
#   - GitHub Action pins:      uses: actions/checkout@v7   -> @__VER__
#   - node-version keys:       node-version: '22'          -> node-version: '__VER__'
#   - bare semver-ish tokens:  1.2.3, v14.2.0, ^8.0.0      -> __VER__
normalize_versions() {
  sed -E \
    -e 's/@v?[0-9]+(\.[0-9]+)*/@__VER__/g' \
    -e "s/(node-version[\"': =]+)v?[0-9]+(\.[0-9]+)*/\1__VER__/g" \
    -e 's/[~^]?v?[0-9]+\.[0-9]+(\.[0-9]+)?([-+][0-9A-Za-z.-]+)?/__VER__/g'
}

# Returns 0 (= reject) when a fix is a pure version-pin change, i.e. the
# old/new strings are IDENTICAL once version tokens are masked. The review
# prompt has forbidden version changes since 2026-07-12 ("Never downgrade a
# version", rule 5) and a model violated it anyway on PR #1287, silently
# downgrading actions/checkout@v7 and actions/setup-node@v6 to @v4 — versions
# newer than a model's training data look like typos to it, so this cannot be
# left to the prompt. Mixed fixes (code change + version change together) still
# apply; the guard targets the "correcting" of pins, which is only ever the
# whole fix. package-lock.json is rejected outright — hand-editing it is never
# a legitimate review fix.
#
# The lockfile list is DATA, not package-manager machinery: the engine must know
# which files it refuses to let a model hand-edit, but never how to run an
# installer.
#
# It has to cover every ecosystem in the fleet because ONE engine now serves all
# three repos. The seed came from DnD, which is npm-only and correctly named just
# `package-lock.json`; that list would silently stop guarding pnpm-lock.yaml the
# moment PromptCI or promptci-cloud adopted it. (Both of those repos already guard
# their own lockfile locally — this is a consequence of sharing an engine, not a
# pre-existing hole in either of them.)
LOCKFILE_NAMES='package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lockb'

is_version_pin_change() {
  local path="$1" old="$2" new="$3"
  case " ${LOCKFILE_NAMES} " in
    *" $(basename "$path") "*) return 0 ;;
  esac
  [ "$old" = "$new" ] && return 1
  local norm_old norm_new
  norm_old="$(normalize_versions <<< "$old")"
  norm_new="$(normalize_versions <<< "$new")"
  [ "$norm_old" = "$norm_new" ]
}

# Shadow mode. Review and comment exactly as normal, but never write to the
# author's branch and never merge.
#
# This is what makes a safe rollout possible: a consumer runs the new engine
# alongside its incumbent reviewer on real PRs and DIFFS THE TWO COMMENTS. Any
# divergence is found on live traffic, for free, before anything can act on it.
# Checked here rather than at each call site so there is one place to be sure of.
# ── Feature flags ──────────────────────────────────────────────────────────
#
# The engine is the union of three forks, so behaviours only one repo wants live
# behind a flag. Set them in the consumer's .cicd/config.env.
#
# The defaults are NOT uniform, and the split is deliberate:
#
#   HOLD policies default ON. Each one can only ever ADD a reason not to merge,
#   never remove one, and each is inert unless its condition actually occurs — a
#   repo that never stacks PRs never trips the stacked-base check. An unwanted
#   hold is visible and recoverable; a missing one merges something it should not.
#
#   DISPATCH actions default OFF. They fire workflow_dispatch at named workflows
#   (e2e.yml, deploy-stage.yml, close-beads.yml) that a consumer may simply not
#   have. Firing them blindly is noise at best and a confusing red at worst, and
#   failing to fire one is recoverable by a human.
#
# DnD's profile therefore sets the dispatch flags to 1 and leaves the holds alone,
# which reproduces the behaviour of the file this engine was seeded from.
cicd_flag() {
  # Normalise one flag to true/false. Unset takes the default passed in $2.
  local name="$1" default="$2" value
  value="${!name:-$default}"
  case "$value" in 1|true|TRUE|yes|on) printf 'true' ;; *) printf 'false' ;; esac
}

CICD_FEATURE_STACKED_PRS="$(cicd_flag CICD_FEATURE_STACKED_PRS true)"
CICD_FEATURE_MIGRATION_JOURNAL="$(cicd_flag CICD_FEATURE_MIGRATION_JOURNAL true)"
CICD_FEATURE_APPROVE_HELD_RUNS="$(cicd_flag CICD_FEATURE_APPROVE_HELD_RUNS true)"
CICD_FEATURE_E2E_GATE="$(cicd_flag CICD_FEATURE_E2E_GATE false)"
CICD_FEATURE_STAGE_DEPLOY="$(cicd_flag CICD_FEATURE_STAGE_DEPLOY false)"
CICD_FEATURE_BEADS="$(cicd_flag CICD_FEATURE_BEADS false)"
CICD_FEATURE_DEPENDABOT_SKIP="$(cicd_flag CICD_FEATURE_DEPENDABOT_SKIP false)"

# Required-check identity.
#
# NOT YET FULLY WIRED, and saying so here rather than letting it look finished:
# ci-status.jq computes `required_missing` and `required_not_passing`, but this
# engine's wait_for_ci (inherited from DnD) reads NEITHER — it has no return code
# for "a required context never registered", which is promptci-cloud's return 6.
# So today the required set influences exactly one thing: whether a skipped check
# counts as unresolved (see CICD_STRICT_SKIPPED). The rest is computed and
# discarded.
#
# Grafting Cloud's return-6 path is deliberately deferred until Cloud's 500-line
# wait_for_ci suite is ported — wait_for_ci is the second-riskiest function here
# after check_ci_status, and changing it without a differential harness is the
# mistake the check_ci_status swap avoided.
#
# ci-lib.sh reads REQUIRED_CHECKS_FALLBACK; consumers
# configure CICD_REQUIRED_CHECKS_FALLBACK alongside their other CICD_* settings,
# so bridge the two rather than making every repo know both names.
#
# This matters more than a rename. required_contexts() reads the live ruleset and
# FAILS OPEN to this fallback — deliberately, because an empty answer is also the
# shape of a token without ruleset scope. So the fallback is the only thing
# standing between a ruleset read failing and the reviewer believing NOTHING is
# required. ci-lib.sh's own default is "gate", which is promptci-cloud's job name
# and wrong for the other two.
#
# Left unset the fallback stays "gate", which in a repo without such a job means
# required_missing=["gate"] and the poller BLOCKS — the safe direction, but
# inexplicable to whoever hits it. So say so out loud instead.
if [ -n "${CICD_REQUIRED_CHECKS_FALLBACK:-}" ]; then
  REQUIRED_CHECKS_FALLBACK="$CICD_REQUIRED_CHECKS_FALLBACK"
  export REQUIRED_CHECKS_FALLBACK
fi

# Whether to warn about an unconfigured fallback. The WARNING is emitted from
# main(), not from here: annotate() writes a workflow command to STDOUT, and a
# top-level write corrupts the stdout of every function a library-mode caller
# invokes — it turned the JSON that check_ci_status returns into unparseable
# output and broke 13 equivalence cases before this was moved.
CICD_FALLBACK_UNSET=false
[ -z "${REQUIRED_CHECKS_FALLBACK:-}" ] && CICD_FALLBACK_UNSET=true

CICD_DRY_RUN="${CICD_DRY_RUN:-false}"
case "$CICD_DRY_RUN" in 1|true|TRUE|yes) CICD_DRY_RUN=true ;; *) CICD_DRY_RUN=false ;; esac

# The single gate on touching the author's branch. Three independent reasons to
# refuse, all of which still produce a full comment-only review:
#   - the author is not on the auto-merge allowlist, or a hold label is on
#     (both collapse into $automerge_eligible=false, computed in main);
#   - the review came from a free / unidentified LLM tier (DnD-8fbkq).
# Kept as a function so the decision is testable at the decision point rather
# than only through the 400-line converge loop that calls it.
review_may_apply_fixes() {
  local automerge_eligible="$1"
  # Dry run is checked FIRST and unconditionally: shadow mode must be impossible
  # to talk past, whatever the allowlist or the tier says.
  [ "$CICD_DRY_RUN" = "true" ] && return 1
  [ "$automerge_eligible" = "true" ] || return 1
  llm_tier_is_paid || return 1
  return 0
}

# Human-readable "why nothing was applied", for the PR comment and the run log.
# Tier first: a hold label or a non-allowlisted author is the expected, boring
# case, while a free-tier run silently declining to apply is the one a reader
# will not otherwise guess.
#
# EVERY hold that can collapse $automerge_eligible to false gets its own branch
# (DnD-s0w3l). This used to distinguish only $HOLD_LABEL and let everything else
# fall through to "author not in auto-merge allowlist" — so a run held by the
# stacked-base guard (including its fail-closed LABEL_LOOKUP_FAILED path) posted
# a false statement ABOUT THE AUTHOR on the PR, and whoever read it went looking
# for an allowlist problem that did not exist. The branch order and the wording
# deliberately mirror the held-run `case "$result"` block and the hold sections
# of generate_comment, so the three places a reader can meet the same hold agree
# with each other. The allowlist message is now reachable only when no hold is
# recorded at all — i.e. when the author genuinely is not allowlisted.
fix_skip_reason() {
  if ! llm_tier_is_paid; then
    printf 'this review ran on the `%s` tier (`%s`), and a free or unidentified tier may comment but never auto-applies a fix (DnD-8fbkq) — a paid-tier re-review or a human has to apply these' \
      "${LLM_USED_TIER:-none}" "${LLM_USED_MODEL:-none}"
  elif [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
    printf "this PR's labels could not be read, so the do-not-merge guard failed closed (DnD-m3uj3) — an infrastructure fault holding every PR, not something about this one"
  elif [ -n "$HOLD_LABEL" ]; then
    printf "blocked by the '%s' label" "$HOLD_LABEL"
  elif [ "$HOLD_STACKED_BASE" = "$LABEL_LOOKUP_FAILED" ] || [ "$HOLD_UNMET_DEPS" = "$LABEL_LOOKUP_FAILED" ]; then
    printf "this PR's base ref or body could not be read, so the stacked-PR guard failed closed — an infrastructure fault holding every PR, not something about this one"
  elif [ -n "$HOLD_STACKED_BASE" ]; then
    printf "this PR is stacked on '%s' rather than the default branch, and stacked PRs are unsupported (DnD-iji9r)" "$HOLD_STACKED_BASE"
  elif [ -n "$HOLD_UNMET_DEPS" ]; then
    printf 'this PR declares Depends-on %s, which is not merged yet' "$HOLD_UNMET_DEPS"
  elif [ -n "$HOLD_ORPHANS" ]; then
    printf 'merging would orphan %s, which are based on this PR head' "$HOLD_ORPHANS"
  else
    printf 'author not in auto-merge allowlist'
  fi
}

# Is $1 inside WORK_DIR once symlinks and `..` are resolved?
#
# The string checks in apply_fixes() below reject `/etc/passwd` and `../../x`, but
# they cannot see a symlink COMMITTED IN THE PR: `linkdir/x`, where `linkdir` is a
# tracked symlink to `/`, is a clean relative path that still escapes. That is a
# sufficient primitive here because apply_fixes() runs
# `mkdir -p "$(dirname "$full_path")"` before writing a new file, so the write
# follows the link. This resolves both sides and requires containment.
#
# `realpath -m` deliberately does NOT require the path to exist — the file a "create
# new file" fix names legitimately does not yet — while still resolving symlinks in
# whatever prefix DOES exist.
#
# Fails CLOSED: an unset WORK_DIR, an unresolvable path, or a runner with no
# `realpath` all return non-zero, which drops the fix rather than applying it. The
# degradation is a comment-only review, never an unguarded write.
fix_path_is_contained() {
  local candidate="$1" resolved work_real
  [ -n "$candidate" ] || return 1
  [ -n "${WORK_DIR:-}" ] || return 1
  resolved="$(realpath -m -- "$candidate" 2>/dev/null)" || return 1
  work_real="$(realpath -m -- "$WORK_DIR" 2>/dev/null)" || return 1
  [ -n "$resolved" ] && [ -n "$work_real" ] || return 1
  # The checkout root itself is never a valid file target.
  [ "$resolved" = "$work_real" ] && return 1
  case "$resolved" in
    "$work_real"/*) return 0 ;;
    *) return 1 ;;
  esac
}

apply_fixes() {
  local json="$1"
  local count=0

  while read -r fix; do
    local path old_string new_string desc
    path="$(echo "$fix" | jq -r '.path')"
    old_string="$(echo "$fix" | jq -r '.old_string')"
    new_string="$(echo "$fix" | jq -r '.new_string')"
    desc="$(echo "$fix" | jq -r '.description')"

    if [ -z "$path" ]; then
      log "  Skipping fix with no path"
      printf -- '- (no file path given) — %s\n' "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    # Containment guard, part 1 of 2 (lexical). `path` comes from the LLM, whose
    # input includes attacker-controlled PR content — a diff, and for a Dependabot
    # PR the third-party release notes in the body. AUTOMERGE_AUTHORS includes
    # `dependabot[bot]` here, so that content reaches a bot with write access on a
    # self-hosted runner. Reject absolute paths and any `..` segment outright.
    if [[ "$path" = /* ]] || [[ "/${path}/" == *"/../"* ]]; then
      log "  REJECTED ${path} (path escapes the PR checkout): ${desc}"
      printf -- '- **%s** (REJECTED: path outside the PR checkout) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    full_path="${WORK_DIR}/${path}"

    # Containment guard, part 2 of 2 (resolved) — catches the symlink escape the
    # lexical test above cannot see. See fix_path_is_contained().
    if ! fix_path_is_contained "$full_path"; then
      log "  REJECTED ${path} (resolves outside the PR checkout): ${desc}"
      printf -- '- **%s** (REJECTED: path resolves outside the PR checkout) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    # Guard against LLM returning null/None as string values
    if [ "$old_string" = "null" ] || [ "$new_string" = "null" ]; then
      log "  SKIPPED ${path} (LLM returned null value): ${desc}"
      printf -- '- **%s** (LLM returned null value) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    # Version-pin guard (DnD-iu4qj): never apply a fix that only changes
    # version pins — see is_version_pin_change above for the incident.
    if is_version_pin_change "$path" "$old_string" "$new_string"; then
      log "  REJECTED ${path} (version-pin change — rule 5 is mechanical now): ${desc}"
      printf -- '- **%s** (REJECTED: version-pin-only change; versions newer than the model'"'"'s training data are not errors) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    if [ "$old_string" = "" ] && [ -n "$new_string" ]; then
      # New file
      mkdir -p "$(dirname "$full_path")"
      echo "$new_string" > "$full_path"
      log "  Created ${path}: ${desc}"
      printf -- '- **%s** (created) — %s\n' "$path" "$desc" >> "$APPLIED_FIXES_FILE"
      count=$((count + 1))
    elif [ -n "$old_string" ] && [ -n "$new_string" ]; then
      # Find and replace — with fuzzy matching fallback
      if [ -f "$full_path" ]; then
        # Pass arguments via stdin as JSON to avoid shell quoting issues
        if "$PYTHON_BIN" -c "
import sys, json, re

args = json.loads(sys.stdin.read())
path = args['path']
old = args['old_string']
new = args['new_string']
desc = args.get('description', '')

with open(path, 'r') as f:
    content = f.read()

# Strategy 1: exact match
if old in content:
    content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    sys.exit(0)

# Strategy 2: whitespace-normalized match
old_norm = re.sub(r'\s+', ' ', old.strip())
content_norm = re.sub(r'\s+', ' ', content)
if old_norm in content_norm:
    content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    sys.exit(0)

# Strategy 3: leading/trailing line match
old_lines = old.strip().split('\n')
content_lines = content.split('\n')
first_line = old_lines[0].strip()
last_line = old_lines[-1].strip()
for i in range(len(content_lines)):
    if content_lines[i].strip() == first_line:
        end = min(i + len(old_lines), len(content_lines))
        region = '\n'.join(content_lines[i:end])
        if content_lines[end-1].strip() == last_line:
            content_lines[i:end] = new.split('\n')
            with open(path, 'w') as f:
                f.write('\n'.join(content_lines))
            sys.exit(0)

sys.exit(1)
        " <<< "$(jq -n --arg p "$(python_path "$full_path")" --arg o "$old_string" --arg n "$new_string" --arg d "$desc" '{path:$p, old_string:$o, new_string:$n, description:$d}')" 2>/dev/null; then
          log "  Fixed ${path}: ${desc}"
          printf -- '- **%s** — %s\n' "$path" "$desc" >> "$APPLIED_FIXES_FILE"
          count=$((count + 1))
        else
          log "  SKIPPED ${path} (pattern not found): ${desc}"
          printf -- '- **%s** (pattern not found) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
        fi
      else
        log "  SKIPPED ${path} (file not found)"
        printf -- '- **%s** (file not found) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      fi
    fi
  done < <(echo "$json" | jq -c '.fixes[]' 2>/dev/null)

  echo "$count"
}

# Check suites on $sha that a LATER successful run of the SAME WORKFLOW has
# superseded, as a JSON array of check-suite ids (DnD-wbds2).
#
# This is a second resolution key, not a softer rule. DnD-78zah resolves a
# superseded check run by NAME, and that is what the draft-to-ready cancel
# defeats: a matrix job cancelled BEFORE its matrix expands publishes the
# LITERAL, unexpanded name
#
#     e2e (Playwright) shard ${{ matrix.shard }}/4        conclusion=cancelled
#
# which no later run can ever republish, because every run that gets as far as
# expanding emits `shard 1/4`…`shard 4/4`. So the successor exists and is green,
# and is simply unreachable by name — group_by(.name) keeps the orphan forever,
# nothing supersedes it, and DnD-7aqcv correctly reports terminal-but-unresolved
# on every poll. Hit on PR #2760 (cancelled run 33435279304) and PR #2815
# (33571835270), each needing two manual `gh run rerun`s.
#
# Keying on WORKFLOW + SHA instead resolves it without ever calling a cancelled
# check a pass: the question asked is "did a later run of this same workflow, on
# this same commit, succeed?" — which is the question a human reading the checks
# UI answers. A PR whose only signal is cancelled is still not passing
# (DnD-78zah AC 2), and a cancelled check is still not a failure, so PR #2691's
# counterweight test is untouched.
#
# `.check_suite.id` on a check run equals `.check_suite_id` on its workflow run,
# which is what joins the two APIs. Strictly-later is by `.id` for the same
# reason the name reduction uses it: monotonic at creation and never null.
superseded_check_suites() {
  local sha="$1" runs api_exit=0 out
  runs="$($GH_CLI api "repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100" 2>/dev/null)" || api_exit=$?
  if [ "$api_exit" -ne 0 ] || [ -z "$runs" ]; then
    >&2 log "  could not list workflow runs for ${sha} (exit=${api_exit}) — not resolving any unresolved check by workflow"
    echo '[]'
    return 1
  fi
  out="$(printf '%s' "$runs" | jq -c '
    [.workflow_runs[] | {id, path, conclusion, suite: .check_suite_id}] as $runs
    | [ $runs[]
        | . as $r
        | select(any($runs[]; .path == $r.path and .id > $r.id and .conclusion == "success"))
        | $r.suite
      ]
  ' 2>/dev/null)" || out=""
  # A jq failure must not be silently read as "nothing superseded"… which is the
  # same value, but the log line is what stops the next reader re-deriving this.
  if [ -z "$out" ]; then
    >&2 log "  could not parse workflow runs for ${sha} — not resolving any unresolved check by workflow"
    echo '[]'
    return 1
  fi
  printf '%s' "$out"
}

# Is a RERUN of a workflow that produced a failing check on this SHA currently
# in flight? (DnD-85jir)
#
# THE BUG THIS ANSWERS. wait_for_ci treats a red as terminal and returns
# immediately, and nothing ever re-polls — so a job rerun that turns the SHA
# green afterwards cannot unblock the merge. The only escapes are a new SHA or a
# human re-running the REVIEW run; three PRs needed one of those in ~6h on
# 2026-09-03 (#2879, #2889, #2899), and 5 of the last 100 review runs were
# manual re-runs.
#
# PR #2879 is the shape, reconstructed from the API. Three e2e.yml check suites
# on head SHA 83267ea2; suite 91319622374 failed `e2e (Playwright)` and
# `e2e (Playwright) shard 4/4`, suites 91317428962 and 91324293028 passed both:
#   23:53:15Z  the failing suite completes
#   00:11:40Z  the review run starts   <- newest run per NAME is the failure
#   00:12:46Z  the GREEN rerun suite starts
#   00:13:50Z  the review exits, having logged FAILURES DETECTED
# Nothing was miscounted: `group_by(.name) | map(max_by(.id))` picked the
# failure because the rerun had not published a check run of either NAME yet. A
# workflow's dependent jobs register their check runs only as they START, so for
# the ~10 minutes between "the rerun begins" and "the rerun reaches that job"
# the check-run API cannot see the rerun at all. The WORKFLOW RUN can — it
# exists, on this SHA, from the moment it is created.
#
# So: given the check suites the failures live in, resolve those to workflow
# paths, and report any path with a STRICTLY LATER run on the same SHA that has
# not completed. That is positive evidence a rerun is under way; wait_for_ci
# keeps polling instead of blocking, and the rerun's own check runs then decide
# the verdict by the normal latest-per-name reduction.
#
# What it deliberately does NOT do: drop, downgrade or otherwise resolve the
# failure itself. The red still counts, `all_success` still cannot become true
# while it stands, and a rerun that finishes without clearing it returns the
# poll to the ordinary fail-fast exit on the very next iteration. This can only
# make the bot WAIT longer, never make it merge something it has not seen green
# — the direction a change to this file has to fail in.
#
# Echoes nothing and returns 1 when the lookup fails or nothing is in flight;
# the caller treats that as "terminal", i.e. today's behaviour.
rerunning_workflows_for_suites() {
  local sha="$1" suites="$2" runs api_exit=0 jq_exit=0 out
  if [ -z "$suites" ] || [ "$suites" = "[]" ]; then
    return 1
  fi
  runs="$($GH_CLI api "repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100" 2>/dev/null)" || api_exit=$?
  if [ "$api_exit" -ne 0 ] || [ -z "$runs" ]; then
    >&2 log "  could not list workflow runs for ${sha} (exit=${api_exit}) — treating the failing checks as terminal"
    return 1
  fi
  out="$(printf '%s' "$runs" | jq -r --argjson suites "$suites" '
    [.workflow_runs[] | {id, path, status, suite: .check_suite_id}] as $all
    | [ $all[] | . as $r | select(($suites | index($r.suite)) != null) ] as $failed
    | [ $all[]
        | . as $r
        | select($r.status != "completed")
        | select(any($failed[]; .path == $r.path and $r.id > .id))
        | $r.path
      ]
    | unique
    | join("; ")
  ' 2>/dev/null)" || jq_exit=$?
  # A jq failure is not "nothing is rerunning" — it produces the same empty
  # value, so say which one happened rather than leaving the next reader to
  # re-derive it from a silent fail-fast.
  if [ "$jq_exit" -ne 0 ]; then
    >&2 log "  could not parse workflow runs for ${sha} (exit=${jq_exit}) — treating the failing checks as terminal"
    return 1
  fi
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# Reduce this SHA's check runs to one CI verdict.
#
# Delegates to ci_status_json() -> ci-status.jq. This replaced 198 lines of inline
# jq inherited from DnD; both encoded the same incidents (silent per_page=30
# truncation, latest-run-per-name, supersession) and the jq program is the tested
# one. tests/engine/check-ci-status-equivalence.test.ts runs the retired
# implementation and this one over the same fixtures and asserts they agree on
# every field the old one emitted.
check_ci_status() {
  local sha="${1:-$HEAD_SHA}"
  >&2 log "  Checking CI for SHA: ${sha}"

  local parsed
  parsed="$(ci_status_json "$sha" '[]' "${REQUIRED_CONTEXTS_JSON:-[]}")"

  # Only now, and only when something actually reached no verdict, pay for the
  # workflow-runs call. The overwhelmingly common poll has unresolved == 0 and
  # costs exactly one API call, as it always did.
  local unresolved_count=0
  unresolved_count="$(printf '%s' "$parsed" | jq -r 'if .unresolved then .unresolved else 0 end' 2>/dev/null)" || unresolved_count=0
  case "$unresolved_count" in ''|*[!0-9]*) unresolved_count=0 ;; esac

  if [ "$unresolved_count" -gt 0 ]; then
    local superseded='[]'
    superseded="$(superseded_check_suites "$sha")" || superseded='[]'
    if [ "$superseded" != "[]" ]; then
      local reparsed now_unresolved=0
      reparsed="$(ci_status_json "$sha" "$superseded" "${REQUIRED_CONTEXTS_JSON:-[]}")"
      now_unresolved="$(printf '%s' "$reparsed" | jq -r 'if .unresolved then .unresolved else 0 end' 2>/dev/null)" || now_unresolved=0
      case "$now_unresolved" in ''|*[!0-9]*) now_unresolved=0 ;; esac
      # KEEP THE FIRST PARSE when the re-parse did not work out. A re-parse that
      # came back api_failed (gh flaked on the second call) would otherwise
      # replace a real verdict with an all-zeros sentinel — i.e. a SHA with a
      # known failure would read as "zero checks" and take the zero-checks path.
      # The worst case of keeping the first parse is the pre-supersession
      # behaviour, which is honest, not wrong.
      if [ "$(printf '%s' "$reparsed" | jq -r 'if .api_failed then "true" else "false" end' 2>/dev/null || echo "true")" = "true" ]; then
        >&2 log "  check-runs re-parse with superseded suites FAILED — keeping the unresolved verdict"
      else
        if [ "$now_unresolved" -lt "$unresolved_count" ]; then
          >&2 log "  CI: $((unresolved_count - now_unresolved)) unresolved check(s) belong to a workflow run that a LATER run of the same workflow re-ran to success on this SHA — resolving them by workflow instead of by name"
        fi
        parsed="$reparsed"
      fi
    fi
  fi

  echo "$parsed"
}

# Poll until this SHA has a CI verdict, or until we can say why it never will.
#
# Structure and return codes come from promptci-cloud, which is the tested one —
# tests/engine/wait-for-ci.graft-spec.test.ts is its suite, ported verbatim. The
# DnD-derived version this replaces had no concept of a REQUIRED context: it read
# ci-status.jq's `required_missing` zero times, so the required set influenced
# nothing but the skipped-check rule.
#
# WHAT WAS DELIBERATELY DROPPED: return 3, the "docs-only grace". It let a SHA with
# zero check runs merge when the PR touched no CI-relevant path. Cloud can fail
# closed instead because its `gate` context ALWAYS registers; DnD can now too,
# since it grew an aggregate gate plus ci-docs-shim.yml. A grace that exists to
# excuse a missing verdict is a liability once a verdict is guaranteed.
#
# WHAT WAS DELIBERATELY KEPT: the approve_held_runs() call each poll. It is the one
# piece of DnD-only logic in here and Cloud has no equivalent, so taking Cloud's
# body wholesale would have silently dropped it — a GITHUB_TOKEN push parks runs as
# action_required, and without this they are never approved and the grace expires
# into a fail-closed naming the wrong cause.
wait_for_ci() {
  local sha="$1"
  # "true" when $sha reached the branch via this pipeline's own GITHUB_TOKEN
  # push. GitHub fires NO workflows for GITHUB_TOKEN events, so a bot-pushed SHA
  # never gets pull_request-triggered CI on its own. For those SHAs this function
  # dispatches ci.yml explicitly, and "zero check runs" means the dispatch
  # failed: fail closed (return 4), never "no CI applies".
  local bot_pushed="${2:-false}"
  local waited=0
  local zero_checks_elapsed=0
  local missing_required_elapsed=0
  local ci_dispatched=false
  # Which checks are keeping this poll alive, with their conclusions. NOT a
  # nicety: "CI: 17 checks, waiting" tells you a count and nothing else, so a
  # run that timed out had to be reconstructed from the API by hand. Declared
  # here (bash `local` is function-scoped) so the post-loop timeout line can
  # still read the last poll's value even if the loop never ran.
  local pending="none"

  while [ "$waited" -lt "$POLL_TIMEOUT" ]; do
    # A GITHUB_TOKEN push fires no workflow JOBS, but the runs are still created and
    # parked as action_required awaiting approval. Approving them here is what makes
    # a checkless bot-pushed SHA recoverable rather than a fail-closed block naming
    # the wrong cause. Every iteration, not just the first: the hold has been seen
    # appearing partway through a review, and a run approved here needs the grace
    # restarted so it can register its check.
    #
    # Returns 0 ONLY when it actually approved something — a disabled feature
    # returns 1, so the grace is not silently reset in a repo that switched it off.
    if approve_held_runs "$sha"; then
      zero_checks_elapsed=0
    fi

    local raw_status
    raw_status="$(check_ci_status "$sha")"

    local all_completed all_success total failures api_failed
    local unresolved unresolved_names required_missing required_missing_names
    all_completed="$(echo "$raw_status" | jq -r 'if .all_completed then "true" else "false" end' 2>/dev/null || echo "false")"
    all_success="$(echo "$raw_status" | jq -r 'if .all_success then "true" else "false" end' 2>/dev/null || echo "false")"
    total="$(echo "$raw_status" | jq -r 'if .total then .total else 0 end' 2>/dev/null || echo "0")"
    failures="$(echo "$raw_status" | jq -r 'if .failures then .failures else 0 end' 2>/dev/null || echo "0")"
    api_failed="$(echo "$raw_status" | jq -r 'if .api_failed then "true" else "false" end' 2>/dev/null || echo "false")"
    pending="$(echo "$raw_status" | jq -r 'if .pending then .pending else "" end' 2>/dev/null || echo "")"
    [ -n "$pending" ] || pending="none"
    # Checks that FINISHED without a verdict — the subset of `pending` that will
    # never move again, and the reason for the return-5 branch below.
    unresolved="$(echo "$raw_status" | jq -r 'if .unresolved then .unresolved else 0 end' 2>/dev/null || echo "0")"
    unresolved_names="$(echo "$raw_status" | jq -r 'if .unresolved_names then .unresolved_names else "" end' 2>/dev/null || echo "")"
    [ -n "$unresolved_names" ] || unresolved_names="none"
    # Required contexts with no check run of that name at all — return 6.
    required_missing="$(echo "$raw_status" | jq -c 'if .required_missing then .required_missing else [] end' 2>/dev/null || echo '[]')"
    [ -n "$required_missing" ] || required_missing='[]'
    required_missing_names="$(printf '%s' "$required_missing" | jq -r 'join(", ")' 2>/dev/null || echo "")"
    [ -n "$required_missing_names" ] || required_missing_names="none"

    if [ "$api_failed" = "true" ]; then
      # "Could not ask" is not "zero checks": don't dispatch off it and don't
      # let it accumulate toward the zero-checks grace, or a minute of GitHub
      # flakiness reads as a terminal verdict. Keep polling; if the API never
      # recovers the loop exits at POLL_TIMEOUT → blocked.
      log "  CI: check-runs lookup failing — not counting toward the zero-checks grace (${waited}s elapsed)"
    elif [ "$total" -eq 0 ]; then
      # Zero check runs is uniformly FAIL CLOSED now (pcic-pa8.3): with `gate`
      # required, a SHA carrying no check runs can never be merged by
      # `gh pr merge`, so there is no safe reading of this state. Dispatch
      # ci.yml once to heal the two recoverable causes (a GITHUB_TOKEN push
      # fires no workflows; a run cancelled by cancel-in-progress), then block.
      if [ "$ci_dispatched" = "false" ]; then
        dispatch_ci
        ci_dispatched=true
        # Restart the grace clock so the dispatched run gets the FULL grace to
        # register its first check run — it had already started ticking on this
        # same poll, and grace-minus-one-interval is tight enough for a queued
        # runner to produce a false "CI never started" block.
        zero_checks_elapsed=0
      fi
      zero_checks_elapsed=$((zero_checks_elapsed + POLL_INTERVAL))
      if [ "$zero_checks_elapsed" -ge "$ZERO_CHECKS_GRACE" ]; then
        log "  CI: no check runs registered after ${zero_checks_elapsed}s (bot_pushed=${bot_pushed}) — the explicit CI dispatch failed or never started. Failing closed."
        return 4
      fi
      log "  CI: no check runs yet (waited ${waited}s) — maybe CI hasn't started"
    elif [ "$all_completed" = "true" ] && [ "$all_success" = "true" ]; then
      log "  CI: ALL CHECKS PASSED"
      return 0
    # FAIL FAST: a failed check is terminal, so there is nothing to learn by
    # waiting for the slow ones. Deliberately NOT gated on all_completed — a
    # lint failure at ~40s used to sit silent behind the rest of the matrix, up
    # to the full POLL_TIMEOUT, and the run then reported a timeout rather than
    # the real failure.
    #
    # Deliberately NOT extended to cancelled/timed_out, which `failures`
    # excludes (it counts conclusion == "failure" only): a cancel is routinely a
    # superseded run rather than a verdict — that is the PR #155 shape — and
    # treating it as one would block PRs that legitimately carry a
    # cancelled+rerun pair. Those are answered by return 5 below.
    #
    # NOT terminal while a RERUN IS IN FLIGHT. The one thing fail-fast got wrong
    # is that it never reconsidered: a rerun that turns the SHA green after this
    # point cannot unblock the merge, because nobody is looking any more. When
    # the workflow behind a failing check demonstrably has a LATER run going on
    # this same SHA, the red is provisional — keep polling and let the rerun
    # publish its own verdict. No rerun in flight means the old behaviour,
    # unchanged and with no extra API call, so a genuinely red PR is still
    # reported on the FIRST poll rather than at POLL_TIMEOUT.
    elif [ "$failures" -gt 0 ]; then
      local failure_names failure_suites rerunning=""
      failure_names="$(echo "$raw_status" | jq -r 'if .failure_names then .failure_names else "" end' 2>/dev/null || echo "")"
      [ -n "$failure_names" ] || failure_names="unnamed"
      failure_suites="$(echo "$raw_status" | jq -c 'if .failure_suites then .failure_suites else [] end' 2>/dev/null || echo '[]')"
      [ -n "$failure_suites" ] || failure_suites='[]'
      rerunning="$(rerunning_workflows_for_suites "$sha" "$failure_suites")" || rerunning=""
      if [ -n "$rerunning" ]; then
        log "  CI: ${failures} of ${total} checks currently RED (${failure_names}) — but a later run of ${rerunning} is in flight on this SHA, so a rerun is under way and this red is not terminal. Waiting for it (${waited}s elapsed)"
      else
        # Named, not just counted: "2 of 11 checks" with no names costs a full
        # diagnosis cycle.
        LAST_FAILED_CHECKS="$failure_names"
        log "  CI: FAILURES DETECTED ($failures of $total checks: ${failure_names}) — not waiting for the checks still running"
        return 1
      fi
    # REQUIRED CONTEXT NEVER REGISTERED — return 6. Every check that exists has
    # finished and none failed, but a context the ruleset requires has no check
    # run of that name at all. GitHub does not read "absent" as "passed", so
    # `gh pr merge` would be refused; reporting it here names the cause instead
    # of failing at the merge call with "the base branch policy prohibits the
    # merge".
    #
    # BEHIND THE SAME GRACE as zero-checks, and that is load-bearing rather than
    # caution: `gate` has `needs: [ci, e2e, audit]`, and a check run appears only
    # when its job STARTS. So there is a genuine window — every check green,
    # `gate` queued and not yet registered — that is indistinguishable from the
    # real fault by a single poll. Only a context still missing after the grace
    # is terminal.
    elif [ "$all_completed" = "true" ] && [ "$required_missing" != "[]" ]; then
      missing_required_elapsed=$((missing_required_elapsed + POLL_INTERVAL))
      if [ "$missing_required_elapsed" -ge "$MISSING_REQUIRED_GRACE" ]; then
        LAST_MISSING_REQUIRED="$required_missing_names"
        log "  CI: REQUIRED CONTEXT MISSING — all ${total} checks finished and none failed, but no check run ever registered for: ${required_missing_names}"
        return 6
      fi
      log "  CI: all ${total} checks completed but required context(s) not registered yet: ${required_missing_names} — waiting ${missing_required_elapsed}s/${MISSING_REQUIRED_GRACE}s for them to start"
    # TERMINAL BUT UNRESOLVED — return 5. Every check finished, none failed, and
    # at least one concluded with something that is neither a pass nor a fail
    # (typically `cancelled` with no re-run, or `skipped` on a REQUIRED context).
    # There is nothing left to wait FOR: check_ci_status already reduced to the
    # latest run per name and resolved anything a later successful run of the
    # same workflow superseded, so no successor is coming and this SHA will look
    # identical in 29 more minutes.
    #
    # A third verdict, not a softening of either neighbour:
    #   * NOT a pass — a cancelled-only SHA must never merge;
    #   * NOT a failure — `failures` still counts conclusion == "failure" only,
    #     so the fail-fast branch above is untouched.
    # What changes is only WHEN the block is reported: on the first poll with
    # the cause named, instead of after the full POLL_TIMEOUT.
    elif [ "$all_completed" = "true" ] && [ "$unresolved" -gt 0 ]; then
      LAST_UNRESOLVED_CHECKS="$unresolved_names"
      log "  CI: TERMINAL BUT UNRESOLVED — all ${total} checks finished, none failed, but ${unresolved} reached no verdict: ${unresolved_names}"
      return 5
    else
      log "  CI: ${total} checks, waiting (${waited}s elapsed) — still non-terminal: ${pending}"
    fi

    if [ $((waited + POLL_INTERVAL)) -ge "$POLL_TIMEOUT" ]; then
      log "  CI: TIMEOUT after ${POLL_TIMEOUT}s — still non-terminal: ${pending}"
      return 2
    fi

    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
  done

  log "  CI: TIMEOUT after ${POLL_TIMEOUT}s — still non-terminal: ${pending}"
  return 2
}

# The PR comment for wait_for_ci's return 5 (DnD-7aqcv), shared by both call
# sites so they cannot drift apart.
#
# The result this feeds is `blocked`, NOT `blocked_infra`, and that distinction
# is the one DnD-xqpyv drew: `blocked_infra` turns the Auto-Review check RED and
# is reserved for "the reviewer could not evaluate this PR at all". Here it
# evaluated it fine — CI reached a terminal state that is simply not a verdict.
# That is the PR's condition to fix, so the run stays green and the comment says
# what to do.
unresolved_ci_message() {
  local names="${LAST_UNRESOLVED_CHECKS:-none}"
  printf '%s' "🛑 CI on this SHA finished **without a verdict** — every check completed, none failed, but these concluded as neither a pass nor a failure (typically \`cancelled\` with nothing re-run after it):

${names}

Not merging: a cancelled or skipped check is not a passing check. Nothing is coming that would change this — the poller already resolves a cancelled run against any later run of the same name, and there is no later run — so this is reported now rather than after ${POLL_TIMEOUT}s of polling.

**To clear it:** re-run those checks (a fresh check run of the same name replaces this one), or push a commit. If a check concluded \`skipped\`, the job was narrowed with a job-level \`if:\` — remove it (see the DnD-t03ne note in .github/workflows/e2e.yml)."
}

missing_required_message() {
  local names="${LAST_MISSING_REQUIRED:-none}"
  printf '%s' "🛑 A **required status check never registered** on this SHA — not merging:

${names}

Every check that did run finished and none failed, but GitHub does not treat an absent required context as a passing one, so \`gh pr merge\` would be refused by the base branch policy.

**Most likely** this branch predates the \`gate\` job in \`.github/workflows/ci.yml\`: the dispatch runs the branch's OWN copy of ci.yml, which cannot publish a job it does not contain. Merge \`main\` into this branch and re-review.

**Otherwise** the \`main\` ruleset names a context that no workflow in this repo publishes at all — check the required-status-checks rule against the job ids in \`.github/workflows/\`, and see \`tests/repo/pr-review-required-checks.test.ts\`."
}

# The PR comment for wait_for_ci's return 1, shared by both call sites so they
# cannot drift apart — the same contract unresolved_ci_message() carries.
#
# $1 is an optional context phrase for the lead-in ("after the auto-review
# fixes"), which is the ONLY difference between the two sites.
#
# It names the failing checks (DnD-85jir). The old text — "CI checks failing.
# Needs investigation." — sent the reader to the run log to find out WHICH,
# and the log said only "2 of 11 checks". Both halves of that are fixed here.
failed_ci_message() {
  local context="${1:-}"
  local names="${LAST_FAILED_CHECKS:-none}"
  [ -z "$context" ] || context=" ${context}"
  printf '%s' "⚠️ CI on this SHA has **failing checks**${context} — not merging:

${names}

**If these are real,** fix them and push. **If one is a flake,** re-run the failed jobs (\`gh run rerun <run-id> --failed\`) — no new commit is needed: this reviewer keeps polling while a rerun of the same workflow is in flight on this SHA, and \`.github/workflows/cron-stranded-review-sweep.yml\` re-runs this review shortly after the SHA goes green if the rerun started after the review had already left."
}

generate_comment() {
  local summary="$1"
  local result="$2"
  local iterations="$3"
  local merge_sha="${4:-}"
  local completed_at
  local duration

  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration=$(( $(date -u -d "$completed_at" +%s) - $(date -u -d "$STARTED_AT" +%s) ))

  cat > "$COMMENT_FILE" <<COMMENTEOF
## 🤖 PR Auto-Review Summary

$(llm_tier_header_line)

${summary}

<details><summary>ℹ️ Review Metadata</summary>

\`\`\`yaml
review:
  host: ${RUNNER_HOST:-artemis}
  runner_name: ${RUNNER_NAME:-artemis-pr-review}
  llm_tier: ${LLM_USED_TIER}
  model: ${LLM_USED_MODEL}
  model_endpoint: ${LLM_USED_ENDPOINT}
  llm_call_seconds: ${LLM_CALL_SECONDS}
  llm_prompt_tokens: ${LLM_PROMPT_TOKENS}
  llm_completion_tokens: ${LLM_COMPLETION_TOKENS}
  automerge_eligible: $(is_automerge_author && echo true || echo false)
  do_not_merge_label: ${HOLD_LABEL:-none}
  stacked_base: ${HOLD_STACKED_BASE:-none}
  unmet_dependencies: ${HOLD_UNMET_DEPS:-none}
  would_orphan: ${HOLD_ORPHANS:-none}
  merge_attempts: ${MERGE_ATTEMPTS_MADE}
  merge_error: "$(merge_error_oneline)"
  started_at: ${STARTED_AT}
  completed_at: ${completed_at}
  duration_seconds: ${duration}
  converge_iterations: ${iterations}
  converge_attempts:
$(echo "$CONVERGE_ATTEMPTS" | jq -r '.[] | "    - check: \(.check)\n      status: \(.result)\n      fix: \(.fix_applied // false)"' 2>/dev/null || echo "    - check: review
      status: completed
      fix: unknown")
  pr_number: ${PR_NUMBER}
  pr_author: ${PR_AUTHOR}
  pr_base_ref: ${PR_BASE_REF}
  pr_head_ref: ${PR_HEAD_REF}
  pr_base_sha: ${BASE_SHA}
  pr_head_sha: ${HEAD_SHA}
  push_sha: $(git -C "$WORK_DIR" rev-parse HEAD 2>/dev/null || echo "none")
  merge_sha: ${merge_sha:-none}
  result: ${result}
\`\`\`
</details>
COMMENTEOF

  # A hold has to be visible in the COMMENT, not just the run log (DnD-m3uj3).
  # "Reviewed but not merged" and "held" look identical from the PR page, so a
  # held PR read as a reviewer that simply had nothing to merge, and three
  # retrigger cycles were spent chasing a CI-timing theory that never existed.
  if [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
    cat >> "$COMMENT_FILE" <<HOLDEOF

### ⛔ Auto-merge held — this PR's labels could not be read

The reviewer could not fetch this PR's labels, so it could not rule out a
\`${DO_NOT_MERGE_LABELS}\` hold and **failed closed**: the review ran, the merge did not.
This is an infrastructure fault that holds **every** PR, not something about this one.

- **Merge manually once CI is green:** \`gh pr merge ${PR_NUMBER} --squash --delete-branch\`
- **Diagnose:** \`gh run view ${GITHUB_RUN_ID:-<run-id>} --log | grep 'label lookup FAILED'\` — the gh error and exit code are logged there.
HOLDEOF
  elif [ -n "$HOLD_LABEL" ]; then
    cat >> "$COMMENT_FILE" <<HOLDEOF

### ⏸️ Auto-merge held by the \`${HOLD_LABEL}\` label

The review ran, but the merge is deliberately blocked. Remove the label to let
the next review merge this PR.
HOLDEOF
  fi

  # ── Stacked-PR holds (DnD-iji9r / DnD-pb4ur) ──────────────────────────────
  # Each one carries its exact remediation. The whole point of these guards is
  # that the next agent can act from the PR page without first finding a bead.
  if [ "$HOLD_STACKED_BASE" = "$LABEL_LOOKUP_FAILED" ] || [ "$HOLD_UNMET_DEPS" = "$LABEL_LOOKUP_FAILED" ]; then
    cat >> "$COMMENT_FILE" <<STACKEOF

### ⛔ Auto-merge held — this PR's base ref or body could not be read

The stacked-PR guard **failed closed**: the review ran, the merge did not. This is
an infrastructure fault that holds **every** PR, not something about this one.

- **Diagnose:** \`gh run view ${GITHUB_RUN_ID:-<run-id>} --log | grep FAILED\`
STACKEOF
  elif [ -n "$HOLD_STACKED_BASE" ]; then
    cat >> "$COMMENT_FILE" <<STACKEOF

### ⛔ Auto-merge blocked — this PR is stacked on \`${HOLD_STACKED_BASE}\`

**Stacked PRs are unsupported in this repo.** This PR targets
\`${HOLD_STACKED_BASE}\` instead of \`$(default_branch)\`. When that base branch merges it is
deleted, and GitHub responds by **closing this PR** rather than retargeting it —
unrecoverably, because it refuses both \`gh pr edit --base\` and \`gh pr reopen\`
on a closed PR whose base is gone. That cost three PR numbers for one bead on
2026-08-30 (DnD-iji9r).

Rebase onto \`$(default_branch)\` and declare the ordering instead:

\`\`\`bash
git fetch origin $(default_branch) && git rebase origin/$(default_branch) && git push --force-with-lease
gh pr edit ${PR_NUMBER} --base $(default_branch)
\`\`\`

Then add a \`Depends-on: #<pr>\` line to the body naming whatever must merge first.
The bot will hold this PR until that one is merged — serialization without stacking.
STACKEOF
  elif [ -n "$HOLD_UNMET_DEPS" ]; then
    cat >> "$COMMENT_FILE" <<STACKEOF

### ⏸️ Auto-merge held — waiting on ${HOLD_UNMET_DEPS}

This PR's body declares \`Depends-on:\`/\`Blocked-by:\` for the above, and they are
not merged yet. The review ran; only the merge is deferred. Nothing to do — the
next review after they merge will pick this up.

If a dependency no longer applies (or the number is wrong — an unresolvable ref is
shown as \`(unresolvable)\`), **edit the \`Depends-on:\` line out of the body**.
Cross-repo refs like \`owner/repo#12\` are not supported and read as unresolvable.
STACKEOF
  elif [ -n "$HOLD_ORPHANS" ]; then
    cat >> "$COMMENT_FILE" <<STACKEOF

### ⛔ Auto-merge blocked — merging would orphan ${HOLD_ORPHANS}

Those PRs are based on \`${PR_HEAD_REF}\`. Merging this one deletes that branch, and
GitHub **closes** every PR targeting it instead of retargeting them — silently, and
unrecoverably (it refuses \`gh pr edit --base\` and \`gh pr reopen\` afterwards).

Retarget each child onto \`$(default_branch)\` first — this works while they are still open:

\`\`\`bash
gh pr edit <child> --base $(default_branch)
\`\`\`

…or close them if they are abandoned. Then this PR merges normally.

> ⚠️ Do **not** work around this with \`gh pr merge --delete-branch\` while those PRs
> are open — that is exactly the operation this guard exists to prevent.
STACKEOF
  fi

  # Any non-merge result gets a how-to-proceed footer. Only the infra/reviewer
  # faults among them also fail the workflow — see the exit map in finish().
  if [ "$result" = "blocked" ] || [ "$result" = "blocked_infra" ] || [ "$result" = "review_failed" ]; then
    cat >> "$COMMENT_FILE" <<BYPASSEOF

### ⛔ Action required — auto-merge did not happen

- **Retry the review:** \`gh run rerun ${GITHUB_RUN_ID:-<run-id>} --failed\` or push a new commit to this branch.
- **Bypass and merge manually:** \`gh pr merge ${PR_NUMBER} --squash --delete-branch\` (use when the reviewer is down or out of credits and CI is otherwise green).
  ⚠️ Check first that no open PR is based on \`${PR_HEAD_REF}\` — \`gh pr list --base ${PR_HEAD_REF}\`.
  Deleting a branch that is another PR's base **closes that PR**, unrecoverably (DnD-iji9r).
BYPASSEOF
  fi

  echo "$COMMENT_FILE"
}

finish() {
  local summary="$1" result="$2" iterations="$3" merge_sha="${4:-}"

  # Give a held run its own result rather than letting it report as a clean
  # "reviewed"/"commented" (DnD-m3uj3). A deliberate label hold stays green — a
  # human parked it on purpose. A hold caused by a FAILED lookup goes red: the
  # run did not do its job, nobody asked for that, and a green check on every PR
  # is exactly how this outage stayed invisible for a whole batch.
  #
  # The stacked-PR holds follow the same split (DnD-iji9r / DnD-pb4ur): every one
  # of them is PR-caused and stays GREEN, because the reviewer did its job — it
  # reviewed the PR and correctly declined to merge it. Only a failed LOOKUP,
  # which is an infrastructure fault affecting every PR, goes red.
  case "$result" in
    reviewed|commented)
      if [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
        result="held_label_lookup_failed"
      elif [ -n "$HOLD_LABEL" ]; then
        result="held_do_not_merge_label"
      elif [ "$HOLD_STACKED_BASE" = "$LABEL_LOOKUP_FAILED" ] || [ "$HOLD_UNMET_DEPS" = "$LABEL_LOOKUP_FAILED" ]; then
        result="held_lookup_failed"
      elif [ -n "$HOLD_STACKED_BASE" ]; then
        result="held_stacked_base"
      elif [ -n "$HOLD_UNMET_DEPS" ]; then
        result="held_unmet_dependency"
      elif [ -n "$HOLD_ORPHANS" ]; then
        result="held_would_orphan_children"
      fi
      ;;
  esac

  generate_comment "$summary" "$result" "$iterations" "$merge_sha" >/dev/null
  # $GITHUB_OUTPUT may be absent on some self-hosted runner configurations; make
  # these writes non-fatal so a missing file doesn't mask the real review result.
  echo "result=${result}" >> "$GITHUB_OUTPUT" 2>/dev/null || true
  echo "comment_path=${COMMENT_FILE}" >> "$GITHUB_OUTPUT" 2>/dev/null || true
  log "=== PR Auto-Review Complete: #${PR_NUMBER} → ${result} ==="
  # No stranded-review hand-off here any more (DnD-y6ez1). The global
  # concurrency group that made one PR's review cancel another's is gone — see
  # the tombstone above dispatch_stranded_review()'s old home.
  # Exit status == "did the REVIEWER do its job?", not "did the PR merge?"
  # (DnD-xqpyv). A red check here used to fire on every `blocked`, so the PR's
  # own failing CI, a do-not-merge label, a merge conflict and a merge race all
  # painted this workflow red too — 10 of 10 failures in the 2026-08-22 audit,
  # none of them a reviewer fault. Those are `blocked` (exit 0: the PR's own
  # CI check is already red, the comment says why). Red is reserved for the
  # cases where the run could not evaluate the PR at all: `blocked_infra`
  # (registry outage, CI never started, poll timeout, unreadable branch tip),
  # a reviewer that failed on every tier, or a label lookup that failed closed.
  case "$result" in
    blocked_infra|review_failed|held_label_lookup_failed|held_lookup_failed) exit 1 ;;
    *) exit 0 ;;
  esac
}

# ── Main logic ─────────────────────────────────────────────────────────────

main() {
  local iterations=0
  local result="reviewed"
  local merge_sha=""
  local summary=""
  local review_summary=""
  local qg_last="none"
  local qg_failure_context=""
  local automerge_eligible=false

  if [ "$CICD_FALLBACK_UNSET" = "true" ]; then
    annotate warning "CICD_REQUIRED_CHECKS_FALLBACK is not set in .cicd/config.env, so the required-check fallback stays 'gate' (promptci-cloud's job name). It currently affects only the skipped-check rule — see CICD_STRICT_SKIPPED. Set it to this repo's required check name(s) before the required-context handling is wired up."
  fi

  # Dependabot short-circuit (from promptci-cloud). Placed before the
  # default-branch priming below so a skipped PR costs zero API calls.
  #
  # Where a repo lets a separate LLM-free auto-merge.yml own Dependabot PRs,
  # reviewing them too burns a model call per lockfile bump and risks two merge
  # authorities racing.
  #
  # It also sidesteps a failure worth naming: a Dependabot-triggered run receives
  # NO Actions secrets, so OPENROUTER_API_KEY arrives empty. PromptCI had this
  # intent documented and the code missing, and every Dependabot PR there failed
  # as a result. review_llm's no-credentials path handles that honestly now
  # regardless, but not paying for the checkout is better still.
  #
  # OFF by default: a repo whose reviewer IS the Dependabot merge authority (DnD)
  # must not silently stop reviewing them.
  if [ "$CICD_FEATURE_DEPENDABOT_SKIP" = "true" ] \
     && [ "$PR_AUTHOR" = "dependabot[bot]" ] && ! is_automerge_author; then
    log "PR #${PR_NUMBER} is a Dependabot PR — the repo's auto-merge workflow owns it. Skipping LLM review."
    echo "result=skipped_dependabot" >> "$GITHUB_OUTPUT" 2>/dev/null || true
    exit 0
  fi

  # Prime the default-branch cache with ONE bare call in this (the parent)
  # shell. Every other call site invokes default_branch inside a $( )
  # substitution, whose subshell copy of DEFAULT_BRANCH_CACHE is discarded on
  # exit, so without this bare statement the "resolved once and cached"
  # promise on the function is false and every call site re-hits the API.
  # Subshells forked after this point inherit the populated cache instead.
  # Safe pre-cd: the lookup passes the repo explicitly (DnD-m3uj3).
  default_branch > /dev/null

  if is_automerge_author; then
    automerge_eligible=true
  fi

  # Informational only — merge_pr re-checks at merge time and is the real gate.
  # Logged up front so a run that reviews but never merges is self-explanatory
  # rather than looking like the bot silently lost interest.
  if HOLD_LABEL="$(has_do_not_merge_label)"; then
    if [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
      log "HOLD: could not read this PR's labels — failing closed, so this run will review but will NOT merge."
      # Only shout when it actually cost a merge. A non-allowlisted author was
      # never going to be auto-merged, so a hold changes nothing for them.
      if [ "$automerge_eligible" = "true" ]; then
        annotate error "Auto-merge is failing closed: the do-not-merge label lookup returned an error for PR #${PR_NUMBER}. If this appears on every PR, auto-merge is down repo-wide — see DnD-m3uj3."
      fi
    else
      log "HOLD: PR carries the '${HOLD_LABEL}' label — this run will review but will NOT merge."
    fi
    automerge_eligible=false
  else
    HOLD_LABEL=""
  fi

  # The stacked-base check runs UP FRONT, not only at merge time, because its
  # value is early warning: a child PR needs to be told to rebase BEFORE its base
  # merges and takes it down. Left to merge_pr alone, a PR held for any other
  # reason (red CI, a label, a non-allowlisted author) would never learn its base
  # is a trap until it was already orphaned. Cheap — one cached API call.
  # merge_pr still re-reads live at merge time; this is informational only.
  if HOLD_STACKED_BASE="$(stacked_base_violation)"; then
    if [ "$HOLD_STACKED_BASE" = "$LABEL_LOOKUP_FAILED" ]; then
      log "HOLD: could not read this PR's base ref — failing closed, so this run will review but will NOT merge."
    else
      log "HOLD: PR targets '${HOLD_STACKED_BASE}', not '$(default_branch)' — stacked PRs are unsupported; this run will review but will NOT merge."
      annotate warning "PR #${PR_NUMBER} is stacked on '${HOLD_STACKED_BASE}'. Rebase onto $(default_branch) NOW and declare ordering with 'Depends-on: #<pr>' — when '${HOLD_STACKED_BASE}' merges it is deleted, and GitHub will CLOSE this PR rather than retarget it (DnD-iji9r)."
    fi
    automerge_eligible=false
  else
    HOLD_STACKED_BASE=""
  fi

  log "=== PR Auto-Review Start: #${PR_NUMBER} ==="
  log "Repo: ${REPO}"
  log "Branch: ${PR_HEAD_REF} → ${PR_BASE_REF}"
  log "Author: ${PR_AUTHOR} (auto-merge eligible: ${automerge_eligible})"
  log "LLM chain: ${OPENROUTER_MODEL} → ${OPENROUTER_FALLBACK_MODEL} @ ${OPENROUTER_ENDPOINT}"

  # ── 1. Set up working directory ────────────────────────────────────────
  # The workflow clones the PR branch into WORK_DIR — just cd in and configure.
  log "Setting up working directory at ${WORK_DIR}..."
  if [ ! -d "$WORK_DIR" ]; then
    die "WORK_DIR ${WORK_DIR} does not exist — the checkout step should have created it"
  fi

  cd "$WORK_DIR"
  git config user.name "$BOT_NAME"
  git config user.email "$BOT_EMAIL"

  # Ensure we have the base branch ref for diff/merge operations
  git fetch origin "$PR_BASE_REF" 2>&1 | tail -3 || log "Warning: could not fetch base ref ${PR_BASE_REF} from origin"

  log "Working directory ready: ${WORK_DIR} ($(git rev-parse HEAD))"

  # Does this PR touch anything ci.yml builds/tests? Computed once (a gh call,
  # so only valid after the cd above — DnD-m3uj3) and threaded into every
  # wait_for_ci decision. When "true", the docs-only zero-checks shortcut is
  # forbidden: a code PR whose head SHA has no checks yet is CI-pending, never
  # docs-only, and must not be merged over absent/red CI (DnD-7k9o0).
  local ci_relevant
  ci_relevant="$(pr_touches_ci_paths)"
  log "PR CI-relevance (touches non-docs paths ci.yml builds/tests): ${ci_relevant}"

  # ── 2. Bot-commit short-circuit ────────────────────────────────────────
  # If the latest PR commit is our own fix/sync push, don't re-review — just
  # wait for CI and merge (eligible authors only; that's the only way a bot
  # commit lands on the branch anyway).
  #
  # Keyed on commit MESSAGE, not author name. The author-name approach broke
  # when the user's git identity ("Strickdd Bot") matched BOT_NAME, causing
  # every user PR to skip review entirely. The pipeline's automated commits
  # use exactly two prefixes — check those instead.
  local pr_latest_message
  pr_latest_message="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json commits --jq '.commits[-1].messageHeadline // ""' 2>/dev/null || echo "")"
  log "PR latest commit message: ${pr_latest_message}"
  local is_bot_commit=false
  if [[ "$pr_latest_message" == "fix(auto-review):"* ]] || [[ "$pr_latest_message" == "chore: merge"* ]]; then
    is_bot_commit=true
  fi
  if [ "$is_bot_commit" = "true" ] && [ "$automerge_eligible" = "true" ]; then
    # Poll the LIVE tip, never the event's HEAD_SHA: a re-run of a
    # pull_request-triggered job replays the original payload, so HEAD_SHA
    # can be a stale author commit with green CI while the actual tip is
    # this unverified bot commit — polling HEAD_SHA there re-opens the
    # zero-CI merge hole this fix closes.
    local live_tip
    if ! live_tip="$(resolve_live_tip)"; then
      finish "⚠️ Could not read the live branch tip — not merging without verifying CI on it. Re-run this review." "blocked_infra" 0
    fi
    log "Last commit is from bot — skipping review, waiting on CI for live tip ${live_tip}"
    local ci_exit=0
    # A bot commit at the branch tip was pushed with GITHUB_TOKEN (that is the
    # only way one lands there), so its CI never fires on its own — pass
    # bot_pushed=true so wait_for_ci dispatches it and fails closed on zero checks.
    #
    # No third argument any more: the docs-only grace (return 3) is gone. It
    # excused a missing verdict, which is only safe when a verdict is not
    # guaranteed — and every consumer now publishes an aggregate context on every
    # PR, DnD included since it grew ci-docs-shim.yml.
    wait_for_ci "$live_tip" true || ci_exit=$?
    if [ "$ci_exit" -eq 0 ]; then
      log "CI all green — merging PR #${PR_NUMBER}"
      if merge_pr; then
        merge_sha="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null || echo "$HEAD_SHA")"
        finish "✅ Previous auto-review fixes passed CI. PR merged." "merged" 0 "$merge_sha"
      else
        finish "⚠️ CI passed but the merge was refused after ${MERGE_ATTEMPTS_MADE} merge attempt(s). $(merge_error_block)
See the run log's \`Mergeability:\` and \`MERGE\` lines for the full sequence; a re-review will retry." "blocked" 0
      fi
    elif [ "$ci_exit" -eq 1 ]; then
      finish "$(failed_ci_message "after the auto-review fixes")" "blocked" 0
    elif [ "$ci_exit" -eq 4 ]; then
      finish "🚨 CI never started for the bot-pushed SHA even after an explicit workflow dispatch — failing closed, not merging. Most likely cause: this branch was cut before ci.yml gained its workflow_dispatch trigger, so the dispatch 422s — merge main into the branch and re-review. Otherwise check the Actions runners, then re-run this review." "blocked_infra" 0
    elif [ "$ci_exit" -eq 5 ]; then
      finish "$(unresolved_ci_message)" "blocked" 0
    elif [ "$ci_exit" -eq 6 ]; then
      finish "$(missing_required_message)" "blocked" 0
    else
      finish "⏰ CI polling timed out after ${POLL_TIMEOUT}s. Manual check recommended." "blocked_infra" 0
    fi
  fi

  # ── 3. Sync with base branch (eligible authors only) ──────────────────
  # Merge (not rebase): a rebase rewrites the PR's commits and cannot be
  # pushed back without force, which we never do on shared branches.
  local synced_with_base=false
  if [ "$automerge_eligible" = "true" ]; then
    local behind_count
    behind_count="$(git rev-list --count "HEAD..origin/${PR_BASE_REF}" 2>/dev/null || echo 0)"
    if [ "$behind_count" -gt 0 ] && migration_journal_collision; then
      log "Both this branch and ${PR_BASE_REF} changed src/drizzle/meta/_journal.json — refusing to auto-merge"
      finish "⚠️ Both this branch and \`${PR_BASE_REF}\` changed \`src/drizzle/meta/_journal.json\`. A migration-number collision is not something a text merge can settle — resolving it either way silently DROPS one side's migration, and every gate stays green until the deploy fails with \`no such column\` (DnD-pk3ex). Resolve by hand: keep \`${PR_BASE_REF}\`'s file, snapshot and journal entry at the contested number, then regenerate this branch's migration at the next free number (\`npx drizzle-kit generate\`)." "blocked" 0
    fi
    if [ "$behind_count" -gt 0 ]; then
      log "Branch is ${behind_count} commits behind ${PR_BASE_REF} — merging it in..."
      if git merge "origin/${PR_BASE_REF}" -m "chore: merge ${PR_BASE_REF} into ${PR_HEAD_REF} (auto-review sync)" 2>&1; then
        synced_with_base=true
        log "Merge successful"
      else
        git merge --abort 2>/dev/null || true
        finish "⚠️ Merge conflicts with \`${PR_BASE_REF}\` — manual conflict resolution needed." "blocked" 0
      fi
    else
      log "Branch is up to date with ${PR_BASE_REF}"
    fi
  fi

  # ── 4. Read the review prompt ──────────────────────────────────────────
  if [ -f "$PROMPT_FILE" ]; then
    SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"
    log "Loaded review prompt from ${PROMPT_FILE}"
  else
    SYSTEM_PROMPT="You are an expert TypeScript/Next.js code reviewer. Review the PR diff, find issues, and provide fixes as a JSON object with a 'fixes' array. Each fix has: path, old_string, new_string, description."
    log "No prompt file found — using default prompt"
  fi

  # ── 5. Converge loop: review → fix → check ────────────────────────────
  local review_failed=false
  local infra_failed=false
  while [ "$iterations" -lt "$MAX_ITERATIONS" ]; do
    iterations=$((iterations + 1))
    log "=== Review iteration ${iterations}/${MAX_ITERATIONS} ==="

    # Get the diff
    local diff_content
    if [ "$iterations" -eq 1 ]; then
      diff_content="$(git diff "origin/${PR_BASE_REF}...HEAD" 2>/dev/null || true)"
    else
      # Re-review the PR diff plus the still-uncommitted fixes from the
      # previous iteration. (HEAD~1..HEAD would diff the sync merge's
      # mainline side — code from the base branch that is not ours to review.)
      diff_content="$(git diff "origin/${PR_BASE_REF}...HEAD" 2>/dev/null || true)
$(git diff HEAD 2>/dev/null || true)"
    fi

    if [ -z "$diff_content" ]; then
      log "No diff to review"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"no_changes"}]' 2>/dev/null || echo '[{"check":"review","result":"no_changes"}]')"
      break
    fi

    # Limit diff size to avoid token overflow. Herestring, NOT a pipe:
    # `echo big-diff | head` dies of SIGPIPE under pipefail once head exits.
    local diff_truncated
    diff_truncated="$(head -n "$MAX_DIFF_LINES" <<< "$diff_content")"

    log "Calling LLM (diff: $(wc -l <<< "$diff_truncated") lines)..."
    # Include full file content for changed files so the LLM can generate accurate patches
    local file_context=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if [ -f "$f" ]; then
        local file_size
        file_size=$(wc -l < "$f" 2>/dev/null || echo "0")
        if [ "$file_size" -le 300 ]; then
          file_context="${file_context}

### FILE: ${f}
$(cat "$f")"
        else
          file_context="${file_context}

### FILE: ${f} (${file_size} lines, showing first 300):
$(head -300 "$f")"
        fi
      fi
    done < <(git diff --name-only "origin/${PR_BASE_REF}...HEAD" 2>/dev/null | head -10)

    local user_content
    user_content="PR Title: ${PR_TITLE}

PR Description:
${PR_BODY:-none}

Files changed:
$(git diff --stat "origin/${PR_BASE_REF}...HEAD" 2>/dev/null || true)

Current file contents:
${file_context}

Diff:
${diff_truncated}"

    if [ -n "$qg_failure_context" ]; then
      user_content="${user_content}

The previous fix attempt failed these quality gates — fix the failures:
${qg_failure_context}"
    fi

    if ! review_llm "$SYSTEM_PROMPT" "$user_content"; then
      log "NO REVIEWER WAS REACHABLE — every LLM tier failed. This PR was NOT assessed."
      log "  Nothing above is a judgement about this PR's contents (DnD-xqpyv)."
      log "  Retrigger once the provider is healthy: gh pr ready ${PR_NUMBER} --undo && gh pr ready ${PR_NUMBER}"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"llm","result":"all_tiers_failed"}]' 2>/dev/null || true)"
      review_failed=true
      break
    fi

    local json_fixes
    json_fixes="$(cat "$FIXES_FILE")"
    if [ "$iterations" -eq 1 ]; then
      review_summary="$(echo "$json_fixes" | jq -r '.summary // empty' 2>/dev/null || true)"
    fi

    local fix_count=0
    local has_fixes
    has_fixes="$(echo "$json_fixes" | jq -r '.fixes | length' 2>/dev/null || echo "0")"

    if [ "$has_fixes" -eq 0 ]; then
      log "Review complete — no fixes needed"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"no_fixes_needed"}]' 2>/dev/null || echo '[{"check":"review","result":"no_fixes_needed"}]')"
      break
    fi

    # Comment-only mode when fixes won't be applied: report findings, never
    # touch the author's branch. The causes are a blocking label, a stacked-base
    # violation, either guard's fail-closed lookup failure, a non-allowlisted
    # author, or a free/unidentified LLM tier (DnD-8fbkq). fix_skip_reason()
    # distinguishes them so the message is honest — reporting the wrong one is a
    # false statement about the author that sends triage the wrong way
    # (DnD-s0w3l).
    if ! review_may_apply_fixes "$automerge_eligible"; then
      local skip_reason
      skip_reason="$(fix_skip_reason)"
      log "Not applying ${has_fixes} suggested fix(es) — ${skip_reason}"
      local suggestions
      suggestions="$(echo "$json_fixes" | jq -r '.fixes[] | "- **\(.path)** — \(.description)"' 2>/dev/null || echo "- (could not render suggestions)")"
      summary="${review_summary:-Review complete.}

**${has_fixes} suggested fix(es)** (not applied — ${skip_reason}):

${suggestions}"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"suggestions_only"}]' 2>/dev/null || true)"
      finish "$summary" "commented" "$iterations"
    fi

    fix_count="$(apply_fixes "$json_fixes")"
    log "Applied ${fix_count} fixes"

    if [ "$fix_count" -eq 0 ]; then
      log "No fixes could be applied — breaking converge loop"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"no_fixes_applied"}]' 2>/dev/null || echo '[{"check":"review","result":"no_fixes_applied"}]')"
      break
    fi

    # The review can ask for a dependency install when its fix adds one. The key
    # names are historical (`require_npm_ci`/`require_npm_install`, still emitted
    # by all three repos' prompts) but the ACTION is no longer npm-specific: both
    # mean "make dependencies match the manifest", and the consumer's hook decides
    # how — npm ci, pnpm install --frozen-lockfile, or otherwise.
    local req_install
    req_install="$(echo "$json_fixes" | jq -r '
      if (.require_npm_ci // false) or (.require_npm_install // false)
      then "true" else "false" end' 2>/dev/null || echo "false")"

    if [ "$req_install" = "true" ]; then
      log "Dependency install requested by the review — delegating to the quality-gates hook..."
      run_install_hook || log "  install hook reported a problem; the gates below will surface it"
    fi

    CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"fixes_applied"}]' 2>/dev/null || echo '[{"check":"review","result":"fixes_applied"}]')"

    # Run quality gates. Stdout is the failure dump followed by a final
    # pass/fail status line — split them, or the status compares below can
    # never match "fail" and broken fixes get committed.
    local qg_output
    qg_output="$(run_quality_gates || true)"
    qg_last="$(printf '%s\n' "$qg_output" | tail -n 1)"
    qg_failure_context="$(printf '%s\n' "$qg_output" | sed '$d' | tail -n 60)"
    if [ -n "$qg_failure_context" ]; then
      printf '%s\n' "$qg_failure_context" >&2
    fi

    if [ "$qg_last" = "pass" ]; then
      log "All quality gates passed!"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"gates","result":"pass"}]' 2>/dev/null || true)"
      break
    elif [ "$qg_last" = "infra_fail" ]; then
      # Environmental failure (persistent npm-registry outage), not a code
      # defect and not something a re-review can fix. Do NOT keep iterating and
      # do NOT let this fall through to the "merge original" path — that would
      # merge the PR with the review effectively skipped. Break and block below.
      log "Quality gates could not run — infrastructure failure (registry/network). Blocking, not merging over an unrun review."
      infra_failed=true
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"gates","result":"infra_fail"}]' 2>/dev/null || true)"
      break
    else
      log "Quality gates failed on iteration ${iterations}"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"gates","result":"fail"}]' 2>/dev/null || true)"

      if [ "$iterations" -ge "$MAX_ITERATIONS" ]; then
        log "Max iterations reached — giving up on converge"
      fi
      # Continue to next iteration to try fixing failures
    fi
  done

  # Infra failure short-circuit: the gates never actually evaluated the PR, so
  # we cannot conclude anything. Discard any uncommitted fixes and block (fail
  # safe) — a red check never merges, so the PR waits for a re-review instead of
  # merging unreviewed. This is the fix for the "npm ci flake → discard fixes →
  # merge original" hole (DnD-1sux0). The re-review is NOT automatic since
  # DnD-y6ez1 retired the stranded hand-off, so the PR comment below says so.
  if [ "$infra_failed" = "true" ]; then
    git checkout -- . 2>/dev/null || true
    git clean -fd 2>/dev/null || true
    finish "🚧 Quality gates could not run — the runner hit a persistent registry/network error, so this PR was NOT reviewed. Blocking rather than merging over an unrun review. Push again, or re-run this workflow, to get a review. If it recurs, check the runner's network and package-registry access." "blocked_infra" "$iterations"
  fi

  # Review never completed → block the merge and say so. The sync merge (if
  # any) is intentionally not pushed either; nothing lands without a review.
  if [ "$review_failed" = "true" ]; then
    # Word this for the operator who sees a red X on their branch and has to
    # decide whether their PR is broken. It is not — no reviewer was reachable,
    # so the PR was never assessed at all (DnD-u1eog / DnD-xqpyv).
    finish "🔌 **No reviewer was reachable** — every LLM tier failed (paid + OpenRouter fallbacks), so this PR was **NOT assessed**. This is an upstream provider outage, **not a finding about your changes**: nothing was reviewed, nothing was rejected, and no fixes were applied. The merge is blocked only because nothing lands unreviewed. While the provider is unhealthy this blocks merges repo-wide, not just here. Retrigger when it recovers: \`gh pr ready ${PR_NUMBER} --undo && gh pr ready ${PR_NUMBER}\`. See the run log for the per-tier failure reason — a \`TIMEOUT after Ns\` line means the endpoint never answered." "review_failed" "$iterations"
  fi

  # ── 6. Commit and push fixes / sync merge ──────────────────────────────
  local fixes_committed=false
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    if ! llm_tier_is_paid; then
      # Belt and braces on the gate in section 5 (DnD-8fbkq). That gate is what
      # normally stops a free-tier review reaching apply_fixes at all; this is
      # the last point before anything the reviewer touched leaves the runner,
      # and it fails closed on the same question. Nothing a free or
      # unidentified tier produced is ever committed, so it can never be pushed
      # and can never be merged.
      log "Discarding working-tree changes — the review that produced them ran on the '${LLM_USED_TIER}' tier, which may not auto-apply fixes"
      git checkout -- . 2>/dev/null || true
      git clean -fd 2>/dev/null || true
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"push","result":"fixes_discarded_free_tier"}]' 2>/dev/null || true)"
    elif [ "$qg_last" = "fail" ]; then
      log "Quality gates still failing — discarding non-converged fixes (not pushing broken code)"
      git checkout -- . 2>/dev/null || true
      git clean -fd 2>/dev/null || true
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"push","result":"fixes_discarded_gates_failing"}]' 2>/dev/null || true)"
    else
      log "Committing fixes..."
      git add -A
      git commit -m "fix(auto-review): code review fixes for PR #${PR_NUMBER}

Auto-generated fixes from AI code review using ${LLM_USED_MODEL}."
      fixes_committed=true
    fi
  fi

  local ahead_count
  ahead_count="$(git rev-list --count "origin/${PR_HEAD_REF}..HEAD" 2>/dev/null || echo 0)"

  # Nothing to push but the base-sync merge, and protection does not require an
  # up-to-date head? Then don't push at all (DnD-rufjg). The merge stays in the
  # local tree — the review and the quality gates above already ran against it —
  # and the PR merges from the author's own SHA, whose CI fired naturally. This
  # is exactly the shape that let PR #2637 merge cleanly the moment a human had
  # levelled the branch: with no commits to push, the workflows restriction
  # never fires. It also removes a pointless merge commit from every PR.
  if [ "$ahead_count" -gt 0 ] \
    && [ "$automerge_eligible" = "true" ] \
    && should_skip_base_sync_push "$fixes_committed" "$synced_with_base"; then
    log "Skipping the base-sync push: ${PR_BASE_REF} protection does not require an up-to-date head, and there are no auto-fix commits to land. Keeping the merge locally only."
    CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"push","result":"base_sync_push_skipped"}]' 2>/dev/null || true)"
    ahead_count=0
  fi

  if [ "$ahead_count" -gt 0 ] && [ "$automerge_eligible" = "true" ]; then
    log "Pushing ${ahead_count} commit(s) (fixes and/or base sync) to ${PR_HEAD_REF}..."
    push_review_commits "$iterations"
  fi

  # ── 7. Wait for CI ─────────────────────────────────────────────────────
  # Non-eligible authors in comment-only mode: no fixes were pushed and the
  # review found nothing wrong — just mark the review as passed and exit.
  # We must not wait for CI (that risks cancellation from concurrent branch
  # updates) and must not attempt a merge (comment-only contract).
  if ! $FIXES_PUSHED && [ "$automerge_eligible" != "true" ]; then
    local clean_note="${review_summary:+

**Review notes:** ${review_summary}}"
    finish "✅ Code review passed — no issues found.${clean_note}" "commented" "$iterations"
  fi

  local push_sha
  # Whether the SHA we are about to poll needs an explicit CI dispatch (see
  # wait_for_ci): true when it isn't the author's own event SHA — the only
  # commit whose CI is known to have fired (or been path-filtered) naturally.
  local poll_bot_pushed="$FIXES_PUSHED"
  if $FIXES_PUSHED; then
    push_sha="$(git rev-parse HEAD 2>/dev/null || echo "$HEAD_SHA")"
    log "Verifying push on remote..."
    sleep 5
    local remote_sha
    remote_sha="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")"
    if [ -n "$remote_sha" ]; then
      log "Remote head SHA: ${remote_sha}"
      if [ "$remote_sha" != "$push_sha" ]; then
        # Someone pushed on top of (or past) our commit in the window since
        # the push. Don't adopt their SHA as ours and start dispatching CI at
        # it — their push fires its own synchronize event and a fresh review.
        log "Remote tip moved past our push (concurrent push) — deferring to the new review run"
        finish "⚠️ The branch moved while this review was finishing (concurrent push). The new review run will pick it up." "blocked" "$iterations"
      fi
    fi
  else
    # No push this run — but do NOT assume the tip is the event's HEAD_SHA. A
    # re-run replays the original payload, and a transient failure in the §2
    # bot-commit classifier can land a bot-tipped branch here: polling the
    # stale (green) author SHA would merge the unverified tip. Poll the live
    # tip, fail closed if it cannot be read, and require a dispatch when the
    # tip is not the author's event commit.
    if ! push_sha="$(resolve_live_tip)"; then
      finish "⚠️ Could not read the live branch tip — not merging without verifying CI on it. Re-run this review." "blocked_infra" "$iterations"
    fi
    if [ "$push_sha" != "$HEAD_SHA" ]; then
      log "Nothing pushed this run, but the live tip ${push_sha:0:12} differs from the event SHA ${HEAD_SHA:0:12} — treating it as bot-pushed for CI purposes"
      poll_bot_pushed=true
    else
      log "Nothing pushed — checking CI for original HEAD_SHA: ${push_sha:0:12}"
    fi
  fi

  local review_note="${review_summary:+

**Review notes:** ${review_summary}}"

  # Surface what the review actually did (DnD-pchr6): enumerate applied fixes
  # (with the commit they shipped in) and findings that were silently dropped,
  # instead of a bare "Review complete" that hides the bot's changes.
  local fixes_note=""
  if [ -s "$APPLIED_FIXES_FILE" ]; then
    local applied_count
    applied_count="$(grep -c '^- ' "$APPLIED_FIXES_FILE" 2>/dev/null || echo 0)"
    # qg_last=fail means section 6 reset the tree — the applied fixes were
    # discarded even if a sync-merge commit was still pushed (FIXES_PUSHED).
    if [ "$qg_last" != "fail" ] && $FIXES_PUSHED; then
      fixes_note="

**${applied_count} fix(es) applied and pushed** (\`${push_sha:0:12}\`):

$(cat "$APPLIED_FIXES_FILE")"
    else
      fixes_note="

**${applied_count} fix(es) were applied locally but discarded** (quality gates did not converge after ${MAX_ITERATIONS} iterations) — these findings may still need manual attention:

$(cat "$APPLIED_FIXES_FILE")"
    fi
  fi
  if [ -s "$DROPPED_FIXES_FILE" ]; then
    local dropped_count
    dropped_count="$(grep -c '^- ' "$DROPPED_FIXES_FILE" 2>/dev/null || echo 0)"
    fixes_note="${fixes_note}

**${dropped_count} finding(s) could not be auto-applied:**

$(cat "$DROPPED_FIXES_FILE")"
  fi
  review_note="${review_note}${fixes_note}"

  log "Checking CI status..."
  local ci_exit=0
  # poll_bot_pushed means $push_sha did not come from the author's own push — its
  # CI never fires naturally, so wait_for_ci must dispatch it. Persistent zero
  # checks are now a fault on EITHER path: the docs-only grace that used to excuse
  # them for an author's own SHA is gone with return 3.
  wait_for_ci "$push_sha" "$poll_bot_pushed" || ci_exit=$?
  if [ "$ci_exit" -eq 0 ]; then
    if [ "$qg_last" = "fail" ]; then
      # Gates failed locally but CI is green on the un-fixed SHA — the LLM's
      # fixes were the problem, not the PR. Merge the PR as-is.
      log "Local converge failed but CI is green on PR head — merging original code"
    fi
    log "CI all green — merging PR #${PR_NUMBER}"
    if merge_pr; then
      merge_sha="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null || echo "$push_sha")"
      finish "✅ Review complete, CI green. PR merged.${review_note}" "merged" "$iterations" "$merge_sha"
    else
      finish "⚠️ CI passed but the merge was refused after ${MERGE_ATTEMPTS_MADE} merge attempt(s). $(merge_error_block)
See the run log's \`Mergeability:\` and \`MERGE\` lines for the full sequence; a re-review will retry.${review_note}" "blocked" "$iterations"
    fi
  elif [ "$ci_exit" -eq 1 ]; then
    finish "$(failed_ci_message)${review_note}" "blocked" "$iterations"
  elif [ "$ci_exit" -eq 4 ]; then
    finish "🚨 CI never started for the bot-pushed SHA even after an explicit workflow dispatch — failing closed, not merging. Most likely cause: this branch was cut before ci.yml gained its workflow_dispatch trigger, so the dispatch 422s — merge main into the branch and re-review. Otherwise check the Actions runners, then re-run this review.${review_note}" "blocked_infra" "$iterations"
  elif [ "$ci_exit" -eq 5 ]; then
    finish "$(unresolved_ci_message)${review_note}" "blocked" "$iterations"
  elif [ "$ci_exit" -eq 6 ]; then
    finish "$(missing_required_message)${review_note}" "blocked" "$iterations"
  else
    finish "⏰ CI check polling timed out after ${POLL_TIMEOUT}s. Manual check recommended.${review_note}" "blocked_infra" "$iterations"
  fi
}

# Library mode (adopted from promptci-cloud).
#
# Sourcing this file to test ONE function must not start a review. Every
# behavioural test in tests/engine/ depends on this guard: without it the only
# way to exercise a function is to strip `main "$@"` with a regex first, which
# is what DnD's and PromptCI's suites do today — a transformation that can
# silently stop matching and leave the tests running against a mutated script.
#
# A guard rather than a bare `return`: `return` at top level is an error in a
# file that is EXECUTED, and this file must keep working normally when it is.
#
# NOTE what this does NOT do: the script runs under `set -u` and reads its
# required inputs (PR_NUMBER and friends) at source time, so a caller must still
# export those before sourcing. Library mode suppresses the REVIEW, not the
# preamble. tests/harness/ exports a fixture set for exactly this reason.
if [ "${PR_REVIEW_LIBRARY_MODE:-0}" != "1" ]; then
  main "$@"
fi
