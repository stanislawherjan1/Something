#!/bin/bash
# Memory PERMISSIONS canary — the chown-trap catcher. Run INSIDE a client
# container (docker exec ... bash test-memory-perms.sh). The memory tree is
# written by TWO uids — the agent (coder, uid 1000) and wsapi (uid 1001) — both
# in group `workspace`. If a write lands with the wrong owner/group/mode, one of
# them silently loses access (setup wizard reappears, reflect writes 0 verdicts,
# private cards go unreadable). This asserts the invariant so that failure is loud.
#
# The real trap (what caused the 3 incidents) is group≠workspace or group-not-
# readable — a workspace-group uid then loses access entirely. So HARD-fail on:
#   owner ∉ {coder, wsapi, bot}  (the three uids that write memory),
#   group ≠ workspace,  or  group-not-readable.
# Group-writable (664 vs 644) is the IDEAL but only WARNed: single-writer files
# (RECENT_* snapshots) are fine at 644, and atomic tmp+rename covers shared files
# via the setgid dir even when the file itself isn't group-writable.
MEM="${PROJECT_DIR:-/home/coder/project}/memory"
[ -d "$MEM" ] || { echo "no memory dir at $MEM"; exit 1; }
FAIL=0

echo "── files (owner ∈ coder|wsapi|bot, group=workspace, group-readable) ──"
while IFS= read -r f; do
    read -r owner grp mode <<<"$(stat -c '%U %G %A' "$f" 2>/dev/null)"
    case "$owner" in coder|wsapi|bot) ;; *) echo "  ✗ owner=$owner (unknown memory writer)  $f"; FAIL=1 ;; esac
    [ "$grp" = "workspace" ] || { echo "  ✗ group=$grp — CHOWN-TRAP  $f"; FAIL=1; }
    [ "${mode:4:1}" = "r" ]   || { echo "  ✗ group-NOT-readable ($mode) — CHOWN-TRAP  $f"; FAIL=1; }
    [ "${mode:5:1}" = "w" ]   || echo "  ⚠ group-not-writable ($mode) — ok for single-writer files  $f"
done < <(find "$MEM" -type f -name '*.md' 2>/dev/null | grep -vE '_reflect/undo')

echo "── dirs (setgid, so new files inherit group=workspace) ──"
while IFS= read -r d; do
    read -r grp mode <<<"$(stat -c '%G %A' "$d" 2>/dev/null)"
    case "$mode" in *s*) ;; *) echo "  ✗ not-setgid ($mode)  $d"; FAIL=1 ;; esac
    [ "$grp" = "workspace" ] || { echo "  ✗ dir group=$grp  $d"; FAIL=1; }
done < <(find "$MEM" -type d 2>/dev/null | grep -vE '_reflect/undo')

[ $FAIL -eq 0 ] && echo "✅ PERMS OK — no chown-trap" || { echo "❌ PERMS BROKEN — the chown-trap (fix: chgrp -R workspace; find -type d -exec chmod 2775; find -type f -exec chmod 664)"; exit 1; }
