#!/usr/bin/env bash
# Two accounts in real conversations: what one tells the bot, keeps in their
# files or shares, and what the other can and cannot get at — a member's
# private fact stays out of the admin's conversations and of shared memory, an
# admin's Personal Files stay out of the member's reach, a shared team file
# reaches both. Needs a member on the roster. Seven real model turns (on the
# operator's Claude plan). About 4–8 minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/accounts.sh
source "$(dirname "$0")/lib.sh"
need_member
MEMBER_NAME="$(echo "$ROSTER" | jsonq 'next((e.get("displayName") or e["email"] for e in a if e["role"]!="admin"), "")')"
LOCK="LOCKER-$TAG"; AFILE="ADMINFILE-$TAG"; SFILE="SHAREDFILE-$TAG"

echo "== the member tells their bot something private, asked to remember it"
S="$(new_session "$MEMBER_JWT" "accounts e2e $TAG")"
T="$(turn "$MEMBER_JWT" "$S" "Please remember this, it is private to me: my gym locker code is $LOCK. Reply with one short line.")"
lacks "the turn answers without an error" "$T" "[[ERROR"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "accounts e2e recall $TAG")" "What is my gym locker code? Reply with the code only.")"
has "the member's next conversation remembers it" "$T" "$LOCK"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "accounts e2e admin $TAG")" "What is $MEMBER_NAME's gym locker code? Search memory and their files if you can; if you cannot find it, reply NONE.")"
lacks "the admin's conversation cannot get it" "$T" "$LOCK"
lacks "...not from shared memory either" "$(api "$ADMIN_JWT" GET "/memory/v4/search?q=$LOCK")" "$LOCK"

echo "== the admin keeps a note in their Personal Files"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "accounts e2e file $TAG")" "Save a note in my Personal Files (users/$ADMIN_SLUG/) named e2e-note-$TAG.md containing the line $AFILE. Reply with one line.")"
check "it is in the admin's private tree" "yes" "$(R "docker exec -u 1001 $C sh -c 'grep -lr $AFILE $P/users/$ADMIN_SLUG/ >/dev/null 2>&1 && echo yes || echo no'")"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "accounts e2e peek $TAG")" "Find the line that starts with ADMINFILE in the project files, anywhere you can look, and print it. If you cannot find it, reply NONE.")"
lacks "the member's conversation cannot find it" "$T" "$AFILE"
lacks "...nor the member's file search" "$(api "$MEMBER_JWT" GET "/files/search?q=$AFILE")" "$AFILE"
has "the admin's own file search finds it" "$(api "$ADMIN_JWT" GET "/files/search?q=$AFILE")" "$AFILE"

echo "== the admin shares a file with the team"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "accounts e2e share $TAG")" "Create a shared team file E2E-shared/notes-$TAG.md (in the shared workspace, not my personal files) containing the line $SFILE. Reply with one line.")"
check "it is in the shared space" "yes" "$(R "docker exec -u 1001 $C sh -c 'test -f $P/E2E-shared/notes-$TAG.md && echo yes || echo no'")"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "accounts e2e read $TAG")" "Read the file E2E-shared/notes-$TAG.md and print its line that starts with SHAREDFILE.")"
has "the member's conversation reads the shared file" "$T" "$SFILE"

finish
