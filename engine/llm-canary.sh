#!/usr/bin/env bash
# Daily paid-tier canary (pcic-ndyi).
#
# On 2026-11-14 the paid review tier stopped answering from about 06:55Z and
# every PR review that night fell back to the free tier, which may not issue a
# verdict. Nobody knew until the PRs piled up. This makes ONE tiny call to the
# paid tier, through the engine's own call_llm (same endpoint, same model, same
# credential handling: the key never reaches argv or a log), and says whether
# the tier answers. A consumer schedules it daily and opens an alert issue on a
# failure, so an outage is known before a night of PRs.
#
# Env:   OPENROUTER_API_KEY, OPENROUTER_MODEL     (required)
#        OPENROUTER_ENDPOINT                      (optional, engine default)
#        CANARY_MAX_TIME   seconds, default 60    (a canary should be quick)
#        CANARY_MAX_TOKENS default 256            (room for a reasoning model)
# Out:   one line on stdout: "CANARY OK: ..." or "CANARY FAILED: <reason>".
#        With GITHUB_OUTPUT set, also result=ok|failed|misconfigured and reason=.
# Exit:  0 the paid tier answered, 1 it did not, 2 misconfigured (no key/model).
#
# A 200 whose content is empty still counts as OK: the key, the credits and the
# model all worked, and a reasoning model can spend a small budget thinking.
# Cost: one request of a few dozen prompt tokens and at most CANARY_MAX_TOKENS.
set -euo pipefail

CANARY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

emit() {
  local result="$1" reason="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "result=${result}"; echo "reason=${reason}"; } >> "$GITHUB_OUTPUT" 2>/dev/null || true
  fi
}

if [ -z "${OPENROUTER_API_KEY:-}" ] || [ -z "${OPENROUTER_MODEL:-}" ]; then
  reason="OPENROUTER_API_KEY or OPENROUTER_MODEL is not set"
  echo "CANARY MISCONFIGURED: ${reason}"
  emit misconfigured "$reason"
  exit 2
fi

# The engine reads its PR inputs at source time even in library mode; the
# canary has no PR, so it supplies inert values. AUTOMERGE_AUTHORS is empty and
# nothing but call_llm runs.
canary_work="$(mktemp -d)"
export PR_REVIEW_LIBRARY_MODE=1 PR_NUMBER=0 PR_HEAD_REF=canary PR_BASE_REF=canary PR_AUTHOR=canary
export REPO="${GITHUB_REPOSITORY:-canary/canary}" WORK_DIR="$canary_work" GH_TOKEN="${GH_TOKEN:-unused}"
export AUTOMERGE_AUTHORS=''
export PR_REVIEW_LLM_MAX_TIME="${CANARY_MAX_TIME:-60}"
# shellcheck source=pr-review.sh
source "$CANARY_DIR/pr-review.sh"

canary_rc=0
call_llm "$OPENROUTER_ENDPOINT" "$OPENROUTER_MODEL" "$OPENROUTER_API_KEY" \
  "You are a health check. Answer with one word." "Reply with the single word OK." \
  false "${CANARY_MAX_TOKENS:-256}" > /dev/null || canary_rc=$?

if [ "$canary_rc" -eq 0 ] || [[ "${LLM_LAST_FAILURE:-}" == "HTTP 200"* ]]; then
  reason="provider openrouter, model ${OPENROUTER_MODEL} answered"
  echo "CANARY OK: ${reason}"
  emit ok "$reason"
  exit 0
fi

record_paid_failure openrouter "$OPENROUTER_MODEL" 2>/dev/null
echo "CANARY FAILED: ${LLM_PAID_FAILURE}"
emit failed "$LLM_PAID_FAILURE"
exit 1
