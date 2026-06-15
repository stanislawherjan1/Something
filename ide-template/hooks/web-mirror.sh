#!/bin/bash
# web-mirror.sh — PostToolUse hook that mirrors the bot's outbound
# Telegram messages into the workspace UI's notification stream.
#
# Why this exists: a user with BOTH Telegram and the workspace UI open
# expects to see the same conversation on each surface. The Telegram
# plugin already delivers to TG; this hook copies the text into the
# web SSE channel via /api/internal/notify so the matching bubble lands
# in the browser as well.
#
# Wiring: registered in ~/.claude/settings.json under
#   hooks.PostToolUse[matcher=mcp__plugin_telegram_telegram__.*]
# CC pipes a JSON payload on stdin describing the tool call.
#
# What gets mirrored:
#   - mcp__plugin_telegram_telegram__reply        (text reply)
#   - mcp__plugin_telegram_telegram__sendMessage  (free-text send)
#   - mcp__plugin_telegram_telegram__sendPhoto    (caption only; "(photo)")
#   - mcp__plugin_telegram_telegram__sendDocument (caption only; "(file)")
#
# What does NOT get mirrored:
#   - The bot's own web_send_message — already lands in the web stream
#     natively, mirroring would double-publish.
#   - Permission / reaction / read-receipt tools — these are TG-specific
#     plumbing, not conversation content.
#
# Exit: always 0. Hook is fire-and-forget; never blocks the bot's turn.

set -e

WSAPI_PORT="${WORKSPACE_API_PORT:-3001}"
NOTIFY_URL="http://127.0.0.1:${WSAPI_PORT}/api/internal/notify"

PAYLOAD=$(cat)
[ -z "$PAYLOAD" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
case "$TOOL_NAME" in
    mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__sendMessage)
        TITLE=""
        BODY=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.text // .tool_input.message // empty' 2>/dev/null)
        ;;
    mcp__plugin_telegram_telegram__sendPhoto)
        TITLE="(photo)"
        BODY=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.caption // empty' 2>/dev/null)
        ;;
    mcp__plugin_telegram_telegram__sendDocument)
        TITLE="(file)"
        BODY=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.caption // empty' 2>/dev/null)
        ;;
    *)
        exit 0
        ;;
esac

[ -z "$TITLE" ] && [ -z "$BODY" ] && exit 0

# Build JSON safely. Python is always present in the image; the printf
# fallback path mirrors web-notify.sh.
if command -v python3 >/dev/null 2>&1; then
    JSON=$(python3 -c '
import json, sys
print(json.dumps({"kind": "bot", "title": sys.argv[1], "body": sys.argv[2]}))
' "$TITLE" "$BODY")
else
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    JSON="{\"kind\":\"bot\",\"title\":\"$(esc "$TITLE")\",\"body\":\"$(esc "$BODY")\"}"
fi

# Fire and forget. Failure here must NEVER block the bot's turn: the
# user's Telegram delivery already succeeded by the time this hook runs.
curl -sS -m 3 -X POST "$NOTIFY_URL" \
    -H 'Content-Type: application/json' \
    -d "$JSON" > /dev/null 2>&1 || true

exit 0
