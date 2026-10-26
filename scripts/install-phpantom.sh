#!/usr/bin/env bash
# Install the PHPantom language server where Albedo looks for it:
#   ~/.albedo/bin/phpantom_lsp
#
#   scripts/install-phpantom.sh               install for this user
#   scripts/install-phpantom.sh --to PATH     write the binary to PATH instead
#                                             (build.sh --with-phpantom uses this
#                                             to bundle it into the app)
#
# Optional. Without it, Go to Declaration, Find Usages and Go to
# Implementation still work through git grep; with it, PHP navigation also
# resolves methods and properties by type. Albedo never downloads anything itself -- this script is the one
# place a binary arrives, pinned to a version and checked against the
# release's published SHA-256 before it is moved into place.
#
# Upgrading means changing VERSION and the four checksums below together.

set -euo pipefail

VERSION="0.11.1"
OUT="${HOME}/.albedo/bin/phpantom_lsp"

while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      [ $# -ge 2 ] || { echo "--to needs a path" >&2; exit 2; }
      OUT="$2"
      shift 2
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Already there at this version: nothing to download.
if [ -x "$OUT" ] && [ "$("$OUT" --version 2>/dev/null)" = "phpantom_lsp ${VERSION}" ]; then
  echo "PHPantom ${VERSION} already at $OUT"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)   TARGET="aarch64-apple-darwin";      SHA="ba32a40677fe2fa87f44f3f7ce6dda678a55a770d06d77f2fe128dcc742e17c6" ;;
  Darwin-x86_64)  TARGET="x86_64-apple-darwin";       SHA="a521654efa0aa60f10b87d1f2c9ecf943c3431a11004c404a3c0769b2c7b2f64" ;;
  Linux-aarch64)  TARGET="aarch64-unknown-linux-gnu"; SHA="5c7483504e0bc245b3c6c91d746e0709a4564e559076154d25692da5a96d591c" ;;
  Linux-x86_64)   TARGET="x86_64-unknown-linux-gnu";  SHA="906dd8104d4bf82aa1c4225fba297a90ff1cff0552df635ee858fc272f445fc6" ;;
  *) echo "No PHPantom build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

ASSET="phpantom_lsp-${TARGET}.tar.gz"
URL="https://github.com/PHPantom-dev/phpantom_lsp/releases/download/${VERSION}/${ASSET}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading PHPantom ${VERSION} (${TARGET})"
curl -fsSL "$URL" -o "$TMP/$ASSET"

if command -v sha256sum >/dev/null; then
  GOT="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"
else
  GOT="$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)"
fi
if [ "$GOT" != "$SHA" ]; then
  echo "Checksum mismatch for $ASSET" >&2
  echo "  expected $SHA" >&2
  echo "  got      $GOT" >&2
  exit 1
fi

tar -xzf "$TMP/$ASSET" -C "$TMP" phpantom_lsp
mkdir -p "$(dirname "$OUT")"
install -m 0755 "$TMP/phpantom_lsp" "$OUT"
echo "Installed $("$OUT" --version) to $OUT"
