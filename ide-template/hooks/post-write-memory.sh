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

# NOTE: even when notifications are `off` we still keep the INDEX map current
# below — the write happened, so the map must reflect it. The `off` switch gates
# only the operator heads-up, so we no longer early-exit here.

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
    RECENT_*.md) exit 0 ;;   # rolling snapshots — the monitor maintains these
    INDEX.md)    exit 0 ;;   # auto-generated MAP — a rebuild is not a memory "write" worth flagging (and needs no reindex)
esac

# Keep the scope's INDEX map in sync with the bot's OWN memory writes. The reflect
# pipeline updates the index on ITS writes (reflect-apply apply/graduate); this
# covers the model writing a card/topic/concept directly via memory-router. A full
# reindex also makes cross-scope MOVES correct: a page written to shared while its
# private original is gone → the private index drops it and the shared index gains
# it. Skip a write TO an index (nothing to derive from it). Best-effort, detached,
# and never allowed to delay or fail the bot's turn.
case "$BASENAME" in
    INDEX.md) ;;
    *)
        REFLECT_APPLY="${REFLECT_APPLY_PY:-/opt/ide/hooks/reflect-apply.py}"
        if [ -f "$REFLECT_APPLY" ]; then
            ( PROJECT_DIR="$PROJECT_DIR" python3 "$REFLECT_APPLY" reindex >/dev/null 2>&1 & )
        fi
        ;;
esac

# From here down is only the operator heads-up — silent clients stop here.
[ "$NOTIFY_TARGET" = "off" ] && exit 0

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

# Truncate cleanly.
[ ${#PREVIEW} -ge 200 ] && PREVIEW="${PREVIEW}…"

# ── Human-friendly framing ───────────────────────────────────────────────────
# Non-technical operators read these, so show NO file paths, tool names, or raw
# markdown. Turn the path into a plain subject and the content into a clean gist;
# clicking the notification opens the memory page (kind=memory, handled client-side).
slug=$(printf '%s' "${BASENAME%.md}" | tr '_-' '  ' | sed -E 's/^ +| +$//g')
case "$REL_PATH" in
    *USER_PROFILE*)          WHAT="I updated your profile" ;;
    *USER_PREFERENCES*)      WHAT="I noted how you like things done" ;;
    *USER_RELATIONSHIPS*)    WHAT="I noted something about someone you know" ;;
    *USER_REFLECTIONS*)      WHAT="I saved a personal reflection" ;;
    */topics/*|*/concepts/*) WHAT="I noted something about ${slug}" ;;
    RULES.md)                WHAT="I noted a rule to follow" ;;
    MISSION.md)              WHAT="I updated what I'm here to do" ;;
    *)                       WHAT="I saved a note about ${slug}" ;;
esac

# Reduce the raw write to a plain-prose gist: DELETE frontmatter, headings, and
# the concept-seed boilerplate line entirely (not just their markers), then unwrap
# wikilinks and strip bullets/bold. What's left is the actual fact in plain words.
GIST=$(printf '%s' "$PREVIEW" \
    | sed -E -e '/^---/d' -e '/^[A-Za-z_]+:[[:space:]]/d' -e '/^[[:space:]]*#{1,6}[[:space:]]/d' \
             -e '/^[[:space:]]*Accreting claims about/d' \
             -e 's/\[\[([^]]+)\]\]/\1/g' -e 's/^[[:space:]]*[-*][[:space:]]+//' -e 's/\*\*//g' \
    | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ +| +$//g')

TITLE="$WHAT"
BODY="${GIST}

Open the memory page to see it — or tell me if I got something wrong."
MESSAGE="🧠 ${WHAT}

${GIST}

Tell me if I got something wrong."

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
