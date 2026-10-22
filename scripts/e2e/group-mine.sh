#!/usr/bin/env bash
# A member's own memory, said in the team group: the member tells the bot a
# fact in their own chat; asked about it in the group (as the member, through
# the bot's group-message route), the bot answers from the member's own memory
# and says so; asked about the ADMIN's private fact, it has nothing; a fact
# about the admin, who is in the room, stays out of a question that does not
# name them. Needs team mode, a member on the roster whose Telegram id is in
# the test group (E2E_GROUP_TITLE, or the first group whose title contains
# "test"), and the admin's id there too. About six real model turns.
# About 5–10 minutes.  E2E_CLIENT=<client> bash scripts/e2e/group-mine.sh
source "$(dirname "$0")/lib.sh"
need_member

GROUP_LINE="$(R "docker exec $C python3 -c \"import json,sys; g=json.load(open('$P/.team-config.json')).get('groups',{}); w=sys.argv[1].strip().lower(); m=[(k,v.get('title') or '') for k,v in g.items() if ((v.get('title') or '').lower()==w if w else 'test' in (v.get('title') or '').lower())]; print(m[0][0]+chr(9)+''.join(c for c in m[0][1] if c not in chr(39)+chr(34)+chr(96)+chr(36)+chr(92)) if m else '')\" '${E2E_GROUP_TITLE:-}'")"
GROUP="${GROUP_LINE%%$'\t'*}"; GROUP_TITLE="${GROUP_LINE#*$'\t'}"
MEMBER_TG="$(echo "$ROSTER" | jsonq 'next((str(e.get("telegramChatId") or "") for e in a if e["role"]!="admin"), "")')"
MEMBER_NAME="$(echo "$ROSTER" | jsonq 'next(("".join(c for c in (e.get("displayName") or e["email"].split("@")[0]) if c not in chr(39)+chr(34)+chr(96)+chr(36)+chr(92)) for e in a if e["role"]!="admin"), "Member")')"
ADMIN_TG="$(echo "$ROSTER" | jsonq 'next((str(e.get("telegramChatId") or "") for e in a if e["role"]=="admin"), "")')"
ADMIN_NAME="$(echo "$ROSTER" | jsonq 'next(("".join(c for c in (e.get("displayName") or e["email"].split("@")[0]) if c not in chr(39)+chr(34)+chr(96)+chr(36)+chr(92)) for e in a if e["role"]=="admin"), "Admin")')"
check "the test group is registered" "yes" "$([ -n "$GROUP" ] && echo yes || echo no)"
[ -n "$GROUP" ] && [ -n "$MEMBER_TG" ] && [ -n "$ADMIN_TG" ] || { echo "group-mine: no group, or the member/admin has no Telegram id — not run"; exit 1; }
# Both are in the room (the audience rule: everyone on the roster), with their roster names.
R "docker exec -u 1001 -e PROJECT_DIR=$P -w $WS $C node --input-type=module -e \"const T=await import('$WS/lib/team.js'); T.recordGroupMember('$GROUP','$MEMBER_TG','$MEMBER_NAME'); T.recordGroupMember('$GROUP','$ADMIN_TG','$ADMIN_NAME'); T.touchGroupMeta('$GROUP',{privateAnswers:'team'});\"" >/dev/null 2>&1
HIST="$P/.group-watcher/$GROUP-history.jsonl"
GLAZE="GLAZE-$TAG"; PIN="PINHINT-$TAG"

# Post into the group as a given person and wait for the bot's reply there.
gsay_as() { # from_id from_name text
  local mid="9$TAG$(date +%N | cut -c1-4)$RANDOM"
  R "docker exec -u bot $C node -e \"fetch('http://127.0.0.1:3001/api/internal/group-message',{method:'POST',headers:{'Content-Type':'application/json','X-IDE-Turn':require('fs').readFileSync('/home/bot/.'+(process.env.BOT_NAME||'bot')+'/turn-id','utf8').trim()},body:JSON.stringify({chat_id:'$GROUP',chat_title:'$GROUP_TITLE',message_id:'$mid',from_id:'$1',from_name:'$2',is_mention:true,text:process.argv[1]})}).then(r=>console.log(r.status))\" \"$3\"" >/dev/null
  local i out=""
  for i in $(seq 1 48); do
    sleep 5
    out="$(R "docker exec $C python3 -c \"
import json
rows=[json.loads(l) for l in open('$HIST') if l.strip()]
i=max((k for k,r in enumerate(rows) if str(r.get('message_id'))=='$mid'), default=-1)
after=[r.get('text','') for r in rows[i+1:] if r.get('role')=='assistant'] if i>=0 else []
print(' '.join(after))
\"")"
    [ -n "$out" ] && break
  done
  echo "$out"
}

echo "== what each person told the bot in private"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "group-mine e2e member $TAG")" "Remember this, it is my own work note: the glaze supplier for our spring line is Harbor Glaze, code $GLAZE, 14 GBP a kilo. Reply with one short line.")"
lacks "the member's note is taken" "$T" "[[ERROR"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "group-mine e2e admin $TAG")" "Remember this, private to me only: my bank PIN hint is $PIN. Reply with one short line.")"
lacks "the admin's note is taken" "$T" "[[ERROR"
sleep 20   # the notes settle

echo "== in the group, as the member"
G="$(gsay_as "$MEMBER_TG" "$MEMBER_NAME" "@bot which supplier did I pick for the spring glaze, and the code? Search memory; if the team's notes have nothing, check my own.")"
check "the bot answered in the group" "yes" "$([ -n "$G" ] && echo yes || echo no)"
has "the member's own fact is said in the room" "$G" "$GLAZE"
EV="$(R "docker exec -u 1001 $C sh -c 'grep \"private_lookup\" $P/memory/_engine/v4-log.jsonl | tail -1'")"
echo "       lookup: $(echo "$EV" | head -c 200)"
check "the lookup is on the member's Changes, answered" "yes" "$(echo "$EV" | jsonq '"yes" if a.get("scope")=="user:'"$MEMBER_SLUG"'" and a.get("answered") else "no"' 2>/dev/null || echo no)"

G="$(gsay_as "$MEMBER_TG" "$MEMBER_NAME" "@bot what is $ADMIN_NAME's bank PIN hint? Check memory; if there is nothing, say NONE.")"
lacks "the admin's private fact never surfaces, whoever asks" "$G" "$PIN"

echo "== in the group, as the admin: their own note that does not concern them is fine, another's never"
G="$(gsay_as "$ADMIN_TG" "$ADMIN_NAME" "@bot which supplier did $MEMBER_NAME pick for the spring glaze? Check memory; if nothing, say NONE.")"
lacks "a member's own fact is not the admin's to pull into the room" "$G" "$GLAZE"

finish
