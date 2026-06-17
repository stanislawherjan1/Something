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

// Recurrence engine — byte-identical with apps/reminder-mcp/recur.cjs (the
// block between the RECUR-SHARED sentinels). Inlined rather than require()'d so
// a misdeploy of that module can never silently stop reminders from firing.
// Drift-guarded by apps/reminder-mcp/recur.test.mjs.
// <<<RECUR-SHARED-START>>>
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function unitMs(u) {
  return u === 'minutes' ? 60000
       : u === 'hours'   ? 3600000
       : u === 'days'    ? 86400000
       : u === 'weeks'   ? 604800000
       : 0;
}
function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof at === 'string' ? at.trim() : '');
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  return (h <= 23 && mm <= 59) ? { h, m: mm } : null;
}
function isSkipped(timeMs, rec) {
  if (!rec) return false;
  const d = new Date(timeMs);
  const h = d.getUTCHours();
  const dow = d.getUTCDay();
  const skipHours = Array.isArray(rec.skip_hours) ? rec.skip_hours : [];
  const skipDays = Array.isArray(rec.skip_days) ? rec.skip_days.map(function (x) { return DOW[String(x).slice(0, 3).toLowerCase()]; }).filter(function (x) { return x != null; }) : [];
  if (skipHours.includes(h)) return true;
  if (skipDays.includes(dow)) return true;
  return false;
}
function resolveRecur(r) {
  if (r && r.recur && typeof r.recur === 'object' && r.recur.type) return r.recur;
  const rep = r && typeof r.repeat === 'string' ? r.repeat : '';
  if (rep === 'daily')  return { type: 'interval', every: 1, unit: 'days' };
  if (rep === 'weekly') return { type: 'interval', every: 1, unit: 'weeks' };
  return null;
}
function nextOccurrence(rec, anchorMs, afterMs) {
  if (!rec) return null;
  if (rec.type === 'interval') {
    const step = (Number(rec.every) || 0) * unitMs(rec.unit);
    if (!(step > 0)) return null;
    let t = Number(anchorMs);
    if (!Number.isFinite(t)) return null;
    if (t <= afterMs) t += (Math.floor((afterMs - t) / step) + 1) * step;
    for (let i = 0; i < 1000; i++) {
      if (!isSkipped(t, rec)) return t;
      t += step;
    }
    return null;
  }
  if (rec.type === 'weekly') {
    const at = parseAt(rec.at);
    if (!at) return null;
    const want = new Set((Array.isArray(rec.days) ? rec.days : [])
      .map(function (d) { return DOW[String(d).slice(0, 3).toLowerCase()]; })
      .filter(function (x) { return x != null; }));
    if (!want.size) return null;
    const b = new Date(afterMs);
    for (let off = 0; off <= 365; off++) {
      const d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + off, at.h, at.m, 0, 0));
      if (d.getTime() > afterMs && want.has(d.getUTCDay()) && !isSkipped(d.getTime(), rec)) return d.getTime();
    }
    return null;
  }
  if (rec.type === 'monthly') {
    const at = parseAt(rec.at);
    if (!at) return null;
    const b = new Date(afterMs);
    for (let add = 0; add <= 12; add++) {
      const y = b.getUTCFullYear(), mo = b.getUTCMonth() + add;
      const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const dom = rec.day === 'last' ? lastDay : Math.min(Number(rec.day) || 1, lastDay);
      const d = new Date(Date.UTC(y, mo, dom, at.h, at.m, 0, 0));
      if (d.getTime() > afterMs && !isSkipped(d.getTime(), rec)) return d.getTime();
    }
    return null;
  }
  return null;
}
function advanceReminder(r, nowMs) {
  const rec = resolveRecur(r);
  if (!rec) return null;
  const next = nextOccurrence(rec, new Date(r.due).getTime(), nowMs);
  if (next == null) return null;
  if (rec.until) {
    const u = new Date(rec.until).getTime();
    if (Number.isFinite(u) && next > u) return null;
  }
  let outRec = rec;
  if (rec.count != null) {
    const left = (Number(rec.count) || 0) - 1;
    if (left <= 0) return null;
    outRec = Object.assign({}, rec, { count: left });
  }
  return { due: new Date(next).toISOString(), recur: outRec };
}
// <<<RECUR-SHARED-END>>>

// Best-effort advisory lock shared with the set_reminder MCP (apps/reminder-mcp),
// which runs the same read-modify-write when the user adds/cancels a reminder.
// Without it, a user mutation landing in this 60s tick can clobber a
// fire/advance (last rename wins, the other write is lost). We break a stale
// lock and, after a short wait, proceed WITHOUT it rather than ever skip a due
// ping — a wedged lock must never stop reminders from firing.
const LOCK_FILE = file + '.lock';
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
let lockHeld = false;
{
  const deadline = Date.now() + 4000;
  while (true) {
    try { fs.closeSync(fs.openSync(LOCK_FILE, 'wx')); lockHeld = true; break; } // O_CREAT|O_EXCL
    catch (err) {
      if (err.code !== 'EEXIST') break; // unexpected FS error → proceed unlocked
      try { const st = fs.statSync(LOCK_FILE); if (Date.now() - st.mtimeMs > 30000) { fs.unlinkSync(LOCK_FILE); continue; } } catch {}
      if (Date.now() >= deadline) break; // give up waiting → fail open
      sleepMs(40);
    }
  }
}
const releaseLock = () => { if (lockHeld) { try { fs.unlinkSync(LOCK_FILE); } catch {} lockHeld = false; } };

let reminders;
try { reminders = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { releaseLock(); process.exit(0); }

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
    // Channel hint travels with the wire message via a tab separator —
    // bash splits on it below. Default 'all' covers legacy reminders that
    // pre-date the field.
    const channel = (typeof r.channel === 'string' && ['telegram','web','all'].includes(r.channel))
        ? r.channel : 'all';
    toSend.push(`${channel}\t${wire.replace(/\n/g, ' ')}`);
    changed = true;

    // Advance to the next occurrence — interval / weekly / monthly, honoring
    // until/count bounds. Returns null for a one-shot or an exhausted bounded
    // repeat → mark 'sent' (filtered out below). advanceReminder loops past a
    // long downtime gap internally so the user gets one ping, not N. All math
    // is in the RECUR-SHARED block above (shared with the set_reminder MCP).
    const adv = advanceReminder(r, now);
    if (!adv) {
        return { ...r, status: 'sent' };
    }
    process.stderr.write(`[reminder-monitor] Repeating ${r.id} → next: ${adv.due}\n`);
    return { ...r, due: adv.due, recur: adv.recur };
});

if (changed) {
    reminders = reminders.filter(r => r.status !== 'sent');
    // Unique tmp per writer — a fixed `.tmp` lets the MCP and this monitor
    // interleave into the same scratch file and corrupt the rename.
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(reminders, null, 2));
        fs.renameSync(tmp, file); // atomic swap
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

releaseLock();
toSend.forEach(m => process.stdout.write(m + '\n'));
NODEEOF
    )

    # Fire each due reminder. Format on the wire: "channel\tmessage" — see
    # the node block above. Routing per channel:
    #
    #   - tmux session alive → send-keys with [REMINDER channel=X | msg]
    #     prefix so the bot reads the channel hint and replies through the
    #     matching tool (telegram_send_message vs web_send_message). This
    #     is the primary path; the bot's web-mirror.sh PostToolUse hook
    #     handles the TG → web copy automatically when channel=all/telegram
    #     and the bot replies on TG.
    #
    #   - tmux session DEAD (bot crashed, deferred at start, fresh install
    #     pre-token) → fallback. For channel=telegram or channel=all, try
    #     bot-notify.sh (raw direct TG API). For channel=web (or when
    #     bot-notify isn't usable), POST a raw bubble via web-notify.sh
    #     so the user at least sees the trigger landed.
    #
    # SECURITY: -l (literal) sends the prefix string as literal keystrokes,
    # preventing shell or tmux metacharacters in the reminder body from
    # being interpreted.
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        # Split channel\tmessage. Legacy payloads (no tab) default to 'all'.
        case "$line" in
            *$'\t'*)
                channel="${line%%$'\t'*}"
                message="${line#*$'\t'}"
                ;;
            *)
                channel="all"
                message="$line"
                ;;
        esac
        if tmux -L "$TMUX_SOCKET" has-session -t "$TMUX_SESSION" 2>/dev/null; then
            log "Firing via tmux (channel=${channel}): ${message}"
            tmux -L "$TMUX_SOCKET" send-keys -l -t "$TMUX_SESSION" \
                "[REMINDER channel=${channel} chat_id=${CHAT_ID} | ${message}]"
            tmux -L "$TMUX_SOCKET" send-keys -t "$TMUX_SESSION" Enter
        else
            log "Bot session offline (channel=${channel}) — using fallback"
            # Prefer the channel-matching fallback; fall through to the
            # other one if the preferred path is missing.
            case "$channel" in
                web)
                    if [ -x "$WEB_NOTIFY_SCRIPT" ]; then
                        "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || \
                            log "Web fallback failed for: ${message}"
                    elif [ -x "$NOTIFY_SCRIPT" ]; then
                        "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || \
                            log "Telegram fallback failed for: ${message}"
                    else
                        log "Cannot deliver — no fallback available: ${message}"
                    fi
                    ;;
                *)
                    if [ -x "$NOTIFY_SCRIPT" ]; then
                        "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || \
                            log "Telegram fallback failed for: ${message}"
                    elif [ -x "$WEB_NOTIFY_SCRIPT" ]; then
                        "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || \
                            log "Web fallback failed for: ${message}"
                    else
                        log "Cannot deliver — no fallback available: ${message}"
                    fi
                    ;;
            esac
        fi
        sleep 3  # small gap between multiple reminders
    done <<< "$MESSAGES"

done
