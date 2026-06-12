#!/bin/bash
# Usage: rotate.sh <path-to-.env>
# Called by each client's rotate.sh wrapper.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}ERROR: $ENV_FILE not found${NC}"
    exit 1
fi

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Secret Rotation — $(basename "$(dirname "$ENV_FILE")")${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Press Enter to skip a key (keeps current value).${NC}"
echo -e "${YELLOW}Auto-generated keys are rotated automatically.${NC}"
echo ""

# ─── Helpers ────────────────────────────────────────────────────────────────

# Update a key in the .env file (handles special characters safely)
update_env() {
    local key="$1"
    local value="$2"
    python3 - "$key" "$value" "$ENV_FILE" <<'PYEOF'
import sys, re
key, value, path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r') as f:
    content = f.read()
pattern = r'^(' + re.escape(key) + r'=).*$'
new_line = key + '=' + value
content = re.sub(pattern, new_line, content, flags=re.MULTILINE)
with open(path, 'w') as f:
    f.write(content)
PYEOF
}

# Read current value of a key from .env
get_env() {
    local key="$1"
    grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

# Check if key exists and is not empty/FILL_ME
key_is_set() {
    local val
    val=$(get_env "$1")
    [ -n "$val" ] && [ "$val" != "FILL_ME" ]
}

# Mask a value: show first 8 chars + ***
mask() {
    local val="$1"
    if [ ${#val} -le 8 ]; then
        echo "***"
    else
        echo "${val:0:8}***"
    fi
}

# Prompt for a key — skip if user presses Enter
prompt_key() {
    local key="$1"
    local hint="$2"
    local current
    current=$(get_env "$key")
    local masked
    masked=$(mask "$current")

    echo -e "${CYAN}${key}${NC}"
    [ -n "$hint" ] && echo -e "  ${hint}"
    echo -e "  Current: ${masked}"
    printf "  New value: "
    read -r new_val
    if [ -n "$new_val" ]; then
        update_env "$key" "$new_val"
        echo -e "  ${GREEN}✓ Updated${NC}"
    else
        echo -e "  Skipped"
    fi
    echo ""
}

ROTATED=()

# ─── Auto-generated ─────────────────────────────────────────────────────────

echo -e "${BOLD}── Auto-generated ──────────────────────────────────────────${NC}"
echo ""

SESSION_SECRET_NEW=$(openssl rand -hex 32)
update_env "SESSION_SECRET" "$SESSION_SECRET_NEW"
echo -e "${GREEN}✓ SESSION_SECRET${NC} — rotated"
ROTATED+=("SESSION_SECRET")

CODE_SERVER_PASSWORD_NEW=$(openssl rand -hex 16)
update_env "CODE_SERVER_PASSWORD" "$CODE_SERVER_PASSWORD_NEW"
echo -e "${GREEN}✓ CODE_SERVER_PASSWORD${NC} — rotated"
ROTATED+=("CODE_SERVER_PASSWORD")

echo ""

# ─── Telegram ───────────────────────────────────────────────────────────────

echo -e "${BOLD}── Telegram ────────────────────────────────────────────────${NC}"
echo ""
echo -e "  Get new token: Telegram → @BotFather → /mybots → API Token → Revoke"
echo ""
prompt_key "TELEGRAM_BOT_TOKEN"

# ─── Google OAuth ────────────────────────────────────────────────────────────

echo -e "${BOLD}── Google OAuth ────────────────────────────────────────────${NC}"
echo ""
echo -e "  Get new secret: console.cloud.google.com/apis/credentials → OAuth 2.0 → Reset Secret"
echo ""
prompt_key "GOOGLE_CLIENT_SECRET"
echo ""

CURRENT_CLIENT_ID=$(get_env "GOOGLE_CLIENT_ID")
CURRENT_CLIENT_SECRET=$(get_env "GOOGLE_CLIENT_SECRET")
echo -e "${CYAN}RCLONE_GDRIVE_TOKEN${NC}"
echo -e "  1. Revoke old: myaccount.google.com/permissions → rclone → Remove"
echo -e "  2. Generate — run this command:"
echo -e "     ${YELLOW}rclone authorize \"drive\" --drive-client-id=${CURRENT_CLIENT_ID} --drive-client-secret=${CURRENT_CLIENT_SECRET}${NC}"
echo -e "  3. Paste the full JSON token below (or Enter to skip):"
CURRENT_RCLONE=$(get_env "RCLONE_GDRIVE_TOKEN")
echo -e "  Current: $(mask "$CURRENT_RCLONE")"
printf "  New value: "
read -r new_rclone
if [ -n "$new_rclone" ]; then
    update_env "RCLONE_GDRIVE_TOKEN" "$new_rclone"
    echo -e "  ${GREEN}✓ Updated${NC}"
else
    echo -e "  Skipped"
fi
echo ""

# ─── External APIs (only if set) ────────────────────────────────────────────

if key_is_set "META_ACCESS_TOKEN"; then
    echo -e "${BOLD}── Meta Ads ────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "  1. business.facebook.com → Business Settings → Users → System Users"
    echo -e "  2. Click the system user → Generate New Token"
    echo -e "  3. Select your Meta App → select permissions:"
    echo -e "     ads_management, ads_read, read_insights, business_management"
    echo -e "  4. Generate Token → copy it (does not expire)"
    echo ""
    prompt_key "META_ACCESS_TOKEN"
fi

if key_is_set "SHOPIFY_CLIENT_SECRET"; then
    echo -e "${BOLD}── Shopify ──────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "  dev.shopify.com → Apps → select app → Settings → Credentials → Rotate secret"
    echo ""
    prompt_key "SHOPIFY_CLIENT_SECRET"
fi

if key_is_set "GEMINI_API_KEY"; then
    echo -e "${BOLD}── Gemini ───────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "  aistudio.google.com/app/apikey → Delete old → Create API key"
    echo ""
    prompt_key "GEMINI_API_KEY"
fi

if key_is_set "BYTEPLUS_API_KEY"; then
    echo -e "${BOLD}── BytePlus ─────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "  console.byteplus.com → ModelArk → API Keys → Create new → Delete old"
    echo ""
    prompt_key "BYTEPLUS_API_KEY"
fi

if key_is_set "GOOGLE_ADS_REFRESH_TOKEN"; then
    echo -e "${BOLD}── Google Ads ───────────────────────────────────────────────${NC}"
    echo ""
    echo -e "  1. Add to Google Cloud Console → OAuth Client → Authorized redirect URIs:"
    echo -e "     https://developers.google.com/oauthplayground"
    echo -e "  2. Go to: developers.google.com/oauthplayground"
    echo -e "  3. Click ⚙️ → Use your own OAuth credentials → paste Client ID + Secret"
    echo -e "  4. Find 'AdWords API' in the list → expand → check the adwords scope"
    echo -e "  5. Click Authorize APIs → sign in → Step 2: Exchange authorization code for tokens"
    echo -e "  6. Copy refresh_token from the response"
    echo ""
    prompt_key "GOOGLE_ADS_REFRESH_TOKEN"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Rotation complete — .env updated locally                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Auto-rotated: ${ROTATED[*]}"
echo ""
printf "Deploy now? [y/N] "
read -r do_deploy
if [[ "$do_deploy" =~ ^[Yy]$ ]]; then
    WRAPPER_DIR="$(dirname "$ENV_FILE")"
    if [ -f "$WRAPPER_DIR/deploy.sh" ]; then
        exec "$WRAPPER_DIR/deploy.sh"
    else
        echo -e "${RED}deploy.sh not found in $(dirname "$ENV_FILE")${NC}"
        exit 1
    fi
else
    echo "Run ./deploy.sh when ready."
fi
