#!/usr/bin/env bash
# Write the Homebrew formula for the four platform-specific release archives.
set -euo pipefail

if [[ $# -ne 3 || ! "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <vX.Y.Z> <archive-directory> <output-file>" >&2
  exit 64
fi
TAG="$1"
DIR="$2"
OUTPUT_FILE="$3"

sha() {
  local archive="$DIR/rex-dash-${TAG}-$1.tar.gz"
  test -f "$archive" || { echo "missing archive: $archive" >&2; exit 65; }
  "$(dirname "$0")/sha256.sh" "$archive" | cut -d ' ' -f 1
}
DARWIN_ARM64="$(sha darwin-arm64)"
DARWIN_X64="$(sha darwin-x64)"
LINUX_ARM64="$(sha linux-arm64)"
LINUX_X64="$(sha linux-x64)"
mkdir -p "$(dirname "$OUTPUT_FILE")"

cat > "$OUTPUT_FILE" <<FORMULA
class RexDash < Formula
  desc "Dashboard pane for Rex with agent fleet, PRs and Claude Code usage"
  homepage "https://github.com/gugahoi/rex-dash"
  version "${TAG#v}"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gugahoi/rex-dash/releases/download/${TAG}/rex-dash-${TAG}-darwin-arm64.tar.gz"
      sha256 "${DARWIN_ARM64}"
    end
    on_intel do
      url "https://github.com/gugahoi/rex-dash/releases/download/${TAG}/rex-dash-${TAG}-darwin-x64.tar.gz"
      sha256 "${DARWIN_X64}"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/gugahoi/rex-dash/releases/download/${TAG}/rex-dash-${TAG}-linux-arm64.tar.gz"
      sha256 "${LINUX_ARM64}"
    end
    on_intel do
      url "https://github.com/gugahoi/rex-dash/releases/download/${TAG}/rex-dash-${TAG}-linux-x64.tar.gz"
      sha256 "${LINUX_X64}"
    end
  end

  depends_on "gh"

  def install
    bin.install "rex-dash"
    pkgshare.install "LICENSE", "NODE-LICENSE"
  end

  test do
    assert_equal "ok", shell_output("#{bin}/rex-dash --test").strip
  end
end
FORMULA
