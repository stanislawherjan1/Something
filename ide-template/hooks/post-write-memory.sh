#!/bin/bash
# post-write-memory.sh — PostToolUse hook that fires after Write/Edit
# operations targeting `<PROJECT_DIR>/memory/`. The memory WRITE itself
# already happened silently in the background; this hook only emits an
# ambient "heads-up" so the operator can spot a wrong / mis-routed write
# and /correct it. By default it goes to the WEB dashboard's notifications
# (the AI-Settings memory graph already reflects the write too) — NOT the
# Telegram chat, which made every routine save spam the conversation.
# Set MEMORY_WRITE_NOTIFY=telegram|both|off to change the target.
#
# Wiring: registered in ~/.claude/settings.json under
# hooks.PostToolUse[matcher=Write|Edit]. CC pipes a JSON payload on
# stdin describing the tool call.
#
# Why this exists: WS6.5 in docs/future-plans/CONTEXT_ENGINEERING_REWORK.md.
# Before this hook, memory writes happened silently. Operator had no
# real-time signal that the bot wrote anything, let alone whether it
# was correctly routed (USER_PROFILE vs USER_PREFERENCES vs
# USER_RELATIONSHIPS — easy to mis-route without feedback).
#
# Exit: always 0. This hook is informational only; never blocks.

set -e

PROJECT_DIR="${PROJECT_DIR:-/home/coder/project}"
MEMORY_DIR="$PROJECT_DIR/memory"
# Where the memory-write FYI goes. The WRITE itself already happened silently;
# this is only a "heads-up so you can /correct a mis-route" signal. Default is
# WEB (ambient in the workspace dashboard's notifications + the AI-Settings
# memory graph) so it never spams the Telegram chat. Override per client:
#   MEMORY_WRITE_NOTIFY = web (default) | telegram | both | off
# off = fully silent; review writes on demand in the memory graph / .activity.jsonl.
NOTIFY_TARGET="${MEMORY_WRITE_NOTIFY:-web}"
TG_NOTIFY="${NOTIFY_SCRIPT:-/opt/ide/bot-notify.sh}"
WEB_NOTIFY="${WEB_NOTIFY_SCRIPT:-/opt/ide/web-notify.sh}"

# Fully silent → skip all the payload parsing too.
[ "$NOTIFY_TARGET" = "off" ] && exit 0

# Read JSON payload from stdin. CC PostToolUse passes the tool call
# context as JSON; we want tool_name and tool_input.file_path (Write)
# or tool_input.file_path + tool_input.new_string (Edit).
PAYLOAD=$(cat)

# Bail silently if no payload or no jq (defensive — hook must not
# break the bot's turn over its own bugs).
[ -z "$PAYLOAD" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(echo "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# Only fire on Write/Edit
case "$TOOL_NAME" in
    Write|Edit) ;;
    *) exit 0 ;;
esac

# Only fire when the write targets memory/
[ -z "$FILE_PATH" ] && exit 0
case "$FILE_PATH" in
    "$MEMORY_DIR"/*) ;;
    *) exit 0 ;;
esac

# Skip auto-maintained snapshots (RECENT_*.md) — they're updated by
# the snapshot monitor, not by the model deciding to remember something.
# Operator notifications on those would be noise.
BASENAME=$(basename "$FILE_PATH")
case "$BASENAME" in
    RECENT_*.md) exit 0 ;;
esac

# Determine the card/topic label (relative path under memory/)
REL_PATH="${FILE_PATH#$MEMORY_DIR/}"

# Extract a short preview of what was written/edited.
# Write: tool_input.content (full file content)
# Edit:  tool_input.new_string (the replacement text)
PREVIEW=""
if [ "$TOOL_NAME" = "Write" ]; then
    PREVIEW=$(echo "$PAYLOAD" | jq -r '.tool_input.content // empty' 2>/dev/null | head -c 200)
elif [ "$TOOL_NAME" = "Edit" ]; then
    PREVIEW=$(echo "$PAYLOAD" | jq -r '.tool_input.new_string // empty' 2>/dev/null | head -c 200)
fi

# Truncate cleanly
[ -z "$PREVIEW" ] && PREVIEW="(content not extracted from hook payload)"
[ ${#PREVIEW} -ge 200 ] && PREVIEW="${PREVIEW}…"

# Title + body for the web notification (web-notify.sh JSON-encodes, so no
# markdown-fence escaping needed). The single-string form is kept for the
# Telegram path (bot-notify.sh wraps in markdown).
TITLE="Memory write: $TOOL_NAME → $REL_PATH"
BODY="$PREVIEW

To correct: edit $REL_PATH manually, or send /correct <note> if this was a verification-failure pattern."
MESSAGE="Memory write: $TOOL_NAME → $REL_PATH

\`\`\`
$PREVIEW
\`\`\`

To correct: edit $REL_PATH manually, or send /correct <note> if this was a verification-failure pattern."

# Fire-and-forget, each path backgrounded with a hard 5s timeout so this hook
# NEVER blocks claude's turn finalization (PostToolUse waits for the process to
# exit; backgrounding + disown returns immediately). The model already made the
# write; a notify outage just means it's visible in the memory graph instead.
notify_web()      { ( timeout 5 "$WEB_NOTIFY" "$TITLE" "$BODY" memory >/dev/null 2>&1 ) & disown 2>/dev/null || true; }
notify_telegram() { ( timeout 5 "$TG_NOTIFY" "$MESSAGE"          >/dev/null 2>&1 ) & disown 2>/dev/null || true; }

case "$NOTIFY_TARGET" in
    telegram) notify_telegram ;;
    both)     notify_web; notify_telegram ;;
    web|*)    notify_web ;;   # default: ambient web, no Telegram spam
esac

exit 0
