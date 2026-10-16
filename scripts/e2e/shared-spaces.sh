#!/usr/bin/env bash
# Shared spaces and integrations:
#   - turn slots: every roster entry has one, the private trees are its uid's,
#     a member's uid cannot open the admin's tree at the kernel level, a real
#     turn of the member runs as that uid;
#   - locks: read-only for everyone through the API and through a real turn;
#   - integrations with a reach: a member's own connection is keyed by them,
#     stays out of the bot's config, shows on the list the right way, and
#     leaves with them.
# Needs a member on the roster. Five real model turns (on the operator's
# Claude plan) and a 65 s pause for the integrations rate limit. About 3–4
# minutes.  E2E_CLIENT=<client> bash scripts/e2e/shared-spaces.sh
source "$(dirname "$0")/lib.sh"
need_member

echo "== turn slots"
ADMIN_SLOT="$(echo "$ROSTER" | jsonq 'next((e.get("slot") for e in a if e["role"]=="admin"), "")')"
MEMBER_SLOT="$(echo "$ROSTER" | jsonq 'next((e.get("slot") for e in a if e["role"]!="admin"), "")')"
check "the admin has a slot" "yes" "$([ -n "$ADMIN_SLOT" ] && echo yes || echo no)"
check "the member has a different one" "yes" "$([ -n "$MEMBER_SLOT" ] && [ "$MEMBER_SLOT" != "$ADMIN_SLOT" ] && echo yes || echo no)"
MS="$(printf '%02d' "${MEMBER_SLOT:-0}")"; AS="$(printf '%02d' "${ADMIN_SLOT:-0}")"
check "the pool users exist in the container" "yes" "$(R "docker exec $C sh -c 'id turn-$MS >/dev/null 2>&1 && id turn-group >/dev/null 2>&1 && echo yes || echo no'")"
check "the member's private tree is their slot's (owner turn-$MS, group priv-$MS, 2770)" "turn-$MS priv-$MS 2770" "$(R "docker exec $C stat -c '%U %G %a' /home/coder/project/users/$MEMBER_SLUG 2>/dev/null")"
check "...their memory too" "turn-$MS priv-$MS 2770" "$(R "docker exec $C stat -c '%U %G %a' /home/coder/project/memory/users/$MEMBER_SLUG 2>/dev/null")"
check "the admin's tree is the admin's slot's" "turn-$AS priv-$AS 2770" "$(R "docker exec $C stat -c '%U %G %a' /home/coder/project/users/$ADMIN_SLUG 2>/dev/null")"
R "docker exec -u root $C sh -c 'echo \"the secret word is PAPRYKA-$TAG\" > /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md && chown turn-$AS:priv-$AS /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md && chmod 660 /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md'" >/dev/null 2>&1
check "the kernel keeps the member's uid out of the admin's tree" "denied" "$(R "docker exec -u turn-$MS $C cat /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md 2>&1 | grep -q -i 'permission denied' && echo denied || echo READ")"
check "...and the group turn's uid too" "denied" "$(R "docker exec -u turn-group $C cat /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md 2>&1 | grep -q -i 'permission denied' && echo denied || echo READ")"
check "...while workspace-api reads it" "yes" "$(R "docker exec -u wsapi $C cat /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md 2>/dev/null | grep -q PAPRYKA && echo yes || echo no")"
check "...and the brain (bot) reads the operator's" "yes" "$(R "docker exec -u bot $C cat /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md 2>/dev/null | grep -q PAPRYKA && echo yes || echo no")"
check "the bot's config is not readable by a turn user" "no" "$(R "docker exec -u turn-$MS $C cat /home/bot/.claude.json >/dev/null 2>&1 && echo yes || echo no")"
check "a slot's run directory is its group's, 2730" "root priv-$MS 2730" "$(R "docker exec $C stat -c '%U %G %a' /run/turns/$MS 2>/dev/null")"
S="$(new_session "$MEMBER_JWT" "slots e2e $TAG")"
T="$(turn "$MEMBER_JWT" "$S" "Run this shell command and reply with its output only: id -un")"
has "a real turn of the member runs as their slot's user" "$T" "turn-$MS"
T="$(turn "$MEMBER_JWT" "$S" "Run this shell command and show its output: cat /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md")"
lacks "...and cannot read the admin's file through the shell" "$T" "PAPRYKA-$TAG"
R "docker exec -u root $C rm -f /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md" >/dev/null 2>&1

echo "== locks"
R "docker exec -u wsapi $C sh -c 'mkdir -p /home/coder/project/E2E-locks && echo one > /home/coder/project/E2E-locks/plan-$TAG.md'" >/dev/null 2>&1
check "a member cannot lock" "403" "$(code "$MEMBER_JWT" POST /files/lock '{"path":"E2E-locks"}')"
check "an admin locks the folder" "200" "$(code "$ADMIN_JWT" POST /files/lock '{"path":"E2E-locks"}')"
check "the member cannot write under it" "403" "$(code "$MEMBER_JWT" POST /files/write '{"path":"E2E-locks/plan-'"$TAG"'.md","content":"x"}')"
check "...nor the admin" "403" "$(code "$ADMIN_JWT" POST /files/write '{"path":"E2E-locks/plan-'"$TAG"'.md","content":"x"}')"
has "the tree marks it" "$(api "$ADMIN_JWT" GET '/files/tree?path=E2E-locks')" '"inherited":true'
has "...with the admin's name" "$(api "$MEMBER_JWT" GET '/files/tree')" '"byName"'
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "locks e2e $TAG")" "Append the line LOCKTEST-$TAG to the file E2E-locks/plan-$TAG.md in the project, then reply with one sentence saying whether you could.")"
lacks "a real turn (the admin's) cannot change a locked file" "$(R "docker exec $C cat /home/coder/project/E2E-locks/plan-$TAG.md")" "LOCKTEST-$TAG"
has "...and says it is locked" "$T" "lock"
check "an admin unlocks" "200" "$(code "$ADMIN_JWT" POST /files/unlock '{"path":"E2E-locks"}')"
check "...and the member writes again" "200" "$(code "$MEMBER_JWT" POST /files/write '{"path":"E2E-locks/plan-'"$TAG"'.md","content":"two"}')"
code "$ADMIN_JWT" DELETE "/files/delete?path=E2E-locks" >/dev/null

echo "== integrations with a reach"
L="$(api "$MEMBER_JWT" GET /integrations)"
check "the list carries reach fields" "yes" "$(echo "$L" | jsonq '"yes" if all(k in a["integrations"][0] for k in ("personal","mine","canConnectPersonal","canConnectWorkspace")) else "no"')"
check "a member cannot connect for the workspace" "403" "$(code "$MEMBER_JWT" PUT /integrations/trello '{"fields":{"TRELLO_API_KEY":"e2e-key-'"$TAG"'","TRELLO_TOKEN":"e2e-token-'"$TAG"'"}}')"
check "...but can for themselves" "200" "$(code "$MEMBER_JWT" PUT "/integrations/trello?reach=personal" '{"fields":{"TRELLO_API_KEY":"e2e-key-'"$TAG"'","TRELLO_TOKEN":"e2e-token-'"$TAG"'"}}')"
check "the store holds it under the member's key" "yes" "$(R "docker exec -u wsapi $C python3 -c \"import json; a=json.load(open('/var/wsapi-store/credentials.json')); print('yes' if 'trello@$MEMBER_SLUG' in a and a['trello@$MEMBER_SLUG'].get('reach')=='personal' else 'no')\"")"
check "the bot's config does not name it" "no" "$(R "docker exec -u wsapi $C sh -c 'grep -q trello-mine /home/bot/.claude.json && echo yes || echo no'")"
has "the member sees it as their own" "$(api "$MEMBER_JWT" GET /integrations | jsonq 'json.dumps(next(i for i in a["integrations"] if i["id"]=="trello")["mine"])')" '"active": true'
has "the admin sees who has their own" "$(api "$ADMIN_JWT" GET /integrations | jsonq 'json.dumps(next(i for i in a["integrations"] if i["id"]=="trello").get("activeFor"))')" "$MEMBER_SLUG"
has "the page shows the member their own, secrets masked" "$(api "$MEMBER_JWT" GET /integrations/trello)" '"summary"'
lacks "...never in clear" "$(api "$MEMBER_JWT" GET /integrations/trello)" "e2e-token-$TAG"
has "the member's own test probe answers" "$(api "$MEMBER_JWT" POST "/integrations/trello/test?reach=personal")" '"ok":true'
S="$(new_session "$MEMBER_JWT" "reach e2e $TAG")"
T="$(turn "$MEMBER_JWT" "$S" "List the names of the MCP tools you have whose name contains trello, one per line, nothing else. If none, say NONE.")"
has "the member's turn has their own Trello (trello-mine)" "$T" "trello-mine"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "reach e2e admin $TAG")" "List the names of the MCP tools you have whose name contains trello-mine, one per line, nothing else. If none, say NONE.")"
has "...and the admin's turn does not" "$T" "NONE"
check "another member cannot remove it (as the admin, with the wrong slug it is 404)" "404" "$(code "$ADMIN_JWT" DELETE "/integrations/trello?reach=personal&slug=nobody-$TAG")"
check "the member removes their own" "200" "$(code "$MEMBER_JWT" DELETE "/integrations/trello?reach=personal")"
check "...and it is gone from the store" "no" "$(R "docker exec -u wsapi $C python3 -c \"import json; a=json.load(open('/var/wsapi-store/credentials.json')); print('yes' if 'trello@$MEMBER_SLUG' in a else 'no')\"")"

echo "== tonight's additions: any service for oneself, sources by key, the sharing-questions mark"
sleep 65   # the integrations routes are rate-limited per person per minute; the suite above used the budget
check "a member connects a service with no personal flag for themselves (Shopify)" "200" "$(code "$MEMBER_JWT" PUT "/integrations/shopify?reach=personal" '{"fields":{"SHOPIFY_STORE_DOMAIN":"e2e.myshopify.com","SHOPIFY_CLIENT_ID":"a","SHOPIFY_CLIENT_SECRET":"b"}}')"
check "...and removes it" "200" "$(code "$MEMBER_JWT" DELETE "/integrations/shopify?reach=personal")"
check "the bot's own Telegram cannot be anyone's own" "400" "$(code "$MEMBER_JWT" PUT "/integrations/telegram?reach=personal" '{"fields":{"TELEGRAM_BOT_TOKEN":"1:x","TELEGRAM_ADMIN_CHAT_ID":"1"}}')"
SRC="$(api "$ADMIN_JWT" GET /memory/v4/sources)"
if echo "$SRC" | jsonq "1 if a.get('items') else 0" | grep -q 1; then
  has "a person's sources carry their connection key" "$SRC" '"key":'
else
  skip "a person's sources carry their connection key" "no notetaker connected here"
fi
PRIV="$(api "$MEMBER_JWT" GET /memory/v4/privacy)"
has "the privacy answer says whether there is a team" "$PRIV" '"teamMode":'
has "...and when the bot was last told that questions wait" "$PRIV" '"mentionedAt":'
LIST="$(api "$MEMBER_JWT" GET /integrations)"
lacks "no description carries a dash" "$LIST" "\u2014"
echo "== logs"
ERR="$(R "docker exec -u coder $C sh -c 'tail -400 /home/coder/.\${BOT_NAME:-bot}/workspace-api-error.log 2>/dev/null | grep -a -i -E \"priv-tree|turn-slots|turn-runner|locks|reach|TypeError|ReferenceError\" | grep -v \"no turn slot\" | tail -6'")"
check "no errors from the new code" "0" "$(echo -n "$ERR" | grep -c .)"
echo "$ERR" | cut -c1-200 | sed 's/^/       /'
finish
