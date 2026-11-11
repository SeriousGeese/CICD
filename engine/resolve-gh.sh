#!/usr/bin/env bash
# Resolve a gh CLI that actually RUNS on this runner and export it as GH_CLI.
#
# Why not just `gh`: pr-review.sh's has_do_not_merge_label() FAILS CLOSED when
# gh cannot run (rc=127), which silently holds a PR nobody labelled. So a gh that
# does not work must be caught HERE, loudly, not discovered later as a mystery
# "label lookup returned an error".
#
# Why a probe and not `[ -x ]`: on 2026-11-11 the Bazzite runner
# artemis-promptci-pr-review had an executable linuxbrew gh that died on launch
# ("symbol lookup error: /run/host/usr/lib64/libc.so.6: undefined symbol:
# __pointer_chk_guard"). The old resolver accepted it because it was executable,
# logged "Resolved", and every review on that runner then held its PR. A
# candidate now counts only if `gh --version` exits 0 and its stdout says
# "gh version", AND (when a token is present) one real API call succeeds:
# `--version` alone passed on artemis while every API call crashed (see probe).
#
# Why a pinned download: when no installed gh runs (the case above), use the
# official release tarball. Those binaries are static Go builds, so they do not
# depend on the host's libc. Version and sha256 are pinned here. Only the
# TARBALL is cached, and it is re-hashed on every run and extracted fresh into
# this job's RUNNER_TEMP, so nothing extracted is ever trusted across jobs. A
# mismatch is refused, never run.
#
# Inputs (env):
#   GH_CLI_HINT                 preferred path (vars.GH_CLI_PATH): a hint, tried first
#   RUNNER_NAME, GITHUB_ENV     set by the runner
#   RUNNER_TEMP                 per-job scratch, set by the runner (required for the download)
#   RUNNER_TOOL_CACHE           where the verified tarball is cached (optional)
# Test seams, honoured only with RESOLVE_GH_TEST=1 (never set by the actions):
#   RESOLVE_GH_CANDIDATES       newline-separated list replacing the built-in candidates
#   RESOLVE_GH_NO_DOWNLOAD=1    skip the pinned download
#   RESOLVE_GH_DOWNLOAD_BASE    release download base URL
set -euo pipefail

GH_PINNED_VERSION="2.103.3"
# From https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_checksums.txt
GH_SHA256_LINUX_AMD64="4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d"
GH_SHA256_LINUX_ARM64="ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63"
PROBE_TIMEOUT_SECONDS=20

: "${GITHUB_ENV:?GITHUB_ENV must be set (this runs inside a GitHub Actions step)}"
runner_name="${RUNNER_NAME:-unknown-runner}"
echo "RUNNER_HOST=${runner_name%-pr-review}" >> "$GITHUB_ENV"

testing=0
[ "${RESOLVE_GH_TEST:-}" = "1" ] && testing=1

failures=()
probe_version=""

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/resolve-gh.XXXXXX")"
# shellcheck disable=SC2064 # expand $scratch now
trap "rm -rf '$scratch'" EXIT

# Run a command with a timeout where `timeout` exists (not on stock macOS), so a
# candidate that hangs fails fast instead of eating the job's whole timeout.
with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$PROBE_TIMEOUT_SECONDS" "$@"
  else
    "$@"
  fi
}

# 0 when "$1 --version" exits 0 and its stdout's first line starts with
# "gh version". stderr is kept only for the failure reason, so a working gh that
# prints a warning to stderr is not rejected. Sets probe_version; records why in
# failures[] otherwise.
probe() {
  local out err first rc=0
  out="$(with_timeout "$1" --version 2>"$scratch/probe.err")" || rc=$?
  err="$(head -1 "$scratch/probe.err" 2>/dev/null || true)"
  first="${out%%$'\n'*}"
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -eq 124 ] && err="timed out after ${PROBE_TIMEOUT_SECONDS}s"
    failures+=("$1: --version failed (rc=$rc): ${err:-${first:-<no output>}}")
    return 1
  fi
  case "$first" in
    "gh version "*) ;;
    *)
      failures+=("$1: --version did not identify gh: ${first:-${err:-<no output>}}")
      return 1
      ;;
  esac
  probe_version="$first"

  # `--version` is not enough. On artemis (2026-11-11) the linuxbrew gh passed
  # it and then died on its first API call: resolving a hostname makes glibc
  # dlopen the HOST's NSS modules (/run/host/usr/lib64), which need a
  # GLIBC_PRIVATE symbol the brew glibc lacks ("undefined symbol:
  # __pointer_chk_guard"). With lazy binding nothing fails until that call. So
  # make one real call when a token is present (the action passes
  # github.token by default; gh refuses to touch the network without one).
  # GET /rate_limit does not count against the rate limit.
  #
  # Only a CRASH condemns the binary: exec failure (126/127), a signal (>=128),
  # a timeout (124), or a dynamic-loader message. A gh that ran and got an
  # HTTP error back (bad token, 5xx) WORKS: the API said no, and pr-review will
  # fail on that itself with the real cause instead of "install gh".
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    rc=0
    with_timeout "$1" api rate_limit --jq .resources.core.limit >/dev/null 2>"$scratch/probe.err" || rc=$?
    if [ "$rc" -ne 0 ]; then
      err="$(head -1 "$scratch/probe.err" 2>/dev/null || true)"
      if [ "$rc" -eq 124 ] || [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ] || [ "$rc" -ge 128 ] ||
        grep -Eq 'symbol lookup error|error while loading shared libraries|cannot execute' "$scratch/probe.err" 2>/dev/null; then
        [ "$rc" -eq 124 ] && err="timed out after ${PROBE_TIMEOUT_SECONDS}s"
        failures+=("$1: runs, but crashed on an API call (rc=$rc): ${err:-<no output>}")
        return 1
      fi
      echo "Note: $1 works, but its probe API call was refused (rc=$rc): ${err:-<no output>}"
    fi
  fi
  return 0
}

accept() {
  echo "GH_CLI=$1" >> "$GITHUB_ENV"
  echo "Resolved gh on ${runner_name}: $1 (${probe_version})"
  exit 0
}

builtin=()
if [ "$testing" = 1 ] && [ -n "${RESOLVE_GH_CANDIDATES+x}" ]; then
  # A while-read loop, not mapfile: a self-hosted macOS runner may run bash 3.2.
  while IFS= read -r line; do builtin+=("$line"); done <<<"$RESOLVE_GH_CANDIDATES"
else
  builtin=(
    "$(command -v gh 2>/dev/null || true)"
    /home/linuxbrew/.linuxbrew/bin/gh
    /usr/local/bin/gh
    /usr/bin/gh
    /opt/homebrew/bin/gh
  )
fi

seen=$'\n'
for candidate in "${GH_CLI_HINT:-}" ${builtin[@]+"${builtin[@]}"}; do
  [ -n "$candidate" ] || continue
  case "$seen" in *$'\n'"$candidate"$'\n'*) continue ;; esac
  seen+="$candidate"$'\n'
  if [ ! -x "$candidate" ]; then
    [ -e "$candidate" ] && failures+=("$candidate: not executable")
    continue
  fi
  if probe "$candidate"; then accept "$candidate"; fi
done

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# No installed gh runs: fall back to the pinned official release.
# Each step that can fail records why and returns 1 (this runs under `|| true`,
# where set -e is off).
download_pinned() {
  if [ "$testing" = 1 ] && [ "${RESOLVE_GH_NO_DOWNLOAD:-}" = "1" ]; then
    failures+=("pinned download: disabled (RESOLVE_GH_NO_DOWNLOAD=1)")
    return 1
  fi
  if [ -z "${RUNNER_TEMP:-}" ]; then
    failures+=("pinned download: RUNNER_TEMP is not set, so there is no per-job directory to extract into")
    return 1
  fi
  local os arch want tool
  os="$(uname -s)"
  arch="$(uname -m)"
  if [ "$os" != "Linux" ]; then
    failures+=("pinned download: only Linux is supported, this runner is $os")
    return 1
  fi
  case "$arch" in
    x86_64 | amd64) arch=amd64; want="$GH_SHA256_LINUX_AMD64" ;;
    aarch64 | arm64) arch=arm64; want="$GH_SHA256_LINUX_ARM64" ;;
    *) failures+=("pinned download: unsupported architecture $arch"); return 1 ;;
  esac
  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || { failures+=("pinned download: $tool is not installed"); return 1; }
  done

  local name="gh_${GH_PINNED_VERSION}_linux_${arch}"
  local base="https://github.com/cli/cli/releases/download"
  if [ "$testing" = 1 ] && [ -n "${RESOLVE_GH_DOWNLOAD_BASE:-}" ]; then base="$RESOLVE_GH_DOWNLOAD_BASE"; fi
  local url="$base/v${GH_PINNED_VERSION}/${name}.tar.gz"
  local tarball="" cached="" got

  if [ -n "${RUNNER_TOOL_CACHE:-}" ]; then
    cached="$RUNNER_TOOL_CACHE/gh-pinned/${GH_PINNED_VERSION}/${name}.tar.gz"
    if [ -f "$cached" ] && [ "$(sha256_of "$cached")" = "$want" ]; then
      tarball="$cached"
    fi
  fi

  if [ -z "$tarball" ]; then
    local retry_all=()
    if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then retry_all=(--retry-all-errors); fi
    if ! curl -fsSL --connect-timeout 15 --max-time 120 --retry 3 --retry-max-time 90 \
      ${retry_all[@]+"${retry_all[@]}"} -o "$scratch/gh.tar.gz" "$url"; then
      failures+=("pinned download: could not fetch $url")
      return 1
    fi
    got="$(sha256_of "$scratch/gh.tar.gz")"
    if [ "$got" != "$want" ]; then
      failures+=("pinned download: sha256 mismatch for ${name}.tar.gz (got $got, want $want); refusing to run it")
      return 1
    fi
    tarball="$scratch/gh.tar.gz"
    # Best-effort cache of the VERIFIED tarball: write beside the target and
    # rename, so a concurrent job never sees a partial file. A failure here
    # only costs the next job a download.
    if [ -n "$cached" ]; then
      local part
      if mkdir -p "$(dirname "$cached")" 2>/dev/null &&
        part="$(mktemp "$cached.XXXXXX" 2>/dev/null)" &&
        cp "$scratch/gh.tar.gz" "$part" 2>/dev/null; then
        mv -f "$part" "$cached" 2>/dev/null || rm -f "$part"
      fi
    fi
  fi

  # Extract fresh into this job's RUNNER_TEMP (the runner wipes it after the
  # job), not into $scratch: GH_CLI must outlive this script.
  local dest
  if ! dest="$(mktemp -d "$RUNNER_TEMP/gh-pinned.XXXXXX")"; then
    failures+=("pinned download: could not create a directory under RUNNER_TEMP")
    return 1
  fi
  if ! tar -xzf "$tarball" -C "$dest" 2>"$scratch/tar.err"; then
    failures+=("pinned download: tar failed: $(head -1 "$scratch/tar.err")")
    return 1
  fi
  local bin="$dest/$name/bin/gh"
  if [ ! -x "$bin" ]; then
    failures+=("pinned download: ${name}.tar.gz has no executable $name/bin/gh")
    return 1
  fi
  if probe "$bin"; then
    echo "No installed gh runs on ${runner_name}; using the pinned official release."
    accept "$bin"
  fi
  return 1
}

download_pinned || true

echo "::error::No working gh CLI on runner '${runner_name}'. Install gh there, or set the GH_CLI_PATH repo variable to a gh that runs on every runner this job can land on. What was tried:"
for f in ${failures[@]+"${failures[@]}"}; do echo "  - $f"; done
exit 1
