#!/bin/bash
set -e

# ============================================================================
# add-redirect-uri.sh — append a callback URL to the shared OAuth app
# ============================================================================
# Onboarding a new client = adding their domain's /auth/callback URL to the
# admin's shared Google OAuth client's authorised redirect list.
#
# Usage:
#   ./bin/add-redirect-uri.sh <domain>            (uses gcloud, default project from clients/admin.env)
#   ./bin/add-redirect-uri.sh acme.example.com
#
# Prereqs:
#   - gcloud CLI installed and authenticated as the admin who owns the OAuth project
#   - GOOGLE_OAUTH_PROJECT_ID + GOOGLE_OAUTH_CLIENT_ID set in $WORKSPACE_ADMIN_ENV
#     (defaults to <repo>/clients/admin.env)
#
# What it does:
#   1. Reads the current redirect URI list for the shared OAuth client
#   2. Appends https://<domain>/auth/callback (idempotent — skips if already there)
#   3. Pushes the updated list back to Google
#
# Why a script and not just the console:
#   Onboarding 10+ clients in a row through the GCP UI is a click-fest.
#   This makes it `./bin/add-redirect-uri.sh acme.com` per client.
# ============================================================================

if [ $# -ne 1 ] || [ -z "$1" ]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 acme.example.com"
    exit 1
fi
DOMAIN="$1"

# Validate domain shape — accepts only [a-zA-Z0-9.-] with at least one dot.
# Rejects shell metacharacters, quotes, spaces, slashes, etc. Without this,
# the value flows into a Python heredoc below and a hostile $1 could break
# out of the string literal and execute arbitrary Python.
if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$' \
   || ! echo "$DOMAIN" | grep -q '\.'; then
    echo "ERROR: invalid domain format: $DOMAIN" >&2
    echo "  Expected something like: acme.example.com" >&2
    exit 1
fi

NEW_URI="https://$DOMAIN/auth/callback"
export NEW_URI

# --- Load admin shared env ---
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_ENV="${WORKSPACE_ADMIN_ENV:-$THIS_DIR/../clients/admin.env}"
if [ ! -f "$ADMIN_ENV" ] || [ ! -s "$ADMIN_ENV" ]; then
    echo "ERROR: $ADMIN_ENV not found or empty."
    echo "Fill it with:"
    echo "  GOOGLE_OAUTH_PROJECT_ID=workspace-shared-XXXX"
    echo "  GOOGLE_OAUTH_CLIENT_ID=YYYY.apps.googleusercontent.com"
    echo "  GOOGLE_CLIENT_ID=<same as above>"
    echo "  GOOGLE_CLIENT_SECRET=GOCSPX-..."
    exit 1
fi
set -a; source "$ADMIN_ENV"; set +a

if [ -z "$GOOGLE_OAUTH_PROJECT_ID" ] || [ -z "$GOOGLE_OAUTH_CLIENT_ID" ]; then
    echo "ERROR: GOOGLE_OAUTH_PROJECT_ID or GOOGLE_OAUTH_CLIENT_ID missing from $ADMIN_ENV"
    exit 1
fi

# --- Get an access token (gcloud handles refresh) ---
if ! command -v gcloud >/dev/null 2>&1; then
    echo "ERROR: gcloud CLI not found. Install it from https://cloud.google.com/sdk/install"
    exit 1
fi
TOKEN=$(gcloud auth print-access-token)

API="https://oauth2.googleapis.com/v1/clients/$GOOGLE_OAUTH_CLIENT_ID"
HDR="Authorization: Bearer $TOKEN"

# --- Read current redirects ---
CURRENT_JSON=$(curl -fsSL -H "$HDR" "$API")
echo "$CURRENT_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Current redirect URIs:')
for u in d.get('redirectUris', []):
    print(f'  - {u}')
" || true

# --- Append if not present ---
# NEW_URI is exported above and read from the environment inside Python.
# Never interpolate user-controlled values directly into the heredoc — that
# was a shell-injection vector via the script argument before this fix.
UPDATED_JSON=$(echo "$CURRENT_JSON" | python3 - <<'PYEOF'
import sys, os, json
d = json.load(sys.stdin)
uris = d.get('redirectUris', []) or []
new_uri = os.environ['NEW_URI']
if new_uri in uris:
    sys.stderr.write('NOOP\n')
    sys.exit(0)
uris.append(new_uri)
d['redirectUris'] = uris
print(json.dumps(d))
PYEOF
)

if [ -z "$UPDATED_JSON" ]; then
    echo "✓ $NEW_URI is already on the redirect list — nothing to do."
    exit 0
fi

# --- PATCH the OAuth client ---
echo "+ Adding $NEW_URI"
curl -fsSL -X PATCH \
    -H "$HDR" \
    -H "Content-Type: application/json" \
    -d "$UPDATED_JSON" \
    "$API" > /dev/null

echo "✓ Added. The change is live immediately — clients can redirect through this URL on their next login."
