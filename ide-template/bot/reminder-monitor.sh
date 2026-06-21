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

WSAPI_PORT="${WORKSPACE_API_PORT:-3001}"
OP_SLUG=""   # operator slug (team mode); fetched lazily once wsapi is reachable

# Resolve the operator slug from wsapi (team mode). Empty in solo or until wsapi
# is up — called lazily in the poll loop until it resolves.
fetch_op_slug() {
    command -v curl >/dev/null 2>&1 || return 0
    local j
    j=$(curl -sS --max-time 5 --fail "http://localhost:${WSAPI_PORT}/api/internal/operator-identity" 2>/dev/null || true)
    OP_SLUG=$(printf '%s' "$j" | grep -oE '"slug":"[a-z0-9-]+"' | head -1 | sed -E 's/.*:"//; s/"//')
}

# Is the operator a recipient of this reminder? Their own copy is brain-
# elaborated (the operator is the only persistent brain pre-Phase-B); teammates
# are delivered by wsapi. True for the '*everyone*' sentinel.
operator_in_set() {
    [ "$1" = "*everyone*" ] && return 0
    [ -z "$OP_SLUG" ] && return 1
    case ",$1," in *",$OP_SLUG,"*) return 0 ;; esac
    return 1
}

# Fire a reminder to the OPERATOR — TODAY's exact behaviour, extracted verbatim
# so the solo / operator path stays byte-identical. tmux alive → brain frame;
# else the channel-matched fallback ladder.
fire_operator() {
    local channel="$1" message="$2"
    if tmux -L "$TMUX_SOCKET" has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log "Firing via tmux (channel=${channel}): ${message}"
        tmux -L "$TMUX_SOCKET" send-keys -l -t "$TMUX_SESSION" \
            "[REMINDER channel=${channel} chat_id=${CHAT_ID} | ${message}]"
        tmux -L "$TMUX_SOCKET" send-keys -t "$TMUX_SESSION" Enter
    else
        log "Bot session offline (channel=${channel}) — using fallback"
        case "$channel" in
            web)
                if [ -x "$WEB_NOTIFY_SCRIPT" ]; then
                    "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || log "Web fallback failed for: ${message}"
                elif [ -x "$NOTIFY_SCRIPT" ]; then
                    "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || log "Telegram fallback failed for: ${message}"
                else
                    log "Cannot deliver — no fallback available: ${message}"
                fi
                ;;
            *)
                if [ -x "$NOTIFY_SCRIPT" ]; then
                    "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || log "Telegram fallback failed for: ${message}"
                elif [ -x "$WEB_NOTIFY_SCRIPT" ]; then
                    "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || log "Web fallback failed for: ${message}"
                else
                    log "Cannot deliver — no fallback available: ${message}"
                fi
                ;;
        esac
    fi
}

# Fan out the NON-operator recipients to wsapi (recipient-scoped web toast + their
# Telegram if linked). title+desc passed separately for a clean heading/detail
# split. Returns non-zero on POST failure so the caller surfaces it to the
# operator (a team reminder is never silently lost). Uses node (already required
# by this script) to build the JSON safely.
deliver_to_teammates() {
    command -v curl >/dev/null 2>&1 || return 1
    local json
    # node script via a QUOTED heredoc (not -e) so bash treats the body — incl.
    # its parens — literally; an inline -e '...(...)' trips the legacy macOS
    # bash $() parser. Mirrors the MESSAGES heredoc below.
    json=$(RCSV="$1" CH="$2" TI="$3" DE="$4" node - << 'NODE'
const rc = process.env.RCSV;
const recips = rc === "*everyone*" ? ["*everyone*"] : rc.split(",").filter(Boolean);
process.stdout.write(JSON.stringify({ recipients: recips, channel: process.env.CH, title: process.env.TI, body: process.env.DE }));
NODE
) || return 1
    curl -sS -m 6 -X POST "http://localhost:${WSAPI_PORT}/api/internal/reminder-deliver" \
        -H 'Content-Type: application/json' -d "$json" >/dev/null 2>&1
}

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
    // Team mode: recipients ride as the 2nd column (CSV of slugs, or the
    // '*everyone*' sentinel). EMPTY = solo / operator-only → the bash side
    // reproduces today's exact path. title + description ride as their own
    // columns so a teammate's clean notification keeps the heading/detail
    // split; `wire` stays the operator's brain-frame message (unchanged).
    // Flatten newlines AND tabs so the 5-column structure can't be broken.
    const recipientsCsv = Array.isArray(r.recipients) ? r.recipients.join(',') : '';
    // \x1f (unit separator) between columns — a NON-whitespace delimiter so bash
    // `read` PRESERVES empty fields (an empty recipients column = solo; a
    // whitespace IFS like \t would collapse it). Flatten it (+ newlines/tabs)
    // out of every field so content can never inject a column break.
    const flat = (s) => String(s == null ? '' : s).replace(/[\n\t\x1f]+/g, ' ');
    toSend.push(`${channel}\x1f${recipientsCsv}\x1f${flat(wire)}\x1f${flat(title)}\x1f${flat(desc)}`);
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

    # Fire each due reminder. Wire format (tab-separated, 5 columns from the node
    # block above): channel \t recipients \t wire \t title \t description.
    #
    #   - recipients EMPTY → solo / operator-only: fire_operator() — TODAY's exact
    #     path (tmux brain frame, else the channel-matched fallback ladder).
    #   - recipients PRESENT → team mode. The operator (if in the set, or for the
    #     '*everyone*' sentinel) gets the brain-elaborated frame — it's the only
    #     persistent brain pre-Phase-B. The NON-operator recipients are fanned out
    #     by wsapi (/internal/reminder-deliver: recipient-scoped web toast + their
    #     Telegram if linked). On a wsapi-down POST failure the reminder is
    #     surfaced to the operator so a team reminder is never silently lost.
    #
    # SECURITY: -l (literal, inside fire_operator) keeps reminder-body
    # metacharacters inert.
    [ -z "$OP_SLUG" ] && fetch_op_slug
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        # Split on \x1f (unit separator) — non-whitespace, so empty fields (e.g.
        # an absent recipients column = solo) are preserved.
        IFS=$'\x1f' read -r channel recipients wire title desc <<< "$line"
        [ -z "$channel" ] && channel="all"

        if [ -z "$recipients" ]; then
            # Solo / operator-only — byte-identical to before.
            fire_operator "$channel" "$wire"
        else
            # Team mode. Operator's own copy is brain-elaborated when targeted.
            if operator_in_set "$recipients"; then
                fire_operator "$channel" "$wire"
            fi
            # Teammates via wsapi; on failure, surface to the operator.
            if ! deliver_to_teammates "$recipients" "$channel" "$title" "$desc"; then
                log "reminder-deliver POST failed (wsapi down?) — surfacing to operator"
                fire_operator "$channel" "(team delivery failed) $wire"
            fi
        fi
        sleep 3  # small gap between multiple reminders
    done <<< "$MESSAGES"

done
