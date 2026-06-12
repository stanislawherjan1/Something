#!/bin/bash
# post-write-memory.sh — PostToolUse hook that fires after Write/Edit
# operations targeting `<PROJECT_DIR>/memory/`. Sends a Telegram
# notification to the operator with what was just written so they can
# spot wrong / mis-routed writes in seconds (vs hours later via the
# memory dashboard).
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
NOTIFY_SCRIPT="${NOTIFY_SCRIPT:-/opt/ide/bot-notify.sh}"

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

# Compose notification. Plain text — bot-notify.sh wraps in markdown
# already, and these write-bodies often contain markdown that would
# escape badly if double-wrapped.
MESSAGE="Memory write: $TOOL_NAME → $REL_PATH

\`\`\`
$PREVIEW
\`\`\`

To correct: edit $REL_PATH manually, or send /correct <note> if this was a verification-failure pattern."

# Fire-and-forget. Don't block the turn even if Telegram is down —
# the model has already made the write; the user can still see it in
# the memory dashboard if the notification fails.
#
# Run in background with hard 5s timeout so this hook NEVER blocks
# claude's turn finalization. Claude's PostToolUse spec waits for
# the hook process to exit; backgrounding + disown means we return
# immediately while the curl to Telegram runs detached. The 5s
# timeout protects against zombie children if Telegram API hangs.
( timeout 5 "$NOTIFY_SCRIPT" "$MESSAGE" >/dev/null 2>&1 ) &
disown 2>/dev/null || true

exit 0
