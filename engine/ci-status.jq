# Reduce a commit's check runs to a single CI verdict object.
#
# Invoked as:
#   gh api --paginate "repos/$REPO/commits/$SHA/check-runs?per_page=100" \
#     | jq -s --argjson superseded '[]' --argjson required '["gate"]' \
#         -f scripts/ci-status.jq
#
# `-s` (slurp) because `gh --paginate` emits a STREAM of page objects, one per
# page, not a single merged document. A single-page response slurps to a
# one-element array just the same, so the same program handles both.
#
# NO ALTERNATIVE OPERATORS (the two-slash `alternative` form) ANYWHERE IN THIS
# FILE. jq accepts one as an object-construction value only from 1.8.0 on; jq
# 1.7.1 — what ubuntu-latest ships — treats `total: (...) alternative 0` as a
# SYNTAX error, so the whole program fails to COMPILE and every field is lost
# at once. The caller then falls back to its api_failed sentinel on every
# single poll, which reads as "GitHub is down" forever. Guards of that shape
# were dead weight anyway (`length` yields a number, `and` yields a boolean —
# neither can be null or false-y), so use `if ... then ... else ... end` where
# a genuine null needs handling and nothing at all elsewhere.
#
# ── WHY THE group_by/max_by REDUCTION EXISTS (ported from DnD-78zah) ─────────
#
# One head SHA can carry SEVERAL check runs of the SAME name, from different
# generations of the same workflow. In this repo the reliable producer is
# `.github/workflows/auto-merge.yml`: it has `cancel-in-progress: true` and
# fires on every label and synchronize event, so labelling a PR twice in quick
# succession leaves two `auto-merge` runs `completed/cancelled` and a third
# `completed/success` — all three attached to the same SHA.
#
# CONFIRMED on PR #155, head 98a70d4: `auto-merge` appears as
#   101508518115 completed/cancelled   (suite 92230698661)
#   101508521301 completed/cancelled   (suite 92230700324)
#   101508523940 completed/success     (suite 92230701261)
# Counting all three makes the two cancels permanently un-resolvable: a cancel
# is not a `failure` (so it never trips a fail-fast branch) and it is not
# `success`/`neutral` (so `all_success` can never become true). On a SHA of
# that shape with otherwise-green CI the poller yields
# `all_completed=true, failures=0, all_success=false` and falsely blocks the
# merge. #155 only escaped because its `ci` check genuinely failed first.
#
# So reduce to the MOST RECENT run per NAME before computing anything. This is
# not a local convenience — it is the semantics GitHub's own merge gating uses:
# the last check run of a given name is the verdict.
#
# RECENCY KEY = `.id`, deliberately, not a timestamp:
#   * `.id` is a monotonically increasing integer assigned at check-run
#     CREATION and is never null, so the newer generation always wins;
#   * `.completed_at` is null for the very run we must prefer (the fresh one is
#     still in progress while its cancelled predecessor is completed) — it
#     would rank the superseded run highest, i.e. exactly backwards;
#   * `.started_at` is second-resolution and a re-trigger lands in the same
#     second often enough to tie, and a tie silently picks the wrong
#     generation with no way to tell from the outside.
#
# ── $superseded (ported from DnD-wbds2) ─────────────────────────────────────
#
# A second key, for the case the name-based reduction cannot reach: a workflow
# run cancelled BEFORE its matrix expanded publishes a check run under a name
# no later generation ever republishes, so `group_by(.name)` finds no successor
# to prefer. $superseded carries the check-suite ids of workflow runs that a
# LATER successful run of the same workflow superseded. Runs in those suites
# are dropped ONLY when they are terminal with no verdict — a failure, a
# success and anything still running are all left untouched, so this can never
# turn a red into a green. It is applied BEFORE the group_by so a same-named
# survivor from the newer generation still wins normally. On the ordinary poll
# $superseded is `[]` and this filter costs nothing.
#
# ── $required ───────────────────────────────────────────────────────────────
#
# The branch-protection required status check contexts (see required_contexts()
# in ci-lib.sh). Two things turn on it:
#   * a `skipped` check is a PASS unless it is required, in which case it is a
#     terminal non-verdict — GitHub will not merge on a skipped required
#     context, so neither may we;
#   * a required context with NO check run at all is `required_missing`, which
#     is a hard block. "Zero runs for a required gate" is the shape of a
#     workflow that never registered, not of a green PR.
[.[] | if .check_runs then .check_runs[] else empty end]

# The bot must never wait on itself. Matches how pr-review.sh has always
# excluded its own check run, by name prefix.
| map(select(.name | startswith("🤖 Auto-Review") | not))

| map(select(
    . as $c
    | ($superseded | index($c.check_suite.id)) == null
      or $c.status != "completed"
      or $c.conclusion == "success"
      or $c.conclusion == "neutral"
      or $c.conclusion == "failure"
  ))

| group_by(.name)
| map(max_by(.id))

| . as $runs

# TERMINAL BUT UNRESOLVED. A check that FINISHED with a conclusion that is
# neither a pass (success/neutral) nor a fail (failure): cancelled, timed_out,
# stale, action_required — and `skipped` only when the name is required. The
# reduction above already dropped any such run that a later run of the SAME
# NAME superseded, so whatever survives here has no successor and will never
# change again. `failures` deliberately excludes these: a cancel is not a
# verdict, and treating it as one would report a red PR that nothing failed on.
#
# `. as $r` is not decoration: inside `$required | index(...)` the input to
# `index` is the ARRAY, so a bare `.name` there would index an array with a
# string and abort the whole program at runtime. Bind the run first.
| ([$runs[] | select(
      . as $r
      | $r.status == "completed"
      and $r.conclusion != "success"
      and $r.conclusion != "neutral"
      and $r.conclusion != "failure"
      and (
        # A `skipped` check is a PASS unless it is a REQUIRED context, in which
        # case GitHub will not merge on it and it is a terminal non-verdict.
        #
        # $strict_skipped restores the blunter rule DnD's inline implementation
        # used: ANY skipped check is unresolved, required or not. That rule is
        # cruder, but it is safe when $required is empty — and $required comes
        # from required_contexts(), which FAILS OPEN to a fallback. A repo whose
        # fallback is wrong therefore has no required set, every skipped check
        # reads as a pass, and the merge gate quietly stops gating. A repo without
        # an aggregate `gate` job should set this until it has one.
        $r.conclusion != "skipped"
        or $strict_skipped
        or (($required | index($r.name)) != null)
      )
    )]) as $unresolved_runs

# Required contexts with no surviving check run of that name at all.
| ([$required[] as $ctx
    | select(([$runs[] | select(.name == $ctx)] | length) == 0)
    | $ctx]) as $required_missing

# Required contexts that DID run but whose latest run is not exactly `success`.
# Disjoint from $required_missing by construction, so the two lists together
# say precisely why a required gate is not green. Neutral and skipped are NOT
# accepted here even though they pass for an unrequired check: GitHub requires
# a required context to conclude `success`.
| ([$required[] as $ctx
    | ([$runs[] | select(.name == $ctx)]) as $matched
    | select(
        ($matched | length) > 0
        and (($matched | map(select(.conclusion == "success")) | length) == 0)
      )
    | $ctx]) as $required_not_passing

# The "not passing" predicate, shared by `pending` and `all_success` so the two
# can never disagree: still running, or terminal with something other than
# success / neutral / (skipped-and-not-required).
| ([$runs[] | select(
      . as $r
      | $r.status != "completed"
      or (
        $r.conclusion != "success"
        and $r.conclusion != "neutral"
        and (
          # Same strict-skipped rule as $unresolved_runs above — these two
          # predicates must agree, or `pending` and `all_success` disagree with
          # `unresolved` and the poller sees a state that cannot happen.
          $r.conclusion != "skipped"
          or $strict_skipped
          or (($required | index($r.name)) != null)
        )
      )
    )]) as $not_passing_runs

| {
    total: ($runs | length),
    completed: ([$runs[] | select(.status == "completed")] | length),
    success: ([$runs[] | select(.conclusion == "success")] | length),
    failures: ([$runs[] | select(.conclusion == "failure")] | length),

    # WHICH checks failed, not just how many. A bare "2 of 11 checks failed"
    # costs a full diagnosis cycle; the names are the entire clue.
    failure_names: ([$runs[] | select(.conclusion == "failure") | .name] | join("; ")),

    # The check SUITES those failures live in — the join key into the
    # workflow-runs API for anything that wants to re-run them.
    failure_suites: ([$runs[] | select(.conclusion == "failure") | .check_suite.id] | unique),

    neutral: ([$runs[] | select(.conclusion == "neutral")] | length),
    skipped: ([$runs[] | select(.conclusion == "skipped")] | length),

    unresolved: ($unresolved_runs | length),
    unresolved_names: ([$unresolved_runs[]
      | "\(.name) [conclusion=\(if .conclusion then .conclusion else "none" end)]"] | join("; ")),

    required_missing: $required_missing,
    required_not_passing: $required_not_passing,

    all_completed: (
      ($runs | length) > 0
      and ([$runs[] | select(.status != "completed")] | length) == 0
    ),

    all_success: (
      ($runs | length) > 0
      and ([$runs[] | select(.status != "completed")] | length) == 0
      and ($not_passing_runs | length) == 0
      and ($required_missing | length) == 0
      and ($required_not_passing | length) == 0
    ),

    pending: ([$not_passing_runs[]
      | "\(.name) [status=\(.status), conclusion=\(if .conclusion then .conclusion else "none" end)]"]
      | join("; ")),

    # Always false here: this program only runs when the API answered and the
    # program compiled. The caller substitutes its own api_failed:true sentinel
    # when either of those is untrue, and downstream code branches on this
    # field to tell "GitHub says zero checks" from "we could not ask".
    api_failed: false
  }
