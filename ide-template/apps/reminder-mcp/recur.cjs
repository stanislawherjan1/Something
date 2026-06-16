/**
 * Recurrence engine for reminders — shared by reminder-mcp (set_reminder /
 * list_reminders) and bot/reminder-monitor.sh (the firing loop).
 *
 * On-disk recurrence shape (reminder.recur), or absent/null for one-shot:
 *   { type:'interval', every:<int≥1>, unit:'minutes'|'hours'|'days'|'weeks' }
 *   { type:'weekly',   days:['mon'..'sun'], at:'HH:MM' }
 *   { type:'monthly',  day:<1..31|'last'>, at:'HH:MM' }
 *   + optional on any: until:'<ISO>', count:<int≥1 remaining fires>
 * All times are UTC. Legacy reminders carry repeat:'daily'|'weekly' instead
 * (no recur object) — resolveRecur() maps those forward transparently.
 *
 * The block between the RECUR-SHARED sentinels below is kept BYTE-IDENTICAL
 * with the inline copy embedded in bot/reminder-monitor.sh's node heredoc.
 * The monitor inlines it (rather than require()-ing this file) so a misdeploy
 * of this module can never silently stop reminders from firing. The drift
 * guard in recur.test.mjs fails CI if the two copies diverge.
 */

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
    return t;
  }
  if (rec.type === 'weekly') {
    const at = parseAt(rec.at);
    if (!at) return null;
    const want = new Set((Array.isArray(rec.days) ? rec.days : [])
      .map(function (d) { return DOW[String(d).slice(0, 3).toLowerCase()]; })
      .filter(function (x) { return x != null; }));
    if (!want.size) return null;
    const b = new Date(afterMs);
    for (let off = 0; off <= 7; off++) {
      const d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + off, at.h, at.m, 0, 0));
      if (d.getTime() > afterMs && want.has(d.getUTCDay())) return d.getTime();
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
      if (d.getTime() > afterMs) return d.getTime();
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

// ─── set_reminder-side helpers (MCP only — monitor doesn't need these) ───────

function hhmm(at) {
  return String(at.h).padStart(2, '0') + ':' + String(at.m).padStart(2, '0');
}

function applyBounds(src, out) {
  if (src.until != null && src.until !== '') {
    const t = new Date(src.until).getTime();
    if (!Number.isFinite(t)) {
      return { ok: false, error: '`until` must be an ISO date/time, e.g. "2026-07-01T18:00:00Z"' };
    }
    out.until = new Date(t).toISOString();
  }
  if (src.count != null) {
    const c = Number(src.count);
    if (!Number.isInteger(c) || c < 1) return { ok: false, error: '`count` must be an integer ≥ 1' };
    out.count = c;
  }
  return { ok: true, recur: out };
}

/** Validate + normalize a caller-supplied recur object. → {ok,recur} | {ok:false,error}. */
function validateRecur(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, error: '`recur` must be an object' };
  if (rec.type === 'interval') {
    const every = Number(rec.every);
    if (!Number.isInteger(every) || every < 1) return { ok: false, error: '`recur.every` must be an integer ≥ 1' };
    if (!['minutes', 'hours', 'days', 'weeks'].includes(rec.unit)) {
      return { ok: false, error: '`recur.unit` must be one of minutes|hours|days|weeks' };
    }
    return applyBounds(rec, { type: 'interval', every, unit: rec.unit });
  }
  if (rec.type === 'weekly') {
    const days = [...new Set((Array.isArray(rec.days) ? rec.days : [])
      .map((d) => String(d).slice(0, 3).toLowerCase())
      .filter((d) => d in DOW))];
    if (!days.length) return { ok: false, error: '`recur.days` must list weekdays, e.g. ["mon","wed","fri"]' };
    const at = parseAt(rec.at);
    if (!at) return { ok: false, error: 'weekly recurrence needs `recur.at` as "HH:MM" (UTC)' };
    return applyBounds(rec, { type: 'weekly', days, at: hhmm(at) });
  }
  if (rec.type === 'monthly') {
    let day = rec.day;
    if (day !== 'last') {
      day = Number(day);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        return { ok: false, error: '`recur.day` must be 1..31 or "last"' };
      }
    }
    const at = parseAt(rec.at);
    if (!at) return { ok: false, error: 'monthly recurrence needs `recur.at` as "HH:MM" (UTC)' };
    return applyBounds(rec, { type: 'monthly', day, at: hhmm(at) });
  }
  return { ok: false, error: '`recur.type` must be interval | weekly | monthly' };
}

/** Resolve the recurrence for a NEW reminder from either `recur` or `repeat`. */
function buildRecur(args, parsedDueMs) {
  if (args.recur != null) return validateRecur(args.recur);
  const rep = typeof args.repeat === 'string' ? args.repeat.toLowerCase() : 'none';
  if (rep === 'none' || rep === '') return { ok: true, recur: null };
  if (rep === 'hourly') return { ok: true, recur: { type: 'interval', every: 1, unit: 'hours' } };
  if (rep === 'daily')  return { ok: true, recur: { type: 'interval', every: 1, unit: 'days' } };
  if (rep === 'weekly') return { ok: true, recur: { type: 'interval', every: 1, unit: 'weeks' } };
  if (rep === 'monthly') {
    const d = new Date(parsedDueMs);
    return { ok: true, recur: { type: 'monthly', day: d.getUTCDate(), at: hhmm({ h: d.getUTCHours(), m: d.getUTCMinutes() }) } };
  }
  return { ok: false, error: `unknown \`repeat\` "${rep}" — use none|hourly|daily|weekly|monthly, or pass a \`recur\` object` };
}

/**
 * First fire time. Interval honors the caller's explicit `due` (it sets the
 * start + the time-of-day). Weekly/monthly snap to the first matching slot at
 * or after max(due, now), so the first ping always lands on a real occurrence
 * even when the caller passes a throwaway `due` like "in 1 minute".
 */
function computeFirstDue(rec, parsedDueMs, nowMs) {
  if (!rec || rec.type === 'interval') return parsedDueMs;
  const from = Math.max(parsedDueMs, nowMs);
  const n = nextOccurrence(rec, from, from - 1);
  return n == null ? parsedDueMs : n;
}

/** Coarse legacy `repeat` token mirrored onto disk for pre-recur readers. */
function legacyRepeatToken(rec) {
  if (!rec) return 'none';
  if (rec.type === 'interval' && rec.every === 1 && rec.unit === 'days') return 'daily';
  if (rec.type === 'interval' && rec.every === 1 && rec.unit === 'weeks') return 'weekly';
  return 'custom';
}

/** Human-readable recurrence summary for confirmations + list_reminders. */
function humanizeRecur(rec) {
  if (!rec) return 'one-time';
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let s;
  if (rec.type === 'interval') {
    s = rec.every === 1 ? `every ${rec.unit.replace(/s$/, '')}` : `every ${rec.every} ${rec.unit}`;
  } else if (rec.type === 'weekly') {
    s = `every ${rec.days.map(cap).join('/')} at ${rec.at} UTC`;
  } else if (rec.type === 'monthly') {
    s = `monthly on day ${rec.day} at ${rec.at} UTC`;
  } else {
    s = 'recurring';
  }
  if (rec.until) s += `, until ${rec.until.slice(0, 16).replace('T', ' ')} UTC`;
  if (rec.count) s += ` (${rec.count}×)`;
  return s;
}

module.exports = {
  DOW, unitMs, parseAt, resolveRecur, nextOccurrence, advanceReminder,
  validateRecur, buildRecur, computeFirstDue, legacyRepeatToken, humanizeRecur,
};
