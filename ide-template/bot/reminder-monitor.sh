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
# Point at the image's canonical copy, exactly like WEB_NOTIFY_SCRIPT below.
# This used to be "$HOME/bot-notify.sh", which no longer resolves: the uid split
# moved this monitor to uid `bot` (monitor-runner sets HOME=/home/bot) while
# entrypoint.sh still installs the script into /home/coder. The path therefore
# pointed at a file that is never created, so `[ -x ]` failed every time and
# EVERY Telegram fallback silently degraded to a web toast — an in-memory ring
# buffer nobody is watching. That is the last-resort delivery path for a
# reminder whose injection was abandoned because the pane was busy, so the
# reminder simply vanished. The web fallback worked only because it already
# referenced /opt/ide directly. $HOME is kept as a secondary for older images.
# Running as uid bot with HOME=/home/bot is what bot-notify.sh expects: it reads
# the token from $HOME/.$BOT_NAME/integrations.env.
NOTIFY_SCRIPT="/opt/ide/bot-notify.sh"
[ -x "$NOTIFY_SCRIPT" ] || NOTIFY_SCRIPT="$HOME/bot-notify.sh"

# Resolve the operator chat id the same way bot-notify.sh does. The pm2 entry
# for this process carries no env block, so on a client whose Telegram was
# activated through the workspace UI (rather than the deploy .env) the variable
# above is EMPTY — every frame then injects `chat_id=` and the brain has to
# guess a destination from context, with group ids sitting in its prefix.
# Re-resolved on each tick because UI activation can land after this process
# started. Mirrors bot-notify.sh:11-33; keep the two ladders in step.
resolve_chat_id() {
    [ -n "$CHAT_ID" ] && return 0

    # Fallback A — wsapi-managed integrations.env, source of truth after the UI
    # activate flow (`export KEY=val`, mode 0660 group=botshare).
    local integrations_env="${HOME}/.${BOT_NAME}/integrations.env"
    if [ -f "$integrations_env" ]; then
        CHAT_ID=$(grep -oE '^(export )?TELEGRAM_ADMIN_CHAT_ID=.*' "$integrations_env" 2>/dev/null \
                  | sed -E 's/^(export )?[^=]+=//; s/^["'"'"']//; s/["'"'"']$//')
    fi

    # Fallback B — the telegram plugin's own access.json (allowFrom[0]), for
    # pre-Phase-3 deployments that predate integrations.env.
    local plugin_access="$HOME/.claude/channels/telegram/access.json"
    if [ -z "$CHAT_ID" ] && [ -f "$plugin_access" ]; then
        CHAT_ID=$(grep -oE '"allowFrom"[[:space:]]*:[[:space:]]*\[[[:space:]]*"[^"]+"' "$plugin_access" 2>/dev/null \
                  | grep -oE '"[0-9]+"' | head -1 | tr -d '"')
    fi

    [ -n "$CHAT_ID" ] && log "Resolved operator chat id from fallback (env was empty)"
    [ -n "$CHAT_ID" ]
}
WEB_NOTIFY_SCRIPT="/opt/ide/web-notify.sh"
# Serialized, idle-gated tmux injector — the ONLY path that may type into the
# bot's Claude session (prevents reminder/user-turn interleaving). Overridable
# for local dev; defaults to the deployed location alongside this script.
INJECT_SCRIPT="${INJECT_SCRIPT:-/opt/ide/tmux-inject.sh}"
export INJECT_MAX_WAIT_S="${INJECT_MAX_WAIT_S:-25}"

log() { echo "[reminder-monitor] $*"; }

# Append-only record of every fire attempt and how it actually left the box.
# A one-shot's record is DELETED from .reminders.json when it fires, so without
# this there is no evidence anywhere that a reminder ever existed, ran, or
# failed — which is why every delivery bug in this pipeline has been invisible.
# `path` matters as much as `ok`: a reminder "delivered" as a raw fallback ping
# or an in-memory web toast is one the user very likely never saw.
FIRED_LOG="${FIRED_LOG:-/home/coder/project/.reminders-log.jsonl}"
FIRE_PATH=""   # set by fire_operator: tmux | fallback-telegram | fallback-web | none

log_fire() {
    local ok="$1" path="$2" channel="$3" recipients="$4" urgency="$5" exec_flag="$6" title="$7"
    OK="$ok" P="$path" CH="$channel" RCP="$recipients" URG="$urgency" EX="$exec_flag" TI="$title" \
    FL="$FIRED_LOG" node - << 'NODE' 2>/dev/null || true
const fs = require('fs');
const line = JSON.stringify({
    ts: new Date().toISOString(),
    ok: process.env.OK === '0',
    path: process.env.P || 'unknown',
    channel: process.env.CH || '',
    recipients: process.env.RCP || '',
    urgency: process.env.URG || 'now',
    exec: process.env.EX === '1',
    title: (process.env.TI || '').slice(0, 200),
}) + '\n';
try {
    fs.appendFileSync(process.env.FL, line);
    try { fs.chmodSync(process.env.FL, 0o664); } catch {}
} catch {}
NODE
}

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

# The recipients MINUS the operator. /internal/reminder-deliver deliberately
# excludes the operator (they are served by fire_operator's brain frame), so
# handing it an operator-only set makes it return delivered:[] — correct, but
# indistinguishable from a real failure now that delivery is actually verified.
# That turned a harmless no-op into a spurious "(team delivery failed)" ping to
# the operator. '*everyone*' is passed through untouched: the endpoint expands
# the roster and drops the operator itself.
recipients_without_operator() {
    [ "$1" = "*everyone*" ] && { printf '%s' "$1"; return 0; }
    [ -z "$OP_SLUG" ] && { printf '%s' "$1"; return 0; }
    printf '%s' "$1" | tr ',' '\n' | grep -vxF "$OP_SLUG" | paste -sd, -
}

# Fire a reminder to the OPERATOR — TODAY's exact behaviour, extracted verbatim
# so the solo / operator path stays byte-identical. tmux alive → brain frame;
# else the channel-matched fallback ladder.
fire_operator() {
    local channel="$1" message="$2" urgency="${3:-now}"
    # Ambient reminders reach the brain as an [AMBIENT] frame — a soft topic to
    # weave into the next natural opening, not to blurt standalone (handling is
    # in global-claude.md). Everything else fires as a normal [REMINDER].
    local frame="REMINDER"
    [ "$urgency" = "ambient" ] && frame="AMBIENT"
    # Route through the serialized, idle-gated injector (tmux-inject.sh) instead
    # of a raw send-keys. That guarantees this reminder can never interleave with
    # a live user turn or another injection (2026-07-13 incident). exit 3 =
    # session stayed busy past the wait budget → DON'T type over the live turn;
    # fall through to the same direct-API ladder used when the bot is offline, so
    # the ping is delivered without corrupting the conversation.
    local injected=1
    # Never inject a Telegram-bound frame with an empty destination: the brain
    # would pick one from context, and its prefix lists every registered group's
    # chat id. Fall through to the direct ladder instead (bot-notify.sh resolves
    # the id itself and fails loudly if it can't). channel=web needs no chat id.
    if [ "$channel" != "web" ] && ! resolve_chat_id; then
        log "No operator chat id (env, integrations.env and access.json all empty) — refusing to inject a frame with an empty destination; using direct fallback"
    elif tmux -L "$TMUX_SOCKET" has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log "Firing via tmux (channel=${channel} urgency=${urgency}): ${message}"
        "$INJECT_SCRIPT" "[${frame} channel=${channel} chat_id=${CHAT_ID} | ${message}]"
        injected=$?
        [ "$injected" = "3" ] && log "Session busy past ${INJECT_MAX_WAIT_S:-25}s — using direct fallback so the live turn isn't corrupted (channel=${channel})"
    fi
    FIRE_PATH="none"
    local rc=0
    if [ "$injected" = "0" ]; then
        FIRE_PATH="tmux"
        return 0
    fi

    [ "$injected" = "1" ] && log "Bot session offline (channel=${channel}) — using fallback"

    # An internal trigger frame ([PLAN_DAY_TRIGGER], [REPO_AUDIT], [BACKUP]…) is
    # an instruction for the brain, not a message for a person. The raw ladder
    # cannot run it — it only forwards text — so sending it would show the user
    # the instruction verbatim ("⏰ Reminder: [PLAN_DAY_TRIGGER] Run the
    # morning-planner skill…") while the work still never happened: noise AND a
    # silent miss at once. Suppress it and record the miss instead; the fire log
    # is now the place where a skipped ritual is visible.
    case "$message" in
        \[[A-Z_]*\]*)
            log "Internal trigger frame could not be injected — NOT delivering it raw (it is an instruction, not a message): ${message%%]*}]"
            FIRE_PATH="suppressed-trigger"
            return 1
            ;;
    esac

    case "$channel" in
        web)
            if [ -x "$WEB_NOTIFY_SCRIPT" ]; then
                FIRE_PATH="fallback-web"
                "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || { log "Web fallback failed for: ${message}"; rc=1; }
            elif [ -x "$NOTIFY_SCRIPT" ]; then
                FIRE_PATH="fallback-telegram"
                "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || { log "Telegram fallback failed for: ${message}"; rc=1; }
            else
                log "Cannot deliver — no fallback available: ${message}"; rc=1
            fi
            ;;
        *)
            if [ -x "$NOTIFY_SCRIPT" ]; then
                FIRE_PATH="fallback-telegram"
                "$NOTIFY_SCRIPT" "⏰ Reminder: ${message}" || { log "Telegram fallback failed for: ${message}"; rc=1; }
            elif [ -x "$WEB_NOTIFY_SCRIPT" ]; then
                FIRE_PATH="fallback-web"
                "$WEB_NOTIFY_SCRIPT" "Reminder" "${message}" reminder || { log "Web fallback failed for: ${message}"; rc=1; }
            else
                log "Cannot deliver — no fallback available: ${message}"; rc=1
            fi
            ;;
    esac
    return $rc
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
    # Check BOTH the HTTP status and the per-slug result. Without --fail curl
    # exits 0 on a 500, and even a 200 can mean nothing was delivered: an
    # unknown/departed slug is skipped silently, and a member whose Telegram
    # isn't linked (or whose surface preference excludes it) comes back
    # web:false,telegram:false. Either way the monitor used to treat it as
    # delivered while the record had already been consumed.
    local resp status payload
    resp=$(curl -sS -m 6 -w '\n%{http_code}' -X POST \
        "http://localhost:${WSAPI_PORT}/api/internal/reminder-deliver" \
        -H 'Content-Type: application/json' -d "$json" 2>/dev/null) || {
        log "reminder-deliver: POST failed (wsapi unreachable)"
        return 1
    }
    status="${resp##*$'\n'}"
    payload="${resp%$'\n'*}"
    if [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 300 ] 2>/dev/null; then
        log "reminder-deliver: HTTP ${status} — ${payload}"
        return 1
    fi
    # Solo mode legitimately delivers nothing here; that is not a failure.
    RESP="$payload" node - << 'NODE'
let r = {};
try { r = JSON.parse(process.env.RESP || '{}'); } catch { process.exit(2); }
if (r.skipped) process.exit(0);
const rows = Array.isArray(r.delivered) ? r.delivered : [];
const dead = rows.filter(d => !d.web && !d.telegram).map(d => d.slug);
if (!rows.length) { process.stderr.write('no recipient resolved'); process.exit(3); }
if (dead.length)  { process.stderr.write('reached nobody: ' + dead.join(',')); process.exit(3); }
NODE
    local rc=$?
    [ "$rc" = "0" ] || log "reminder-deliver: delivered to nobody (rc=${rc}) — ${payload}"
    return $rc
}

# EXECUTION reminders (exec=1, e.g. the per-user morning-planner): run the wire
# message AS each NON-operator teammate recipient, so the skill executes in THAT
# person's identity + scope (reads their own private cards) instead of the
# operator brain — which the scope-guard now fences out of a teammate's private
# tree. POSTs to wsapi /internal/invoke-turn, which spawns runClaudeTurn(actor).
# Fire-and-forget (wsapi returns 202); the operator's own leg still runs via
# fire_operator above, so the operator is skipped here to avoid a double-run.
invoke_turn_teammates() {
    command -v curl >/dev/null 2>&1 || return 1
    local recips="$1" wire="$2" slug json
    [ "$recips" = "*everyone*" ] && return 0   # planner triggers are per-slug; never mass-execute
    IFS=',' read -ra _arr <<< "$recips"
    for slug in "${_arr[@]}"; do
        [ -z "$slug" ] && continue
        operator_in_set "$slug" && continue    # operator ran via fire_operator
        json=$(ACTOR="$slug" MSG="$wire" node - << 'NODE'
process.stdout.write(JSON.stringify({ actor: process.env.ACTOR, message: process.env.MSG }));
NODE
) || continue
        curl -sS -m 8 -X POST "http://localhost:${WSAPI_PORT}/api/internal/invoke-turn" \
            -H 'Content-Type: application/json' -d "$json" >/dev/null 2>&1 \
            || log "invoke-turn POST failed for ${slug}"
    done
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
        ? (desc ? `${title}: ${desc}` : title)
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
    // 7th column `exec`: '1' marks an EXECUTION reminder (run the wire AS each
    // teammate recipient via /internal/invoke-turn), vs '' = a delivery reminder
    // (notify the recipient). Only reconcile-set per-user planner triggers set it.
    toSend.push(`${channel}\x1f${recipientsCsv}\x1f${flat(wire)}\x1f${flat(title)}\x1f${flat(desc)}\x1f${flat(r.urgency || 'now')}\x1f${r.exec ? '1' : ''}`);
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
        IFS=$'\x1f' read -r channel recipients wire title desc urgency exec <<< "$line"
        [ -z "$channel" ] && channel="all"

        if [ -z "$recipients" ]; then
            # Solo / operator-only — byte-identical to before.
            fire_operator "$channel" "$wire" "$urgency"
            log_fire "$?" "$FIRE_PATH" "$channel" "" "$urgency" "$exec" "$title"
        else
            # Team mode. Operator's own copy is brain-elaborated when targeted.
            if operator_in_set "$recipients"; then
                fire_operator "$channel" "$wire" "$urgency"
                log_fire "$?" "$FIRE_PATH" "$channel" "$OP_SLUG" "$urgency" "$exec" "$title"
            fi
            if [ "$exec" = "1" ]; then
                # EXECUTION reminder (per-user planner): run the wire AS each
                # teammate recipient in their own scope, not the operator brain.
                invoke_turn_teammates "$recipients" "$wire"
                log_fire "$?" "invoke-turn" "$channel" "$recipients" "$urgency" "$exec" "$title"
            else
                # Delivery reminder: notify teammates via wsapi; on failure,
                # surface to the operator so a team reminder is never lost.
                others=$(recipients_without_operator "$recipients")
                if [ -z "$others" ]; then
                    : # operator-only reminder — already delivered by fire_operator above
                elif deliver_to_teammates "$others" "$channel" "$title" "$desc"; then
                    log_fire 0 "teammates" "$channel" "$recipients" "$urgency" "$exec" "$title"
                else
                    log_fire 1 "teammates" "$channel" "$recipients" "$urgency" "$exec" "$title"
                    log "reminder-deliver reached nobody — surfacing to operator"
                    fire_operator "$channel" "(team delivery failed) $wire"
                    log_fire "$?" "$FIRE_PATH" "$channel" "$OP_SLUG" "$urgency" "$exec" "(escalated) $title"
                fi
            fi
        fi
        sleep 3  # small gap between multiple reminders
    done <<< "$MESSAGES"

done
