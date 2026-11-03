#!/usr/bin/env bash
# Write the Homebrew formula for one rex-dash release, installed from the tag's source tarball.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <tag> <sha256> <output-file>" >&2
  exit 64
fi

TAG="$1"
SHA256="$2"
OUTPUT_FILE="$3"

if [[ ! "$TAG" =~ ^v[0-9] ]]; then
  echo "tag must start with v, for example v1.0.0" >&2
  exit 65
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Keep the executable beside its CommonJS modules. A wrapper uses Homebrew's
# Node directly, independent of PATH or shebang rewriting inside libexec.
cat >"$OUTPUT_FILE" <<FORMULA
class RexDash < Formula
  desc "Dashboard pane for Rex with agent fleet, PRs and Claude Code usage"
  homepage "https://github.com/gugahoi/rex-dash"
  url "https://github.com/gugahoi/rex-dash/archive/refs/tags/${TAG}.tar.gz"
  sha256 "${SHA256}"
  license "MIT"

  depends_on "gh"
  depends_on "node"

  def install
    libexec.install "rex-dash", "lib"
    (bin/"rex-dash").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/rex-dash" "\$@"
    SH
    chmod 0755, bin/"rex-dash"
  end

  test do
    assert_equal "ok", shell_output("#{bin}/rex-dash --test").strip
  end
end
FORMULA
