# `check-ci-status.legacy.sh`

DnD's 198-line inline-jq `check_ci_status()`, extracted verbatim from the seed
commit (`8f06dea`, byte-identical to `SeriousGeese/DnD` at `a802e8f3`).

It exists for exactly one reason: `check-ci-status-equivalence.test.ts` runs it
and the replacement side by side over the same fixtures and asserts they agree.
That function decides whether a PR merges, and both implementations encode years
of separately-learned incidents, so "the new one looks right" is not a standard
worth swapping on.

**This file is not part of the engine and nothing sources it at runtime.** Once
the equivalence test has been green across a full adoption cycle (Stage 5), it
and its test can go — the field-level assertions in the ported `wait_for_ci`
suite subsume them.
