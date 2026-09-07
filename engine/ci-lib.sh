#!/usr/bin/env bash
# Shared CI-status helpers: the two shell-side seams around scripts/ci-status.jq.
#
# Extracted into its own file (rather than living inline in pr-review.sh) for
# the same reason sanitize-secret.sh was: a bash function is not otherwise
# reachable from Node, so a testable seam has to be a file. This one is both
# SOURCEABLE (pr-review.sh and any future workflow script source it for the
# functions) and DIRECTLY INVOCABLE as a CLI, via the BASH_SOURCE guard at the
# bottom, which is how scripts/ci-lib.test.mjs exercises it.
#
# Deliberately does NOT `set -euo pipefail`: sourcing a file must not change
# the shell options of the script that sourced it. pr-review.sh already sets
# them, and every command below handles its own exit status explicitly.

CI_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolved from THIS file's own location rather than the caller's $SCRIPT_DIR.
# ci-status.jq always ships beside ci-lib.sh, so own-dir is correct in every
# context — sourced into pr-review.sh (where it resolves to the identical
# path), sourced from a test harness, or run as a CLI. Overridable for tests
# that need to point the same shell code at a mutated copy of the program.
CI_STATUS_JQ="${CI_STATUS_JQ:-${CI_LIB_DIR}/ci-status.jq}"

# The api_failed sentinel. api_failed distinguishes "the API told us there are
# zero checks" from "we could not ask" — the latter must never count toward the
# zero-checks grace, or a minute of GitHub flakiness reads as a mergeable
# docs-only PR.
#
# It carries EVERY key ci-status.jq can emit, not just the subset pr-review.sh
# reads today. A caller doing `jq -r '.unresolved'` on a narrower sentinel gets
# the string "null", and the numeric test `[ "$n" -gt 0 ]` on that is a syntax
# error that kills the script under `set -e` — a failed poll would abort the
# review instead of retrying. Keep this in sync with the jq program's output
# object; ci-lib.test.mjs asserts the two key sets match exactly, so adding a
# field there without adding it here fails the suite.
CI_STATUS_API_FAILED='{"total":0,"completed":0,"success":0,"failures":0,"failure_names":"","failure_suites":[],"neutral":0,"skipped":0,"unresolved":0,"unresolved_names":"","required_missing":[],"required_not_passing":[],"all_completed":false,"all_success":false,"pending":"","api_failed":true}'

# pr-review.sh defines its own log() (prefixed `[pr-review]`), but it does so
# AFTER the point where library files get sourced. Defining ours only when the
# name is unbound means: standalone use gets a working logger, and a later
# definition by the sourcing script wins — neither clobbers the other.
if ! declare -F log >/dev/null 2>&1; then
  log() { echo >&2 "[ci-lib] $*"; }
fi

# required_contexts [base_ref]
#
# Prints a JSON array of the required status check CONTEXTS that branch
# protection enforces on $base_ref, e.g. ["gate"].
#
# Reads the repository RULESET endpoint (repos/{owner}/{repo}/rules/branches/
# {branch}), not the legacy branch-protection endpoint: rulesets are what this
# repo actually configures, and the ruleset endpoint is readable with the
# workflow's default token where branch protection often is not.
#
# FAILS OPEN TO A FALLBACK, LOUDLY. An API error and an EMPTY result are
# treated the same on purpose. An empty array is not evidence that nothing is
# required — it is equally the shape of a token without the scope to see the
# ruleset, or of a base branch name that does not match any ruleset target. If
# an empty result were taken at face value, every `skipped` check would count
# as a pass and required_missing could never fire, which is exactly the
# fail-open the required-context plumbing exists to prevent. So fall back to
# $REQUIRED_CHECKS_FALLBACK (default "gate") and say so in the log, rather than
# silently degrading to "nothing is required".
required_contexts() {
  local base="${1:-${PR_BASE_REF:-main}}"
  local raw="" parsed="" rc=0

  raw="$("${GH_CLI:-gh}" api "repos/${REPO:-}/rules/branches/${base}" 2>&1)" || rc=$?

  if [ "$rc" -eq 0 ] && [ -n "$raw" ]; then
    parsed="$(printf '%s' "$raw" | jq -c '
      [.[]
       | select(.type == "required_status_checks")
       | .parameters.required_status_checks[].context]
      | unique
    ' 2>/dev/null)" || parsed=""
  fi

  if [ -n "$parsed" ] && [ "$parsed" != "[]" ] && [ "$parsed" != "null" ]; then
    printf '%s\n' "$parsed"
    return 0
  fi

  log "  required contexts unavailable for ${REPO:-?}@${base} (gh exit=${rc}) — falling back to REQUIRED_CHECKS_FALLBACK='${REQUIRED_CHECKS_FALLBACK:-gate}'"
  printf '%s' "${REQUIRED_CHECKS_FALLBACK:-gate}" | jq -R -c '
    split(",")
    | map(gsub("^\\s+|\\s+$"; ""))
    | map(select(length > 0))
    | unique
  '
}

# ci_status_json <sha> [superseded_json] [required_json]
#
# Prints the verdict object described in scripts/ci-status.jq, or the
# api_failed sentinel if gh or jq failed.
#
# --paginate with per_page=100 is load-bearing, not tidiness. `gh api` defaults
# to 30 results per page and returns ONE page, so a SHA carrying more than 30
# check runs silently loses the rest — and a lost check run is indistinguishable
# from a check run that does not exist, i.e. it reads as green. Superseded
# generations make that ceiling far easier to hit than the number of workflows
# suggests. The jq program is invoked with -s precisely because --paginate
# hands over a stream of page objects rather than one merged document.
ci_status_json() {
  local sha="${1:-}"
  local superseded="${2:-[]}"
  local required="${3:-[]}"
  # Treat ANY skipped check as unresolved, not just a skipped REQUIRED one.
  # Defaults off (the precise rule). See $strict_skipped in ci-status.jq.
  local strict_skipped="${4:-${CICD_STRICT_SKIPPED:-false}}"
  case "$strict_skipped" in 1|true) strict_skipped=true ;; *) strict_skipped=false ;; esac
  local raw="" parsed="" rc=0 jq_rc=0

  raw="$("${GH_CLI:-gh}" api --paginate "repos/${REPO:-}/commits/${sha}/check-runs?per_page=100" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$raw" ]; then
    log "  CI API call failed (exit=${rc})"
    log "  Response: $(printf '%s' "$raw" | head -c 200)"
    printf '%s\n' "$CI_STATUS_API_FAILED"
    return 0
  fi

  parsed="$(printf '%s' "$raw" | jq -s \
    --argjson superseded "$superseded" \
    --argjson required "$required" \
    --argjson strict_skipped "$strict_skipped" \
    -f "$CI_STATUS_JQ" 2>&1)" || jq_rc=$?
  if [ "$jq_rc" -ne 0 ] || [ -z "$parsed" ]; then
    log "  check-runs jq parse FAILED (exit=${jq_rc}): $(printf '%s' "$parsed" | head -c 200)"
    printf '%s\n' "$CI_STATUS_API_FAILED"
    return 0
  fi

  printf '%s\n' "$parsed"
}

# CLI entry point for testing: `bash scripts/ci-lib.sh required_contexts main`
# or `bash scripts/ci-lib.sh ci_status_json <sha> '[]' '["gate"]'`. When sourced
# (the pr-review.sh usage) this block does not run.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  __ci_lib_cmd="${1:-}"
  shift || true
  case "$__ci_lib_cmd" in
    required_contexts) required_contexts "$@" ;;
    ci_status_json) ci_status_json "$@" ;;
    *)
      echo "usage: ci-lib.sh {required_contexts [base]|ci_status_json <sha> [superseded] [required]}" >&2
      exit 2
      ;;
  esac
fi
