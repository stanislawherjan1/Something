#!/bin/bash
# bot-relay.sh — inject a user message from the workspace web UI into the
# bot's tmux session, so the bot's Claude treats it as a normal inbound
# prompt (just like a Telegram message or a reminder trigger).
#
# Invoked via /usr/local/bin/monitor-runner (setuid wrapper) by
# workspace-api's POST /api/bot/send. Runs as bot uid (1003) so the
# per-uid tmux socket at /tmp/tmux-1003/<session> is reachable.
#
# Input: BOT_RELAY_MESSAGE env var. Stdin is intentionally NOT used —
# env-var passing through monitor-runner's execve(environ) is the
# cleanest path and the value is short enough to never hit ARG_MAX.
#
# Security: tmux send-keys -l (literal) sends the string as raw keystrokes
# with no shell or tmux interpretation. The [WEB_USER] prefix is a literal
# marker the bot's memory-prefix instructs Claude to recognise for channel
# routing (reply via web_send_message, not the Telegram tools).
#
# Exit: 0 on send, non-zero with stderr on error.

set -eu

MSG="${BOT_RELAY_MESSAGE:-}"
if [ -z "$MSG" ]; then
    echo "[bot-relay] BOT_RELAY_MESSAGE empty; nothing to send" >&2
    exit 1
fi

SESSION="${BOT_NAME:-bot}"

if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
    echo "[bot-relay] no tmux session '$SESSION' — bot offline" >&2
    exit 2
fi

# -l (literal) prevents Claude's TUI input parser from interpreting
# embedded escape codes the user might paste. Enter is sent separately
# so it's NOT part of the literal payload.
tmux -L "$SESSION" send-keys -l -t "$SESSION" "[WEB_USER] $MSG"
tmux -L "$SESSION" send-keys -t "$SESSION" Enter

exit 0
