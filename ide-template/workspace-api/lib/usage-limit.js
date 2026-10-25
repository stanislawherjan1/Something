/**
 * usage-limit — read a failed turn's output for "the plan's usage limit is
 * exhausted", and for WHEN it comes back.
 *
 * Two things were wrong before this existed:
 *
 *  1. A turn that exited non-zero was assumed to be a usage limit. Any crash —
 *     a bad config, a missing binary, an MCP blowing up — was announced to the
 *     group as "the usage limit is exhausted", which is a confident lie about
 *     something the user might act on (waiting instead of fixing).
 *  2. The CLI PRINTS the reset time when it refuses, and the workspace threw it
 *     away, so the notice could only say "I'll be back when it renews" — the one
 *     thing the reader actually wants to know was available and discarded.
 *
 * The phrasing here is matched loosely on purpose (the CLI's wording has changed
 * more than once). When nothing matches we return null and the caller says
 * nothing about timing — never a guessed time.
 */

// "Claude usage limit reached", "usage limit reached", "you've hit your limit",
// "rate limit exceeded", "/rate-limit-options" (the interactive menu's marker).
// The CLI today says "You've hit your weekly limit · resets Oct 22, 12pm (UTC)"
// (also session / 5-hour / daily): unmatched, a spent plan read as a crash.
const LIMIT_RE = /(usage|rate)[ -]limit (reached|exceeded|exhausted)|\byou(?:'ve| have) hit your (?:[\w-]+ )?limit\b|limit reached[.!]?\s*(your|the)? ?limit will reset|rate-limit-options|out of (usage|credits)|insufficient (credits|quota)|quota exceeded/i;

// "…will reset at 3pm", "resets at 10:00 (Europe/Warsaw)", "reset at 15:40 CET".
// Captures the time as PRINTED, with an optional zone/AM-PM, and passes it
// through verbatim — reformatting it would only invite a timezone bug in a
// string whose whole value is being exactly right.
const RESET_RE = /(?:will\s+)?reset(?:s|ting)?\s+(?:at|on)?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?(?:\s*\([^)]{1,40}\))?(?:\s*[A-Z]{2,5})?)/i;

/**
 * How long to stay quiet after announcing the limit, in ms — the next occurrence
 * of the printed clock time, or null when it did not say one.
 *
 * The notice used to repeat on a fixed 15-minute interval, so a five-hour window
 * put ~20 identical "the limit is exhausted" messages into the chat. Announcing
 * it once and then waiting is the whole point: the reader already knows.
 *
 * Deliberately approximate. Getting it wrong only means the notice may repeat
 * once more, which is a far cheaper failure than staying silent past the reset.
 */
export function resetDelayMs(text, now = new Date()) {
  const raw = parseResetAt(text);
  if (!raw) return null;
  const m = raw.match(/^([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ampm = (m[3] || '').toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);   // already past → tomorrow
  const delta = target - now;
  // A window longer than half a day means we misread it; fall back to null so
  // the caller uses its own conservative interval instead of going mute.
  return delta > 0 && delta <= 12 * 3600_000 ? delta : null;
}

/** True when this failure is the plan's usage limit rather than a crash. */
export function isUsageLimit(text) {
  return LIMIT_RE.test(String(text || ''));
}

/**
 * The reset time exactly as the CLI printed it ("3pm", "10:00 (Europe/Warsaw)"),
 * or null when it did not say. Never inferred.
 */
export function parseResetAt(text) {
  const m = String(text || '').match(RESET_RE);
  if (!m) return null;
  const raw = m[1].trim().replace(/\s+/g, ' ');
  // A bare "0" or a stray number is not a time worth showing.
  return /[0-9]/.test(raw) && raw.length >= 1 && raw.length <= 40 ? raw : null;
}

/**
 * Format the `resetsAt` the CLI now reports as a structured field (unix
 * seconds) into the workspace's own clock.
 *
 * The regexes above read the CLI's PRINTED wording. It stopped printing the
 * limit into the reply and started emitting a `rate_limit_event` instead, so
 * they matched nothing and the turn ended silently — "it just stopped
 * replying" — with the reset time sitting in an event the stream handler was
 * dropping as an unknown type.
 *
 * Rendered in IDE_TIMEZONE so "back at 13:00" means 13:00 where the people
 * reading it live, not in UTC.
 */
export function formatResetAt(resetsAtSeconds, tz = process.env.IDE_TIMEZONE || 'UTC', { zoneLabel = false } = {}) {
  const secs = Number(resetsAtSeconds);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const when = new Date(secs * 1000);
  const fmt = (zone, label) => {
    const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(when);
    if (!label) return hm;
    // A room's readers may live in other zones: the zone goes with the hour.
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(when).find(p => p.type === 'timeZoneName')?.value;
    return name ? `${hm} ${name}` : hm;
  };
  try {
    return fmt(tz, zoneLabel);
  } catch {
    // An unknown zone must not cost us the whole notice — UTC still tells
    // the reader more than silence does.
    return `${fmt('UTC', false)} UTC`;
  }
}

/**
 * The instant a printed reset names, as unix seconds, or null. The CLI
 * prints it in its own zone, sometimes with a day: "resets 6pm (UTC)",
 * "resets Oct 22, 12pm (UTC)", "resets 18:00 (Europe/Warsaw)". A time with no
 * day is the next one to come. Never a guess: an unreadable one is null.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function resetInstant(text, now = Date.now()) {
  const m = String(text || '').match(/resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]{1,40})\))?/i);
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] || 0);
  const ap = (m[5] || '').toLowerCase();
  if (hour > 23 || minute > 59 || (ap && hour > 12)) return null;
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  const zone = (m[6] || 'UTC').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { return null; }
  // The wall clock in `zone` → an instant: guess as UTC, then correct by the zone's offset at that moment.
  const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
  };
  const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  let year = +today.year, month = +today.month - 1, day = +today.day;
  const named = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (m[1] && named < 0) return null;
  if (named >= 0) { month = named; day = Number(m[2]); }
  const at = (y, mo, d) => { const guess = Date.UTC(y, mo, d, hour, minute); return guess - offsetAt(guess); };
  let ms = at(year, month, day);
  if (named < 0 && ms <= now) ms = at(year, month, day + 1);        // a time with no day: the next one
  if (named >= 0 && ms < now - 12 * 3600_000) ms = at(year + 1, month, day);   // "Jan 2" seen on Dec 31
  return Math.round(ms / 1000);
}

/** The sentence a person should see when the plan is spent. */
// One sentence on every surface — the web chat, a Telegram or Slack direct
// message, a group or a channel — in the reader's language and clock. An
// i18n table (the one place another language is allowed in code).
import { NOTICE, UNNAMED } from './i18n/limit-notice.js';
/** 'pl' for a Polish preference ("pl", "Polish", "polski"), else 'en'. */
export function noticeLang(pref) {
  const l = String(pref || '').trim().toLowerCase();
  return l.startsWith('pl') || l.startsWith('pol') ? 'pl' : 'en';
}

/**
 * The sentence a person should see when the plan is spent. `tz`: the reader's
 * zone (a person's own, else the workspace's); `lang`: 'en' | 'pl';
 * `zoneLabel`: name the zone with the hour (a room, read across zones).
 */
export function limitNotice(resetsAtSeconds, botName, { tz, lang = 'en', zoneLabel = false } = {}) {
  const who = (botName || '').trim() || UNNAMED[lang] || UNNAMED.en;
  const at = formatResetAt(resetsAtSeconds, tz || process.env.IDE_TIMEZONE || 'UTC', { zoneLabel });
  return (NOTICE[lang] || NOTICE.en)(who, at);
}

/** The reset instant a notice built by limitNotice carries, for a surface that re-says it in another language. */
const NOTICE_SECS_RE = /\[resets=(\d{9,12})\]/;
export function noticeResetsAt(text) {
  const m = String(text || '').match(NOTICE_SECS_RE);
  return m ? Number(m[1]) : null;
}
