#!/bin/bash
# Recent-snapshot Monitor — runs as a PM2 process.
# Polls workspace-api every 60s and asks it to refresh the rolling
# RECENT_WEB.md / RECENT_TELEGRAM.md memory cards if their source JSONLs
# have been idle long enough.
#
# Why a separate process and not a setInterval inside workspace-api:
#   - PM2 keeps it independent of the API server's request loop.
#   - If wsapi restarts (integration toggle, reload), the monitor stays
#     up and resumes polling once the API is back.
#   - Curl-based: trivial to verify by hand (curl the endpoint yourself).
#
# The "stale-only" check lives server-side (lib/recent-snapshot.js
# isSnapshotStale). The monitor never writes directly — it just nudges.

WSAPI_HEALTH="http://localhost:3001/api/health"
WSAPI_REFRESH="http://localhost:3001/api/memory/snapshot/refresh?channel=all"
TICK_SECONDS="${SNAPSHOT_TICK_SECONDS:-60}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [snapshot-monitor] $*"; }

log "Started. Polling ${WSAPI_REFRESH} every ${TICK_SECONDS}s."

while true; do
    sleep "$TICK_SECONDS"

    # Skip the call if wsapi isn't up yet — avoids log spam during boot.
    if ! curl -sf --max-time 2 "$WSAPI_HEALTH" >/dev/null 2>&1; then
        continue
    fi

    # Nudge wsapi to refresh any stale channel. Single short call;
    # wsapi handles the stale-check + atomic write. We log only when
    # something actually got refreshed so the log stays terse.
    response=$(curl -sf --max-time 10 -X POST "$WSAPI_REFRESH" 2>/dev/null) || continue
    if echo "$response" | grep -q '"written_at"'; then
        # At least one channel produced a fresh snapshot. Echo the
        # response so the operator can see which one + when.
        log "refresh: $response"
    fi

    # Sweep idle threads → verdict cards (P4 Track B / reflect-summary). Same idle
    # cadence; server-side single-flight + dedup + per-tick cap make calling it
    # every tick safe. A sweep that summarises several threads spawns short
    # claude -p runs, so allow a generous timeout. Log only when it wrote one.
    sweep=$(curl -sf --max-time 120 -X POST "http://localhost:3001/api/internal/reflect-sweep" 2>/dev/null) || true
    if echo "$sweep" | grep -qE '"written":[1-9]'; then
        log "reflect-sweep: $sweep"
    fi

    # Distil durable conclusions from recent verdicts → 7-card proposals
    # (_drafts → /memory review). Self-rate-limited (~12h) + single-flight
    # server-side, so calling every tick is a cheap no-op until it's due.
    distill=$(curl -sf --max-time 120 -X POST "http://localhost:3001/api/internal/reflect-distill" 2>/dev/null) || true
    if echo "$distill" | grep -qE '"proposals":[1-9]'; then
        log "reflect-distill: $distill"
    fi

    # Health-check the shared memory wiki → advisory findings → _drafts
    # (memory/LINT.md). Self-rate-limited (~24h) + single-flight server-side, so
    # calling every tick is a cheap no-op until due. Log only when it flags one.
    lint=$(curl -sf --max-time 120 -X POST "http://localhost:3001/api/internal/memory-lint" 2>/dev/null) || true
    if echo "$lint" | grep -qE '"proposals":[1-9]'; then
        log "memory-lint: $lint"
    fi
done
