#!/bin/bash
# bot-relay.sh — inject a single line into the bot's tmux session, so the
# bot's Claude treats it as a normal inbound prompt (just like a Telegram
# message or a reminder trigger). The bot's memory-prefix teaches Claude to
# recognise the leading literal marker for channel/intent routing.
#
# Two modes (same allowlisted script + monitor-runner path, so neither adds
# setuid surface):
#   1. BOT_INJECT_LITERAL set → inject that string VERBATIM. The caller has
#      pre-composed a full marker line, e.g. a teammate-relay frame
#      "[RELAY from=<slug> name=<Name> thread=<id> depth=<n> await=reply | <text>]".
#      The caller MUST pre-flatten newlines to spaces (a literal newline would
#      send Enter mid-frame and split it). Takes precedence.
#   2. else BOT_RELAY_MESSAGE → inject "[WEB_USER] $BOT_RELAY_MESSAGE" (the
#      original web-UI relay path; unchanged).
#
# Invoked via /usr/local/bin/monitor-runner (setuid wrapper) by workspace-api.
# Runs as bot uid so the per-uid tmux socket at /tmp/tmux-<uid>/<session> is
# reachable. Env-var passing through monitor-runner's execve(environ) is the
# cleanest path; payloads stay well under ARG_MAX.
#
# Security: tmux send-keys -l (literal) sends the string as raw keystrokes with
# no shell or tmux interpretation, so any metacharacters in the relayed text are
# inert. Enter is sent separately so it's NOT part of the literal payload.
#
# Exit: 0 on send, 1 on empty input, 2 when the bot tmux session is offline
# (the caller then takes its own fallback — for a relay, the raw Telegram DM
# was already delivered as the durable record).

set -eu

LITERAL="${BOT_INJECT_LITERAL:-}"
MSG="${BOT_RELAY_MESSAGE:-}"

if [ -n "$LITERAL" ]; then
    PAYLOAD="$LITERAL"
elif [ -n "$MSG" ]; then
    PAYLOAD="[WEB_USER] $MSG"
else
    echo "[bot-relay] no BOT_INJECT_LITERAL or BOT_RELAY_MESSAGE; nothing to send" >&2
    exit 1
fi

SESSION="${BOT_NAME:-bot}"

if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
    echo "[bot-relay] no tmux session '$SESSION' — bot offline" >&2
    exit 2
fi

tmux -L "$SESSION" send-keys -l -t "$SESSION" "$PAYLOAD"
tmux -L "$SESSION" send-keys -t "$SESSION" Enter

exit 0
