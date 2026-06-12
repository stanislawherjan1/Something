#!/bin/bash
# Browser watchdog — kills hung Chromium processes that have been pinning a
# core for too long. Real failure mode we hit: claude calls playwright-mcp,
# Chromium's renderer enters a busy-loop on a Google Docs page, the MCP tool
# call times out from claude's side but Chromium keeps running at 80% CPU
# for hours, dragging down the whole container.
#
# Heuristic: AND of two conditions, not just elapsed time alone.
#   - elapsed > 60 min: a tool call should NEVER take that long
#   - cpu > 5%: a legit idle/long-lived browser session sits at ~0%
# Both true ⇒ stuck in a loop, not legitimately working. Either alone
# wouldn't be — a long idle session is fine, a brief CPU spike is fine.
#
# Runs as uid 1003 (bot) via /usr/local/bin/monitor-runner. Chrome procs
# spawned by playwright-mcp / docs-comments-mcp are owned by bot too, so kill -9
# works without setuid escalation.

LOG_PREFIX="[browser-watchdog]"
ELAPSED_THRESHOLD_S=3600   # 60 min — beyond any plausible single tool call
CPU_THRESHOLD_PCT=5        # idle browser sits well below this
INTERVAL_S=300             # 5 min check cadence

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $*"; }

log "Started — threshold elapsed>${ELAPSED_THRESHOLD_S}s AND cpu>${CPU_THRESHOLD_PCT}%, interval ${INTERVAL_S}s"

while true; do
    # ps -eo: pid, elapsed seconds, cpu%, comm. We match comm starting with
    # `chrome` to catch the browser + renderer + gpu workers (chrome,
    # chrome_crashpad_handler — though the crashpad is usually idle so the
    # cpu AND won't fire on it anyway). Killing the main browser process
    # cascades to its children, so we don't have to be precise.
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        pid=$(echo "$line"   | awk '{print $1}')
        etime=$(echo "$line" | awk '{print $2}')
        cpu=$(echo "$line"   | awk '{print $3}')
        comm=$(echo "$line"  | awk '{print $4}')
        log "killing pid=$pid comm=$comm elapsed=${etime}s cpu=${cpu}% — hung chromium"
        kill -9 "$pid" 2>/dev/null || true
    done < <(ps -eo pid,etimes,pcpu,comm 2>/dev/null \
             | awk -v t="$ELAPSED_THRESHOLD_S" -v c="$CPU_THRESHOLD_PCT" \
                   '$4 ~ /^chrome/ && $2+0 > t && $3+0 > c { print }')
    sleep "$INTERVAL_S"
done
