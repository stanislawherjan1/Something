#!/usr/bin/env bash
# Removes what the end-to-end suites leave behind, so the deployment's screens
# show only real use: test chats, test facts and records (private and shared),
# test questions, the lock-test folder and its locks, the test reminder, test
# tasks, the stand-in notetaker and its connections. Every suite runs it on
# exit (unless KEEP=1); safe to run any time. No model turns, well under a
# minute.  E2E_CLIENT=<client> bash scripts/e2e/cleanup.sh
TOKEN_TTL=900
source "$(dirname "$0")/lib.sh"
ADMIN_JWT=""
for email in $(echo "$ROSTER" | jsonq '" ".join(e["email"] for e in a)'); do
  JWT="$(mint "$email")"
  [ "$(echo "$ROSTER" | jsonq "next(e['role'] for e in a if e['email']=='$email')")" = admin ] && [ -z "$ADMIN_JWT" ] && ADMIN_JWT="$JWT"
  # test chats: the titles the suites give them
  for id in $(api "$JWT" GET /chat/sessions | jsonq '" ".join(s["id"] for s in a.get("sessions",[]) if __import__("re").search(r"(^|\s)e2e(\s|$)|^imports-|^(sharing|reach|slots|locks) e2e", s.get("title") or ""))'); do
    api "$JWT" DELETE "/chat/sessions/$id" >/dev/null
    echo "chat removed: $email $id"
  done
  # stand-in connections, if a run was cut short
  api "$JWT" DELETE "/integrations/otter?reach=personal" >/dev/null 2>&1
done
# the stand-in notetaker's workspace connection and catalog entry (imports.sh) —
# only while the local catalog is the stand-in's, so a real Otter connection or
# an operator's own local catalog is never touched
if R "docker exec $C grep -q 127.0.0.1:7788 $WS/integrations.catalog.local.json 2>/dev/null"; then
  api "$ADMIN_JWT" DELETE "/integrations/otter" >/dev/null 2>&1
  R "docker exec -u root $C rm -f $WS/integrations.catalog.local.json"
  echo "stand-in notetaker connection and catalog entry removed"
fi
# the lock-test folder: unlock, then remove
for p in $(api "$ADMIN_JWT" GET /files/locks | jsonq '" ".join(l["path"] for l in a.get("locks",[]) if l["path"].startswith("E2E-"))'); do
  api "$ADMIN_JWT" POST /files/unlock "{\"path\":\"$p\"}" >/dev/null; echo "unlocked: $p"
done
R "docker exec -u root $C sh -c 'rm -rf /home/coder/project/E2E-locks /home/coder/project/.claude/skills/e2e-group-* /home/coder/project/E2E-shared /home/coder/project/users/*/e2e-note-*.md /home/coder/project/.claude/skills/e2e-* /home/coder/project/users/*/.skills/e2e-* /home/coder/project/users/*/.e2e-note.md /home/coder/project/.canary-probe.svg /home/coder/project/notes/e2e-*.md; rm -f /tmp/stub-notetaker.log; pkill -f stub-notetaker/server.mjs; true'"
# test memory, private and shared, and the questions about it — through the memory engine
R "docker exec -u 1001 -e PROJECT_DIR=/home/coder/project -e WSAPI_STORE_DIR=/var/wsapi-store -e MEMORY_V4=on -w /opt/ide/workspace-api $C node --input-type=module -e \"
const L=await import('/opt/ide/workspace-api/lib/memory-ledger.js'); const F=await import('/opt/ide/workspace-api/lib/memory-facts.js'); const A=await import('/opt/ide/workspace-api/lib/memory-asks.js');
const T=await import('/opt/ide/workspace-api/lib/team.js');
const TEST=/(Orbis|Nowak|Kowalski|E2E)-[0-9]{6}|E2E-probe-[0-9]+|PROBE-[0-9]+|Quarry-[0-9]{6}|Vellmark|Quarry launch|Two things to remember, no need to do anything|job offer from a recruiter|head of operations role elsewhere|PAPRYKA-|LOCKTEST-|E2E test reminder|import:otter:m-|Board sync|Supplier call|Ann 1:1 with Bob|(MANGO|KIWI|PLUM|HACKED|LOCKER|ADMINFILE|SHAREDFILE)-[0-9]{6}|(THERAPY|LOAN|PARTNER|ROTA)-(ask|auto|never)-[0-9]{6}|(SALARY|PINHINT|TEAMCODE|GROUPSKILL|ORW|GLAZE)-[0-9]{6}|e2e-(member|team|admin)-[0-9]{6}/i;
const groups=Object.keys((JSON.parse((await import('node:fs')).readFileSync('/home/coder/project/.team-config.json','utf8')).groups)||{});
const scopes=['shared', ...T.list().map(m=>'user:'+m.slug), ...groups.map(g=>'group:'+g)];
for (const scope of scopes) {
  const recs=L.read({scopes:[scope]}).filter(r=>TEST.test((r.text||'')+' '+(r.conv||'')));
  const ids=new Set(recs.map(r=>r.id));
  const facts=F.all(scope).filter(f=>ids.has(f.record)||TEST.test((f.title||'')+' '+(f.text||'')));
  for (const r of recs) await L.hide(scope, r.id, 'cleanup');
  if (facts.length) await F.erase(scope, facts.map(f=>f.id));
  if (recs.length||facts.length) console.log(scope+': hid '+recs.length+' test records, erased '+facts.length+' test facts');
  if (scope.startsWith('user:')) { const slug=scope.slice(5); let n=0;
    for (const a of A.listAsks(slug,{status:'pending'})) if (TEST.test(a.text||'')) { try { await A.resolveAsk(slug, a.id, 'keep'); n++; } catch {} }
    if (n) console.log(scope+': closed '+n+' test questions'); }
}
\"" 2>&1 | grep -v "egress\]\|restartBot\|crypto\]\|catalog\]"
# the group's stored transcript: the test lines out (the Telegram chat itself keeps them)
R "docker exec -u 1001 $C python3 -c \"
import glob,re
pat=re.compile(r'(SALARY|PINHINT|TEAMCODE|GROUPSKILL|ORW|GLAZE)-[0-9]{6}|e2e-group-[0-9]{6}|message_id\\\":\\\"9[0-9]{7,8}\\\"')
for f in glob.glob('/home/coder/project/.group-watcher/*-history.jsonl'):
  rows=open(f).read().splitlines(); keep=[r for r in rows if not pat.search(r)]
  if len(keep)!=len(rows): open(f,'w').write('\\n'.join(keep)+'\\n'); print('group transcript:', f.split('/')[-1], len(rows)-len(keep), 'test lines removed')
\"" 2>/dev/null
# the test reminder
R "docker exec -u 1001 $C python3 -c \"
import json; p='/home/coder/project/.reminders.json'
try: a=json.load(open(p))
except Exception: a=None
if isinstance(a,list):
  b=[r for r in a if 'E2E test reminder' not in json.dumps(r)]
  if len(b)!=len(a): json.dump(b,open(p,'w'),indent=2); print('reminders removed:',len(a)-len(b))
\"" 2>/dev/null
# test tasks off the board (the memory cleanup above already took their facts)
R "docker exec $C sh -c 'curl -s http://127.0.0.1:3001/api/tasks' " 2>/dev/null | python3 -c "
import json,sys,re
try: a=json.load(sys.stdin)
except Exception: sys.exit(0)
print(' '.join(t['id'] for t in a.get('tasks',[]) if re.search(r'(Orbis|Nowak|Kowalski|E2E)-[0-9]{6}|Q4 budget draft|Orbis.*pricing sheet|Kowalski.*invoice summary', t.get('title','')+' '+t.get('description',''))))" | while read -r ids; do for id in $ids; do R "docker exec $C curl -s -X DELETE http://127.0.0.1:3001/api/tasks/$id" >/dev/null; done; done
# the filing trace a test asked for
R "docker exec -u 1001 $C rm -f /home/coder/project/memory/_engine/trace.jsonl /var/wsapi-store/trace/consolidator.jsonl" >/dev/null 2>&1
echo "cleanup done"
