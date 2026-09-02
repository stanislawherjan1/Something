#!/bin/bash
# Memory safety harness — the "silent killer" suite.
#
# Covers the write path (the engine: routing, corrections, guards, revert,
# INDEX), the read path (per-actor prefix isolation, grep isolation) and the
# card registry (one definition, group fence, cache-stable prefix).
# Permissions are container-specific and run separately via test-memory-perms.sh.
#
# Usage:  bash ide-template/scripts/test-memory.sh
# Exit 0 iff every check passes — wire it into CI on any memory-path change.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
API="$DIR/../workspace-api"

echo "═══════════ Memory safety harness ═══════════"
echo
echo "── WRITE path: the engine (routing, corrections, guards, revert, INDEX) ──"
node "$API/lib/memory-engine.test.mjs"; E=$?
echo
echo "── REGISTRY + READ path: one card list, group fence, prefix isolation ──"
node "$API/lib/memory-registry.test.mjs"; R=$?
echo
echo "── PERMS (chown-trap) — container-specific ──"
echo "  Not run here (needs the real coder/wsapi uids). In a client container:"
echo "    docker exec -u coder <ctr> bash /opt/ide/scripts/test-memory-perms.sh"
echo
if [ "$E" -eq 0 ] && [ "$R" -eq 0 ]; then
    echo "✅ ALL DETERMINISTIC MEMORY TESTS PASSED"
else
    echo "❌ FAILURES ABOVE (engine=$E registry=$R)"; exit 1
fi
