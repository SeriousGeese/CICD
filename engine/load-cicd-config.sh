#!/usr/bin/env bash
# Read a consumer's `.cicd/config.env` and emit the settings that should take
# effect, as `KEY=VALUE` lines on stdout. The caller decides what to do with
# them (the pr-review action exports them and appends them to $GITHUB_ENV).
#
# This was inline in actions/pr-review/action.yml. It is a file, and a tested
# one, because it decides which knobs on the PR-merge gate are live — and the
# inline version got that wrong in two ways that no run would ever have
# reported:
#
# 1. KEY NAMES CONTAIN DIGITS. The filter was `CICD_[A-Z_]+=`, which does not
#    match `CICD_FEATURE_E2E_GATE` — the single flag with a digit in its name.
#    A repo turning its e2e gate on would have been ignored, with nothing in
#    the log, because a key that never matches is a key nothing knows to
#    mention. promptci-cloud is the repo that needs that flag, so the bug was
#    aimed squarely at Stage 4.
#
# 2. AN INPUT WITH A DEFAULT IS ALWAYS "PASSED EXPLICITLY". The rule is that an
#    explicit input beats the file, implemented as "skip any key already set in
#    the environment". But the action declares `strict-skipped` with
#    `default: 'false'`, so CICD_STRICT_SKIPPED is *never* unset and the file
#    could never turn it on. Precedence still belongs to the caller; the action
#    now defaults that input to empty so "unset" means unset.
#
# VALUES ARE DATA, NEVER CODE. This file arrives from a consumer repo and is
# parsed, not `source`d — `source` would hand whoever can write it arbitrary
# execution inside the reviewer that decides whether their PR merges. For the
# same reason the caller reads it from the BASE commit rather than the PR head.
#
# Usage: load-cicd-config.sh <path>     ("-" reads stdin)
# Exit:  0 always for a readable file (an absent or empty file is not an error —
#        it means "defaults"), 2 for a usage error.
set -uo pipefail

# Names must match this exactly. Anchored at both ends so `CICD_X=1 rm -rf /`
# cannot smuggle a second token through as part of the key.
CICD_KEY_RE='^CICD_[A-Z0-9_]+$'

usage() {
  echo "usage: load-cicd-config.sh <path|->" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
src="$1"

if [ "$src" = "-" ]; then
  content="$(cat)"
elif [ -f "$src" ]; then
  content="$(cat "$src")"
else
  exit 0   # no config file: defaults, not a failure
fi

while IFS= read -r line; do
  # Strip a leading indent and anything from an unquoted `#` onward, then
  # trailing whitespace. Comments are stripped BEFORE the value is read so a
  # trailing `# why` note never lands inside the value.
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "$line" ] || continue

  case "$line" in
    *=*) ;;
    *) continue ;;
  esac

  key="${line%%=*}"
  value="${line#*=}"

  # `export KEY=value` is what a reader expects an .env to accept; honour it
  # rather than dropping the line as malformed.
  case "$key" in
    export\ *) key="${key#export }" ;;
  esac
  key="${key%"${key##*[![:space:]]}"}"
  key="${key#"${key%%[![:space:]]*}"}"

  [[ "$key" =~ $CICD_KEY_RE ]] || continue

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  # One layer of matching quotes, so `CICD_X="a b"` and `CICD_X='a b'` both work.
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac

  # Already set in the environment = passed explicitly by the caller, which wins.
  if [ -n "${!key:-}" ]; then
    echo "  ${key}: already set by the caller, keeping that" >&2
    continue
  fi

  # A newline in a value would forge a second GITHUB_ENV assignment. There is no
  # legitimate multi-line CICD_* value, so refuse rather than sanitize.
  case "$value" in
    *$'\n'*) echo "  ${key}: rejected, value contains a newline" >&2; continue ;;
  esac

  printf '%s=%s\n' "$key" "$value"
done <<< "$content"
