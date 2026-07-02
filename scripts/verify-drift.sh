#!/usr/bin/env bash
# =============================================================================
# verify-drift.sh — which client runs which version?
# =============================================================================
# Reads the .deploy-manifest.json that deploy.sh writes on every successful
# deploy (REMOTE_PATH/.deploy-manifest.json) from every client in clients/
# and compares the deployed commit against local HEAD (or --ref <commit>).
#
# Usage:
#   scripts/verify-drift.sh [--ref <commit-ish>] [--json]
#
# Per-client status:
#   ok           deployed commit == reference commit
#   drift        deployed commit differs (shows how many commits behind)
#   no-manifest  client was last deployed before manifests existed
#   unreachable  SSH to the host failed
#
# Read-only: only `cat`s one file over SSH per client. Exit 0 if the whole
# fleet is ok, 3 if any client drifts / has no manifest / is unreachable.
# =============================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="HEAD"
JSON=0

while [ $# -gt 0 ]; do
    case "$1" in
        --ref)  REF="${2:-HEAD}"; shift ;;
        --json) JSON=1 ;;
        -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "verify-drift: unknown option '$1'" >&2; exit 1 ;;
    esac
    shift
done

REF_COMMIT="$(git -C "$REPO_ROOT" rev-parse "$REF" 2>/dev/null)" \
    || { echo "verify-drift: cannot resolve ref '$REF'" >&2; exit 1; }

SSH_CTRL="/tmp/wsdeploy-%h-%p-%r.sock"
SSH_BASE_OPTS="-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
 -o ControlMaster=auto -o ControlPath=$SSH_CTRL -o ControlPersist=10m"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; NC=''; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t'; }
# Pull a string field out of the one-object manifest we write ourselves.
manifest_field() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

ANY_BAD=0
ROWS=""   # accumulated JSON rows

[ "$JSON" -eq 0 ] && printf "%-26s %-13s %-8s %s\n" "CLIENT" "STATUS" "COMMIT" "DETAIL"

for dir in "$REPO_ROOT"/clients/*/; do
    name="$(basename "$dir")"
    case "$name" in example-client) continue ;; esac
    [ -f "$dir/.env" ] || continue

    host="$(sed -n 's/^HETZNER_HOST=//p' "$dir/.env" | head -1 | tr -d '"')"
    rpath="$(sed -n 's/^REMOTE_PATH=//p' "$dir/.env" | head -1 | tr -d '"')"
    [ -n "$rpath" ] || rpath="/root/$name"

    status=""; commit=""; detail=""
    if [ -z "$host" ]; then
        status="unreachable"; detail="HETZNER_HOST missing in .env"
    else
        # shellcheck disable=SC2086
        manifest="$(ssh $SSH_BASE_OPTS "$host" "cat '$rpath/.deploy-manifest.json' 2>/dev/null" 2>/dev/null)"
        rc=$?
        if [ $rc -ne 0 ] && [ -z "$manifest" ]; then
            # Distinguish "host down" from "file missing": probe the host.
            # shellcheck disable=SC2086
            if ssh $SSH_BASE_OPTS "$host" 'true' 2>/dev/null; then
                status="no-manifest"; detail="deployed before manifests existed — redeploy to stamp"
            else
                status="unreachable"; detail="ssh to $host failed"
            fi
        elif [ -z "$manifest" ]; then
            status="no-manifest"; detail="deployed before manifests existed — redeploy to stamp"
        else
            commit="$(manifest_field "$manifest" git_commit)"
            deployed_at="$(manifest_field "$manifest" deployed_at)"
            if [ -z "$commit" ]; then
                status="no-manifest"; detail="manifest unreadable"
            elif [ "$commit" = "$REF_COMMIT" ]; then
                status="ok"; detail="deployed $deployed_at"
            else
                behind="$(git -C "$REPO_ROOT" rev-list --count "$commit..$REF_COMMIT" 2>/dev/null || echo '?')"
                status="drift"; detail="$behind commit(s) behind $REF (deployed $deployed_at)"
            fi
        fi
    fi

    [ "$status" = "ok" ] || ANY_BAD=1
    short="${commit:0:7}"

    if [ "$JSON" -eq 1 ]; then
        [ -n "$ROWS" ] && ROWS+=","
        ROWS+="{\"client\":\"$(json_escape "$name")\",\"status\":\"$status\",\"commit\":\"$(json_escape "$commit")\",\"detail\":\"$(json_escape "$detail")\"}"
    else
        case "$status" in
            ok)          printf "%-26s ${GREEN}%-13s${NC} %-8s %s\n" "$name" "$status" "$short" "$detail" ;;
            drift)       printf "%-26s ${YELLOW}%-13s${NC} %-8s %s\n" "$name" "$status" "$short" "$detail" ;;
            *)           printf "%-26s ${RED}%-13s${NC} %-8s %s\n" "$name" "$status" "$short" "$detail" ;;
        esac
    fi
done

if [ "$JSON" -eq 1 ]; then
    ok_flag=true; [ "$ANY_BAD" -eq 1 ] && ok_flag=false
    printf '{"ok":%s,"reference":"%s","clients":[%s]}\n' "$ok_flag" "$REF_COMMIT" "$ROWS"
else
    echo ""
    if [ "$ANY_BAD" -eq 0 ]; then
        printf "${GREEN}Fleet in sync with %s (%s)${NC}\n" "$REF" "${REF_COMMIT:0:7}"
    else
        printf "${YELLOW}Fleet has drift / gaps — redeploy the flagged clients.${NC}\n"
    fi
fi

exit $((ANY_BAD == 0 ? 0 : 3))
