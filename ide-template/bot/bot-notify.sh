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
# The exit status of this script is now meaningful, and it did not used to be.
# It previously ended on `[ $EXIT_CODE -ne 0 ] && echo ...`, whose own status
# becomes the script's: when curl SUCCEEDED the test was false, the && list
# returned 1, and the script reported failure — exactly inverted. Every caller
# that trusted it was misled in both directions; it stayed hidden only because
# callers redirected the result away, until reminder-monitor started checking.
#
# The HTTP status is checked too, not just curl's transport result: `curl -s`
# without --fail exits 0 on 401 (bad token) or 400 (bad chat id), so transport
# success was being read as delivery.
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d text="$FULL_MESSAGE" \
    -d disable_notification=false 2>/dev/null)
CURL_RC=$?

if [ "$CURL_RC" -ne 0 ]; then
    echo "[notify] Failed to reach Telegram (curl exit: $CURL_RC)"
    exit 1
fi
case "$HTTP_CODE" in
    2*) exit 0 ;;
    *)  echo "[notify] Telegram API rejected the message (HTTP $HTTP_CODE)"
        exit 1 ;;
esac
