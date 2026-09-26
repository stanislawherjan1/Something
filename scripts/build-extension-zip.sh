#!/bin/bash
# build-extension-zip.sh — package chrome-extension/ as the download the
# workspace's "Browser agent" page offers (public/downloads, served by the
# frontend). Unzipping creates one folder, ready for Chrome's "Load unpacked".
# Re-run after any change under chrome-extension/ and commit the zip with it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/ide-template/frontend/public/downloads/something-chrome-extension.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$(dirname "$OUT")"
cp -R "$ROOT/chrome-extension" "$TMP/something-chrome-extension"
find "$TMP" -name '.DS_Store' -delete
rm -f "$OUT"
(cd "$TMP" && zip -q -r -X "$OUT" something-chrome-extension)
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
