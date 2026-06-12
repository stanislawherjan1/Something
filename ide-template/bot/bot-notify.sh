#!/bin/bash
# Bot Notify — wysyła powiadomienia bezpośrednio przez Telegram Bot API
# Parametric: uses BOT_NAME, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID from env.
# Nie wymaga Claude pluginu — działa niezależnie.
# Użycie: bot-notify.sh "wiadomość"

BOT_NAME="${BOT_NAME:-bot}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_ADMIN_CHAT_ID:-}"

# Fallback A — wsapi-managed integrations.env. This is the source of truth
# for both fields after the UI activate flow: workspace-api writes both
# TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID here in `export KEY=val`
# format, mode 0660 group=botshare. Reading it as bot uid (which this
# script runs as via monitor-runner) is straightforward.
INTEGRATIONS_ENV="${HOME}/.${BOT_NAME}/integrations.env"
if [ -f "$INTEGRATIONS_ENV" ]; then
    [ -z "$BOT_TOKEN" ] && BOT_TOKEN=$(grep -oE '^(export )?TELEGRAM_BOT_TOKEN=.*'      "$INTEGRATIONS_ENV" 2>/dev/null | sed -E 's/^(export )?[^=]+=//; s/^["'"'"']//; s/["'"'"']$//')
    [ -z "$CHAT_ID" ]   && CHAT_ID=$(grep   -oE '^(export )?TELEGRAM_ADMIN_CHAT_ID=.*' "$INTEGRATIONS_ENV" 2>/dev/null | sed -E 's/^(export )?[^=]+=//; s/^["'"'"']//; s/["'"'"']$//')
fi

# Fallback B — telegram plugin's own .env (token only; chat ID lives in
# access.json's allowFrom[0]). Only useful in pre-Phase-3 deployments
# where integrations.env didn't exist yet.
PLUGIN_ENV="$HOME/.claude/channels/telegram/.env"
PLUGIN_ACCESS="$HOME/.claude/channels/telegram/access.json"
if [ -z "$BOT_TOKEN" ] && [ -f "$PLUGIN_ENV" ]; then
    BOT_TOKEN=$(grep -oP 'TELEGRAM_BOT_TOKEN=\K.*' "$PLUGIN_ENV" 2>/dev/null)
fi
if [ -z "$CHAT_ID" ] && [ -f "$PLUGIN_ACCESS" ]; then
    CHAT_ID=$(grep -oE '"allowFrom"[[:space:]]*:[[:space:]]*\[[[:space:]]*"[^"]+"' "$PLUGIN_ACCESS" 2>/dev/null \
              | grep -oE '"[0-9]+"' | head -1 | tr -d '"')
fi

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo "[notify] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID (tried env + $INTEGRATIONS_ENV + $PLUGIN_ENV/$PLUGIN_ACCESS)"
    exit 1
fi

MESSAGE="$1"
[ -z "$MESSAGE" ] && { echo "[notify] Usage: bot-notify.sh \"message\""; exit 1; }

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S UTC' -u 2>/dev/null || date '+%Y-%m-%d %H:%M:%S')
# Capitalize first letter of BOT_NAME for display
DISPLAY_NAME="$(echo "${BOT_NAME:0:1}" | tr '[:lower:]' '[:upper:]')${BOT_NAME:1}"

FULL_MESSAGE="🤖 *${DISPLAY_NAME}* | $(hostname)
${TIMESTAMP}

${MESSAGE}"

## NOTE: parse_mode="Markdown" was removed 2026-06-04 — bot-notify is also
# used by post-write-memory.sh to forward 200-char previews of memory card
# writes, and those previews carry raw markdown (`**bold**`, `_italic_`,
# unbalanced asterisks from headings, code spans). Telegram's Markdown
# parser rejects unbalanced or invalid markdown with HTTP 400, the curl
# error was being swallowed (>/dev/null 2>&1), and operators silently
# missed every memory-write notification whose body had special chars.
# Plain text is robust against any character soup.
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d text="$FULL_MESSAGE" \
    -d disable_notification=false \
    > /dev/null 2>&1

EXIT_CODE=$?
[ $EXIT_CODE -ne 0 ] && echo "[notify] Failed to send Telegram notification (curl exit: $EXIT_CODE)"
