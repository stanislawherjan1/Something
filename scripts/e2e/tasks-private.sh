#!/usr/bin/env bash
# A person's own task list is theirs alone: the member's own task is absent
# from the admin's board and 404 to the admin's hands, the file sits in the
# member's private tree as their turn user's (0660, their priv group) where the
# admin's turn shell cannot open it, and once the member puts the task on the
# team board the admin sees it. No model turns (API and shell only); the test
# tasks are deleted at the end. About a minute.
#   E2E_CLIENT=<client> bash scripts/e2e/tasks-private.sh
TOKEN_TTL=600
source "$(dirname "$0")/lib.sh"
need_member
TITLE="E2E-$TAG private task of the member"
TEAM_TITLE="E2E-$TAG team task of the member"
IDS=()
trap 'for id in "${IDS[@]}"; do api "$MEMBER_JWT" DELETE "/tasks/$id" >/dev/null 2>&1; api "$ADMIN_JWT" DELETE "/tasks/$id" >/dev/null 2>&1; done' EXIT

echo "== the member makes a task in the browser"
T="$(api "$MEMBER_JWT" POST /tasks "{\"title\":\"$TITLE\"}")"
TID="$(echo "$T" | jsonq 'a.get("task",{}).get("id","")')"; IDS+=("$TID")
check "it is on their own list" "user:$MEMBER_SLUG" "$(echo "$T" | jsonq 'a.get("task",{}).get("scope","")')"
check "...owned by them" "$MEMBER_SLUG" "$(echo "$T" | jsonq 'a.get("task",{}).get("owner","")')"
has "the member's board lists it" "$(api "$MEMBER_JWT" GET /tasks)" "$TITLE"
lacks "the admin's board does not" "$(api "$ADMIN_JWT" GET /tasks)" "$TITLE"
check "the admin cannot change it (404, not 403)" "404" "$(code "$ADMIN_JWT" PATCH "/tasks/$TID" '{"title":"x"}')"
check "...nor delete it" "404" "$(code "$ADMIN_JWT" DELETE "/tasks/$TID")"
lacks "a caller with no identity does not see it" "$(R "docker exec $C curl -s http://127.0.0.1:3001/api/tasks")" "$TITLE"

echo "== the file is the member's, on disk"
F="$P/.team/users/$MEMBER_SLUG/tasks.json"
MSLOT="$(echo "$ROSTER" | jsonq "next((str(e.get('slot','')) for e in a if e.get('slug')=='$MEMBER_SLUG'), '')")"
ASLOT="$(echo "$ROSTER" | jsonq "next((str(e.get('slot','')) for e in a if e.get('slug')=='$ADMIN_SLUG'), '')")"
MSLOT="$(printf '%02d' "${MSLOT:-0}")"; ASLOT="$(printf '%02d' "${ASLOT:-0}")"
check "owner and group are the member's turn user and priv group" "turn-$MSLOT:priv-$MSLOT" "$(R "docker exec -u 1001 $C stat -c '%U:%G' $F")"
check "mode: group may read, nobody else" "0" "$(R "docker exec -u 1001 $C stat -c '%a' $F" | python3 -c 'import sys; m=int(sys.stdin.read().strip() or "777",8); print(m & 0o007)')"
check "the admin's turn user cannot open it" "no" "$(R "docker exec -u turn-$ASLOT $C sh -c 'cat $F >/dev/null 2>&1 && echo yes || echo no'")"
check "...the member's own can" "yes" "$(R "docker exec -u turn-$MSLOT $C sh -c 'cat $F >/dev/null 2>&1 && echo yes || echo no'")"
has "the directory itself is theirs" "$(R "docker exec -u 1001 $C stat -c '%U:%G %a' $P/.team/users/$MEMBER_SLUG")" "turn-$MSLOT:priv-$MSLOT 2770"

echo "== the member puts it on the team board"
T="$(api "$MEMBER_JWT" PATCH "/tasks/$TID" '{"scope":"shared"}')"
check "moved" "shared" "$(echo "$T" | jsonq 'a.get("task",{}).get("scope","")')"
has "now the admin sees it" "$(api "$ADMIN_JWT" GET /tasks)" "$TITLE"
check "the admin may not take someone else's team task to their own list" "403" "$(code "$ADMIN_JWT" PATCH "/tasks/$TID" '{"scope":"mine"}')"
T="$(api "$MEMBER_JWT" PATCH "/tasks/$TID" '{"scope":"mine"}')"
check "the member takes it back" "user:$MEMBER_SLUG" "$(echo "$T" | jsonq 'a.get("task",{}).get("scope","")')"
lacks "...and it is gone from the admin's board again" "$(api "$ADMIN_JWT" GET /tasks)" "$TITLE"

echo "== a task for someone else goes to the team board"
T="$(api "$MEMBER_JWT" POST /tasks "{\"title\":\"$TEAM_TITLE\",\"owner\":\"$ADMIN_SLUG\"}")"
TID2="$(echo "$T" | jsonq 'a.get("task",{}).get("id","")')"; IDS+=("$TID2")
check "on the team board" "shared" "$(echo "$T" | jsonq 'a.get("task",{}).get("scope","")')"
has "the admin sees it" "$(api "$ADMIN_JWT" GET /tasks)" "$TEAM_TITLE"

finish
