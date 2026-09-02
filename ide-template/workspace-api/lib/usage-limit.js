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
const LIMIT_RE = /(usage|rate)[ -]limit (reached|exceeded|exhausted)|limit reached[.!]?\s*(your|the)? ?limit will reset|rate-limit-options|out of (usage|credits)|insufficient (credits|quota)|quota exceeded/i;

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
