#!/usr/bin/env bash
# Strips CR, LF, tab and leading/trailing whitespace from a secret pulled out
# of the environment.
#
# GitHub Actions repository secrets can end up carrying a trailing newline —
# pasted from a file, copied out of a UI that appends one, etc. curl silently
# DROPS an HTTP header whose value contains a line break instead of erroring,
# so a call built as `-H "Authorization: Bearer ${key}"` goes out with NO
# Authorization header at all. The API then reports "missing", not "invalid",
# which is exactly the trap: the caller's own `[ -n "$key" ]` guard sees a
# non-empty variable and proceeds, because the guard never looked past
# emptiness. Sanitizing at ingest closes that gap — and a key that turns out
# to be whitespace-only after stripping normalizes to "", so the existing
# "skipped — not set" branch fires honestly instead of sending a broken header.
#
# Extracted into its own file (rather than living inline in pr-review.sh) so
# it is a testable seam: pr-review.sh sources this for the `sanitize_secret`
# function, and the vitest spec (pr-review-sanitize-secret.test.mjs) exercises
# it by invoking this file directly as a CLI (see the BASH_SOURCE check below)
# since a bash function isn't otherwise reachable from Node.
sanitize_secret() {
  local value="${1-}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  value="${value//$'\t'/}"
  # Trim any remaining leading/trailing plain-space runs (the well-known
  # parameter-expansion trim idiom). If $value is now all-whitespace this
  # correctly collapses to "".
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# CLI entry point for testing: `bash scripts/sanitize-secret.sh 'raw value'`
# prints the sanitized value on stdout. When sourced (the pr-review.sh usage),
# this block does not run.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  sanitize_secret "${1-}"
fi
