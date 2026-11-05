#!/usr/bin/env bash
# Smoke-test the packaged binary in an empty directory with no Node or lib/ on PATH.
set -euo pipefail
if [[ $# -ne 1 || ! -x "$1" ]]; then
  echo "usage: $0 <path-to-rex-dash-binary>" >&2
  exit 64
fi
BINARY="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home/.claude/projects"
cp "$BINARY" "$TMP/bin/rex-dash"

# Stub only the two services --once calls. git is intentionally absent: this is
# the global dashboard, running outside any repo, without Node or project files.
printf '%s\n' '#!/bin/sh' 'echo '\''{"sessions":[]}'\''' > "$TMP/bin/rex"
printf '%s\n' '#!/bin/sh' 'case "$*" in' \
  '  *is:pr*) echo '\''{"data":{"mine":{"issueCount":0,"nodes":[]},"review":{"issueCount":0,"nodes":[]}}}'\'' ;;' \
  '  *) echo '\''{"data":{"issues":{"issueCount":0,"nodes":[]}}}'\'' ;;' \
  'esac' > "$TMP/bin/gh"
chmod +x "$TMP/bin/rex" "$TMP/bin/gh"

(
  cd "$TMP"
  selftest="$(env -i HOME="$TMP/home" PATH="$TMP/bin" XDG_CACHE_HOME="$TMP/cache" "$TMP/bin/rex-dash" --test)"
  grep -qx ok <<< "$selftest"
  env -i HOME="$TMP/home" PATH="$TMP/bin" XDG_CACHE_HOME="$TMP/cache" "$TMP/bin/rex-dash" --once > "$TMP/once.txt"
)
for heading in FLEET USAGE 'REVIEW REQUESTS' 'MY PRS' ISSUES; do
  grep -q "$heading" "$TMP/once.txt"
done
for result in '0 sessions' '0 waiting on you' '0 open' '0 assigned to you'; do
  grep -q "$result" "$TMP/once.txt"
done
test -s "$TMP/cache/rex-dash/all/state.json"
echo 'Binary works without Node or lib/'
