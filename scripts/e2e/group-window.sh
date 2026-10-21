#!/usr/bin/env bash
# The group's memory over time: a decision posted in the test group is filed
# once the group goes quiet; a later message about the same thing ("ok, sent")
# is filed as its own window and shows up today — a new version of the fact
# with the old one as history, or a fact of its own — counted in Changes, never
# folded into the old fact in place where nobody sees it, and carrying no file
# the conversation did not write. Then
# a note the bot saves mid-turn never tells the person memory is down. Needs a
# registered test group the admin is in (E2E_GROUP_TITLE, or the first group
# whose title contains "test"). Two group turns, one direct turn and two
# consolidator filings on the operator's Claude plan. About 5–10 minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/group-window.sh
source "$(dirname "$0")/lib.sh"

GROUP_LINE="$(R "docker exec $C python3 -c \"import json,sys; g=json.load(open('$P/.team-config.json')).get('groups',{}); w=sys.argv[1].strip().lower(); m=[(k,v.get('title') or '') for k,v in g.items() if ((v.get('title') or '').lower()==w if w else 'test' in (v.get('title') or '').lower())]; print(m[0][0]+chr(9)+''.join(c for c in m[0][1] if c not in chr(39)+chr(34)+chr(96)+chr(36)+chr(92)) if m else '')\" '${E2E_GROUP_TITLE:-}'")"
GROUP="${GROUP_LINE%%$'\t'*}"; GROUP_TITLE="${GROUP_LINE#*$'\t'}"
ADMIN_NAME="$(echo "$ROSTER" | jsonq 'next(("".join(c for c in (e.get("displayName") or e["email"].split("@")[0]) if c not in chr(39)+chr(34)+chr(96)+chr(36)+chr(92)) for e in a if e["role"]=="admin"), "Admin")')"
ADMIN_TG="$(echo "$ROSTER" | jsonq 'next((str(e.get("telegramChatId") or "") for e in a if e["role"]=="admin"), "")')"
check "the test group is registered" "yes" "$([ -n "$GROUP" ] && echo yes || echo no)"
[ -n "$GROUP" ] && [ -n "$ADMIN_TG" ] || { echo "group-window: no group or no admin Telegram id — not run"; exit 1; }
HIST="$P/.group-watcher/$GROUP-history.jsonl"
FACTS="$P/memory/groups/$GROUP/facts.jsonl"
MARK="ORW-$TAG"
TODAY="$(date -u +%Y-%m-%d)"

# Post a message into the group as the admin (mentioning the bot) and wait for the bot's reply there.
gsay() {
  local mid="9$TAG$(date +%N | cut -c1-4)$RANDOM"
  R "docker exec -u bot $C node -e \"fetch('http://127.0.0.1:3001/api/internal/group-message',{method:'POST',headers:{'Content-Type':'application/json','X-IDE-Turn':require('fs').readFileSync('/home/bot/.'+(process.env.BOT_NAME||'bot')+'/turn-id','utf8').trim()},body:JSON.stringify({chat_id:'$GROUP',chat_title:'$GROUP_TITLE',message_id:'$mid',from_id:'$ADMIN_TG',from_name:'$ADMIN_NAME',is_mention:true,text:process.argv[1]})}).then(r=>console.log(r.status))\" \"$1\"" >/dev/null
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

# Age the group's transcript past the idle window, poke the consolidator and
# wait until the group's facts hold the given text (up to ~5 minutes).
file_group() {
  R "docker exec -u root $C touch -d '20 minutes ago' $HIST"
  local i out
  for i in $(seq 1 30); do
    out="$(R "docker exec $C curl -s -X POST http://127.0.0.1:3001/api/internal/memory/consolidate")"
    R "docker exec -u 1001 $C sh -c 'cat $FACTS 2>/dev/null'" | grep -qi -- "$1" && return 0
    sleep 10
  done
  echo "       last consolidate: $(echo "$out" | head -c 300)"
  return 1
}
facts_about() { # python: the group's facts file, analysed
  R "docker exec -u 1001 $C python3 -c \"
import json,sys
ev=[]
for l in open('$FACTS'):
  try: ev.append(json.loads(l))
  except Exception: pass
mark='$MARK'.lower()
def about(e): t=((e.get('title') or '')+' '+(e.get('text') or '')).lower(); return mark in t or 'quote request' in t
adds={e['id']:dict(e) for e in ev if e.get('op')=='add'}
for e in ev:
  if e.get('op')=='amend' and e['id'] in adds: adds[e['id']].update({k:v for k,v in e.items() if k in ('title','text','kind')}); adds[e['id']]['amended']=adds[e['id']].get('amended',0)+1
  if e.get('op')=='update' and e['id'] in adds: adds[e['id']].setdefault('updates',[]).append(e.get('text',''))
  if e.get('op') in ('replace','hide','retire') and e['id'] in adds: adds[e['id']]['gone']=e.get('op')
mine=[f for f in adds.values() if about(f)]
first=sorted(mine, key=lambda f: f.get('at') or f.get('ts'))[0] if mine else None
current=[f for f in mine if not f.get('gone')]
later=[f for f in current if 'quote request' in (f.get('text','')+' '.join(f.get('updates',[]))).lower()]
inplace=bool(first and 'quote request' in (first.get('text') or '').lower() and not first.get('gone') and first.get('amended') and not first.get('updates'))
proper=any(f.get('replaces')==(first or {}).get('id') for f in later) or any(f['id']==(first or {}).get('id') and f.get('updates') for f in later)
print(json.dumps({'facts':len(mine),'current':len(current),'later':len(later),'inplace':inplace,'proper':proper,'firstAt':(first or {}).get('at'),'laterAt':[f.get('at') for f in later]}))
\""
}

echo "== window 1: the decision"
G="$(gsay "@bot Decision for the record: for project $MARK we move the packaging print run from the current printer to a cheaper local one; the current quote is 900 eur. Acknowledge in one short line, nothing else.")"
check "the bot answered in the group" "yes" "$([ -n "$G" ] && echo yes || echo no)"
ok "the decision is filed as a fact once the group goes quiet" "$(file_group "$MARK" && echo 1 || echo 0)"
A1="$(facts_about)"
echo "       facts: $A1"
check "one fact about the decision" "1" "$(echo "$A1" | jsonq 'a["current"]')"

echo "== window 2, later: ok, sent"
G="$(gsay "@bot Update for the record on $MARK: the quote requests went out today to the two local printers, with purchasing on cc; now waiting for their answers. One short line is enough.")"
check "the bot answered again" "yes" "$([ -n "$G" ] && echo yes || echo no)"
ok "the update is filed as a fact once the group goes quiet" "$(file_group "quote request" && echo 1 || echo 0)"
A2="$(facts_about)"
echo "       facts: $A2"
# Whether the model calls the later step the same thing (a new version or a
# dated remark under the decision) or a thing of its own ("a cause and its
# consequence are unrelated"), it must be SEEN: dated today, never the old
# fact reworded in place where nobody looks.
check "the update is in memory" "1" "$(echo "$A2" | jsonq '1 if a["later"] else 0')"
check "...never folded into the old fact in place" "no" "$(echo "$A2" | jsonq '"yes" if a["inplace"] else "no"')"
check "...dated today, so the Facts list shows it on top" "yes" "$(echo "$A2" | jsonq '"yes" if any(str(x or "").startswith("'"$TODAY"'") for x in a["laterAt"]) else "no"')"
echo "       as: $(echo "$A2" | jsonq '"a new version of the decision" if a["proper"] else "a fact of its own"')"
EV="$(R "docker exec -u 1001 $C sh -c 'grep \"\\\"op\\\":\\\"file\\\"\" $P/memory/_engine/v4-log.jsonl | grep \"group:$GROUP\" | tail -1'")"
echo "       changes: $(echo "$EV" | head -c 240)"
check "Changes counts it (a fact or a correction, not 0)" "yes" "$(echo "$EV" | jsonq '"yes" if (a.get("notes") or 0)+(a.get("updated") or 0)+(a.get("superseded") or 0) > 0 else "no"')"
# The Facts screen, as the admin: the group fact with its history or remark.
FX="$(api "$ADMIN_JWT" GET "/memory/v4/facts?scope=group&limit=100")"
check "the Facts screen shows the update under today" "yes" "$(echo "$FX" | jsonq '"yes" if any("quote request" in ((i.get("title") or "")+" "+(i.get("text") or "")+" "+" ".join(u.get("text","") for u in i.get("updates") or [])).lower() and str(i.get("ts","")).startswith("'"$TODAY"'") for i in a.get("items",[])) else "no"')"
check "...with no file the conversation did not write" "yes" "$(echo "$FX" | jsonq '"yes" if not any("'"$MARK"'".lower() in ((i.get("title") or "")+" "+(i.get("text") or "")).lower() and i.get("files") for i in a.get("items",[])) else "no"')"

echo "== a note mid-turn never says memory is down"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "group-window e2e $TAG")" "Remember this, just for me: the $MARK printer contact is Ms Brook at Harbor Print. Reply with one short line.")"
lacks "the turn answers" "$T" "[[ERROR"
lacks "the bot never claims memory is unreachable" "$T" "unreachable"
lacks "...or down" "$T" "memory server"
RG="$(R "docker exec -u 1001 -e PROJECT_DIR=$P -e WSAPI_STORE_DIR=/var/wsapi-store -w $WS $C node --input-type=module -e \"const m=await import('$WS/lib/memory-regate.js'); console.log(JSON.stringify(await m.regateUngated({cap:5})))\"" 2>/dev/null | tail -1)"
echo "       regate: $RG"
has "the night's second look runs" "$RG" "\"records\""

finish
