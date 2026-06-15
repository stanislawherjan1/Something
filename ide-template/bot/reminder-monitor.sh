#!/bin/bash
# Reminder Monitor — runs as a PM2 process.
# Polls ~/project/.reminders.json every 60s. For each due reminder:
#   - If the bot's tmux session is alive, inject a [REMINDER] trigger so
#     Claude processes it and replies on Telegram with full context.
#   - If the bot is down (crashed, never started, no Claude token yet),
#     fall back to bot-notify.sh — direct Telegram Bot API call. The user
#     gets a raw "[reminder]" message instead of an elaborated one, but
#     it's never silently lost.
# Handles repeating reminders (daily / weekly).

REMINDERS_FILE="/home/coder/project/.reminders.json"
BOT_NAME="${BOT_NAME:-bot}"
TMUX_SOCKET="$BOT_NAME"
TMUX_SESSION="$BOT_NAME"
CHAT_ID="${TELEGRAM_ADMIN_CHAT_ID:-}"
NOTIFY_SCRIPT="$HOME/bot-notify.sh"
WEB_NOTIFY_SCRIPT="/opt/ide/web-notify.sh"

log() { echo "[reminder-monitor] $*"; }

# Don't block on bot startup — keep polling and route per-reminder. If the
# bot lights up later, subsequent reminders go through tmux; if it never
# does, every reminder still reaches the user via direct API.
log "Started. Watching ${REMINDERS_FILE}"

while true; do
    sleep 60

    [ ! -f "$REMINDERS_FILE" ] && continue

    # node: update file (mark sent / advance repeating), print due messages to stdout
    # Each due message is printed as a single line (newlines replaced with space)
    MESSAGES=$(node - "$REMINDERS_FILE" "$CHAT_ID" << 'NODEEOF'
const fs = require('fs');

const [,, file, chatId] = process.argv;
const now = Date.now();

let reminders;
try { reminders = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { process.exit(0); }

let changed = false;
const toSend = [];

reminders = reminders.map(r => {
    if (r.status !== 'pending') return r;

    const due = new Date(r.due).getTime();
    if (due > now) return r;

    // Compose the wire-format message. Prefer the structured title +
    // description fields when present (newer reminders), fall back to the
    // legacy `message` string. Newlines are flattened so each reminder
    // emerges as exactly one stdout line.
    const title = (typeof r.title === 'string' ? r.title : '').trim();
    const desc  = (typeof r.description === 'string' ? r.description : '').trim();
    const wire  = title
        ? (desc ? `${title} — ${desc}` : title)
        : (typeof r.message === 'string' ? r.message : '');
    toSend.push(wire.replace(/\n/g, ' '));
    changed = true;

    // One-shot reminders are deleted after firing. Treat any value other
    // than the known recurring tokens ('daily', 'weekly') as one-shot —
    // otherwise a missing/unknown `repeat` field silently re-schedules the
    // reminder by +1 day and the user gets it back tomorrow.
    if (r.repeat !== 'daily' && r.repeat !== 'weekly') {
        return { ...r, status: 'sent' };
    }

    // Advance to next FUTURE occurrence. After a long downtime (deploy
    // gap, bot crash loop) the simple `+1 day` step would leave `due`
    // still in the past, so the next tick would fire again and advance
    // again — the user gets N pings 60s apart instead of one. Loop until
    // we land past `now`.
    const d = new Date(r.due);
    const stepDays = r.repeat === 'weekly' ? 7 : 1;
    while (d.getTime() <= now) {
        d.setDate(d.getDate() + stepDays);
    }
    process.stderr.write(`[reminder-monitor] Repeating ${r.id} → next: ${d.toISOString()}\n`);
    return { ...r, due: d.toISOString() };
});

if (changed) {
    reminders = reminders.filter(r => r.status !== 'sent');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reminders, null, 2));
    fs.renameSync(tmp, file); // atomic swap
}

toSend.forEach(m => process.stdout.write(m + '\n'));
NODEEOF
    )

    # Fire each due reminder. Prefer the bot's tmux session (so Claude
    # can elaborate, schedule a follow-up, etc.); fall back to direct
    # Telegram Bot API via bot-notify.sh when the session is missing.
    # SECURITY: -l (literal) flag sends the string as literal keystrokes,
    # preventing shell metacharacters in reminder messages from being interpreted.
    #
    # Additionally, ALWAYS push a notification onto the web chat SSE
    # channel via web-notify.sh — independent of Telegram, so a user
    # sitting in the workspace browser tab sees the reminder bubble even
    # when no messenger is wired up. Non-fatal if wsapi is down.
    while IFS= read -r message; do
        [ -z "$message" ] && continue
        if tmux -L "$TMUX_SOCKET" has-session -t "$TMUX_SESSION" 2>/dev/null; then
            log "Firing via tmux: ${message}"
            tmux -L "$TMUX_SOCKET" send-keys -l -t "$TMUX_SESSION" \
                "[REMINDER] chat_id=${CHAT_ID} | ${message}"
            tmux -L "$TMUX_SOCKET" send-keys -t "$TMUX_SESSION" Enter
        elif [ -x "$NOTIFY_SCRIPT" ]; then
            log "Bot session offline — direct fallback: ${message}"
            "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || \
                log "Direct fallback failed for: ${message}"
        else
            log "Cannot deliver — no tmux session and no $NOTIFY_SCRIPT: ${message}"
        fi
        if [ -x "$WEB_NOTIFY_SCRIPT" ]; then
            "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || \
                log "Web notify failed for: ${message}"
        fi
        sleep 3  # small gap between multiple reminders
    done <<< "$MESSAGES"

done
