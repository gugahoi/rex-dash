#!/usr/bin/env bash
# Portable SHA-256 output/checks for macOS (shasum) and minimal Linux (sha256sum).
set -euo pipefail
if command -v shasum >/dev/null 2>&1; then
  exec shasum -a 256 "$@"
fi
exec sha256sum "$@"
