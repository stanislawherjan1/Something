#!/bin/bash
# vendor-jev.sh — take jev-ultrafast's page snapshot (and its licence) at a
# given commit into chrome-extension/vendor/, keeping our attribution header,
# and show what changed. The same commit is the one the Jev runner pins, so
# bump both together (JEV_ULTRAFAST_REF in ide-template/Dockerfile).
#
#   scripts/vendor-jev.sh              # the pinned commit (below)
#   scripts/vendor-jev.sh <commit>     # another commit, e.g. to try upstream main
set -euo pipefail
REF="${1:-1231850a0bf1a0c0341fe408ef1668dbbfdfac46}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/chrome-extension/vendor"
RAW="https://raw.githubusercontent.com/browser-use/jev-ultrafast/$REF"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$RAW/jev_ultrafast/snapshot.js" -o "$TMP/snapshot.js"
curl -fsSL "$RAW/LICENSE" -o "$TMP/LICENSE"

{
  sed -n '1,/^$/p' "$DEST/jev-snapshot.js"   # our header, up to its blank line
  cat "$TMP/snapshot.js"
} > "$TMP/jev-snapshot.js"

if cmp -s "$TMP/jev-snapshot.js" "$DEST/jev-snapshot.js" && cmp -s "$TMP/LICENSE" "$DEST/LICENSE-jev-ultrafast"; then
  echo "vendor-jev: already at $REF"
  exit 0
fi
diff -u "$DEST/jev-snapshot.js" "$TMP/jev-snapshot.js" || true
cp "$TMP/jev-snapshot.js" "$DEST/jev-snapshot.js"
cp "$TMP/LICENSE" "$DEST/LICENSE-jev-ultrafast"
echo "vendor-jev: updated to $REF — rebuild the download with scripts/build-extension-zip.sh"
