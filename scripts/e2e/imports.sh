#!/usr/bin/env bash
# Imports with the stand-in notetaker (a fake Otter served on the container's
# loopback, from ide-template/workspace-api/test-fixtures/stub-notetaker): the
# workspace's connection feeds the admin's scope, a member's own feeds the
# member's, nothing reaches the shared scope, each read with its own token.
# Few model turns: the import files each meeting through the model (two or
# three meetings), then one question each for the admin and the member.
# About 3–7 minutes.  E2E_CLIENT=<client> bash scripts/e2e/imports.sh
# STUB_DIR overrides where the stand-in is read from.
source "$(dirname "$0")/lib.sh"
STUB="${STUB_DIR:-$REPO_ROOT/ide-template/workspace-api/test-fixtures/stub-notetaker}"
[ -f "$STUB/server.mjs" ] || { echo "stub not found at $STUB"; exit 1; }
echo "== the stand-in notetaker inside the container"
R "docker exec $C mkdir -p $WS/test-fixtures/stub-notetaker" >/dev/null
# Each run gets its own meeting ids: a meeting a previous run hid is, by design,
# never imported again, so fixed ids made every rerun import nothing.
TAG="$(date +%H%M%S)"
SCRATCH="$(mktemp -d)"; sed -E "s/\"(m-(ws|ann)-[0-9]+)\"/\"\1-r$TAG\"/g" "$STUB/meetings.json" > "$SCRATCH/meetings.json"
scp -q "$STUB/server.mjs" "$SCRATCH/meetings.json" "$HETZNER_HOST:/tmp/" && R "docker cp /tmp/server.mjs $C:$WS/test-fixtures/stub-notetaker/server.mjs && docker cp /tmp/meetings.json $C:$WS/test-fixtures/stub-notetaker/meetings.json && docker exec $C sh -c 'chmod 644 $WS/test-fixtures/stub-notetaker/*'"
R "docker exec $C node -e \"const c=require('$WS/integrations.catalog.json');const o=c.integrations.find(i=>i.id==='otter');o.mcp={...o.mcp,url:'http://127.0.0.1:7788/mcp'};require('fs').writeFileSync('/tmp/catalog.local.json',JSON.stringify({integrations:[o]}))\" && docker cp $C:/tmp/catalog.local.json /tmp/catalog.local.json && docker cp /tmp/catalog.local.json $C:$WS/integrations.catalog.local.json && docker exec $C chmod 644 $WS/integrations.catalog.local.json"
R "docker exec -d -u 1001 -e PORT=7788 -e STUB_LOG=/tmp/stub-notetaker.log $C node $WS/test-fixtures/stub-notetaker/server.mjs"
sleep 2
up="$(R "docker exec $C node -e \"fetch('http://127.0.0.1:7788/mcp').then(r=>console.log(r.status)).catch(e=>console.log('down',e.message))\"")"
ok "the stand-in answers on the loopback" "$([ "$up" != "" ] && [[ "$up" != down* ]] && echo 1 || echo 0)" "$up"
cat_url="$(api "$ADMIN_JWT" GET "/integrations/otter" | jsonq 'a.get("mcpUrl") or a.get("id")')"
echo "== connect: the workspace's Otter (admin) and the member's own"
r="$(api "$ADMIN_JWT" PUT "/integrations/otter?access=read" '{"fields":{"OAUTH_TOKENS":"{\"access_token\":\"ws-token\"}"}}')"
ok "the admin connected Otter for the workspace, read-only" "$(echo "$r" | grep -q '"reach":"workspace"' && echo 1 || echo 0)" "$r"
if [ -n "$MEMBER_JWT" ]; then
  r="$(api "$MEMBER_JWT" PUT "/integrations/otter?reach=personal" '{"fields":{"OAUTH_TOKENS":"{\"access_token\":\"ann-token\"}"}}')"
  ok "the member connected their own Otter" "$(echo "$r" | grep -q '"reach":"personal"' && echo 1 || echo 0)" "$r"
fi
echo "== the nightly imports, on request"
api "$ADMIN_JWT" POST "/memory/v4/sources/otter/run" >/dev/null
[ -n "$MEMBER_JWT" ] && api "$MEMBER_JWT" POST "/memory/v4/sources/otter/run" >/dev/null
# Each meeting takes the model a while: wait until every expected one is filed (up to five minutes).
WANT=2; [ -n "$MEMBER_JWT" ] && WANT=3
for i in $(seq 1 60); do
  sleep 5
  have="$(R "docker exec -u 1001 $C sh -c 'cat /home/coder/project/memory/users/*/ledger/*.jsonl 2>/dev/null'" | grep -o "import:otter:m-[a-z0-9-]*-r$TAG" | sort -u | wc -l | tr -d ' ')"
  [ "${have:-0}" -ge "$WANT" ] && break
done
led() { R "docker exec -u 1001 $C sh -c 'cat /home/coder/project/memory/$1/ledger/*.jsonl 2>/dev/null' | grep -o 'import:otter:m-[a-z0-9-]*-r$TAG' | sort -u | tr '\n' ' '"; }
A="$(led "users/$ADMIN_SLUG")"; S="$(led "")"
ok "the admin's scope holds the workspace meetings" "$(echo "$A" | grep -q 'm-ws-1' && echo "$A" | grep -q 'm-ws-2' && echo 1 || echo 0)" "$A"
ok "...and not the member's" "$(echo "$A" | grep -q 'm-ann' && echo 0 || echo 1)" "$A"
ok "the shared scope holds no import" "$([ -z "$S" ] && echo 1 || echo 0)" "$S"
if [ -n "$MEMBER_JWT" ]; then
  M="$(led "users/$MEMBER_SLUG")"
  ok "the member's scope holds their meeting only" "$([ "$(echo "$M" | tr ' ' '\n' | grep -c .)" = 1 ] && echo "$M" | grep -q 'm-ann-1' && echo 1 || echo 0)" "$M"
fi
LOG="$(R "docker exec $C cat /tmp/stub-notetaker.log")"
ok "the workspace connection was read with its token only for its meetings" "$(echo "$LOG" | awk -F'\t' '$1=="ws-token" && $3!="" && $3 !~ /^m-ws-/ {bad=1} END{print bad?0:1}')" "$LOG"
ok "the member's with theirs" "$(echo "$LOG" | awk -F'\t' '$1=="ann-token" && $3!="" && $3 !~ /^m-ann-1-r/ {bad=1} END{print bad?0:1}')" "$LOG"
ok "no other token reached the server" "$(echo "$LOG" | awk -F'\t' '$1!="ws-token" && $1!="ann-token" {bad=1} END{print bad?0:1}')" "$LOG"
echo "== scenario 5: each person asks about both meetings by name (real turns)"
# Asked by name: on a deployment with real meetings a general "which meetings"
# lists those first. Each side names the other's meeting too — a sharper probe.
Q="From memory only, no tools: (1) what was decided about the Quarry launch date? (2) who takes the Orbis dashboard? Answer each in one line; say NOT IN MEMORY for what you do not have."
AS="$(new_session "$ADMIN_JWT" "imports-$(date +%H%M%S)")"
AR="$(turn "$ADMIN_JWT" "$AS" "$Q")"
ok "the admin's bot knows the workspace meeting" "$(echo "$AR" | grep -qiE '3 october|october 3|october third|3rd' && echo 1 || echo 0)" "$(echo "$AR" | head -c 300)"
ok "...and not the member's" "$(echo "$AR" | grep -qi 'bob' && echo 0 || echo 1)" "$(echo "$AR" | head -c 300)"
if [ -n "$MEMBER_JWT" ]; then
  MSESS="$(new_session "$MEMBER_JWT" "imports-$(date +%H%M%S)")"
  MR="$(turn "$MEMBER_JWT" "$MSESS" "$Q")"
  ok "the member's bot knows their own meeting" "$(echo "$MR" | grep -qi 'bob' && echo 1 || echo 0)" "$(echo "$MR" | head -c 300)"
  ok "...and not the workspace's" "$(echo "$MR" | grep -qiE '3 october|october 3|october third|3rd|vellmark|pakto' && echo 0 || echo 1)" "$(echo "$MR" | head -c 300)"
fi
finish
