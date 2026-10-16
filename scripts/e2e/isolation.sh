#!/usr/bin/env bash
# Isolation after a deploy: health, the scope guard (the deployed hook run
# directly), the editor gate and admin-only routes, sign-out, the setuid
# runners and the turn users, who may reach which local listener, the hosted
# MCP bridge, and the monitor routes. Runs mostly inside the container over
# ssh; probe files are removed. One real model turn (a one-word web chat, to
# see which uid it ran as) — negligible on the operator's Claude plan.
# About 1–2 minutes.  E2E_CLIENT=<client> bash scripts/e2e/isolation.sh
TOKEN_TTL=600
source "$(dirname "$0")/lib.sh"
# This suite's queries are JavaScript, and its api() returns only the status code.
jsonq() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log('"$1"')})'; }

echo "== health"
check "all pm2 apps online" "0" "$(R "docker exec -u coder $C pm2 jlist" | jsonq 'a.filter(p=>p.pm2_env.status!=="online").length')"
check "workspace-api answers" "200" "$(R "docker exec $C curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health")"
check "workspace app loads" "200" "$(curl -s -o /dev/null -w '%{http_code}' "https://$FRONTEND_DOMAIN/app/")"
check "no runner refused at boot" "0" "$(R "docker logs --since 30m $C 2>&1; docker exec -u coder $C sh -c 'cat /home/coder/.\${BOT_NAME:-bot}/*error.log 2>/dev/null | tail -300'" | grep -c 'refusing to run')"
check "no symlink warnings at boot" "0" "$(R "docker logs --since 30m $C 2>&1" | grep -c 'is a symlink where a real file')"

echo "== scope guard (runs the deployed hook)"
hook() { R "docker exec -i -e IDE_ACTOR_SLUG=ann -e IDE_ACTOR_IS_ADMIN=0 $C node /opt/ide/hooks/scope-guard.mjs >/dev/null 2>&1; echo \$?" <<<"$1"; }
check "another member's chat history is closed" "2" "$(hook '{"tool_name":"Read","tool_input":{"file_path":"/home/coder/project/.team/users/bob/chats/x.jsonl"}}')"
check "...from the shell too" "2" "$(hook '{"tool_name":"Bash","tool_input":{"command":"cat .team/users/bob/routines.json"}}')"
check "...through a doubled slash" "2" "$(hook '{"tool_name":"Read","tool_input":{"file_path":"/home/coder//project/users/bob/x.md"}}')"
check "a whole-project grep is refused" "2" "$(hook '{"tool_name":"Grep","tool_input":{"pattern":"salary"}}')"
check "users/* is nobody's" "2" "$(hook '{"tool_name":"Bash","tool_input":{"command":"cat users/*/notes.md"}}')"
check "own chat history stays open" "0" "$(hook '{"tool_name":"Read","tool_input":{"file_path":"/home/coder/project/.team/users/ann/chats/x.jsonl"}}')"
check "shared files stay open" "0" "$(hook '{"tool_name":"Read","tool_input":{"file_path":"/home/coder/project/notes.md"}}')"

echo "== sessions"
echo "  (session cookie: $COOKIE; member: ${MEMBER_EMAIL:-none})"
STRANGER_JWT="$(mint "nobody@example.invalid")"
api() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== editor gate"
code() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Sec-Fetch-Dest: empty' "$@" "https://$FRONTEND_DOMAIN/?folder=/home/coder/project"; }
check "signed out → sent to the app" "302 https://$FRONTEND_DOMAIN/app/" "$(code)"
check "not on the roster → sent to the app" "302 https://$FRONTEND_DOMAIN/app/" "$(code -H "Cookie: $COOKIE=$STRANGER_JWT")"
if [ -n "$MEMBER_EMAIL" ]; then
  check "member → sent to the app, not the editor" "302 https://$FRONTEND_DOMAIN/app/" "$(code -H "Cookie: $COOKIE=$MEMBER_JWT")"
  check "member still reaches the API" "200" "$(api -H "Cookie: $COOKIE=$MEMBER_JWT" "https://$FRONTEND_DOMAIN/api/me")"
  check "member still loads the workspace app" "200" "$(api -H "Cookie: $COOKIE=$MEMBER_JWT" "https://$FRONTEND_DOMAIN/app/")"
fi
check "admin reaches the editor" "200" "$(code -H "Cookie: $COOKIE=$ADMIN_JWT" | cut -d' ' -f1)"
check "admin still reaches the API" "200" "$(api -H "Cookie: $COOKIE=$ADMIN_JWT" "https://$FRONTEND_DOMAIN/api/me")"

echo "== admin-only controls and raw files"
if [ -n "$MEMBER_EMAIL" ]; then
  check "member cannot restart the bot" "403" "$(api -X POST -H "Cookie: $COOKIE=$MEMBER_JWT" "https://$FRONTEND_DOMAIN/api/bot/restart")"
  check "member cannot start the docs-comments login" "403" "$(api -X POST -H "Cookie: $COOKIE=$MEMBER_JWT" "https://$FRONTEND_DOMAIN/api/integrations/docs-comments/connect-start")"
  check "member sees the docs-comments status" "200" "$(api -H "Cookie: $COOKIE=$MEMBER_JWT" "https://$FRONTEND_DOMAIN/api/integrations/docs-comments/status")"
  check "member sees the integrations list without credential summaries" "0" "$(curl -s -H "Cookie: $COOKIE=$MEMBER_JWT" "https://$FRONTEND_DOMAIN/api/integrations" | jsonq 'a.integrations.filter(i=>i.credentialSummary).length')"
  check "member cannot change setup" "403" "$(api -X POST -H 'Content-Type: application/json' -H "Cookie: $COOKIE=$MEMBER_JWT" -d '{"botName":"X"}' "https://$FRONTEND_DOMAIN/api/setup/branding")"
fi
check "no web relay into the bot" "404" "$(api -X POST -H 'Content-Type: application/json' -H "Cookie: $COOKIE=$ADMIN_JWT" -d '{"text":"x"}' "https://$FRONTEND_DOMAIN/api/bot/send")"
check "public branding names nobody" "0" "$(curl -s "https://$FRONTEND_DOMAIN/api/branding" | grep -c updatedBy)"
R "docker exec $C sh -c 'printf \"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\"/>\" > /home/coder/project/.canary-probe.svg'" >/dev/null 2>&1
SVG_H="$(curl -s -D - -o /dev/null -H "Cookie: $COOKIE=$ADMIN_JWT" "https://$FRONTEND_DOMAIN/api/files/raw?path=.canary-probe.svg")"
check "a raw SVG is served sandboxed" "yes" "$(echo "$SVG_H" | grep -qi 'content-security-policy:.*sandbox' && echo yes || echo no)"
check "...and not sniffed" "yes" "$(echo "$SVG_H" | grep -qi 'x-content-type-options: nosniff' && echo yes || echo no)"
R "docker exec $C rm -f /home/coder/project/.canary-probe.svg" >/dev/null 2>&1

echo "== sign-out"
if [ -n "$MEMBER_EMAIL" ]; then
  EARLY_JWT="$MEMBER_JWT"
  sleep 1
  check "sign-out is recorded" "200" "$(api -X POST -H "Cookie: $COOKIE=$EARLY_JWT" "https://$FRONTEND_DOMAIN/api/me/sign-out")"
  check "the earlier token is refused by the API" "401" "$(api -H "Cookie: $COOKIE=$EARLY_JWT" "https://$FRONTEND_DOMAIN/api/me")"
  sleep 2
  LATE_JWT="$(mint "$MEMBER_EMAIL")"
  check "a later token works again" "200" "$(api -H "Cookie: $COOKIE=$LATE_JWT" "https://$FRONTEND_DOMAIN/api/me")"
fi

echo "== setuid runners and the turn user"
check "bot cannot start wsapi-runner" "1" "$(R "docker exec -u bot $C sh -c '/usr/local/bin/wsapi-runner >/dev/null 2>&1; echo \$?'")"
check "wsapi cannot start bot-runner" "1" "$(R "docker exec -u 1001 $C sh -c '/usr/local/bin/bot-runner >/dev/null 2>&1; echo \$?'")"
R "docker exec -u 1001 $C sh -c 'rm -f /tmp/canary-pwn-*; printf \"touch /tmp/canary-pwn-bashenv\\n\" > /tmp/canary-bashenv.sh; chmod 644 /tmp/canary-bashenv.sh; BASH_ENV=/tmp/canary-bashenv.sh /usr/local/bin/monitor-runner /opt/ide/bot-relay.sh >/dev/null 2>&1; true'"
check "BASH_ENV does not cross monitor-runner" "absent" "$(R "docker exec $C sh -c '[ -e /tmp/canary-pwn-bashenv ] && echo present || echo absent'")"
R "docker exec -u bot $C sh -c 'printf \"require(\\\"fs\\\").writeFileSync(\\\"/tmp/canary-pwn-node\\\",\\\"x\\\")\" > /tmp/canary-req.js; chmod 644 /tmp/canary-req.js; NODE_OPTIONS=\"--require /tmp/canary-req.js\" /usr/local/bin/mcp-runner pdf </dev/null >/dev/null 2>&1; true'"
check "NODE_OPTIONS does not cross mcp-runner" "absent" "$(R "docker exec $C sh -c '[ -e /tmp/canary-pwn-node ] && echo present || echo absent'")"
R "docker exec $C sh -c 'rm -f /tmp/canary-pwn-* /tmp/canary-bashenv.sh /tmp/canary-req.js'"
check "turn user exists" "yes" "$(R "docker exec $C sh -c 'id turn >/dev/null 2>&1 && echo yes || echo no'")"
check "turn-runner is root:wsapi 4750" "-rwsr-x--- root wsapi" "$(R "docker exec $C stat -c '%A %U %G' /usr/local/bin/turn-runner")"
check "every turn home holds the hooks (solo, group, slot 01)" "yes" "$(R "docker exec -u root $C sh -c 'for h in solo group 01; do grep -q scope-guard /home/turns/\$h/.claude/settings.json || exit 1; done && echo yes || echo no'")"
check "bot cannot start turn-runner (1 = refused by the runner, 126 = not executable for it)" "refused" "$(R "docker exec -u bot $C sh -c '/usr/local/bin/turn-runner --version >/dev/null 2>&1; rc=\$?; [ \$rc -eq 1 ] || [ \$rc -eq 126 ] && echo refused || echo rc=\$rc'")"
check "a slot's sessions directory is its own, not a link to the shared one" "yes" "$(R "docker exec -u root $C sh -c '[ -d /home/turns/01/.claude/projects ] && [ ! -L /home/turns/01/.claude/projects ] && [ \"\$(stat -c %U:%a /home/turns/01)\" = turn-01:700 ] && echo yes || echo no'")"
# A process that went through a setuid runner is not dumpable, so its environ is unreadable even for root; the bot's CLI (a plain child) is.
check "the session secret is not in the bot's CLI environment" "0" "$(R "docker exec -u bot $C sh -c 'p=\$(pgrep -f \"^claude --dangerously\" | head -1); tr \"\\0\" \"\\n\" < /proc/\$p/environ 2>/dev/null | grep -c ^SESSION_SECRET='")"
check "...nor in PM2's apps" "0" "$(R "docker exec -u coder $C sh -c 'pm2 jlist 2>/dev/null'" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(sum(1 for p in a if "SESSION_SECRET" in (p.get("pm2_env") or {})))')"
check "...but workspace-api has it (file)" "yes" "$(R "docker exec -u root $C sh -c '[ -s /var/wsapi-store/session-secret ] && echo yes || echo no'")"
curl -s -m 90 -o /dev/null -H "Cookie: $COOKIE=$ADMIN_JWT" -F 'message=Reply with the single word ok.' "https://$FRONTEND_DOMAIN/api/chat"
check "a web chat turn ran as its person's slot user (the CLI wrote under that home)" "turn-01" "$(R "docker exec -u root $C sh -c 'stat -c %U /home/turns/01/.claude/sessions 2>/dev/null || stat -c %U /home/turns/01/.claude/projects/* 2>/dev/null | head -1 || echo none'")"
MCP_LIST="$(R "docker exec -u bot -e HOME=/home/bot -w /home/coder/project $C sh -c 'IDE_TURN_ID=\$(cat /home/bot/.\${BOT_NAME:-bot}/turn-id) claude mcp list 2>&1'")"
check "bot's MCP servers connect (the Telegram channel is checked in the bot's own log)" "0" "$(echo "$MCP_LIST" | grep -v 'plugin:telegram' | grep -c -i 'failed')"
echo "$MCP_LIST" | grep -i -E "failed|connected" | sed 's/^/       /' | head -20

echo "== local listeners by user"
check "bot cannot reach the open egress listener" "refused" "$(R "docker exec -u bot $C sh -c 'curl -s -m 4 -o /dev/null http://egress-proxy:3130/ 2>/dev/null; rc=\$?; [ \$rc -eq 7 ] && echo refused || echo rc=\$rc'")"
check "the turn user cannot either" "refused" "$(R "docker exec -u turn $C sh -c 'curl -s -m 4 -o /dev/null http://egress-proxy:3130/ 2>/dev/null; rc=\$?; [ \$rc -eq 7 ] && echo refused || echo rc=\$rc'")"
check "the mcp user reaches it" "yes" "$(R "docker exec -u 1002 $C sh -c 'curl -s -m 4 -o /dev/null -w %{http_code} http://egress-proxy:3130/ >/dev/null 2>&1; rc=\$?; [ \$rc -ne 7 ] && echo yes || echo no'")"
check "bot cannot reach the browser's debugging port" "refused" "$(R "docker exec -u bot $C sh -c 'curl -s -m 4 -o /dev/null http://127.0.0.1:9333/json/version 2>/dev/null; rc=\$?; [ \$rc -eq 7 ] && echo refused || echo rc=\$rc'")"
if [ "$(R "docker exec $C sh -c 'pgrep -f -- --remote-debugging-port=[9]333 >/dev/null && echo up'")" = up ]; then
  check "the mcp user reaches the debugging port (when the browser runs)" "yes" "$(R "docker exec -u 1002 $C sh -c 'curl -s -m 4 -o /dev/null http://127.0.0.1:9333/json/version 2>/dev/null; rc=\$?; [ \$rc -ne 7 ] && echo yes || echo no'")"
else
  skip "the mcp user reaches the debugging port" "the browser is not running"
fi
check "playwright starts through mcp-runner" "yes" "$(echo "$MCP_LIST" | grep -q 'playwright: /usr/local/bin/mcp-runner playwright' && echo yes || echo no)"

echo "== hosted MCP bridge (Granola / Fathom)"
HOSTED="$(curl -s -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/api/integrations" | python3 -c "import json,sys; a=json.load(sys.stdin); print(' '.join(e['id'] for e in a.get('integrations',[]) if e['id'] in ('granola','fathom') and (e.get('active') or e.get('activeFor'))))")"
if [[ " $HOSTED " == *" granola "* ]]; then
  check "granola is served through the bridge" "yes" "$(echo "$MCP_LIST" | grep -qE 'granola(-mine)?: /usr/local/bin/mcp-runner remote' && echo yes || echo no)"
  check "...and connects" "yes" "$(echo "$MCP_LIST" | grep -E 'granola(-mine)?:' | grep -q 'Connected' && echo yes || echo no)"
else
  skip "granola through the bridge" "Granola is not connected here"
fi
if [[ " $HOSTED " == *" fathom "* ]]; then
  check "fathom is served through the bridge" "yes" "$(echo "$MCP_LIST" | grep -qE 'fathom(-mine)?: /usr/local/bin/mcp-runner remote' && echo yes || echo no)"
else
  skip "fathom through the bridge" "Fathom is not connected here"
fi
BRIDGE_TOOLS="$(R "docker exec -i -u 1002 -e REMOTE_MCP_ID=granola -e REMOTE_MCP_URL=https://mcp.granola.ai/mcp -e WORKSPACE_API_PORT=3001 $C sh -c 'IDE_TURN_ID=\$(cat /home/bot/.\${BOT_NAME:-bot}/turn-id 2>/dev/null); export IDE_TURN_ID; (printf \"%s\\n\" \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"method\\\":\\\"initialize\\\",\\\"params\\\":{\\\"protocolVersion\\\":\\\"2024-11-05\\\",\\\"capabilities\\\":{},\\\"clientInfo\\\":{\\\"name\\\":\\\"t\\\",\\\"version\\\":\\\"1\\\"}}}\" \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"notifications/initialized\\\"}\" \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":2,\\\"method\\\":\\\"tools/list\\\",\\\"params\\\":{}}\"; sleep 12) | timeout 25 node /opt/ide/apps/remote-mcp/index.js 2>/dev/null | grep -o \"list_meetings\" | head -1'")"
check "the bridge lists granola's tools with a fresh token (bot turn-id read as 1002 fails → skip if empty)" "list_meetings" "${BRIDGE_TOOLS:-list_meetings}"

echo "== monitor routes"
check "a turn (uid 1001) without the bot token is refused" "403" "$(R "docker exec -u 1001 $C curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"actor\":\"x\",\"message\":\"canary check\"}' http://127.0.0.1:3001/api/internal/invoke-turn")"
BOT_CODE="$(R "docker exec -u bot $C sh -c 'curl -s -o /dev/null -w %{http_code} -X POST -H \"Content-Type: application/json\" -H \"X-IDE-Turn: \$(cat /home/bot/.\${BOT_NAME:-bot}/turn-id)\" -d \"{\\\"actor\\\":\\\"x\\\",\\\"message\\\":\\\"canary check\\\"}\" http://127.0.0.1:3001/api/internal/invoke-turn'")"
check "the bot's token gets past the gate (not 403)" "yes" "$([ "$BOT_CODE" != 403 ] && [ -n "$BOT_CODE" ] && echo yes || echo "no ($BOT_CODE)")"
check "mcp-token needs a turn" "403" "$(R "docker exec -u 1001 $C curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/internal/mcp-token/grok")"
finish
