# shellcheck shell=bash
# Shared by every end-to-end suite in scripts/e2e: finds the deployment to
# test, reads its .env, signs in as the admin and the first member of its
# roster, and gives the suites their helpers (check/has/lacks/ok, jsonq, mint,
# api, code, new_session, turn, finish). Sourced, never run.
#
# The target deployment:
#   E2E_CLIENT=<name>    a directory under clients/ (in a git worktree, which has
#                        no clients/, the main checkout's clients/ is used), or
#   E2E_CLIENT=/abs/dir  any client directory holding the deployment's .env.
# If E2E_CLIENT is not in the environment, scripts/e2e/.env.local (gitignored)
# is read; it may set E2E_CLIENT and the other overrides below. Variables
# already in the environment win over the file.
#
# Overrides: KEEP=1 leaves the test data in place (no cleanup at exit; clean up
# by hand with cleanup.sh). TOKEN_TTL (seconds) and TURN_TIMEOUT (seconds) are
# set by suites that need other values than the defaults.
set -u

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$(basename "$0" .sh)"
REPO_ROOT="$(git -C "$E2E_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$E2E_DIR/../.." && pwd))"

# .env.local: KEY=VALUE lines; a key already set in the environment is kept.
if [ -f "$E2E_DIR/.env.local" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line%$'\r'}"
    case "$_line" in ''|'#'*) continue ;; esac
    _line="${_line#export }"
    _key="${_line%%=*}"
    case "$_key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    [ -n "${!_key+x}" ] || eval "export $_line"
  done < "$E2E_DIR/.env.local"
  unset _line _key
fi

if [ -z "${E2E_CLIENT:-}" ]; then
  cat >&2 <<EOF
$SUITE: no deployment to test. Set E2E_CLIENT to a client directory name under
clients/ or to an absolute path of a client directory (one holding its .env),
either in the environment or in scripts/e2e/.env.local:

  E2E_CLIENT=my-canary bash scripts/e2e/$SUITE.sh
  E2E_CLIENT=/path/to/clients/my-canary bash scripts/e2e/$SUITE.sh
EOF
  exit 2
fi
case "$E2E_CLIENT" in
  /*) CLIENT_DIR="$E2E_CLIENT" ;;
  *)  CLIENT_DIR="$REPO_ROOT/clients/$E2E_CLIENT"
      if [ ! -d "$CLIENT_DIR" ]; then
        # clients/ is gitignored, so a linked worktree has none: use the main checkout's.
        _main="$(git -C "$E2E_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
        [ -n "$_main" ] && CLIENT_DIR="$(dirname "$_main")/clients/$E2E_CLIENT"
        unset _main
      fi ;;
esac
[ -f "$CLIENT_DIR/.env" ] || { echo "$SUITE: no .env in $CLIENT_DIR (E2E_CLIENT=$E2E_CLIENT)" >&2; exit 2; }
export E2E_CLIENT
set -a; . "$CLIENT_DIR/.env"; set +a
C="$IDE_NAME"
BASE="https://$FRONTEND_DOMAIN"
P=/home/coder/project
WS=/opt/ide/workspace-api
R() { ssh -o ConnectTimeout=15 "$HETZNER_HOST" "$@"; }

# Whatever happens, the deployment is left without test data (chats, facts,
# locks, reminders, tasks). KEEP=1 leaves it for a look.
if [ "$SUITE" != cleanup ] && [ -z "${KEEP:-}" ]; then
  trap 'bash "$E2E_DIR/cleanup.sh" >/dev/null 2>&1' EXIT
fi

# ── Results ─────────────────────────────────────────────────────────────────
PASS=0; FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 — expected [$2], got [$3]"; fi
}
has() { # name text needle (case-insensitive, fixed string)
  if echo "$2" | grep -q -i -F -- "$3"; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 — did not contain [$3]:"; echo "$2" | head -c 500 | sed 's/^/       /'; echo; fi
}
lacks() { # name text needle
  if echo "$2" | grep -q -i -F -- "$3"; then FAIL=$((FAIL+1)); echo "  FAIL $1 — contained [$3]:"; echo "$2" | head -c 500 | sed 's/^/       /'; echo; else PASS=$((PASS+1)); echo "  ok   $1"; fi
}
ok() { # name 1|0 [detail]
  if [ "$2" = 1 ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1${3:+ — $3}"; fi
}
skip() { # name reason — a check this deployment has nothing for (not a pass, not a failure)
  echo "  skip $1 — $2"
}
finish() {
  echo
  echo "$SUITE: $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
}

# ── JSON, sessions, API ─────────────────────────────────────────────────────
jsonq() { python3 -c "import json,sys; a=json.load(sys.stdin); print($1)"; }
mint() { R "docker exec $C-auth node -e \"console.log(require('jsonwebtoken').sign({email:'$1'},process.env.SESSION_SECRET,{expiresIn:${TOKEN_TTL:-1800}}))\""; }
api() { # jwt method path [json] → body
  if [ -n "${4:-}" ]; then curl -s -X "$2" -H "Cookie: $COOKIE=$1" -H 'Content-Type: application/json' -d "$4" "$BASE/api$3";
  else curl -s -X "$2" -H "Cookie: $COOKIE=$1" "$BASE/api$3"; fi
}
code() { # jwt method path [json] → HTTP status
  if [ -n "${4:-}" ]; then curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "Cookie: $COOKIE=$1" -H 'Content-Type: application/json' -d "$4" "$BASE/api$3";
  else curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "Cookie: $COOKIE=$1" "$BASE/api$3"; fi
}
# A chat turn: a new session with a title, then the message, the reply text.
new_session() { api "$1" POST /chat/sessions "{\"title\":\"$2\"}" | jsonq 'a.get("id") or a.get("session",{}).get("id","")'; }
turn() { # jwt sessionId message → reply text (SSE data deltas joined; an error event as [[ERROR …]])
  curl -s -N -m "${TURN_TIMEOUT:-240}" -H "Cookie: $COOKIE=$1" --form-string "sessionId=$2" --form-string "message=$3" "$BASE/api/chat" | python3 -c '
import sys, json
out=[]; ev=None
for line in sys.stdin:
    line=line.rstrip("\n")
    if line.startswith("event: "): ev=line[7:]; continue
    if line.startswith("data: "):
        d=line[6:]
        if ev is None:
            try: out.append(json.loads(d))
            except Exception: pass
        elif ev=="error": out.append("[[ERROR " + d + "]]")
        ev=None
    elif line=="": ev=None
print("".join(out))'
}

# ── Who is who: the admin and the first member of the roster ────────────────
COOKIE="$(R "docker exec $C-auth sh -c 'echo \${SESSION_COOKIE_NAME:-ide_session}'")"
ROSTER="$(R "docker exec $C cat $P/.allowed-emails.json")"
[ "$SUITE" = cleanup ] && return 0
ADMIN_EMAIL="$(echo "$ROSTER" | jsonq 'next(e["email"] for e in a if e["role"]=="admin")')"
ADMIN_SLUG="$(echo "$ROSTER" | jsonq 'next(e.get("slug","") for e in a if e["role"]=="admin")')"
MEMBER_EMAIL="$(echo "$ROSTER" | jsonq 'next((e["email"] for e in a if e["role"]!="admin"), "")')"
MEMBER_SLUG="$(echo "$ROSTER" | jsonq 'next((e.get("slug","") for e in a if e["role"]!="admin"), "")')"
ADMIN_JWT="$(mint "$ADMIN_EMAIL")"
MEMBER_JWT=""; [ -n "$MEMBER_EMAIL" ] && MEMBER_JWT="$(mint "$MEMBER_EMAIL")"
TAG="$(date +%H%M%S)"
# A suite that needs a second person stops here when the roster has none.
need_member() { [ -n "$MEMBER_EMAIL" ] || { echo "no member on the roster — add one first"; exit 1; }; }
