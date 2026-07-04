#!/bin/bash
# Memory read/write safety harness — the "silent killer" suite.
# Covers: path-escape, secret kill-list, append dedup, INDEX-map correctness
# (write side, deterministic) + cross-user prefix isolation and grep isolation
# (read side, deterministic). Permissions/chown are container-specific and run
# separately via test-memory-perms.sh (see the note at the end).
#
# Usage:  bash ide-template/scripts/test-memory.sh
# Exit 0 iff every check passes — wire it into CI on any memory-path change.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══════════ Memory safety harness ═══════════"
echo
echo "── WRITE guards + INDEX map (python) ──"
python3 "$DIR/test-memory-guards.py"; G=$?
echo
echo "── READ isolation: prefix + grep (node) ──"
node "$DIR/test-memory-read.mjs"; R=$?
echo
echo "── PERMS (chown-trap) — container-specific ──"
echo "  Not run here (needs the real coder/wsapi uids). In a client container:"
echo "    docker exec -u coder <ctr> bash /opt/ide/scripts/test-memory-perms.sh"
echo
if [ "$G" -eq 0 ] && [ "$R" -eq 0 ]; then
    echo "✅ ALL DETERMINISTIC MEMORY TESTS PASSED"
else
    echo "❌ FAILURES ABOVE (guards=$G read=$R)"; exit 1
fi
