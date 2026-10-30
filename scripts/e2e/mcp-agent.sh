#!/usr/bin/env bash
# A coding agent connects to the workspace and reads as one person. Headless:
# a scripted MCP client does what Claude Code does — discovers the
# authorization server from the 401, registers (dynamic registration; the
# metadata-document path needs a public HTTPS document and is checked by hand
# with a real client), is sent to the consent page, consents as the member
# (a minted session stands in for the browser), exchanges the code with PKCE,
# refreshes, and then talks MCP: the context, memory, tasks, files — the
# member's own and the team's, never the admin's. The admin's agent reads no
# wider. The grant is revoked at the end. A person taken off the team loses the agent with them. No model turns. About
# two minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/mcp-agent.sh
TOKEN_TTL=600
source "$(dirname "$0")/lib.sh"
need_member
MCP="$BASE/mcp"
TITLE="E2E-$TAG mcp own task"
GONE="e2e-gone-$TAG@example.com"
IDS=(); GRANTS=()
trap 'api "$ADMIN_JWT" DELETE "/team/$GONE" >/dev/null 2>&1; R "docker exec -u root $C sh -c \"rm -rf $P/.archived-members/e2e-gone-*\""; for id in "${IDS[@]}"; do api "$MEMBER_JWT" DELETE "/tasks/$id" >/dev/null 2>&1; done; for g in "${GRANTS[@]}"; do curl -s -o /dev/null -X DELETE -H "Cookie: $COOKIE=$MEMBER_JWT" "$BASE/auth/agents/$g"; curl -s -o /dev/null -X DELETE -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/auth/agents/$g"; done' EXIT

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
pkce_verifier="$(head -c 32 /dev/urandom | b64url)"
pkce_challenge="$(printf '%s' "$pkce_verifier" | openssl dgst -sha256 -binary | b64url)"

echo "== discovery, as a client with no token"
H="$(curl -s -D - -o /dev/null -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' "$MCP")"
check "no token → 401" "401" "$(echo "$H" | head -1 | awk '{print $2}')"
has "…with the resource metadata in WWW-Authenticate" "$H" "resource_metadata=\"$BASE/.well-known/oauth-protected-resource/mcp\""
PRM="$(curl -s "$BASE/.well-known/oauth-protected-resource/mcp")"
check "protected resource metadata names this endpoint" "$MCP" "$(echo "$PRM" | jsonq 'a.get("resource","")')"
AS="$(curl -s "$BASE/.well-known/oauth-authorization-server")"
check "authorization server: PKCE S256, public clients, metadata documents, registration" "yes" "$(echo "$AS" | jsonq '"yes" if a.get("code_challenge_methods_supported")==["S256"] and a.get("token_endpoint_auth_methods_supported")==["none"] and a.get("client_id_metadata_document_supported") and a.get("registration_endpoint") else "no"')"
check "…served without a session, GET only" "yes" "$(c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/.well-known/oauth-authorization-server"); [ "$c" = 403 ] || [ "$c" = 405 ] && echo yes || echo "no ($c)")"

echo "== register and authorize"
REG="$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"client_name\":\"E2E-$TAG agent\",\"redirect_uris\":[\"http://localhost:51234/callback\"],\"token_endpoint_auth_method\":\"none\"}" "$BASE/oauth/register")"
CID="$(echo "$REG" | jsonq 'a.get("client_id","")')"
check "a loopback public client registers" "yes" "$([ -n "$CID" ] && echo yes || echo no)"
AUTHZ="$BASE/oauth/authorize?response_type=code&client_id=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$CID")&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&code_challenge=$pkce_challenge&code_challenge_method=S256&state=e2e-$TAG&scope=read%20read%3Aprivate%20write%3Atasks&resource=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$MCP")"
LOC="$(curl -s -o /dev/null -w '%{redirect_url}' "$AUTHZ")"
has "without a session the person is sent to sign in, back to the consent page" "$LOC" "/auth/google?returnTo=%2Fapp%2Fconnect%3Freq%3D"
LOC="$(curl -s -o /dev/null -w '%{redirect_url}' -H "Cookie: $COOKIE=$MEMBER_JWT" "$AUTHZ")"
has "with a session, straight to the consent page" "$LOC" "/app/connect?req="
REQ="${LOC##*req=}"
SHOWN="$(curl -s -H "Cookie: $COOKIE=$MEMBER_JWT" "$BASE/auth/agents/request/$REQ")"
has "the consent page sees the client's name" "$SHOWN" "E2E-$TAG agent"
check "…and every scope to choose from, whatever the client asked" "read,read:private,write:tasks,write:memory,write:files,ask" "$(echo "$SHOWN" | jsonq '",".join(a.get("scopes",[]))')"
check "a client that would send the code to a website is refused" "invalid_redirect_uri" "$(curl -s -X POST -H 'Content-Type: application/json' -d '{"client_name":"Claude Code","redirect_uris":["https://evil.example.com/cb"]}' "$BASE/oauth/register" | jsonq 'a.get("error","")')"
# (the body in a variable: inside $( ) bash brace-expands a literal {a,b} and curl gets two bodies)
BOGUS='{"req":"'"$REQ"'-nope","allow":true}'
check "the admin cannot answer the member's request" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE=$ADMIN_JWT" -H 'Content-Type: application/json' --data-binary "$BOGUS" "$BASE/auth/agents/consent")"
CONSENT="$(curl -s -X POST -H "Cookie: $COOKIE=$MEMBER_JWT" -H 'Content-Type: application/json' -d "{\"req\":\"$REQ\",\"allow\":true,\"scopes\":[\"read\",\"read:private\",\"write:tasks\"]}" "$BASE/auth/agents/consent")"
REDIRECT="$(echo "$CONSENT" | jsonq 'a.get("redirect","")')"
has "allow answers with the client's redirect, code and state" "$REDIRECT" "http://localhost:51234/callback?code=sc_"
has "…and the state" "$REDIRECT" "state=e2e-$TAG"
CODE="$(python3 -c "import urllib.parse,sys; print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).query).get('code',[''])[0])" "$REDIRECT")"

echo "== token"
TOK="$(curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$CODE" --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=http://localhost:51234/callback" --data-urlencode "code_verifier=$pkce_verifier" --data-urlencode "resource=$MCP" "$BASE/oauth/token")"
AT="$(echo "$TOK" | jsonq 'a.get("access_token","")')"; RT="$(echo "$TOK" | jsonq 'a.get("refresh_token","")')"
check "the exchange yields a bearer token with the granted scopes" "read read:private write:tasks" "$(echo "$TOK" | jsonq 'a.get("scope","")')"
TOK2="$(curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "grant_type=refresh_token" --data-urlencode "refresh_token=$RT" --data-urlencode "client_id=$CID" "$BASE/oauth/token")"
AT2="$(echo "$TOK2" | jsonq 'a.get("access_token","")')"
check "a refresh rotates the tokens" "yes" "$([ -n "$AT2" ] && [ "$AT2" != "$AT" ] && echo yes || echo no)"
PAGE="$(curl -s -H "Cookie: $COOKIE=$MEMBER_JWT" "$BASE/auth/agents")"
GID="$(echo "$PAGE" | jsonq "next((g['id'] for g in a.get('grants',[]) if g.get('client')=='E2E-$TAG agent'), '')")"; GRANTS+=("$GID")
has "the Coding agents page lists the connection" "$PAGE" "E2E-$TAG agent"

# One MCP call: JSON-RPC over POST, a JSON answer (the server is stateless).
mcp() { # token method params-json → result json
  curl -s -m 60 -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-11-25' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$MCP"
}
tool() { mcp "$1" tools/call "{\"name\":\"$2\",\"arguments\":$3}" | jsonq '"".join(c.get("text","") for c in a.get("result",{}).get("content",[])) if "result" in a else "ERROR "+json.dumps(a.get("error"))'; }

echo "== the member's agent reads as the member"
T="$(api "$MEMBER_JWT" POST /tasks "{\"title\":\"$TITLE\",\"description\":\"E2E-$TAG made in the browser, on the own list\"}")"
TID="$(echo "$T" | jsonq 'a.get("task",{}).get("id","")')"; IDS+=("$TID")
INIT="$(mcp "$AT2" initialize '{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}')"
has "initialize answers with the server's instructions" "$INIT" "get_context"
TOOLS="$(mcp "$AT2" tools/list '{}')"
check "the read tools are there, read-only" "yes" "$(echo "$TOOLS" | jsonq '"yes" if all(any(t["name"]==n and t.get("annotations",{}).get("readOnlyHint") for t in a["result"]["tools"]) for n in ["get_context","search_memory","list_tasks","read_file"]) else "no"')"
CTX="$(tool "$AT2" get_context "{\"project\":\"$TITLE\"}")"
has "the context bundle is wrapped as data" "$CTX" "<<<WORKSPACE DATA"
has "…and lists the member's own task about the project (they ticked their private things)" "$CTX" "] $TITLE"
LIST="$(tool "$AT2" list_tasks '{"which":"mine"}')"
has "list_tasks(mine) has the own task, on the own list" "$LIST" "own list"
has "…by title" "$LIST" "$TITLE"
MEM="$(tool "$AT2" search_memory '{"query":"zzz-e2e-nothing"}')"
has "a search with no match says so" "$MEM" "nothing in memory matches"
F="$(tool "$AT2" read_file "{\"path\":\"users/$ADMIN_SLUG/anything.md\"}")"
has "the admin's folder does not exist for the member's agent" "$F" "not a file you can read"
F="$(tool "$AT2" read_file '{"path":".allowed-emails.json"}')"
lacks "the roster file is not readable" "$F" "$ADMIN_EMAIL"
F="$(tool "$AT2" read_file '{"path":"memory/MISSION.md"}')"
has "memory is not a file" "$F" "search_memory"

echo "== the gate holds"
check "a session JWT as bearer is not an agent" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $MEMBER_JWT" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$MCP")"
check "GET is 405" "405" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AT2" "$MCP")"
check "the old access token is dead after the refresh? no — it lives until it expires" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$MCP")"
EV="$(R "docker exec -u 1001 $C sh -c 'grep agent_read $P/memory/_engine/v4-log.jsonl | tail -1'")"
check "the read is on the member's Changes, with the client" "yes" "$(echo "$EV" | jsonq "'yes' if a.get('scope')=='user:$MEMBER_SLUG' and 'E2E-$TAG agent' in a.get('client','') else 'no'" 2>/dev/null || echo no)"

echo "== the admin's agent reads no wider"
pkce_verifier2="$(head -c 32 /dev/urandom | b64url)"; pkce_challenge2="$(printf '%s' "$pkce_verifier2" | openssl dgst -sha256 -binary | b64url)"
AUTHZ2="${AUTHZ/code_challenge=$pkce_challenge/code_challenge=$pkce_challenge2}"
LOC="$(curl -s -o /dev/null -w '%{redirect_url}' -H "Cookie: $COOKIE=$ADMIN_JWT" "$AUTHZ2")"; REQ2="${LOC##*req=}"
CONSENT="$(curl -s -X POST -H "Cookie: $COOKIE=$ADMIN_JWT" -H 'Content-Type: application/json' -d "{\"req\":\"$REQ2\",\"allow\":true}" "$BASE/auth/agents/consent")"
CODE2="$(python3 -c "import urllib.parse,sys; print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).query).get('code',[''])[0])" "$(echo "$CONSENT" | jsonq 'a.get("redirect","")')")"
ATA="$(curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$CODE2" --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=http://localhost:51234/callback" --data-urlencode "code_verifier=$pkce_verifier2" --data-urlencode "resource=$MCP" "$BASE/oauth/token" | jsonq 'a.get("access_token","")')"
GA="$(curl -s -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/auth/agents" | jsonq "next((g['id'] for g in a.get('grants',[]) if g.get('client')=='E2E-$TAG agent'), '')")"; GRANTS+=("$GA")
LIST="$(tool "$ATA" list_tasks '{"which":"all"}')"
lacks "the admin's agent does not see the member's own task" "$LIST" "$TITLE"
F="$(tool "$ATA" read_file "{\"path\":\"users/$MEMBER_SLUG/anything.md\"}")"
has "…nor the member's folder" "$F" "not a file you can read"
INV="$(curl -s -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/auth/agents?team=1")"
has "the admin's page shows the team inventory with the member's connection" "$INV" "\"email\":\"$MEMBER_EMAIL\""
lacks "…without its scopes" "$(echo "$INV" | jsonq 'json.dumps([g for g in a.get("team",[]) if g.get("email")=="'"$MEMBER_EMAIL"'"])')" "write:tasks"

echo "== a person taken off the team loses the agent with it"
NEWBIE='{"email":"'"$GONE"'","role":"member"}'
check "a temporary member is added" "yes" "$(api "$ADMIN_JWT" POST /team "$NEWBIE" | jsonq '"yes" if a.get("ok") else json.dumps(a)')"
GJWT="$(mint "$GONE")"
pkce_verifier3="$(head -c 32 /dev/urandom | b64url)"; pkce_challenge3="$(printf '%s' "$pkce_verifier3" | openssl dgst -sha256 -binary | b64url)"
LOC="$(curl -s -o /dev/null -w '%{redirect_url}' -H "Cookie: $COOKIE=$GJWT" "${AUTHZ/code_challenge=$pkce_challenge/code_challenge=$pkce_challenge3}")"; REQ3="${LOC##*req=}"
CONSENT='{"req":"'"$REQ3"'","allow":true,"scopes":["read"]}'
CODE3="$(python3 -c "import urllib.parse,sys; print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).query).get('code',[''])[0])" "$(curl -s -X POST -H "Cookie: $COOKIE=$GJWT" -H 'Content-Type: application/json' --data-binary "$CONSENT" "$BASE/auth/agents/consent" | jsonq 'a.get("redirect","")')")"
TOKG="$(curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$CODE3" --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=http://localhost:51234/callback" --data-urlencode "code_verifier=$pkce_verifier3" --data-urlencode "resource=$MCP" "$BASE/oauth/token")"
ATG="$(echo "$TOKG" | jsonq 'a.get("access_token","")')"; RTG="$(echo "$TOKG" | jsonq 'a.get("refresh_token","")')"
GG="$(curl -s -H "Cookie: $COOKIE=$GJWT" "$BASE/auth/agents" | jsonq "next((g['id'] for g in a.get('grants',[]) if g.get('client')=='E2E-$TAG agent'), '')")"; GRANTS+=("$GG")
listed() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$MCP"; }
check "…connects an agent and reads" "200" "$(listed "$ATG")"
check "the admin takes them off the team" "yes" "$(api "$ADMIN_JWT" DELETE "/team/$GONE" | jsonq '"yes" if a.get("ok") else json.dumps(a)')"
check "…and their agent's token is refused at once" "401" "$(listed "$ATG")"
# auth-service reads the roster at most every 30 s (as for any sign-in); the
# workspace checks it live, so reads end at once and the refresh at the latest
# half a minute later — and with it the connection itself.
sleep 31
check "…and within half a minute it cannot be refreshed" "invalid_grant" "$(curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "grant_type=refresh_token" --data-urlencode "refresh_token=$RTG" --data-urlencode "client_id=$CID" "$BASE/oauth/token" | jsonq 'a.get("error") or json.dumps(a)[:300]')"
lacks "…and the connection is gone from the admin's inventory" "$(curl -s -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/auth/agents?team=1")" "$GONE"

echo "== disconnect"
check "the member disconnects the agent" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Cookie: $COOKIE=$MEMBER_JWT" "$BASE/auth/agents/$GID")"
check "…and its token is dead" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $AT2" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$MCP")"

finish
