#!/usr/bin/env bash
# mint.sh <slug> <scope …>     → "<access token> <granted scopes>" for the eval client, as that person,
#                                through the real flow (register, authorize, consent, PKCE, token).
# mint.sh --cleanup <slug …>   → revokes every eval grant of those people.
# mint.sh --info               → "<base url> <bot name>"
KEEP=1 TOKEN_TTL=900; export KEEP TOKEN_TTL; SUITE=mcp-eval
source "$(dirname "$0")/../lib.sh" >/dev/null 2>&1
CLIENT_NAME='Eval (headless Claude Code)'
jwt_of() { mint "$(echo "$ROSTER" | jsonq "next(e['email'] for e in a if e.get('slug')=='$1')")"; }
if [ "$1" = "--info" ]; then
  echo "$BASE $(api "$ADMIN_JWT" GET /branding | jsonq 'a.get("botDisplayName") or (a.get("botName") or "assistant").capitalize()')"; exit 0
fi
if [ "$1" = "--cleanup" ]; then
  shift
  for slug in "$@"; do
    J="$(jwt_of "$slug")"
    for id in $(curl -s -H "Cookie: $COOKIE=$J" "$BASE/auth/agents" | jsonq "' '.join(g['id'] for g in a.get('grants',[]) if g.get('client')=='$CLIENT_NAME')"); do
      curl -s -o /dev/null -X DELETE -H "Cookie: $COOKIE=$J" "$BASE/auth/agents/$id"
    done
  done
  exit 0
fi
SLUG="$1"; shift; SCOPES="$*"
JWT="$(jwt_of "$SLUG")"
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
V="$(head -c 32 /dev/urandom | b64url)"; C="$(printf '%s' "$V" | openssl dgst -sha256 -binary | b64url)"
REG='{"client_name":"'"$CLIENT_NAME"'","redirect_uris":["http://localhost:51234/callback"],"token_endpoint_auth_method":"none"}'
CID="$(curl -s -X POST -H 'Content-Type: application/json' --data-binary "$REG" "$BASE/oauth/register" | jsonq 'a["client_id"]')"
SC="$(echo "$SCOPES" | sed 's/ /%20/g; s/:/%3A/g')"
REQ="$(curl -s -o /dev/null -w '%{redirect_url}' -H "Cookie: $COOKIE=$JWT" "$BASE/oauth/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&code_challenge=$C&code_challenge_method=S256&state=s&scope=$SC")"; REQ="${REQ##*req=}"
LIST="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1].split()))" "$SCOPES")"
BODY='{"req":"'"$REQ"'","allow":true,"scopes":'"$LIST"'}'
CODE="$(curl -s -X POST -H "Cookie: $COOKIE=$JWT" -H 'Content-Type: application/json' --data-binary "$BODY" "$BASE/auth/agents/consent" | python3 -c "import sys,json,urllib.parse; r=json.load(sys.stdin)['redirect']; print(urllib.parse.parse_qs(urllib.parse.urlparse(r).query)['code'][0])")"
curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=http://localhost:51234/callback" --data-urlencode "code_verifier=$V" "$BASE/oauth/token" | jsonq 'a["access_token"]+" "+a["scope"].replace(" ",",")'
