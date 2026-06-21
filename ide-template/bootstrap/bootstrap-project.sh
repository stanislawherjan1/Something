#!/bin/bash
# bootstrap-project.sh — first-run scaffolding for ~/project
#
# Idempotent: gated by ~/project/.bootstrapped flag. If the flag exists, exits
# 0 immediately. Also exits 0 if ~/project/.claude/CLAUDE.md already exists
# (= legacy client with mature setup — never touch their structure).
#
# Sourced by entrypoint.sh after Drive sync settles and after the platform
# Claude token is active. Runs as the `coder` user.
#
# Effects on first run:
#   1. Creates default folder structure (Inbox/, Research/, ${BOT_NAME}/)
#   2. Copies bootstrap templates into ~/project/ with token substitution
#   3. Seeds 3 weekly recurring reminders (Monday audit, Friday backup,
#      Sunday reindex) into ~/project/.reminders.json — but only if the file
#      doesn't already exist with content
#   4. Touches ~/project/.bootstrapped so this never runs again

set -e

PROJECT="${PROJECT_DIR:-/home/coder/project}"
BOT="${BOT_NAME:-bot}"
BOOTSTRAP_SRC="${BOOTSTRAP_SRC:-/opt/ide/bootstrap}"
FLAG="$PROJECT/.bootstrapped"

log() { echo "[bootstrap] $*"; }

# ── Bail-out conditions ────────────────────────────────────────────────────
if [ -f "$FLAG" ]; then
    exit 0   # already bootstrapped — nothing to do
fi

if [ -f "$PROJECT/.claude/CLAUDE.md" ]; then
    log "skipping — $PROJECT/.claude/CLAUDE.md already exists (legacy client setup)"
    touch "$FLAG"   # mark so we don't keep checking
    exit 0
fi

if [ ! -d "$BOOTSTRAP_SRC" ]; then
    log "WARNING: bootstrap source $BOOTSTRAP_SRC missing — skipping"
    exit 0
fi

log "first-run bootstrap for $PROJECT (bot=$BOT)"
mkdir -p "$PROJECT"

# ── 1. Folder structure ────────────────────────────────────────────────────
mkdir -p "$PROJECT/Inbox"
mkdir -p "$PROJECT/Research"
mkdir -p "$PROJECT/$BOT"
log "created Inbox/, Research/, $BOT/"

# ── 2. Templates with token substitution ───────────────────────────────────
# Only copy if destination doesn't exist (don't clobber user content).
# (Tasks are no longer a Markdown file — they live in the structured board
# at .tasks.json, managed via the tasks MCP / the workspace board. An absent
# .tasks.json simply reads as an empty board, so nothing to seed here.)
for src_name in "README.md"; do
    src="$BOOTSTRAP_SRC/$src_name"
    dst="$PROJECT/$src_name"
    if [ ! -f "$dst" ] && [ -f "$src" ]; then
        sed -e "s|<BotName>|$BOT|g" -e "s|\${BOT_NAME}|$BOT|g" "$src" > "$dst"
        log "seeded $src_name"
    fi
done

# ── 3. Recurring reminders ─────────────────────────────────────────────────
REMINDERS_FILE="$PROJECT/.reminders.json"
# Only seed if the file doesn't exist OR is an empty array
if [ ! -f "$REMINDERS_FILE" ] || [ "$(cat "$REMINDERS_FILE" 2>/dev/null | tr -d '[:space:]')" = "[]" ]; then
    # Compute the "next Monday/Friday/Sunday" dates in UTC
    NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    NEXT_MON="$(date -u -d 'next monday 09:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || date -u -v+monday -v9H -v0M -v0S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || echo "2099-01-01T09:00:00.000Z")"
    NEXT_FRI="$(date -u -d 'next friday 14:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || date -u -v+friday -v14H -v0M -v0S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || echo "2099-01-01T14:00:00.000Z")"
    NEXT_SUN="$(date -u -d 'next sunday 22:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || date -u -v+sunday -v22H -v0M -v0S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || echo "2099-01-01T22:00:00.000Z")"
    # Daily 22:00 UTC — next 22:00 from now (today if before 22:00 UTC, else tomorrow).
    NEXT_DAILY_22="$(date -u -d 'today 22:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || date -u -v22H -v0M -v0S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                  || echo "2099-01-01T22:00:00.000Z")"
    # If the computed "today 22:00" is already in the past, bump by 1 day.
    if [ "$(date -u +%s)" -gt "$(date -u -d "$NEXT_DAILY_22" +%s 2>/dev/null || echo 0)" ]; then
        NEXT_DAILY_22="$(date -u -d 'tomorrow 22:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                       || date -u -v+1d -v22H -v0M -v0S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
                       || echo "$NEXT_DAILY_22")"
    fi

    sed -e "s|BOOTSTRAP_NEXT_MONDAY_09_UTC|$NEXT_MON|" \
        -e "s|BOOTSTRAP_NEXT_FRIDAY_14_UTC|$NEXT_FRI|" \
        -e "s|BOOTSTRAP_NEXT_SUNDAY_22_UTC|$NEXT_SUN|" \
        -e "s|BOOTSTRAP_NEXT_DAILY_22_UTC|$NEXT_DAILY_22|" \
        -e "s|BOOTSTRAP_NOW|$NOW_ISO|g" \
        "$BOOTSTRAP_SRC/reminders.json" > "$REMINDERS_FILE"
    log "seeded $REMINDERS_FILE with 4 recurring reminders (Mon audit, Fri backup, Sun reindex, Daily reflect)"
else
    log "skipping reminders seed — $REMINDERS_FILE already has content"
fi

# ── 4. Mark complete ───────────────────────────────────────────────────────
touch "$FLAG"
log "bootstrap done. flag: $FLAG"
