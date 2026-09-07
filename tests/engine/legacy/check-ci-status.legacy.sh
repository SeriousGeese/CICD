check_ci_status() {
  local sha="${1:-$HEAD_SHA}"
  >&2 log "  Checking CI for SHA: ${sha}"
  local api_result api_exit=0
  # PAGINATED, deliberately (DnD-85jir). This endpoint defaults to per_page=30
  # and truncates SILENTLY: page 1 is a well-formed response that simply omits
  # the rest, so `total`, `failures` and `all_success` would all be computed
  # from a partial set with nothing to indicate it. Measured on the very SHA
  # that produced this bead (83267ea2): total_count=26 — four short — and every
  # rerun generation adds a fresh check run of every name to the SAME SHA, so a
  # PR that gets re-run twice crosses it. `--paginate` emits ONE JSON OBJECT PER
  # PAGE (verified: per_page=2 on that SHA yields 13 objects, 26 check runs), so
  # the jq program below is slurped (`jq -s`) and flattens `.[].check_runs`
  # rather than reading `.check_runs` off a single object.
  api_result="$($GH_CLI api --paginate "repos/${REPO}/commits/${sha}/check-runs?per_page=100" 2>&1)" || api_exit=$?
  if [ "$api_exit" -ne 0 ] || [ -z "$api_result" ]; then
    >&2 log "  CI API call failed (exit=${api_exit})"
    >&2 log "  Response: $(echo "$api_result" | head -c 200)"
    # api_failed distinguishes "the API told us there are zero checks" from
    # "we could not ask" — the latter must never count toward the zero-checks
    # grace, or 120s of GitHub flakiness reads as a mergeable docs-only PR.
    echo '{"total":0,"completed":0,"success":0,"failures":0,"failure_names":"","failure_suites":[],"neutral":0,"unresolved":0,"all_completed":false,"all_success":false,"pending":"","unresolved_names":"","api_failed":true}'
    return
  fi
  # No alternative operators in here. jq accepts one as an object-construction
  # value only from 1.8.0 on; under jq 1.7.1 — what ubuntu-latest ships — a
  # `total: (…) or-else 0` form is a SYNTAX error, so nothing compiles at all.
  # Every such guard was dead weight anyway (`length` yields a number, `and`
  # yields a boolean — neither can be null or false-y), but the cost was total
  # silence: this used to end in `2>/dev/null ||` a zero-checks fallback, so a
  # non-compiling program reported "0 checks" and wait_for_ci read that as "no
  # CI applies to this SHA" — the exact mis-read that merges a PR unverified.
  # Hence the failure is now logged, not swallowed — and the fallback carries
  # api_failed so the zero-checks grace never counts an unparseable poll
  # (see wait_for_ci).
  #
  # SUPERSEDED CHECK RUNS (DnD-78zah). One head SHA can carry SEVERAL check runs
  # of the SAME name, from different generations of the same workflow. The usual
  # producer is not an accident: open a PR as a draft and mark it ready seconds
  # later, and `ready_for_review` starts a fresh e2e run whose concurrency group
  # cancels the draft-era one — both generations stay attached to the same SHA.
  #
  # Counting all of them makes a `cancelled` run permanently un-resolvable here:
  # it is not a `failure` (so it never trips the fail-fast branch below) and it
  # is not `success`/`neutral` (so `all_success` can never become true). The loop
  # can only fall through to `waiting` until POLL_TIMEOUT and then report
  # `blocked_infra` — a verdict that is UNREACHABLE, not merely slow. PR #2690
  # (run 33313059457) burned the full 1800s on 11 passing + 5 cancelled-and-
  # superseded e2e check runs, with every check that mattered green.
  #
  # So reduce to the MOST RECENT run per NAME before computing anything. That is
  # not a local convenience — it is the semantics the rest of the system already
  # assumes: GitHub's own merge gating honours the last check run of a given
  # name, and `.github/workflows/e2e.yml`'s draft no-op step says so in its own
  # comment ("the real verdict replaces this one"). Without this reduction the
  # poller could disagree with GitHub about whether a PR is green on a perfectly
  # normal draft-to-ready flow.
  #
  # RECENCY KEY = `.id`, deliberately, not a timestamp:
  #   * `.id` is a monotonically increasing integer assigned at check-run
  #     CREATION and is never null, so the newer generation always wins;
  #   * `.completed_at` is null for the very run we must prefer (the fresh one
  #     is still in progress while its cancelled predecessor is completed) —
  #     it would rank the superseded run highest, i.e. exactly backwards;
  #   * `.started_at` is second-resolution and a re-trigger lands in the same
  #     second often enough to tie, and a tie here silently picks the wrong
  #     generation with no way to tell from the outside.
  #
  # SUPERSEDED CHECK SUITES (DnD-wbds2) — the $superseded filter below. See
  # superseded_check_suites() above for why a second key is needed at all. It
  # drops ONLY check runs that are both (a) in a workflow run a later successful
  # run of the same workflow superseded, and (b) terminal with no verdict. A
  # failure, a success and anything still running are all left untouched, so
  # this can never turn a red into a green — it only clears leftovers whose
  # workflow demonstrably ran again and passed. It is applied BEFORE the
  # group_by so a same-named survivor from the newer generation still wins
  # normally. On the first pass $superseded is empty, costing nothing; it is
  # only recomputed (one extra API call) when something is actually unresolved.
  local ci_jq
  ci_jq='
    [.[] | if .check_runs then .check_runs[] else empty end]
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
    | {'
  ci_jq="${ci_jq}"'
      total: length,
      completed: ([.[] | select(.status == "completed")] | length),
      success: ([.[] | select(.conclusion == "success")] | length),
      failures: ([.[] | select(.conclusion == "failure")] | length),
      # WHICH checks failed, not just how many (DnD-85jir). "2 of 11 checks"
      # with no names cost a full diagnosis cycle on PR #2879: the two names
      # were the entire clue to what had happened, and reconstructing them
      # needed a raw check-runs API call days later.
      failure_names: ([.[] | select(.conclusion == "failure") | .name] | join("; ")),
      # The check SUITES those failures live in, which is the join key into the
      # workflow-runs API — see rerunning_workflows_for_suites() and the
      # rerun-in-flight branch of wait_for_ci.
      failure_suites: ([.[] | select(.conclusion == "failure") | .check_suite.id] | unique),
      neutral: ([.[] | select(.conclusion == "neutral")] | length),
      # TERMINAL BUT UNRESOLVED (DnD-7aqcv). A check that has FINISHED with a
      # conclusion that is neither a pass (success/neutral) nor a fail (failure):
      # cancelled, timed_out, skipped, stale, action_required. The reduction
      # above already dropped any such run that a later run of the SAME NAME
      # superseded, so whatever is counted here has no successor and will never
      # change again.
      #
      # This is the residual of DnD-78zah. `failures` deliberately excludes these
      # (a cancel is not a verdict; see the counterweight test added by PR #2691)
      # and `all_success` can never become true while one is present, so before
      # this field existed the loop had no branch to take and burned the whole
      # 1800s POLL_TIMEOUT to report blocked_infra. Counting them is what lets
      # wait_for_ci say "finished, no verdict" on the first poll instead.
      unresolved: ([
        .[]
        | select(
            .status == "completed"
            and .conclusion != "success"
            and .conclusion != "neutral"
            and .conclusion != "failure"
          )
      ] | length),
      all_completed: (
        length > 0 and
        ([.[] | select(.status != "completed")] | length) == 0
      ),
      all_success: (
        length > 0 and
        ([.[] | select(.conclusion != "success" and .conclusion != "neutral")] | length) == 0
      ),
      pending: ([
        .[]
        | select((.status != "completed") or (.conclusion != "success" and .conclusion != "neutral"))
        | "\(.name) [status=\(.status), conclusion=\(if .conclusion then .conclusion else "none" end)]"
      ] | join("; ")),
      # The same rendering for the unresolved subset, so the DnD-7aqcv verdict
      # can name exactly which checks reached no verdict without the reader
      # having to subtract one list from another.
      unresolved_names: ([
        .[]
        | select(
            .status == "completed"
            and .conclusion != "success"
            and .conclusion != "neutral"
            and .conclusion != "failure"
          )
        | "\(.name) [conclusion=\(if .conclusion then .conclusion else "none" end)]"
      ] | join("; "))
    }
  '

  local parsed jq_exit=0
  # `-s` because --paginate hands us a STREAM of page objects (one per page),
  # and a single-page response slurps to a one-element array just the same.
  parsed="$(echo "$api_result" | jq -s --argjson superseded '[]' "$ci_jq" 2>&1)" || jq_exit=$?
  if [ "$jq_exit" -ne 0 ] || [ -z "$parsed" ]; then
    >&2 log "  check-runs jq parse FAILED (exit=${jq_exit}): $(printf '%s' "$parsed" | head -c 200)"
    echo '{"total":0,"completed":0,"success":0,"failures":0,"failure_names":"","failure_suites":[],"neutral":0,"unresolved":0,"all_completed":false,"all_success":false,"pending":"","unresolved_names":"","api_failed":true}'
    return
  fi

  # Only now, and only when something actually reached no verdict, pay for the
  # workflow-runs call (DnD-wbds2). The overwhelmingly common poll has
  # unresolved == 0 and costs exactly what it did before.
  local unresolved_count=0
  unresolved_count="$(printf '%s' "$parsed" | jq -r 'if .unresolved then .unresolved else 0 end' 2>/dev/null)" || unresolved_count=0
  case "$unresolved_count" in ''|*[!0-9]*) unresolved_count=0 ;; esac
  if [ "$unresolved_count" -gt 0 ]; then
    local superseded='[]'
    superseded="$(superseded_check_suites "$sha")" || superseded='[]'
    if [ "$superseded" != "[]" ]; then
      local reparsed re_exit=0
      reparsed="$(echo "$api_result" | jq -s --argjson superseded "$superseded" "$ci_jq" 2>&1)" || re_exit=$?
      if [ "$re_exit" -ne 0 ] || [ -z "$reparsed" ]; then
        # Keep the first pass rather than failing the poll: the worst case is
        # the pre-DnD-wbds2 behaviour, which is honest, not wrong.
        >&2 log "  check-runs re-parse with superseded suites FAILED (exit=${re_exit}) — keeping the unresolved verdict"
      else
        local now_unresolved=0
        now_unresolved="$(printf '%s' "$reparsed" | jq -r 'if .unresolved then .unresolved else 0 end' 2>/dev/null)" || now_unresolved=0
        case "$now_unresolved" in ''|*[!0-9]*) now_unresolved=0 ;; esac
        if [ "$now_unresolved" -lt "$unresolved_count" ]; then
          >&2 log "  CI: $((unresolved_count - now_unresolved)) unresolved check(s) belong to a workflow run that a LATER run of the same workflow re-ran to success on this SHA — resolving them by workflow instead of by name (DnD-wbds2)"
        fi
        parsed="$reparsed"
      fi
    fi
  fi
  echo "$parsed"
}
