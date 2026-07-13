#!/bin/bash
# tmux-inject.sh — the ONE serialized, idle-gated path for typing a literal
# line into the bot's Claude tmux session. Every send-keys writer
# (reminder-monitor.sh, bot-relay.sh, …) MUST route through this instead of
# calling `tmux send-keys` directly.
#
# WHY (2026-07-13 incident):
#   Reminders and relays typed straight into the shared Claude TUI prompt with
#   zero coordination — no lock between writers, no check that Claude was idle.
#   When a reminder fired while a Telegram message was mid-flight, the two
#   keystroke streams INTERLEAVED into a single turn. Observed live:
#       "... parallel search? </channel> [REMINDER channel=telegram | ...]"
#   Two failures fell out of that one race:
#     1. The model answered the injected reminder (weather / overdue tasks)
#        instead of the user's actual question.
#     2. verify-telegram-reply.sh (the Stop hook that guarantees a Telegram
#        reply) keys off the LAST user line. With a trailing [REMINDER] frame
#        it classified the whole turn as a system trigger and skipped
#        reply-enforcement → the user's real question was answered by silence.
#
#   This helper removes the race at the source:
#     (a) MUTUAL EXCLUSION — an flock so two injections can never interleave.
#     (b) IDLE GATE — inject only when the session is quiescent: the pane is
#         not changing (no active generation) and shows no interrupt/menu
#         state. A reminder can therefore never land inside a live user turn.
#
# Usage:   tmux-inject.sh "<already-newline-flattened literal line>"
# Env:     BOT_NAME            tmux -L socket + session name (default 'bot')
#          INJECT_MAX_WAIT_S   total budget to wait for lock+idle (default 25)
# Exit:    0 injected · 1 empty input · 2 session offline · 3 busy-timeout
#          (on 3 the caller keeps its own durable fallback — a reminder goes
#           out via the direct Bot API, a relay keeps its raw Telegram copy —
#           so nothing is lost AND the live turn is never corrupted).
#
# Security: `send-keys -l` (literal) sends the payload as raw keystrokes with
# no shell/tmux interpretation, so metacharacters in the body stay inert.
# Enter is sent separately so it is never part of the literal.

set -u

PAYLOAD="${1:-}"
[ -n "${PAYLOAD//[[:space:]]/}" ] || { echo "[tmux-inject] empty payload" >&2; exit 1; }

SESSION="${BOT_NAME:-bot}"
SOCK="$SESSION"
MAX_WAIT="${INJECT_MAX_WAIT_S:-25}"

# Lock lives beside the plugin state, writable by the bot uid (1003) that both
# reminder-monitor and bot-relay run as. Fall back to /tmp if that tree is
# absent (dev / TG-less clients).
LOCK_DIR="${BOT_HOME:-$HOME}/.claude/channels/telegram"
[ -d "$LOCK_DIR" ] || LOCK_DIR="/tmp"
LOCK_FILE="$LOCK_DIR/tmux-inject.lock"

tmux -L "$SOCK" has-session -t "$SESSION" 2>/dev/null || {
    echo "[tmux-inject] session '$SESSION' offline" >&2; exit 2; }

pane() { tmux -L "$SOCK" capture-pane -p -t "$SESSION" 2>/dev/null; }

# "Not idle" = actively generating, or parked on an interactive prompt/menu we
# must not type over. Match only EXPLICIT active/dialog markers:
#   - "esc to interrupt" / "interrupt to stop" — live generation hint text
#   - dialog titles that must not be typed over
# Deliberately NOT matched (caught live 2026-07-13, first injection attempt):
#   - "bypass permissions on (shift+tab to cycle)" — the session's PERMANENT
#     status bar; matching "Bypass Permissions" made pane_active always-true
#     and every injection timed out (exit 3). Only the warning-screen title
#     "Bypass Permissions mode" counts.
#   - bare spinner glyphs (✻ ✳ …) — they linger in finished output ("✻ Crunched
#     for 2m"); live generation is caught by the two-snapshot diff instead.
pane_active() {
    printf '%s' "$1" | grep -qiE \
        'esc to interrupt|interrupt to stop|rate-limit-options|Bypass Permissions mode|Do you want to proceed|Select an option' \
        && return 0
    return 1
}

# Idle iff two snapshots ~0.5s apart are identical AND neither looks active.
# A changing pane means Claude is mid-generation; identical+quiet means the
# prompt is sitting empty and safe to type into.
is_idle() {
    local a b
    a="$(pane)"; sleep 0.5; b="$(pane)"
    [ "$a" = "$b" ] || return 1
    pane_active "$b" && return 1
    return 0
}

START=$(date +%s)
budget_left() { echo $(( MAX_WAIT - ($(date +%s) - START) )); }

# Serialize against every other injector. fd 9 holds the lock for the send.
exec 9>"$LOCK_FILE" 2>/dev/null || { echo "[tmux-inject] cannot open lock" >&2; exit 3; }
if ! flock -w "$MAX_WAIT" 9; then
    echo "[tmux-inject] lock timeout" >&2; exit 3
fi

# Holding the lock — now wait for the session to fall idle within the remaining
# budget. Require two consecutive idle reads so we don't slip in during a brief
# render pause between tokens.
idle_streak=0
while :; do
    if is_idle; then
        idle_streak=$((idle_streak + 1))
        [ "$idle_streak" -ge 2 ] && break
    else
        idle_streak=0
    fi
    [ "$(budget_left)" -le 1 ] && { echo "[tmux-inject] idle-gate timeout" >&2; exit 3; }
    sleep 0.4
done

tmux -L "$SOCK" send-keys -l -t "$SESSION" "$PAYLOAD" || { echo "[tmux-inject] send-keys failed" >&2; exit 3; }
tmux -L "$SOCK" send-keys    -t "$SESSION" Enter        || { echo "[tmux-inject] enter failed" >&2; exit 3; }

# Brief settle so a caller firing several lines in a row can't stack a second
# injection onto this turn before Claude has picked it up.
sleep 0.3
exit 0