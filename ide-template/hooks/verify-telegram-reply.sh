#!/bin/bash
# verify-telegram-reply.sh — Stop hook that blocks silent failures on the
# Telegram channel. If a turn was triggered from Telegram (transcript_path
# under /home/bot/.claude/projects/...) and the model finished WITHOUT
# calling any mcp__plugin_telegram_telegram__* tool, the response would
# vanish (written only to the IDE transcript, invisible to the Telegram
# sender). global-claude.md's "Every Telegram response MUST be sent via
# Telegram MCP" rule is purely textual — no structural enforcement before
# this hook.
#
# Why this exists (2026-06-04):
#   Telegram silence is one of the operator's most painful symptoms — bot
#   sometimes replies in the IDE transcript instead of via MCP, message
#   never reaches Telegram, operator stares at chat thinking bot is dead.
#   The verify-denials.sh sibling hook catches false absence claims; this
#   one catches the orthogonal "completely silent" failure mode.
#
# Wiring: registered in claude-settings.json under hooks.Stop. Two Stop
# hooks may fire on the same turn — order doesn't matter (each is an
# independent exit-2 gate).
#
# Telegram channel detection:
#   We use transcript_path prefix as the channel signal. Bot tmux session
#   runs as uid 1003 with HOME=/home/bot, so its transcripts land under
#   /home/bot/.claude/projects/.... Web side (wsapi spawns claude -p as
#   uid 1001 with HOME=/home/wsapi) lands under /home/wsapi/.claude/
#   projects/... — verified empirically 2026-06-04. If transcript_path
#   doesn't start with /home/bot/ this hook exits 0 (web turns never had
#   the silent-reply failure mode).
#
# MCP tool detection:
#   The Telegram plugin's reply tool is `mcp__plugin_telegram_telegram__*`
#   (note: `plugin_telegram_telegram` — the plugin namespace duplicates
#   the channel name in CC's discovery). Most common in observed transcripts
#   is `mcp__plugin_telegram_telegram__reply`. We match on the prefix to
#   catch reply / replyTo / sendPhoto / etc. all at once.
#
# Don't-fire cases:
#   - User explicitly asked for silence ("nie wysyłaj", "don't reply",
#     "tylko zapisz", "only save") — operator intent overrides hook.
#
# Exit:
#   0 — let through (not a Telegram turn, or reply was sent)
#   2 — block + ask model to send the reply

set +e

# Per-uid log path. Hook fires under whatever uid CC spawned claude as
# (bot 1003 on TG side, wsapi 1001 / coder 1000 on web side). Shared
# /tmp path caused "Permission denied" on alternating writes when an
# earlier hook fire left the file owned by a different uid.
LOG="/tmp/verify-telegram-reply-$(id -u 2>/dev/null || echo 0).log"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG" 2>/dev/null; }

PAYLOAD=$(cat)
[ -z "$PAYLOAD" ] && { log "empty payload"; exit 0; }
command -v jq >/dev/null 2>&1 || { log "no jq"; exit 0; }

# Anti-loop guard.
STOP_ACTIVE=$(echo "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$STOP_ACTIVE" = "true" ] && { log "stop_hook_active=true"; exit 0; }

TRANSCRIPT=$(echo "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null)

# Detect channel by transcript_path prefix.
case "$TRANSCRIPT" in
    /home/bot/*) CHANNEL=telegram ;;
    *) log "non-telegram channel ($TRANSCRIPT), exit 0"; exit 0 ;;
esac

[ ! -f "$TRANSCRIPT" ] && { log "transcript file missing, exit 0"; exit 0; }

# Pull the last user message to check for silence-intent overrides.
LAST_USER=$(tail -200 "$TRANSCRIPT" 2>/dev/null | jq -r '
    select(.type == "user") |
    if (.message.content | type) == "string"
    then .message.content
    else (.message.content[]? | select(.type == "text") | .text)
    end
' 2>/dev/null | tail -c 2000)

# Operator explicitly asked for no reply → don't block.
if echo "$LAST_USER" | grep -qiE '(nie wysyłaj|nie odpowiadaj|tylko zapisz|tylko notatk|don.t reply|only save|do not reply|skip reply)'; then
    log "user asked for silence, exit 0"
    exit 0
fi

# System triggers (reminder-monitor send-keys, periodic self-audits) come in
# as user messages but are bot's own internal scheduling — they don't need a
# Telegram reply. Whitelist by [PREFIX] convention used across the codebase:
#   [REMINDER]                    — reminder-monitor.sh send-keys (user reminders + recurring)
#   [REPO_AUDIT_TRIGGER]          — weekly repo audit (Mondays)
#   [MEMORY_INDEX_TRIGGER]        — weekly knowledge graph reindex
#   [BACKUP_TRIGGER]              — weekly project backup
#   [REFLECT_LEARNINGS_TRIGGER]   — daily reflect-bot
#   [SUGGESTIONS_CLEANUP]         — periodic cleanup
#   [TMP_CLEANUP]                 — periodic cleanup
# Without this whitelist the hook blocked every internal-trigger turn,
# claude retried, hook blocked again — infinite loop until tmux was killed.
# Caught 2026-06-05 on canary right after first deploy.
if echo "$LAST_USER" | grep -qE '^\[(REMINDER|REPO_AUDIT|MEMORY_INDEX|BACKUP|REFLECT_LEARNINGS|REFLECT_ORGANIZER|REFLECT_SUMMARY|SUGGESTIONS_CLEANUP|TMP_CLEANUP|CAPABILITY_TOUR|TASTE_RECALL|GROUP)'; then
    log "system trigger ([${LAST_USER:1:25}...]), exit 0"
    exit 0
fi

# Pull telegram tool_uses from the most recent assistant turn.
TG_SENDS=$(tail -200 "$TRANSCRIPT" 2>/dev/null | jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use") |
    .name
' 2>/dev/null | grep -c '^mcp__plugin_telegram_telegram__')

if [ "$TG_SENDS" -gt 0 ]; then
    log "telegram MCP send detected ($TG_SENDS calls), exit 0"
    exit 0
fi

log "BLOCKING — Telegram inbound + no telegram reply sent"

cat >&2 <<EOF
Your turn was triggered by a Telegram message, but you did not send a reply
via any mcp__plugin_telegram_telegram__* tool. Text written here ends up in
the IDE transcript only — invisible to the Telegram sender.

Send the reply NOW using mcp__plugin_telegram_telegram__reply (or another
plugin_telegram_telegram tool, e.g. for files/photos). Per the rule in
~/.claude/CLAUDE.md "Telegram" section: every Telegram response MUST go
via the Telegram MCP — no exceptions.

If the operator explicitly asked for silence ("tylko zapisz" / "don't reply"
/ similar), this hook would have let your reply through silently. Re-read
the last user message; if you genuinely shouldn't reply, write a one-line
"acknowledged, not sending" so the hook won't fire on the retry.

Retry your response with a Telegram-MCP send.
EOF

exit 2
