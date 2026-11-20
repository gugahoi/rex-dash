#!/usr/bin/env bash
# Download the binary CI built for a PR, for this machine, check it and run its self-check, to try the PR
# before it merges. Needs gh, logged in. Builds are kept in ${XDG_CACHE_HOME:-~/.cache}/rex-dash-builds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CALLER="$PWD"

usage() {
  cat <<'USAGE'
usage: scripts/try-pr.sh [PR] [--isolated] [--run [-- ARGS...]]

  PR          a PR number, URL or branch; by default, the PR for this checkout's branch
  --isolated  give the build a cache and settings of its own, apart from your installed rex-dash's
  --run       start the build, in this folder, with ARGS
USAGE
}
PR='' ISOLATED=false RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --isolated) ISOLATED=true ;;
    --run) RUN=true ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) usage >&2; exit 64 ;;
    *) if [[ -n "$PR" ]]; then usage >&2; exit 64; fi; PR="$1" ;;
  esac
  shift
done
if [[ $# -gt 0 && "$RUN" != true ]]; then
  echo 'ARGS are for --run' >&2
  exit 64
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
  Darwin-x86_64) PLATFORM=darwin-x64 ;;
  Linux-aarch64|Linux-arm64) PLATFORM=linux-arm64 ;;
  Linux-x86_64) PLATFORM=linux-x64 ;;
  *) echo "CI doesn't build rex-dash for $(uname -s) $(uname -m)" >&2; exit 65 ;;
esac

# gh finds the repository, and the PR for the branch, from the checkout.
cd "$ROOT"
info="$(gh pr view ${PR:+"$PR"} --json number,headRefOid --jq '"\(.number) \(.headRefOid)"')"
NUMBER="${info% *}" SHA="${info#* }"
PR_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/rex-dash-builds/pr-$NUMBER"
BUILD="$PR_DIR/${SHA:0:7}"
BIN="$BUILD/rex-dash"

if [[ -x "$BIN" ]]; then
  echo "Using PR #$NUMBER's build of ${SHA:0:7}, downloaded before."
else
  # The latest CI run for the PR's last commit. It ran on the PR merged into main as it was then.
  run="$(gh run list --workflow ci.yml --commit "$SHA" --event pull_request --limit 1 \
    --json databaseId,status,conclusion,url --jq '.[0] // empty | "\(.databaseId)|\(.status)|\(.conclusion)|\(.url)"')"
  if [[ -z "$run" ]]; then
    echo "CI hasn't run on PR #$NUMBER's last commit, ${SHA:0:7}, yet." >&2
    exit 1
  fi
  IFS='|' read -r RUN_ID STATUS CONCLUSION URL <<< "$run"

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  # Each platform's binary is uploaded once it passes its tests, even while other jobs still run.
  if ! gh run download "$RUN_ID" --name "rex-dash-$PLATFORM" --dir "$TMP/download"; then
    if [[ "$STATUS" != completed ]]; then
      echo "The $PLATFORM binary for ${SHA:0:7} isn't built yet. To wait for it: gh run watch $RUN_ID" >&2
    else
      echo "CI has no $PLATFORM binary for ${SHA:0:7}: its build failed, or it expired after 14 days. See $URL" >&2
    fi
    exit 1
  fi
  if [[ "$STATUS" != completed ]]; then
    echo "CI is still running for ${SHA:0:7}, but the $PLATFORM binary has passed its tests. See $URL" >&2
  elif [[ "$CONCLUSION" != success ]]; then
    echo "Warning: CI ended in $CONCLUSION for ${SHA:0:7}, but the $PLATFORM binary passed its tests. See $URL" >&2
  fi

  sums=("$TMP"/download/*-"$PLATFORM".tar.gz.sha256)
  if [[ ${#sums[@]} -ne 1 || ! -f "${sums[0]}" ]]; then
    echo "expected one $PLATFORM archive in CI's rex-dash-$PLATFORM artifact" >&2
    exit 1
  fi
  (cd "$TMP/download" && "$ROOT/scripts/sha256.sh" -c --quiet "$(basename "${sums[0]}")") || {
    echo "The $PLATFORM archive doesn't match its SHA-256 file." >&2
    exit 1
  }
  mkdir "$TMP/build"
  tar -xzf "${sums[0]%.sha256}" -C "$TMP/build"
  if [[ "$("$TMP/build/rex-dash" --test 2>&1)" != ok ]]; then
    echo "The $PLATFORM binary failed its self-check." >&2
    exit 1
  fi

  # A binary is around 100 MB, so keep only the PR's latest. Deleting one that's running doesn't stop it.
  mkdir -p "$PR_DIR"
  for old in "$PR_DIR"/*; do
    if [[ -d "$old" && "$(basename "$old")" =~ ^[0-9a-f]{7}$ ]]; then rm -rf "$old"; fi
  done
  mv "$TMP/build" "$BUILD"
  echo "Downloaded PR #$NUMBER's build of ${SHA:0:7} for $PLATFORM."
fi

if [[ "$ISOLATED" == true ]]; then
  # Only rex-dash's cache and settings move. The config, with your keys, stays shared.
  CMD=(env "XDG_CACHE_HOME=$PR_DIR/cache" "XDG_STATE_HOME=$PR_DIR/state" "$BIN")
else
  # Capture the list before grep: grep -q in a pipe would close it early, and fail it under pipefail.
  files="$(gh pr diff "$NUMBER" --name-only 2>/dev/null)" || files=''
  if grep -qxE 'lib/(storage|usage)\.js' <<< "$files"; then
    echo "PR #$NUMBER changes what rex-dash saves, which your installed rex-dash reads too. Consider --isolated." >&2
  fi
  CMD=("$BIN")
fi

cd "$CALLER"
if [[ "$RUN" == true ]]; then
  exec "${CMD[@]}" "$@"
fi
command="$(printf '%q ' "${CMD[@]}")"
echo
echo 'Run it here:'
echo "  ${command% }"
echo 'Or beside this pane, in Rex:'
echo "  rex split -b \"\$REX_BLOCK\" --split=right --ratio 45 --label 'PR $NUMBER' --focus=false -- ${command% }"
