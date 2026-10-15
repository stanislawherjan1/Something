#!/usr/bin/env bash
# One truth about whether something got done: a task and the memory fact behind
# it point at each other, the bot reads the task's state under its memory, the
# nightly filing ties a note to the task made for it, and "done" on the board is
# what the bot answers from. Real conversations (web turns as the admin, about
# twelve, on the operator's Claude plan) and forced filings. About 10–15
# minutes. ONLY=1,6 runs those scenarios alone (each is self-contained except
# 2–3, which need 1).  E2E_CLIENT=<client> bash scripts/e2e/tasks-memory.sh
TOKEN_TTL=3600
TURN_TIMEOUT=300
source "$(dirname "$0")/lib.sh"
JWT="$ADMIN_JWT"
# ONLY=1,6 runs those scenarios alone (each is self-contained except 2–3, which need 1).
want() { [ -z "${ONLY:-}" ] || echo ",$ONLY," | grep -q ",$1,"; }
task_by() { api "$JWT" GET /tasks | python3 -c "import json,sys; a=json.load(sys.stdin); t=[x for x in a['tasks'] if '$1' in (x['title']+' '+x.get('description','')) or '$2' in (x['title']+' '+x.get('description',''))]; t.sort(key=lambda x: x.get('createdAt',''), reverse=True); print(json.dumps(t[0]) if t else '{}')"; }
# The test levers are the bot's: the call carries the bot's turn token.
file_now() { R "docker exec -u bot $C sh -c 'curl -s -X POST -H \"X-IDE-Turn: \$(cat /home/bot/.\${BOT_NAME:-bot}/turn-id)\" \"http://127.0.0.1:3001/api/internal/memory/consolidate?idle=0&trace=1\"'"; }
trace_tail() { R "docker exec -u 1001 $C sh -c 'tail -n 3 /var/wsapi-store/trace/consolidator.jsonl 2>/dev/null'" | python3 -c "import sys,json
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    print('   trace', d.get('src'), 'tasks', d.get('tasks'), 'written', d.get('written'), 'kept', [k.get('title') for k in d.get('kept',[])])"; }
facts_with() { R "docker exec -u 1001 $C sh -c 'cat /home/coder/project/memory/users/$ADMIN_SLUG/facts.jsonl /home/coder/project/memory/facts.jsonl 2>/dev/null'" | grep -c "$1"; }
fact_task() { R "docker exec -u 1001 $C node -e \"
const F=require('/opt/ide/workspace-api/lib/memory-facts.js');\" 2>/dev/null"; R "docker exec -u 1001 -w /opt/ide/workspace-api $C node --input-type=module -e \"
const F=await import('/opt/ide/workspace-api/lib/memory-facts.js');
for (const s of ['user:$ADMIN_SLUG','shared']) { const f=F.all(s).filter(x=>!x.hidden && /$1/.test(x.title+' '+x.text)); if (f.length) { console.log(JSON.stringify({scope:s, retired:!!f[0].retired, why:f[0].retiredWhy||null, task:f[0].task||null})); process.exit(0);} }
console.log('{}')\""; }

if want 1; then
echo "== 1. a remembered request becomes a task that points back at it"
S="$(new_session "$JWT" "tasks-memory e2e $TAG")"
T="$(turn "$JWT" "$S" "Remember this, nothing to do yet: Orbis-$TAG asked me for a pricing sheet by 20 October.")"
ok "the request is noted" "$([ "$(facts_with "Orbis-$TAG")" -ge 1 ] && echo 1 || echo 0)" "$(echo "$T" | head -c 200)"
S2="$(new_session "$JWT" "tasks-memory e2e link $TAG")"
T="$(turn "$JWT" "$S2" "Add a task for me: send Orbis-$TAG the pricing sheet (E2E-$TAG). It is about what you remember of Orbis-$TAG; link the task to that.")"
TASK1="$(task_by "Orbis-$TAG" "Orbis")"
ok "the task is on the board, mine" "$(echo "$TASK1" | python3 -c "import json,sys; t=json.load(sys.stdin); print(1 if t.get('owner')=='$ADMIN_SLUG' else 0)")" "$TASK1"
ok "...and linked to the remembered request" "$(echo "$TASK1" | python3 -c "import json,sys; t=json.load(sys.stdin); print(1 if t.get('fact',{}).get('id') else 0)")" "$(echo "$T" | head -c 200)"
ID1="$(echo "$TASK1" | jsonq 'a.get("id","")')"
ok "the fact points at the task" "$(fact_task "Orbis-$TAG" | python3 -c "import json,sys; f=json.load(sys.stdin); print(1 if f.get('task',{}) and f['task'].get('id')=='$ID1' else 0)")" "$(fact_task "Orbis-$TAG")"
fi

if want 2; then
echo "== 2. not done yet: the bot says so from the board"
S3="$(new_session "$JWT" "tasks-memory e2e open $TAG")"
T="$(turn "$JWT" "$S3" "Did I already send Orbis-$TAG the pricing sheet? One line, from what you know.")"
ok "an open task reads as not done" "$(echo "$T" | grep -qiE "not yet|not been sent|no record of (it being )?sen[dt]|not sent|gone out|haven.t|hasn.t|not done|not started|still open|in progress|backlog|^no\b|no[,.]" && echo 1 || echo 0)" "$(echo "$T" | head -c 240)"
fi

if want 3; then
echo "== 3. done on the board (not in chat): memory follows, the bot says done"
r="$(api "$JWT" PATCH "/tasks/$ID1" '{"status":"done"}')"
ok "done closes the linked fact" "$(echo "$r" | grep -q '"retiredFacts":1' && echo 1 || echo 0)" "$r"
S4="$(new_session "$JWT" "tasks-memory e2e done $TAG")"
T="$(turn "$JWT" "$S4" "Did I already send Orbis-$TAG the pricing sheet? One line, from what you know.")"
ok "the bot answers done, not 'I don't know'" "$(echo "$T" | grep -qiE "done|sent|completed|yes" && ! echo "$T" | grep -qiE "don.t know|not sure|no record|can.t tell" && echo 1 || echo 0)" "$(echo "$T" | head -c 240)"
fi

if want 4; then
echo "== 4. task first, nothing remembered yet: the nightly filing ties them"
S5="$(new_session "$JWT" "tasks-memory e2e night $TAG")"
T="$(turn "$JWT" "$S5" "Nowak-$TAG wants the Q4 budget draft by Friday 24 October. Add a task for me to prepare it (E2E-$TAG).")"
TASK2="$(task_by "Nowak-$TAG" "Nowak")"; ID2="$(echo "$TASK2" | jsonq 'a.get("id","")')"
ok "the task is on the board" "$([ -n "$ID2" ] && echo 1 || echo 0)" "$(echo "$T" | head -c 200)"
for i in 1 2 3 4 5 6; do sleep 20; file_now >/dev/null; [ "$(facts_with "Nowak-$TAG")" -ge 1 ] && break; done
FT="$(fact_task "Nowak-$TAG")"
ok "the filed fact names the task" "$(echo "$FT" | python3 -c "import json,sys; f=json.load(sys.stdin); print(1 if (f.get('task') or {}).get('id')=='$ID2' else 0)")" "$FT"
trace_tail
ok "...and the task names the fact" "$(task_by "Nowak-$TAG" "Nowak" | python3 -c "import json,sys; t=json.load(sys.stdin); print(1 if t.get('fact',{}).get('id') else 0)")"
api "$JWT" PATCH "/tasks/$ID2" '{"status":"done"}' >/dev/null
S6="$(new_session "$JWT" "tasks-memory e2e night done $TAG")"
T="$(turn "$JWT" "$S6" "Is the Q4 budget draft for Nowak-$TAG done? One line: done or not done, and since when.")"
ok "after done, memory answers done" "$(echo "$T" | grep -qiE "done|completed|finished" && ! echo "$T" | grep -qiE "don.t know|not sure" && echo 1 || echo 0)" "$(echo "$T" | head -c 240)"
fi

if want 5; then
echo "== 5. memory says open, the board says done, no link: the board wins"
S7="$(new_session "$JWT" "tasks-memory e2e net $TAG")"
T="$(turn "$JWT" "$S7" "Remember: Kowalski-$TAG asked me for the invoice summary by Monday. Nothing to do yet.")"
r="$(api "$JWT" POST /tasks "{\"title\":\"Send Kowalski-$TAG the invoice summary (E2E-$TAG)\",\"status\":\"done\"}")"
ok "a task done on the board, unlinked" "$(echo "$r" | grep -q '"status":"done"' && echo 1 || echo 0)" "$r"
S8="$(new_session "$JWT" "tasks-memory e2e net ask $TAG")"
T="$(turn "$JWT" "$S8" "Did I send Kowalski-$TAG the invoice summary? One line, check what you have.")"
ok "the bot answers from the board: done" "$(echo "$T" | grep -qiE "done|sent|completed|yes" && ! echo "$T" | grep -qiE "don.t know|not sure|no record" && echo 1 || echo 0)" "$(echo "$T" | head -c 240)"
fi

if want 6; then
echo "== 6. a note written in the conversation is linked from the fact"
S9="$(new_session "$JWT" "tasks-memory e2e files $TAG")"
T="$(turn "$JWT" "$S9" "Two things. First, remember this: Orbis-$TAG pays invoices net 30. Second, write a short note file at notes/e2e-$TAG.md with Orbis-$TAG payment terms (net 30, invoices in euros).")"
ok "the note file exists" "$(R "docker exec $C test -f /home/coder/project/notes/e2e-$TAG.md && echo 1 || echo 0")" "$(echo "$T" | head -c 200)"
FN=""; for i in 1 2 3 4 5 6; do sleep 20; FN="$(file_now)"; echo "$FN" | grep -q '"filesLinked":[1-9]' && break; done
FF="$(R "docker exec -u 1001 -w /opt/ide/workspace-api $C node --input-type=module -e \"
const F=await import('/opt/ide/workspace-api/lib/memory-facts.js');
const out=[]; for (const s of ['user:$ADMIN_SLUG','shared']) for (const x of F.all(s)) if (!x.hidden && /Orbis-$TAG/.test(x.title+' '+x.text)) out.push({scope:s, title:x.title, files:x.files||[], by:x.by||null, record:x.record});
console.log(JSON.stringify(out))\"")"
ok "the filed fact names the note file" "$(echo "$FF" | grep -q "notes/e2e-$TAG.md" && echo 1 || echo 0)" "facts: $FF · filing: $(echo "$FN" | head -c 200)"
trace_tail
S10="$(new_session "$JWT" "tasks-memory e2e files ask $TAG")"
T="$(turn "$JWT" "$S10" "Where did we write down the Orbis-$TAG payment terms? Name the file path only.")"
ok "the bot names the file from memory" "$(echo "$T" | grep -q "notes/e2e-$TAG.md" && echo 1 || echo 0)" "$(echo "$T" | head -c 240)"

fi
finish
