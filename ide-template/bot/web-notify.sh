#!/bin/bash
# Web Notify — push a server-side event into the workspace web chat.
#
# Loopback-only call to workspace-api /api/internal/notify. workspace-api
# fans the event out over /api/notifications/stream SSE to every
# connected browser tab. Independent of Telegram — works even on clients
# who never wired up a messenger.
#
# Usage:
#   web-notify.sh "title" "body" [kind]
#
# kind defaults to "system". Body is optional; either title or body must
# be non-empty (the wsapi route rejects both-empty).
#
# Failures are non-fatal: this is one of several delivery paths
# (reminder-monitor also tries tmux send-keys and bot-notify.sh), so a
# wsapi outage shouldn't take down the caller. We log to stderr and exit
# non-zero so callers that care can inspect.

set -u

TITLE="${1:-}"
BODY="${2:-}"
KIND="${3:-system}"

if [ -z "$TITLE" ] && [ -z "$BODY" ]; then
    echo "[web-notify] usage: web-notify.sh \"title\" \"body\" [kind]" >&2
    exit 1
fi

WSAPI_PORT="${WORKSPACE_API_PORT:-3001}"
WSAPI_URL="http://127.0.0.1:${WSAPI_PORT}/api/internal/notify"

# Build JSON body with python (always present in image) so embedded
# quotes / newlines / unicode in title or body don't break the curl
# call. Fall back to a printf-based encoder if python is missing.
if command -v python3 >/dev/null 2>&1; then
    PAYLOAD=$(python3 -c '
import json, sys
print(json.dumps({"kind": sys.argv[1], "title": sys.argv[2], "body": sys.argv[3]}))
' "$KIND" "$TITLE" "$BODY")
else
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n' | sed 's/\\n$//'; }
    PAYLOAD="{\"kind\":\"$(esc "$KIND")\",\"title\":\"$(esc "$TITLE")\",\"body\":\"$(esc "$BODY")\"}"
fi

RESPONSE=$(curl -sS -m 5 -X POST "$WSAPI_URL" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo "[web-notify] curl failed (exit=$EXIT_CODE): $RESPONSE" >&2
    exit "$EXIT_CODE"
fi

# wsapi returns {"ok": true, "id": "..."} on success. Anything else =
# log and exit non-zero so the caller can decide what to do.
case "$RESPONSE" in
    *'"ok":true'*) exit 0 ;;
    *)
        echo "[web-notify] wsapi rejected: $RESPONSE" >&2
        exit 2
        ;;
esac
