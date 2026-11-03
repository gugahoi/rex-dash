#!/usr/bin/env bash
# Validate the committed source archive and generated formula; --brew also
# installs/tests the formula against a local archive (macOS CI).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --brew ) ]]; then
  echo "usage: $0 [--brew]" >&2
  exit 64
fi

TMP="$(mktemp -d)"
INSTALLED=false
cleanup() {
  if [[ "$INSTALLED" == true ]]; then brew uninstall --formula "$TMP/rex-dash.rb"; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
ARCHIVE="$TMP/rex-dash.tar.gz"
git archive --format=tar.gz --prefix=rex-dash-v0.0.0/ HEAD -o "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$TMP"
test -x "$TMP/rex-dash-v0.0.0/rex-dash"
test -f "$TMP/rex-dash-v0.0.0/lib/app.js"
"$TMP/rex-dash-v0.0.0/rex-dash" --test | grep -qx ok
SHA256="$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f 1)"
./scripts/write-formula.sh v0.0.0 "$SHA256" "$TMP/rex-dash.rb"
ruby -c "$TMP/rex-dash.rb"

if [[ ${1:-} == --brew ]]; then
  if brew list --versions rex-dash >/dev/null 2>&1; then
    echo 'rex-dash is already installed; refusing to replace it for a packaging test' >&2
    exit 1
  fi
  # Point the *generated* formula at this local archive; exercise its actual
  # install method without publishing a tag or modifying the tap.
  # shellcheck disable=SC2016 # Ruby, not the shell, expands #{...}.
  FORMULA_ARCHIVE="$ARCHIVE" ruby -pi -e '$_ = "  url \"file://#{ENV.fetch("FORMULA_ARCHIVE")}\"\n" if $_.strip.start_with?("url ")' "$TMP/rex-dash.rb"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install --formula --build-from-source "$TMP/rex-dash.rb"
  INSTALLED=true
  HOMEBREW_NO_AUTO_UPDATE=1 brew test "$TMP/rex-dash.rb"
fi
