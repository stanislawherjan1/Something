#!/usr/bin/env bash
# The sharing model: the Sharing screen's routes as the admin and as a member,
# then one real private web turn by the member — a work fact and a personal
# one — filed by the consolidator (the transcript is aged past the idle window
# and the consolidator poked), and what of it the team can see: the work fact
# as a fact in the member's name, the personal one never. Then "make private"
# and "restore". Needs a member on the roster. One real model turn plus the
# consolidator's filing (on the operator's Claude plan). About 2–4 minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/sharing.sh
source "$(dirname "$0")/lib.sh"
need_member

CLIENT="Vellmark-$TAG"       # fictional; the run tag keeps it findable for the cleanup even when the model rewords
PROJECT="Quarry-$TAG"

ADMIN_MODE0="$(api "$ADMIN_JWT" GET /memory/v4/privacy | jsonq 'a.get("mode")')"
echo "== the Sharing screen's routes"
P="$(api "$MEMBER_JWT" GET /memory/v4/privacy)"
check "privacy answers with a mode, rules and asks for the member" "ok" "$(echo "$P" | jsonq '"ok" if a.get("ok") and a.get("mode") in ("ask","auto","never") and isinstance(a.get("rules"),list) and isinstance(a.get("asks"),list) and isinstance(a.get("sharedFromMe"),list) else a')"
check "the default mode is ask" "ask" "$(echo "$P" | jsonq 'a.get("mode")')"
check "an unknown mode is refused" "false" "$(api "$MEMBER_JWT" POST /memory/v4/sharing/mode '{"mode":"everything"}' | jsonq 'str(a.get("ok")).lower()')"
check "the member switches to automatic sharing" "auto" "$(api "$MEMBER_JWT" POST /memory/v4/sharing/mode '{"mode":"auto"}' | jsonq 'a.get("mode")')"
check "...and the screen shows it" "auto" "$(api "$MEMBER_JWT" GET /memory/v4/privacy | jsonq 'a.get("mode")')"
check "the admin's own mode is untouched" "$ADMIN_MODE0" "$(api "$ADMIN_JWT" GET /memory/v4/privacy | jsonq 'a.get("mode")')"

echo "== a private web turn by the member: a work fact and a personal one"
S="$(new_session "$MEMBER_JWT" "sharing e2e $TAG")"
check "a member's session is created" "yes" "$([ -n "$S" ] && echo yes || echo no)"
T="$(turn "$MEMBER_JWT" "$S" "Two things to remember, no need to do anything: $CLIENT starts the warehouse pilot for project $PROJECT on 4 November. And privately, just for you: I have a job offer from a recruiter for a head of operations role elsewhere — keep that between us. Reply with one short line.")"
lacks "the turn answers without an error" "$T" "[[ERROR"
# Age the transcript past the idle window and poke the consolidator (it runs on
# loopback inside the container; the monitor normally pokes it every minute).
R "docker exec -u root $C sh -c 'f=\$(ls -t /home/coder/project/.team/users/$MEMBER_SLUG/chats/*.jsonl | head -1); touch -d \"20 minutes ago\" \"\$f\"; echo \$f'" | sed 's/^/       aged: /'
OUT="$(R "docker exec $C curl -s -X POST http://127.0.0.1:3001/api/internal/memory/consolidate")"
echo "       consolidate: $(echo "$OUT" | head -c 300)"
# The server's own sweep may have picked the aged file up first: wait for it, then poke again.
for i in $(seq 1 24); do
  echo "$OUT" | grep -q '"in-progress"' || break
  sleep 5
  OUT="$(R "docker exec $C curl -s -X POST http://127.0.0.1:3001/api/internal/memory/consolidate")"
  echo "       consolidate (again): $(echo "$OUT" | head -c 200)"
done
has "the consolidator filed the member's conversation" "$OUT" "\"sources\":"

echo "== what crossed"
P="$(api "$MEMBER_JWT" GET /memory/v4/privacy)"
has "the work fact reached the team by itself (mode auto)" "$(echo "$P" | jsonq 'json.dumps(a.get("sharedFromMe"))')" "$PROJECT"
lacks "...the personal one did not" "$(echo "$P" | jsonq 'json.dumps(a.get("sharedFromMe"))')" "recruiter"
lacks "...and no conversation line crossed (the fact, not the excerpt)" "$(echo "$P" | jsonq 'json.dumps(a.get("sharedFromMe"))')" "no need to do anything"
TEAM="$(api "$ADMIN_JWT" GET "/memory/v4/facts?history=1&limit=500" | jsonq 'json.dumps([f for f in a.get("items",[]) if f.get("scope")=="shared"])')"
has "the admin sees the work fact in shared memory" "$TEAM" "$PROJECT"
lacks "...and never the member's personal fact" "$TEAM" "recruiter"
lacks "...nor the job offer" "$TEAM" "job offer"
FID="$(echo "$P" | jsonq "next((x['id'] for x in a.get('sharedFromMe',[]) if '$PROJECT' in json.dumps(x)), '')")"
if [ -n "$FID" ]; then
  check "the admin cannot withdraw the member's fact" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/api/memory/v4/shared/$FID/withdraw")"
  check "the member makes it private" "true" "$(api "$MEMBER_JWT" POST "/memory/v4/shared/$FID/withdraw" | jsonq 'str(a.get("ok")).lower()')"
  lacks "...and the admin no longer sees it" "$(api "$ADMIN_JWT" GET "/memory/v4/facts?history=1&limit=500" | jsonq 'json.dumps([f for f in a.get("items",[]) if f.get("scope")=="shared"])')" "$PROJECT"
  check "the member restores it" "true" "$(api "$MEMBER_JWT" POST "/memory/v4/shared/$FID/restore" | jsonq 'str(a.get("ok")).lower()')"
  has "...and the admin sees it again" "$(api "$ADMIN_JWT" GET "/memory/v4/facts?history=1&limit=500" | jsonq 'json.dumps([f for f in a.get("items",[]) if f.get("scope")=="shared"])')" "$PROJECT"
  api "$MEMBER_JWT" POST "/memory/v4/shared/$FID/withdraw" >/dev/null   # leave the team's memory as it was
else
  FAIL=$((FAIL+3)); echo "  FAIL withdraw/restore skipped — no shared fact to act on"
fi

echo "== back to ask-first, and the questions' shape"
check "the member goes back to ask-first" "ask" "$(api "$MEMBER_JWT" POST /memory/v4/sharing/mode '{"mode":"ask"}' | jsonq 'a.get("mode")')"
ASKS="$(api "$MEMBER_JWT" GET /memory/v4/privacy | jsonq 'json.dumps(a.get("asks"))')"
check "every pending question carries its fact and whom it concerns" "yes" "$(echo "$ASKS" | python3 -c 'import json,sys; a=json.load(sys.stdin); print("yes" if all(("fact" in x and "aboutPerson" in x) or x.get("fact") is None for x in a) else "no")')"
echo "       pending for the member: $(echo "$ASKS" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(len(a))')"

echo "== logs"
ERR="$(R "docker exec -u coder $C sh -c 'tail -300 /home/coder/.\${BOT_NAME:-bot}/workspace-api-error.log 2>/dev/null | grep -a -i -E \"memory-sharing|sharing|TypeError|ReferenceError\" | tail -5'")"
check "no errors from the sharing code" "0" "$(echo -n "$ERR" | grep -c .)"
echo "$ERR" | cut -c1-200 | sed 's/^/       /'
finish
