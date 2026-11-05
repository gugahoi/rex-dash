#!/usr/bin/env bash
# Build a binary archive, validate the generated formula, and optionally install
# it from a local archive with Homebrew (macOS CI).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --brew ) ]]; then
  echo "usage: $0 [--brew]" >&2
  exit 64
fi

TMP="$(mktemp -d)"
TAP="rex-dash-ci/package-$$"
TAPPED=false
TRUSTED=false
INSTALLED=false
cleanup() {
  if [[ "$INSTALLED" == true ]]; then HOMEBREW_NO_AUTOREMOVE=1 brew uninstall --formula "$TAP/rex-dash" || true; fi
  if [[ "$TRUSTED" == true ]]; then brew untrust --formula "$TAP/rex-dash" || true; fi
  if [[ "$TAPPED" == true ]]; then brew untap "$TAP" || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

./scripts/build-binary.sh v0.0.0 "$TMP/dist"
./scripts/test-binary.sh "$TMP/dist/rex-dash"
PLATFORM="$(node -p 'process.platform + "-" + process.arch')"
ARCHIVE="$TMP/dist/rex-dash-v0.0.0-${PLATFORM}.tar.gz"
# Only this host's binary is runnable; duplicate its archive under the other
# platform names to exercise all four formula branches without cross-compiling.
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  if [[ "$platform" != "$PLATFORM" ]]; then
    cp "$ARCHIVE" "$TMP/dist/rex-dash-v0.0.0-${platform}.tar.gz"
  fi
done
./scripts/write-formula.sh v0.0.0 "$TMP/dist" "$TMP/rex-dash.rb"
ruby -c "$TMP/rex-dash.rb"

if [[ ${1:-} == --brew ]]; then
  if brew list --versions rex-dash >/dev/null 2>&1; then
    echo 'rex-dash is already installed; refusing to replace it for a packaging test' >&2
    exit 1
  fi
  # All four test archives contain the same host binary. Use a disposable tap
  # and point its generated formula at the local archive, never the release tap.
  # shellcheck disable=SC2016 # Ruby expands #{...}, not the shell.
  FORMULA_ARCHIVE="$ARCHIVE" ruby -pi -e \
    '$_ = $_.sub(%r{https://github.com/gugahoi/rex-dash/releases/download/[^\"]+\.tar\.gz}, "file://#{ENV.fetch("FORMULA_ARCHIVE")}")' \
    "$TMP/rex-dash.rb"
  HOMEBREW_NO_AUTO_UPDATE=1 brew tap-new --no-git "$TAP"
  TAPPED=true
  TAP_DIR="$(brew --repo "$TAP")"
  cp "$TMP/rex-dash.rb" "$TAP_DIR/Formula/rex-dash.rb"
  HOMEBREW_NO_AUTO_UPDATE=1 brew trust --formula "$TAP/rex-dash"
  TRUSTED=true
  # Declared (not --installed) deps: the formula isn't installed yet. Capture
  # before grep so a brew failure or SIGPIPE can't make this check pass silently.
  deps="$(HOMEBREW_NO_ENV_HINTS=1 brew deps --formula "$TAP/rex-dash")"
  if grep -qx node <<< "$deps"; then
    echo 'the binary formula must not depend on Node' >&2
    exit 1
  fi
  HOMEBREW_NO_AUTO_UPDATE=1 brew install --formula --build-from-source "$TAP/rex-dash"
  INSTALLED=true
  HOMEBREW_NO_AUTO_UPDATE=1 brew test "$TAP/rex-dash"
fi
