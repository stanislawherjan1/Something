#!/usr/bin/env bash
# =============================================================================
# preflight.sh — fail-fast checks before a deploy touches anything slow
# =============================================================================
# Verifies in seconds everything that would otherwise fail a deploy minutes
# into a Docker build:
#
#   env      required vars present + valid format (HETZNER_HOST, REMOTE_PATH,
#            FRONTEND_DOMAIN)
#   ssh      key auth works (BatchMode — never prompts for a password)
#   dns      FRONTEND_DOMAIN resolves to the server's IP (TLS provisioning
#            fails without it)
#   oauth    the Google OAuth client exists and https://<domain>/auth/callback
#            is a registered redirect URI — probed via Google's authorize
#            endpoint, no login needed; catches redirect_uri_mismatch BEFORE
#            the end-user hits it at first sign-in
#   disk     remote root filesystem has room for a build (warn ≥75%, fail ≥90%)
#   git      working tree is clean — deploys ship the working tree, so
#            uncommitted local edits would reach production (warn)
#   docker   docker present on the server (warn — ensure-server.sh installs it)
#
# Usage:
#   bin/preflight.sh [--env-file <path>] [--json] [--strict] [--skip a,b,...]
#
# Config comes from the environment (a client wrapper that already sourced
# .env) or from --env-file. Never prompts — safe for CI and coding agents.
#
# Exit codes (stable contract — agents rely on these):
#   0  all checks passed (warnings allowed unless --strict)
#   1  usage / config-file error
#   2  one or more checks failed — fix the reported issue and re-run;
#      always safe to retry
#
# --json prints exactly one JSON object on stdout:
#   {"ok":bool,"checks":[{"name":..,"status":"ok|warn|fail|skipped",
#     "error":<machine-parseable code or null>,"retryable":bool,"detail":..}]}
# Error codes: env_missing, env_invalid, ssh_unreachable, dns_unresolved,
# dns_mismatch, oauth_redirect_unregistered, oauth_client_invalid, disk_full,
# dirty_worktree, docker_missing.
# =============================================================================

set -uo pipefail

JSON=0
STRICT=0
SKIP=""
ENV_FILE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --json)     JSON=1 ;;
        --strict)   STRICT=1 ;;
        --skip)     SKIP="${2:-}"; shift ;;
        --env-file) ENV_FILE="${2:-}"; shift ;;
        -h|--help)  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "preflight: unknown option '$1' (see --help)" >&2; exit 1 ;;
    esac
    shift
done

if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || { echo "preflight: env file not found: $ENV_FILE" >&2; exit 1; }
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Reuse deploy.sh's multiplexed SSH socket when one is already open — a
# preflight right before a deploy then costs one handshake total.
SSH_CTRL="/tmp/wsdeploy-%h-%p-%r.sock"
SSH_BASE_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
 -o ControlMaster=auto -o ControlPath=$SSH_CTRL -o ControlPersist=10m"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; NC=''; }

# --- Result collection (bash-3.2 compatible: parallel arrays, no declare -A) --
NAMES=(); STATUSES=(); ERRORS=(); RETRYABLES=(); DETAILS=()
HAS_FAIL=0; HAS_WARN=0

record() { # name status error retryable detail
    NAMES+=("$1"); STATUSES+=("$2"); ERRORS+=("$3"); RETRYABLES+=("$4"); DETAILS+=("$5")
    case "$2" in
        fail) HAS_FAIL=1 ;;
        warn) HAS_WARN=1 ;;
    esac
    if [ "$JSON" -eq 0 ]; then
        case "$2" in
            ok)      printf "${GREEN}  ✓ %-7s${NC} %s\n" "$1" "$5" ;;
            warn)    printf "${YELLOW}  ⚠ %-7s${NC} %s\n" "$1" "$5" ;;
            fail)    printf "${RED}  ✗ %-7s${NC} %s\n" "$1" "$5" ;;
            skipped) printf "  - %-7s %s\n" "$1" "$5" ;;
        esac
    fi
}

skipped() { case ",$SKIP," in *",$1,"*) return 0 ;; *) return 1 ;; esac }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t'; }

# ─── Check: env ──────────────────────────────────────────────────────────────
ENV_OK=1
if skipped env; then
    record env skipped "" false "skipped by --skip"
else
    missing=""
    for v in HETZNER_HOST REMOTE_PATH FRONTEND_DOMAIN; do
        eval "val=\${$v:-}"
        [ -n "$val" ] || missing="$missing $v"
    done
    if [ -n "$missing" ]; then
        record env fail env_missing false "missing:${missing} — fill them in .env (bootstrap-client-env.sh derives the rest)"
        ENV_OK=0
    elif ! echo "$HETZNER_HOST" | grep -qE '^[a-zA-Z0-9_-]+@[a-zA-Z0-9._-]+$'; then
        record env fail env_invalid false "HETZNER_HOST must be user@host, got: $HETZNER_HOST"
        ENV_OK=0
    elif ! echo "$REMOTE_PATH" | grep -qE '^/[a-zA-Z0-9/._-]+$'; then
        record env fail env_invalid false "REMOTE_PATH contains invalid characters: $REMOTE_PATH"
        ENV_OK=0
    elif ! echo "$FRONTEND_DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253})$' \
         || ! echo "$FRONTEND_DOMAIN" | grep -q '\.'; then
        record env fail env_invalid false "FRONTEND_DOMAIN must be a bare domain (no https://, no path): $FRONTEND_DOMAIN"
        ENV_OK=0
    else
        record env ok "" false "HETZNER_HOST=$HETZNER_HOST FRONTEND_DOMAIN=$FRONTEND_DOMAIN"
    fi
fi

SERVER_HOST="${HETZNER_HOST#*@}"

# ─── Check: ssh ──────────────────────────────────────────────────────────────
SSH_OK=0
if skipped ssh || [ "$ENV_OK" -eq 0 ]; then
    record ssh skipped "" false "skipped (env invalid or --skip)"
else
    # shellcheck disable=SC2086
    if ssh -n $SSH_BASE_OPTS "$HETZNER_HOST" 'echo ok' >/dev/null 2>&1; then
        record ssh ok "" false "key auth to $HETZNER_HOST works"
        SSH_OK=1
    else
        record ssh fail ssh_unreachable true "cannot reach $HETZNER_HOST with key auth — fix: ssh-copy-id $HETZNER_HOST, then verify: ssh $HETZNER_HOST 'echo ok'"
    fi
fi

# ─── Check: dns ──────────────────────────────────────────────────────────────
if skipped dns || [ "$ENV_OK" -eq 0 ]; then
    record dns skipped "" false "skipped (env invalid or --skip)"
elif ! command -v dig >/dev/null 2>&1; then
    record dns warn "" true "dig not installed locally — cannot verify $FRONTEND_DOMAIN; TLS fails at deploy if DNS is wrong"
elif ! echo "$SERVER_HOST" | grep -qE '^[0-9]+(\.[0-9]+){3}$'; then
    record dns warn "" true "server address '$SERVER_HOST' is not an IP — cannot compare A record automatically"
else
    resolved="$(dig +short A "$FRONTEND_DOMAIN" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1 || true)"
    if [ -z "$resolved" ]; then
        record dns fail dns_unresolved true "$FRONTEND_DOMAIN does not resolve — add an A record → $SERVER_HOST, wait for propagation, re-run"
    elif [ "$resolved" != "$SERVER_HOST" ]; then
        record dns fail dns_mismatch true "$FRONTEND_DOMAIN points to $resolved, expected $SERVER_HOST — fix the A record"
    else
        record dns ok "" false "$FRONTEND_DOMAIN → $SERVER_HOST"
    fi
fi

# ─── Check: oauth ────────────────────────────────────────────────────────────
# Unauthenticated GET against Google's authorize endpoint. Google renders the
# failure server-side, so the body tells us exactly what's wrong without any
# login: "redirect_uri_mismatch" (URI not registered), "invalid_client" /
# "The OAuth client was not found" (bad client id). Anything else = the
# sign-in page = both halves are fine. This is the #1 first-login failure —
# catching it here beats the end-user catching it at the handoff.
if skipped oauth || [ "$ENV_OK" -eq 0 ]; then
    record oauth skipped "" false "skipped (env invalid or --skip)"
elif [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
    record oauth warn "" false "GOOGLE_CLIENT_ID not set (clients/admin.env) — cannot verify the redirect URI; first Google sign-in may fail"
else
    CALLBACK_URI="https://${FRONTEND_DOMAIN}/auth/callback"
    probe_url="https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=https%3A%2F%2F${FRONTEND_DOMAIN}%2Fauth%2Fcallback&response_type=code&scope=openid%20email"
    probe_body="$(curl -sSL --max-time 8 "$probe_url" 2>/dev/null || true)"
    if [ -z "$probe_body" ]; then
        record oauth warn "" true "could not reach accounts.google.com to verify OAuth — check network; not blocking"
    elif printf '%s' "$probe_body" | grep -q "redirect_uri_mismatch"; then
        record oauth fail oauth_redirect_unregistered true "redirect URI not registered — add ${CALLBACK_URI} in GCP console (APIs & Services → Credentials → your OAuth client → Authorized redirect URIs), or run: bin/add-redirect-uri.sh ${FRONTEND_DOMAIN}"
    elif printf '%s' "$probe_body" | grep -qi "invalid_client\|OAuth client was not found"; then
        record oauth fail oauth_client_invalid false "GOOGLE_CLIENT_ID rejected by Google — check clients/admin.env against GCP console → Credentials"
    else
        record oauth ok "" false "client valid, ${CALLBACK_URI} registered"
    fi
fi

# ─── Check: disk (remote) ────────────────────────────────────────────────────
if skipped disk || [ "$SSH_OK" -eq 0 ]; then
    record disk skipped "" false "skipped (ssh unavailable or --skip)"
else
    # Docker layers land under /var/lib/docker which lives on / for our VPSes.
    # shellcheck disable=SC2086
    pcent="$(ssh -n $SSH_BASE_OPTS "$HETZNER_HOST" "df -P /var/lib/docker 2>/dev/null || df -P /" 2>/dev/null \
        | awk 'NR==2 {gsub(/%/,"",$5); print $5}' || true)"
    if ! echo "$pcent" | grep -qE '^[0-9]+$'; then
        record disk warn "" true "could not read remote disk usage"
    elif [ "$pcent" -ge 90 ]; then
        record disk fail disk_full true "remote disk ${pcent}% full — a build will fail; fix: ssh $HETZNER_HOST 'docker builder prune -af && docker system prune -f'"
    elif [ "$pcent" -ge 75 ]; then
        record disk warn "" true "remote disk ${pcent}% full — build may fit but prune soon (docker builder prune -af)"
    else
        record disk ok "" false "remote disk ${pcent}% used"
    fi
fi

# ─── Check: git (local working tree) ─────────────────────────────────────────
if skipped git; then
    record git skipped "" false "skipped by --skip"
elif ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    record git warn "" false "not a git repository — cannot verify deploy source"
else
    dirty="$(git -C "$REPO_ROOT" status --porcelain -- ide-template scripts 2>/dev/null | head -5 || true)"
    if [ -n "$dirty" ]; then
        commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
        record git warn dirty_worktree false "uncommitted changes in ide-template/ or scripts/ will ship (HEAD=$commit) — commit first, or proceed deliberately"
    else
        commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
        record git ok "" false "working tree clean, deploying HEAD=$commit"
    fi
fi

# ─── Check: docker (remote) ──────────────────────────────────────────────────
if skipped docker || [ "$SSH_OK" -eq 0 ]; then
    record docker skipped "" false "skipped (ssh unavailable or --skip)"
else
    # shellcheck disable=SC2086
    if ssh -n $SSH_BASE_OPTS "$HETZNER_HOST" 'command -v docker >/dev/null 2>&1'; then
        record docker ok "" false "docker present on server"
    else
        record docker warn docker_missing false "docker not installed on server — ensure-server.sh installs it during deploy"
    fi
fi

# ─── Report ──────────────────────────────────────────────────────────────────
OK=1
[ "$HAS_FAIL" -eq 1 ] && OK=0
[ "$STRICT" -eq 1 ] && [ "$HAS_WARN" -eq 1 ] && OK=0

if [ "$JSON" -eq 1 ]; then
    out='{"ok":'
    [ "$OK" -eq 1 ] && out+='true' || out+='false'
    out+=',"checks":['
    for i in "${!NAMES[@]}"; do
        [ "$i" -gt 0 ] && out+=','
        err="null"; [ -n "${ERRORS[$i]}" ] && err="\"$(json_escape "${ERRORS[$i]}")\""
        out+="{\"name\":\"${NAMES[$i]}\",\"status\":\"${STATUSES[$i]}\",\"error\":$err,\"retryable\":${RETRYABLES[$i]},\"detail\":\"$(json_escape "${DETAILS[$i]}")\"}"
    done
    out+=']}'
    printf '%s\n' "$out"
else
    echo ""
    if [ "$OK" -eq 1 ]; then
        printf "${GREEN}Preflight passed${NC}"
        [ "$HAS_WARN" -eq 1 ] && printf "${YELLOW} (with warnings)${NC}"
        echo ""
    else
        printf "${RED}Preflight FAILED — fix the ✗ items above and re-run.${NC}\n"
    fi
fi

[ "$OK" -eq 1 ] && exit 0 || exit 2
