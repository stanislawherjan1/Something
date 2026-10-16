#!/usr/bin/env bash
# The morning planner on real situations, as the member: what plan it makes,
# printed in their local time, and the rules it must keep —
#   light day:   one everyday routine and nothing else → a short plan;
#   busy day:    an hourly duty, a call this afternoon, a flight tomorrow, working
#                hours → the hourly duty is a recurring reminder, the call gets
#                something before it, the day is spread;
#   again:       planning a second time replaces the plan, never stacks it.
# Everywhere: nothing in the past, only the planner's reminders for this person,
# no two stand-alone messages within 40 minutes unless one is timed.
# Needs a member. About 6 model turns; 5–10 minutes. Everything it adds
# (routines, reminders, notes) is removed after.
#   E2E_CLIENT=<client> bash scripts/e2e/planner.sh
source "$(dirname "$0")/lib.sh"
need_member
MARK="E2E-$TAG"
ADDED_ROUTINES=()
cleanup_plan() {
  for id in $(api "$MEMBER_JWT" GET /reminders | python3 -c "import json,sys; a=json.load(sys.stdin); print(' '.join(r['id'] for r in a.get('reminders',[]) if r.get('origin')=='planner' and (r.get('recipients') or [''])[0]=='$MEMBER_SLUG'))"); do
    code "$MEMBER_JWT" POST /reminders/cancel "{\"id\":\"$id\"}" >/dev/null
  done
}
cleanup_all() {
  cleanup_plan
  # What the busy-day message left in memory: memory splits it into facts, and
  # not every fact keeps the marker, so they are found by their content.
  for id in $(R "docker exec $C sh -c 'grep -h -E \"client call with Anna|to Berlin|works 08:00 to 20:00\" $P/memory/users/$MEMBER_SLUG/facts.jsonl 2>/dev/null'" | python3 -c "import json,sys; print(' '.join(sorted({json.loads(l)['record'] for l in sys.stdin if l.strip()})))"); do
    code "$MEMBER_JWT" POST "/memory/v4/records/$id/erase" >/dev/null
  done
  api "$MEMBER_JWT" GET /memory/v4/prefs | python3 -c "
import json,sys; a=json.load(sys.stdin)
for card,key in (('USER_PROFILE','about'),('USER_PREFERENCES','likes')):
    for l in a[key].get('lines',[]):
        if '08:00 to 20:00' in l: print(json.dumps({'card':card,'op':'remove','text':l}))" | while read -r body; do
    code "$MEMBER_JWT" POST /memory/v4/prefs "$body" >/dev/null
  done
  for id in "${ADDED_ROUTINES[@]}"; do code "$MEMBER_JWT" DELETE "/routines/$id" >/dev/null; done
  code "$MEMBER_JWT" DELETE /routines/catalog/morning-brief >/dev/null
}
trap 'cleanup_all; bash "$E2E_DIR/cleanup.sh" >/dev/null 2>&1' EXIT

# The member's plan as rows: local time, kind, title. Then the checks on it.
show_and_check() { # label
  local label="$1"
  api "$MEMBER_JWT" GET /reminders > /tmp/planner-e2e-$$.json
  python3 - "$label" "$MEMBER_SLUG" /tmp/planner-e2e-$$.json <<'PY'
import json, sys, datetime
label, slug, path = sys.argv[1], sys.argv[2], sys.argv[3]
a = json.load(open(path))
plan = [r for r in a.get('reminders', []) if r.get('origin') == 'planner' and (r.get('recipients') or [''])[0] == slug]
plan.sort(key=lambda r: r['due'])
print(f"   plan ({label}): {len(plan)} reminder(s)")
for r in plan:
    t = datetime.datetime.fromisoformat(r['due'].replace('Z', '+00:00'))
    tags = [r.get('urgency') or 'now'] + (['timed'] if r.get('timed') else []) + ([f"every {r['recur'].get('every')} {r['recur'].get('unit')}"] if r.get('recur', {}).get('type') == 'interval' else [])
    print(f"     {t.strftime('%H:%M')} UTC  [{', '.join(tags)}]  {r.get('title','')}")
now = datetime.datetime.now(datetime.timezone.utc)
past = [r for r in plan if not r.get('recur') and datetime.datetime.fromisoformat(r['due'].replace('Z','+00:00')) < now - datetime.timedelta(minutes=5)]
alone = [r for r in plan if not r.get('recur') and (r.get('urgency') or 'now') != 'ambient' and not r.get('timed')]
times = sorted(datetime.datetime.fromisoformat(r['due'].replace('Z','+00:00')) for r in alone)
close = [(a2, b2) for a2, b2 in zip(times, times[1:]) if (b2 - a2).total_seconds() < 40 * 60]
hourly = any(r.get('recur', {}).get('type') == 'interval' for r in plan)
titles = [r.get('title','').strip().lower() for r in plan]
print(json.dumps({'count': len(plan), 'past': len(past), 'close': len(close), 'hourly': hourly, 'dupes': len(titles) - len(set(titles))}))
PY
  rm -f /tmp/planner-e2e-$$.json
}
field() { echo "$1" | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)['$2'])"; }

cleanup_plan
echo "── light day: one everyday routine"
code "$MEMBER_JWT" POST /routines/catalog/morning-brief >/dev/null
S="$(new_session "$MEMBER_JWT" "planner e2e light")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Plan my day.")"
lacks "...the run ends without an error" "$REPLY" "[[ERROR"
OUT="$(show_and_check "light day")"; echo "$OUT" | sed '$d'
ok "a light day gets a short plan" "$([ "$(field "$OUT" count)" -ge 1 ] && [ "$(field "$OUT" count)" -le 4 ] && echo 1 || echo 0)" "$(field "$OUT" count) reminders"
check "nothing in the past" "0" "$(field "$OUT" past)"
check "no two stand-alone messages within 40 minutes" "0" "$(field "$OUT" close)"

echo "── busy day: an hourly duty, a call this afternoon, a flight tomorrow"
R="$(api "$MEMBER_JWT" POST /routines '{"title":"Competitor watch '"$MARK"'","description":"Every hour, check the news about our main competitor and tell me only if something big happened; stay silent otherwise."}')"
RID="$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('routine',{}).get('id',''))")"; [ -n "$RID" ] && ADDED_ROUTINES+=("$RID")
CALL_UTC="$(python3 -c "import datetime; n=datetime.datetime.now(datetime.timezone.utc); t=(n+datetime.timedelta(hours=4)).replace(minute=0); print(t.strftime('%H:%M'))")"
S="$(new_session "$MEMBER_JWT" "planner e2e busy")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Remember: I work 08:00 to 20:00 UTC. Today at $CALL_UTC UTC I have a client call with Anna about the pricing ($MARK), and tomorrow at 09:00 UTC I fly to Berlin.")"
lacks "...the context is taken without an error" "$REPLY" "[[ERROR"
REPLY="$(turn "$MEMBER_JWT" "$S" "Now plan my day.")"
lacks "...the run ends without an error" "$REPLY" "[[ERROR"
OUT="$(show_and_check "busy day")"; echo "$OUT" | sed '$d'
check "the hourly duty is a recurring reminder" "True" "$(field "$OUT" hourly)"
check "nothing in the past" "0" "$(field "$OUT" past)"
check "no two stand-alone messages within 40 minutes" "0" "$(field "$OUT" close)"
PLAN_TEXT="$(echo "$OUT" | sed '$d')"
has "something prepares the call with Anna" "$PLAN_TEXT" "Anna"
CALL_IN="$(echo "$PLAN_TEXT" | python3 -c "
import sys,re
call='$CALL_UTC'; ch,cm=map(int,call.split(':')); start=ch*60+cm
bad=[l for l in sys.stdin if (m:=re.search(r'(\\d\\d):(\\d\\d) UTC +\\[([^\\]]*)\\]',l)) and 'every' not in m.group(3) and start < int(m.group(1))*60+int(m.group(2)) < start+45]
print(len(bad))")"
check "nothing lands during the call with Anna" "0" "$CALL_IN"
ok "the everyday routine is not dropped on a busy day" "$(echo "$PLAN_TEXT" | grep -qiE "brief|overview" && echo 1 || echo 0)" "no morning brief or overview in the plan"
BUSY_COUNT="$(field "$OUT" count)"
SUGG="$(api "$MEMBER_JWT" GET /reminders | python3 -c "import json,sys; a=json.load(sys.stdin); print(sum(1 for r in a.get('reminders',[]) if str(r.get('routine','')).startswith('suggest:')))")"
ok "at most one suggestion in a plan" "$([ "$SUGG" -le 1 ] && echo 1 || echo 0)" "$SUGG suggestions"

echo "── planning again replaces the plan"
S="$(new_session "$MEMBER_JWT" "planner e2e again")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Plan my day again, please.")"
lacks "...the run ends without an error" "$REPLY" "[[ERROR"
OUT="$(show_and_check "again")"; echo "$OUT" | sed '$d'
ok "a second plan replaces the first, not stacked on it" "$([ "$(field "$OUT" count)" -le $((BUSY_COUNT + 1)) ] && echo 1 || echo 0)" "$BUSY_COUNT then $(field "$OUT" count)"
check "no reminder twice" "0" "$(field "$OUT" dupes)"
check "the hourly duty is still there, once" "True" "$(field "$OUT" hourly)"

echo "── the planner sees how its reminders landed"
# Three fired planner reminders of an action routine nobody answered, as the monitor leaves them.
R "docker exec -u wsapi $C node -e \"
const fs=require('fs'); const f='$P/.reminders.json'; const a=JSON.parse(fs.readFileSync(f,'utf8'));
for (const h of [26,50,74]) { const t=new Date(Date.now()-h*3600e3).toISOString(); a.push({id:'r_fb'+h+'$TAG',kind:'user',origin:'planner',kind_of:'action',routine:'Supplier chase $MARK',title:'Supplier chase $MARK',status:'sent',settledAt:t,due:t,recipients:['$MEMBER_SLUG']}); }
fs.writeFileSync(f, JSON.stringify(a,null,2));\""
S="$(new_session "$MEMBER_JWT" "planner e2e feedback")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Call memory_now and quote, word for word, the lines about how the plan's reminders landed. Nothing else.")"
has "memory_now tells how a routine's reminders landed" "$REPLY" "Supplier chase"
has "...that nothing followed them" "$REPLY" "after 0 of them"
R "docker exec -u wsapi $C node -e \"
const fs=require('fs'); const f='$P/.reminders.json'; const a=JSON.parse(fs.readFileSync(f,'utf8'));
fs.writeFileSync(f, JSON.stringify(a.filter(r=>!String(r.id).startsWith('r_fb')),null,2));\""

finish
