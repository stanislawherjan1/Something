#!/usr/bin/env bash
# =============================================================================
# bootstrap-client-env.sh — fill in missing fields in clients/<x>/.env
# =============================================================================
# Operator-supplied minimum (3 fields):
#   HETZNER_HOST=root@<ip>
#   FRONTEND_DOMAIN=<domain>
#   IDE_ALLOWED_EMAILS=<email[,email,...]>
#
# Everything else is derived from those (+ folder name) or generated:
#   IDE_NAME, REMOTE_PATH, SESSION_COOKIE_NAME, ALLOWED_ORIGINS  ← derived
#   BOT_NAME, VITE_APP_TITLE, VITE_*, LEGACY_*                    ← generic defaults
#   SESSION_SECRET, CODE_SERVER_PASSWORD                          ← generated random
#
# Idempotent: re-runs add only missing fields. Existing values are preserved
# (so re-running doesn't rotate secrets or override operator edits).
#
# Atomic: writes via tmp file + rename so a Ctrl-C mid-write doesn't leave
# the .env corrupted.
#
# Usage (from a client wrapper):
#   "$REPO_ROOT/bin/bootstrap-client-env.sh" "$FORK_DIR/.env"
# =============================================================================

set -e

ENV_FILE="${1:?usage: bootstrap-client-env.sh <env-path>}"
CLIENT_DIR="$(cd "$(dirname "$ENV_FILE")" && pwd)"
CLIENT_NAME="$(basename "$CLIENT_DIR")"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found" >&2
    echo "       Copy clients/example-client/.env.example as a starting point." >&2
    exit 1
fi

# --- Source current state ---
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# --- Validate the 3 required fields ---
errors=()
[ -z "${HETZNER_HOST:-}" ]       && errors+=("HETZNER_HOST is required (e.g. root@1.2.3.4)")
[ -z "${FRONTEND_DOMAIN:-}" ]    && errors+=("FRONTEND_DOMAIN is required (e.g. acme.example.com)")
[ -z "${IDE_ALLOWED_EMAILS:-}" ] && errors+=("IDE_ALLOWED_EMAILS is required (e.g. you@example.com)")

if [ ${#errors[@]} -gt 0 ]; then
    echo "ERROR: $ENV_FILE is missing required fields:" >&2
    for e in "${errors[@]}"; do echo "  - $e" >&2; done
    echo "" >&2
    echo "Open the file and fill those 3 fields. Everything else gets" >&2
    echo "auto-derived or generated on the next deploy." >&2
    exit 1
fi

# --- Format validation ---
if ! echo "$HETZNER_HOST" | grep -qE '^[a-zA-Z0-9_-]+@[a-zA-Z0-9._-]+$'; then
    echo "ERROR: HETZNER_HOST format invalid: '$HETZNER_HOST'" >&2
    echo "       Expected: user@host (e.g. root@1.2.3.4)" >&2
    exit 1
fi

if ! echo "$FRONTEND_DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253})$' \
   || ! echo "$FRONTEND_DOMAIN" | grep -q '\.'; then
    echo "ERROR: FRONTEND_DOMAIN format invalid: '$FRONTEND_DOMAIN'" >&2
    echo "       Expected: bare domain like acme.example.com (no https://, no path)" >&2
    exit 1
fi

# --- Helpers ---
declare -a TO_APPEND=()

ensure() {
    local key="$1" val="$2"
    # If already set in env (sourced from .env), keep it.
    if [ -n "${!key:-}" ]; then return 0; fi
    export "$key=$val"
    TO_APPEND+=("$key=$val")
}

# Sanitize folder name into a docker-safe IDE_NAME:
#   - lowercase
#   - non-alphanumeric → dash
#   - collapse repeated dashes, trim leading/trailing dashes
sanitize_name() {
    echo "$1" \
        | tr '[:upper:]' '[:lower:]' \
        | sed 's/[^a-z0-9-]/-/g; s/-\+/-/g; s/^-//; s/-$//'
}

# --- Auto-derive optionals from operator's 3 inputs ---
ide_name="$(sanitize_name "$CLIENT_NAME")"
[ -n "$ide_name" ] || { echo "ERROR: cannot derive IDE_NAME from folder '$CLIENT_NAME'" >&2; exit 1; }

ensure IDE_NAME            "$ide_name"
ensure REMOTE_PATH         "/root/$IDE_NAME"
ensure SESSION_COOKIE_NAME "$(echo "$IDE_NAME" | tr '-' '_')_session"
ensure ALLOWED_ORIGINS     "https://$FRONTEND_DOMAIN"

# Bot identity defaults — operational placeholder. The end-user picks the
# real display name + avatar through the wizard; these only seed Docker
# volume paths, tmux session names, and PM2 process names.
ensure BOT_NAME            "bot"

# Browser tab title — the wizard overrides this at runtime via .branding.json.
# A generic "Workspace" is what fresh deploys show until the user finishes
# Step 1 of onboarding.
ensure VITE_APP_TITLE      "Workspace"
ensure VITE_HIDE_IDE_TEXT  "false"
ensure VITE_LOGO_SIZE_LOGIN  "24px"
ensure VITE_LOGO_SIZE_TOPBAR "22px"

# Mode flags — new clients start non-legacy (wizard-driven, branding editable
# from the UI). Flip these manually if onboarding a pre-wizard client.
ensure LEGACY_DRIVE_SYNC   "false"
ensure LEGACY_CONFIG       "false"

# --- Auto-generate secrets (CSPRNG, 256/128-bit) ---
ensure SESSION_SECRET      "$(openssl rand -hex 32)"
ensure CODE_SERVER_PASSWORD "$(openssl rand -hex 16)"

# --- Atomically append the missing fields ---
if [ ${#TO_APPEND[@]} -gt 0 ]; then
    tmp="$ENV_FILE.tmp.$$"
    cp "$ENV_FILE" "$tmp"

    # Add a single section header the first time we append so re-runs (which
    # only ever add additional missing fields) don't accumulate headers.
    if ! grep -q '^# >>> bootstrap-client-env.sh' "$tmp"; then
        {
            echo ""
            echo "# >>> bootstrap-client-env.sh — auto-filled $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            echo "# Edit operator inputs above this line; these are derived/generated."
            echo "# Re-running ./deploy.sh fills any field deleted from below."
        } >> "$tmp"
    fi

    for line in "${TO_APPEND[@]}"; do
        key="${line%%=*}"
        val="${line#*=}"
        # Quote values containing spaces or shell-special chars.
        if echo "$val" | grep -qE '[[:space:]"$]'; then
            # Escape any embedded double-quote for bash-safe single-line value.
            esc=$(echo "$val" | sed 's/"/\\"/g')
            echo "$key=\"$esc\""
        else
            echo "$line"
        fi
    done >> "$tmp"

    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"

    keys_added=$(printf '%s\n' "${TO_APPEND[@]}" | sed 's/=.*//' | tr '\n' ' ')
    echo "[bootstrap] Auto-filled into $ENV_FILE: $keys_added"
fi
