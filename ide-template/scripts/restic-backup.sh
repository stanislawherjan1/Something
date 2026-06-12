#!/usr/bin/env bash
# Server-side restic backup for one IDE deployment.
#
# Backs up:
#   - Project files     (Docker volume <ide>_project-data)  — includes the
#                       encrypted credential ciphertexts (.platform.token.enc,
#                       .integrations/*.enc).
#   - Claude data       (Docker volume <ide>_claude-data)   — auth tokens, MCP cfg
#   - Bot logs          (Docker volume <ide>_bot-logs)
#   - Integrations data (/srv/<ide>/integrations-data)      — accounts.json etc.
#
# Deliberately NOT backed up:
#   - /srv/<ide>/secrets/integrations.key (the AES master key). Storing the
#     master key alongside the ciphertexts it protects defeats encryption-at-
#     rest — anyone who exfiltrates a restic snapshot would have both halves.
#     Lose the key → admin re-runs the onboarding wizard to re-supply tokens.
#     Acceptable trade-off vs. one-snapshot-pwns-everything.
#
# Designed to run from cron on the host. Reads restic + B2 credentials from
# ~/.workspace-admin/restic.env (or $RESTIC_ENV_FILE) so the script itself is
# committed to the repo with no secrets in it.
#
# Usage:
#   restic-backup.sh <ide-name>
#   IDE_NAME=acme restic-backup.sh
#
# The expected restic.env file looks like:
#   export RESTIC_REPOSITORY=b2:my-bucket:/<host>
#   export RESTIC_PASSWORD=<long-secret>
#   export B2_ACCOUNT_ID=<id>
#   export B2_ACCOUNT_KEY=<key>
#
# Exit codes:
#   0 — backup succeeded
#   1 — usage / config error
#   2 — restic error (snapshot failed)

set -euo pipefail

IDE="${1:-${IDE_NAME:-}}"
if [[ -z "$IDE" ]]; then
    echo "usage: $0 <ide-name>  (or export IDE_NAME)" >&2
    exit 1
fi

ENV_FILE="${RESTIC_ENV_FILE:-$HOME/.workspace-admin/restic.env}"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "[restic-backup] missing env file: $ENV_FILE" >&2
    echo "  Create it with RESTIC_REPOSITORY, RESTIC_PASSWORD, B2_ACCOUNT_ID, B2_ACCOUNT_KEY." >&2
    exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

if [[ -z "${RESTIC_REPOSITORY:-}" || -z "${RESTIC_PASSWORD:-}" ]]; then
    echo "[restic-backup] RESTIC_REPOSITORY and RESTIC_PASSWORD must be set in $ENV_FILE" >&2
    exit 1
fi

# Discover the actual host paths for the named volumes. These are
# `<compose-project>_<volume>` and live under /var/lib/docker/volumes.
# We rely on `docker volume inspect` rather than guessing the project
# prefix — handles both `docker compose` and `docker-compose` naming
# differences across hosts.
volume_path() {
    local volume="$1"
    local id
    id=$(docker volume ls -q --filter "name=${IDE}_${volume}\$" | head -n1 || true)
    if [[ -z "$id" ]]; then
        # Try alternate naming convention (compose v1 used `_` differently).
        id=$(docker volume ls -q --filter "name=${volume}" | head -n1 || true)
    fi
    if [[ -z "$id" ]]; then
        echo ""
        return
    fi
    docker volume inspect -f '{{.Mountpoint}}' "$id"
}

PROJECT_DIR=$(volume_path project-data)
CLAUDE_DIR=$(volume_path claude-data)
BOT_LOGS_DIR=$(volume_path bot-logs)
INTEGRATIONS_DIR="/srv/${IDE}/integrations-data"
# SECRETS_DIR (/srv/<ide>/secrets) deliberately NOT backed up — see header.

PATHS=()
[[ -n "$PROJECT_DIR"     && -d "$PROJECT_DIR"     ]] && PATHS+=("$PROJECT_DIR")
[[ -n "$CLAUDE_DIR"      && -d "$CLAUDE_DIR"      ]] && PATHS+=("$CLAUDE_DIR")
[[ -n "$BOT_LOGS_DIR"    && -d "$BOT_LOGS_DIR"    ]] && PATHS+=("$BOT_LOGS_DIR")
[[ -d "$INTEGRATIONS_DIR" ]] && PATHS+=("$INTEGRATIONS_DIR")

if [[ ${#PATHS[@]} -eq 0 ]]; then
    echo "[restic-backup] no paths to back up — is IDE=$IDE deployed on this host?" >&2
    exit 1
fi

# One-time: initialise the repo if it doesn't exist yet. Idempotent.
if ! restic snapshots --no-lock --quiet >/dev/null 2>&1; then
    echo "[restic-backup] repository not initialised — running 'restic init'..."
    restic init
fi

EXCLUDES=(
    --exclude "*.log"
    --exclude "**/node_modules"
    --exclude "**/.cache_local"
    --exclude "**/.npm"
    --exclude "**/.bun"
    --exclude "**/.pm2"
    # Belt-and-braces: even if PATHS accidentally grows to include a secrets
    # dir, never let the master encryption key into a snapshot.
    --exclude "**/integrations.key"
    --exclude "**/secrets/**"
)

echo "[restic-backup] $(date -Iseconds) — snapshotting $IDE (${#PATHS[@]} path(s))"
restic backup \
    --tag "ide=$IDE" \
    --tag "host=$(hostname)" \
    "${EXCLUDES[@]}" \
    "${PATHS[@]}" \
    || { echo "[restic-backup] snapshot failed" >&2; exit 2; }

# Retention: 7 daily + 4 weekly + 12 monthly. Forget+prune on the same run
# is fine — restic is transactional and snapshots are content-addressed.
echo "[restic-backup] applying retention policy..."
restic forget \
    --tag "ide=$IDE" \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 12 \
    --prune \
    || { echo "[restic-backup] retention prune failed" >&2; exit 2; }

echo "[restic-backup] done."
