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
# candidate now counts only if `gh --version` exits 0 and says "gh version".
#
# Why a pinned download: when no installed gh runs (the case above), fetch the
# official release tarball. Those binaries are static Go builds, so they do not
# depend on the host's libc. Version and sha256 are pinned here; a mismatch is
# refused, never run.
#
# Inputs (env):
#   GH_CLI_HINT                 preferred path (vars.GH_CLI_PATH): a hint, tried first
#   RUNNER_NAME, GITHUB_ENV     set by the runner
#   RUNNER_TOOL_CACHE           where the pinned download is cached (falls back to RUNNER_TEMP)
# Test seams (never set by the actions):
#   RESOLVE_GH_CANDIDATES       newline-separated list replacing the built-in candidates
#   RESOLVE_GH_NO_DOWNLOAD=1    skip the pinned download
#   RESOLVE_GH_DOWNLOAD_BASE    release download base URL
set -euo pipefail

GH_PINNED_VERSION="2.103.3"
# From https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_checksums.txt
GH_SHA256_LINUX_AMD64="4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d"
GH_SHA256_LINUX_ARM64="ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63"

: "${GITHUB_ENV:?GITHUB_ENV must be set (this runs inside a GitHub Actions step)}"
runner_name="${RUNNER_NAME:-unknown-runner}"
echo "RUNNER_HOST=${runner_name%-pr-review}" >> "$GITHUB_ENV"

failures=()
probe_version=""

# 0 when "$1 --version" exits 0 and its first line starts with "gh version".
# Sets probe_version; records why in failures[] otherwise.
probe() {
  local out first
  if ! out="$("$1" --version 2>&1)"; then
    first="${out%%$'\n'*}"
    failures+=("$1: --version failed: ${first:-<no output>}")
    return 1
  fi
  first="${out%%$'\n'*}"
  case "$first" in
    "gh version "*) probe_version="$first"; return 0 ;;
  esac
  failures+=("$1: --version did not identify gh: ${first:-<no output>}")
  return 1
}

accept() {
  echo "GH_CLI=$1" >> "$GITHUB_ENV"
  echo "Resolved gh on ${runner_name}: $1 (${probe_version})"
  exit 0
}

builtin=()
if [ -n "${RESOLVE_GH_CANDIDATES+x}" ]; then
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

# No installed gh runs: fall back to the pinned official release.
download_pinned() {
  if [ "${RESOLVE_GH_NO_DOWNLOAD:-}" = "1" ]; then
    failures+=("pinned download: disabled (RESOLVE_GH_NO_DOWNLOAD=1)")
    return 1
  fi
  local os arch want
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

  local name="gh_${GH_PINNED_VERSION}_linux_${arch}"
  local base="${RESOLVE_GH_DOWNLOAD_BASE:-https://github.com/cli/cli/releases/download}"
  local cache="${RUNNER_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}/gh-pinned/${GH_PINNED_VERSION}"
  local bin="$cache/$name/bin/gh"

  # A cached copy was sha256-verified when it was extracted.
  if [ -x "$bin" ] && probe "$bin"; then accept "$bin"; fi

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand $tmp now: it is local to this function
  trap "rm -rf '$tmp'" EXIT

  if ! curl -fsSL --retry 3 --max-time 120 -o "$tmp/gh.tar.gz" "$base/v${GH_PINNED_VERSION}/${name}.tar.gz"; then
    failures+=("pinned download: could not fetch $base/v${GH_PINNED_VERSION}/${name}.tar.gz")
    return 1
  fi
  local got
  got="$(sha256sum "$tmp/gh.tar.gz" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    failures+=("pinned download: sha256 mismatch for ${name}.tar.gz (got $got, want $want); refusing to run it")
    return 1
  fi
  mkdir -p "$tmp/x"
  tar -xzf "$tmp/gh.tar.gz" -C "$tmp/x"
  mkdir -p "$cache"
  rm -rf "${cache:?}/$name"
  mv "$tmp/x/$name" "$cache/$name"
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
