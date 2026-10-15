// Demo dates are written relative to the day the page is opened, so the
// sample workspace never looks stale: at(-2, '09:10') is two days ago at 09:10
// local time, day(3) is the date three days from now.

const pad = (n) => String(n).padStart(2, '0');

/** ISO timestamp `days` from today at local `hhmm` ('09:10'; default now's time). */
export function at(days = 0, hhmm) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  if (hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m || 0, 0, 0);
  }
  return d.toISOString();
}

/** 'YYYY-MM-DD' for the local date `days` from today. */
export function day(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DDTHH:MM' (local, no zone) — the shape memory uses for a timed "when". */
export function when(days, hhmm) {
  return `${day(days)}T${hhmm}`;
}

/** Minutes from now, as an ISO timestamp. */
export function inMinutes(min) {
  return new Date(Date.now() + min * 60_000).toISOString();
}

/** Days until the next `dow` (0 = Sunday … 6 = Saturday), always 1–7: never today. */
export function nextWeekday(dow) {
  return ((dow - new Date().getDay() + 7) % 7) || 7;
}
