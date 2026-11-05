#!/usr/bin/env bash
# Bundle the CommonJS application and embed it in Node's single executable.
# Run npm ci first. Build on each target OS/architecture; this is not a cross-compiler.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if [[ $# -ne 2 || ! "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <vX.Y.Z> <output-directory>" >&2
  exit 64
fi
TAG="$1"
mkdir -p "$2"
OUT="$(cd "$2" && pwd)"
PLATFORM="$(node -p 'process.platform + "-" + process.arch')"
case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *) echo "unsupported build platform: $PLATFORM" >&2; exit 65 ;;
esac
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo 'build with Node 24 (the runtime embedded in the binary)' >&2
  exit 65
fi
if [[ ! -x node_modules/.bin/esbuild || ! -x node_modules/.bin/postject ]]; then
  echo 'run npm ci before building' >&2
  exit 65
fi
NODE_ROOT="$(dirname "$(dirname "$(node -p 'require("node:fs").realpathSync(process.execPath)')")")"
test -f "$NODE_ROOT/LICENSE" || { echo "Node license not found under $NODE_ROOT" >&2; exit 65; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
node_modules/.bin/esbuild rex-dash --bundle --platform=node --target=node24 --outfile="$TMP/bundle.cjs"
printf '{"main":"%s","output":"%s","disableExperimentalSEAWarning":true}\n' \
  "$TMP/bundle.cjs" "$TMP/sea.blob" > "$TMP/sea-config.json"
node --experimental-sea-config "$TMP/sea-config.json"
cp "$(node -p 'process.execPath')" "$TMP/rex-dash"
chmod u+w "$TMP/rex-dash"

POSTJECT_ARGS=(--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2)
if [[ "$PLATFORM" == darwin-* ]]; then
  codesign --remove-signature "$TMP/rex-dash"
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi
node_modules/.bin/postject "$TMP/rex-dash" NODE_SEA_BLOB "$TMP/sea.blob" "${POSTJECT_ARGS[@]}"
if [[ "$PLATFORM" == darwin-* ]]; then
  # Ad-hoc signing is necessary to run an injected Mach-O; it is NOT notarization.
  codesign --force --sign - "$TMP/rex-dash"
  codesign --verify "$TMP/rex-dash"
fi
selftest="$("$TMP/rex-dash" --test)"
grep -qx ok <<< "$selftest"

mkdir "$TMP/stage"
cp "$TMP/rex-dash" "$TMP/stage/rex-dash"
chmod 0755 "$TMP/stage/rex-dash"
cp LICENSE "$TMP/stage/LICENSE"
cp "$NODE_ROOT/LICENSE" "$TMP/stage/NODE-LICENSE"
ARCHIVE="rex-dash-${TAG}-${PLATFORM}.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$OUT/$ARCHIVE" -C "$TMP/stage" rex-dash LICENSE NODE-LICENSE
cp "$TMP/rex-dash" "$OUT/rex-dash"
(cd "$OUT" && "$ROOT/scripts/sha256.sh" "$ARCHIVE" > "$ARCHIVE.sha256")
echo "Built $OUT/$ARCHIVE"
