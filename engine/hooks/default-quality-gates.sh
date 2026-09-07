#!/usr/bin/env bash
# Fallback quality-gates hook.
#
# A consumer repo supplies its own at `.cicd/quality-gates.sh`, taken from the PR
# HEAD rather than from this repo — it is product code, and a PR that changes the
# build must be reviewable as part of that PR. This file only runs when a repo has
# not supplied one, and exists so CICD's own tests can exercise run_quality_gates()
# without a consumer present.
#
# Contract (both verbs):
#   install   0 = installed | 1 = real failure (e.g. lockfile drift) | 2 = network/infra
#   run       0 = all gates pass | 1 = a gate failed | 2 = infra
#             on 1, failure context goes to STDOUT — the engine feeds it back to
#             the LLM as the next iteration's input, so it must be the compiler's
#             or test runner's own words, not a summary of them.
#
# `2` is not a nicety. It is how a persistent registry outage is prevented from
# looking like a code defect: the engine BLOCKS on infra_fail rather than merging
# a PR whose review never actually ran.
set -uo pipefail

verb="${1:-run}"
case "$verb" in
  install)
    echo "default-quality-gates: no .cicd/quality-gates.sh in this repo; nothing to install." >&2
    exit 0
    ;;
  run)
    echo "default-quality-gates: no .cicd/quality-gates.sh in this repo; no gates to run." >&2
    exit 0
    ;;
  *)
    echo "default-quality-gates: unknown verb '${verb}' (expected: install|run)" >&2
    exit 1
    ;;
esac
