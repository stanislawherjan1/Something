/**
 * Tests for the recurrence engine (recur.cjs) + a drift guard that the inline
 * copy in bot/reminder-monitor.sh stays byte-identical.
 *
 * Run: node apps/reminder-mcp/recur.test.mjs
 * Pure functions + fixed timestamps → deterministic, no network, no clock dep.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import recur from './recur.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const {
  resolveRecur, nextOccurrence, advanceReminder,
  validateRecur, buildRecur, computeFirstDue, legacyRepeatToken, humanizeRecur,
} = recur;

let pass = 0, fail = 0;
const iso = (ms) => new Date(ms).toISOString();
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${name}`); } }
function eq(name, a, b) { ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b); }

// Reference instant: Mon 2026-06-15 12:00:00 UTC (June = month index 5).
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const H = 3600000, MIN = 60000, DAY = 86400000;

// ── interval ────────────────────────────────────────────────────────────────
{
  const r = { due: iso(NOW - 1000), recur: { type: 'interval', every: 1, unit: 'hours' } };
  const adv = advanceReminder(r, NOW);
  eq('hourly: next = due + 1h', adv.due, iso(NOW - 1000 + H));
  ok('hourly: next is in the future', new Date(adv.due).getTime() > NOW);
}
{
  // 10h of missed fires after downtime → exactly ONE catch-up past now, not 10.
  const r = { due: iso(NOW - 10 * H), recur: { type: 'interval', every: 1, unit: 'hours' } };
  const adv = advanceReminder(r, NOW);
  eq('hourly catch-up lands one step past now', adv.due, iso(NOW + H));
}
{
  const r = { due: iso(NOW - 1000), recur: { type: 'interval', every: 30, unit: 'minutes' } };
  eq('every 30 min', advanceReminder(r, NOW).due, iso(NOW - 1000 + 30 * MIN));
}
{
  const r = { due: iso(NOW - 1000), recur: { type: 'interval', every: 2, unit: 'days' } };
  eq('every 2 days', advanceReminder(r, NOW).due, iso(NOW - 1000 + 2 * DAY));
}

// ── weekly ──────────────────────────────────────────────────────────────────
{
  const rec = { type: 'weekly', days: ['mon', 'wed', 'fri'], at: '09:00' };
  const next = nextOccurrence(rec, NOW, NOW);
  const d = new Date(next);
  ok('weekly: strictly after now', next > NOW);
  ok('weekly: lands on a wanted weekday', [1, 3, 5].includes(d.getUTCDay()));
  ok('weekly: at 09:00 UTC', d.getUTCHours() === 9 && d.getUTCMinutes() === 0);
  ok('weekly: within 7 days', next - NOW <= 7 * DAY);
  // earliest: no matching wanted-weekday 09:00 slot exists strictly between now and next
  let earlierExists = false;
  for (let off = 0; off <= 7; off++) {
    const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), new Date(NOW).getUTCDate() + off, 9, 0, 0)).getTime();
    if (c > NOW && c < next && [1, 3, 5].includes(new Date(c).getUTCDay())) earlierExists = true;
  }
  ok('weekly: picks the EARLIEST matching slot', !earlierExists);
}
{
  // "at" earlier today than now → today is skipped even if today is wanted.
  const todayDow = new Date(NOW).getUTCDay();           // Monday = 1
  const rec = { type: 'weekly', days: [['sun','mon','tue','wed','thu','fri','sat'][todayDow]], at: '08:00' };
  const next = nextOccurrence(rec, NOW, NOW);            // 08:00 < 12:00 now → next week
  ok('weekly: same weekday but time passed → +7 days', next - NOW >= 6 * DAY);
}

// ── monthly ─────────────────────────────────────────────────────────────────
{
  const rec = { type: 'monthly', day: 1, at: '08:00' };
  eq('monthly day 1 (June 1 passed → July 1)', nextOccurrence(rec, NOW, NOW), Date.UTC(2026, 6, 1, 8, 0, 0));
}
{
  const rec = { type: 'monthly', day: 31, at: '10:00' };     // June has 30 days → clamp
  eq('monthly day 31 clamps to June 30', nextOccurrence(rec, NOW, NOW), Date.UTC(2026, 5, 30, 10, 0, 0));
}
{
  const rec = { type: 'monthly', day: 'last', at: '17:00' };
  eq('monthly last day of June = 30', nextOccurrence(rec, NOW, NOW), Date.UTC(2026, 5, 30, 17, 0, 0));
}
{
  const rec = { type: 'monthly', day: 15, at: '10:00' };     // 10:00 < now (12:00) → next month
  eq('monthly day 15 today-but-passed → July 15', nextOccurrence(rec, NOW, NOW), Date.UTC(2026, 6, 15, 10, 0, 0));
}

// ── bounds: until / count ────────────────────────────────────────────────────
{
  const r = { due: iso(NOW), recur: { type: 'interval', every: 1, unit: 'hours', until: iso(NOW + 30 * MIN) } };
  ok('until: next (NOW+1h) is past until (NOW+30m) → stops', advanceReminder(r, NOW) === null);
}
{
  const r = { due: iso(NOW), recur: { type: 'interval', every: 1, unit: 'hours', count: 2 } };
  const a1 = advanceReminder(r, NOW);
  ok('count: first advance keeps going', a1 !== null);
  eq('count: decremented to 1', a1.recur.count, 1);
  const a2 = advanceReminder({ due: a1.due, recur: a1.recur }, new Date(a1.due).getTime());
  ok('count: second fire exhausts (count→0) → stops', a2 === null);
}

// ── legacy repeat (no recur object) ──────────────────────────────────────────
{
  const r = { due: iso(NOW - 1000), repeat: 'daily' };
  const adv = advanceReminder(r, NOW);
  eq('legacy daily → +1 day', adv.due, iso(NOW - 1000 + DAY));
  eq('legacy daily → upgraded recur unit', adv.recur.unit, 'days');
}
{
  const r = { due: iso(NOW - 1000), repeat: 'weekly' };
  eq('legacy weekly → +7 days', advanceReminder(r, NOW).due, iso(NOW - 1000 + 7 * DAY));
}
ok('one-shot (no recur/repeat) → null', advanceReminder({ due: iso(NOW - 1000) }, NOW) === null);
ok('repeat:none → null', advanceReminder({ due: iso(NOW - 1000), repeat: 'none' }, NOW) === null);

// ── buildRecur shortcuts + validation ────────────────────────────────────────
eq('buildRecur hourly', JSON.stringify(buildRecur({ repeat: 'hourly' }, NOW).recur), JSON.stringify({ type: 'interval', every: 1, unit: 'hours' }));
eq('buildRecur none → null', buildRecur({ repeat: 'none' }, NOW).recur, null);
{
  const rr = buildRecur({ repeat: 'monthly' }, Date.UTC(2026, 5, 15, 8, 30, 0));
  ok('buildRecur monthly derives day+at from due', rr.ok && rr.recur.type === 'monthly' && rr.recur.day === 15 && rr.recur.at === '08:30');
}
ok('buildRecur recur wins over repeat', buildRecur({ repeat: 'daily', recur: { type: 'interval', every: 2, unit: 'hours' } }, NOW).recur.every === 2);
ok('validate: every < 1 rejected', !buildRecur({ recur: { type: 'interval', every: 0, unit: 'hours' } }, NOW).ok);
ok('validate: bad unit rejected', !buildRecur({ recur: { type: 'interval', every: 1, unit: 'fortnights' } }, NOW).ok);
ok('validate: weekly empty days rejected', !buildRecur({ recur: { type: 'weekly', days: [], at: '09:00' } }, NOW).ok);
ok('validate: bad at rejected', !buildRecur({ recur: { type: 'weekly', days: ['mon'], at: '25:00' } }, NOW).ok);
ok('validate: at without leading zero normalized', buildRecur({ recur: { type: 'weekly', days: ['mon'], at: '9:00' } }, NOW).recur.at === '09:00');
ok('validate: monthly day 32 rejected', !buildRecur({ recur: { type: 'monthly', day: 32, at: '08:00' } }, NOW).ok);
ok('validate: monthly last ok', buildRecur({ recur: { type: 'monthly', day: 'last', at: '08:00' } }, NOW).ok);
ok('validate: until garbage rejected', !buildRecur({ recur: { type: 'interval', every: 1, unit: 'hours', until: 'soon' } }, NOW).ok);
ok('validate: count 0 rejected', !buildRecur({ recur: { type: 'interval', every: 1, unit: 'hours', count: 0 } }, NOW).ok);

// ── computeFirstDue ──────────────────────────────────────────────────────────
eq('firstDue interval honors explicit due', computeFirstDue({ type: 'interval', every: 1, unit: 'hours' }, NOW + 2 * H, NOW), NOW + 2 * H);
{
  const fd = computeFirstDue({ type: 'monthly', day: 1, at: '08:00' }, NOW, NOW);
  eq('firstDue monthly snaps to next 1st', fd, Date.UTC(2026, 6, 1, 8, 0, 0));
}
{
  const fd = computeFirstDue({ type: 'weekly', days: ['mon', 'wed', 'fri'], at: '09:00' }, NOW, NOW);
  ok('firstDue weekly snaps to a wanted weekday 09:00 in the future', fd > NOW && [1, 3, 5].includes(new Date(fd).getUTCDay()) && new Date(fd).getUTCHours() === 9);
}

// ── humanizeRecur + legacyRepeatToken ────────────────────────────────────────
eq('humanize hourly', humanizeRecur({ type: 'interval', every: 1, unit: 'hours' }), 'every hour');
eq('humanize every 2 hours', humanizeRecur({ type: 'interval', every: 2, unit: 'hours' }), 'every 2 hours');
eq('humanize weekly', humanizeRecur({ type: 'weekly', days: ['mon', 'wed', 'fri'], at: '09:00' }), 'every Mon/Wed/Fri at 09:00 UTC');
eq('humanize monthly', humanizeRecur({ type: 'monthly', day: 1, at: '08:00' }), 'monthly on day 1 at 08:00 UTC');
eq('humanize with count', humanizeRecur({ type: 'interval', every: 1, unit: 'hours', count: 3 }), 'every hour (3×)');
eq('humanize one-shot', humanizeRecur(null), 'one-time');
eq('legacyToken daily', legacyRepeatToken({ type: 'interval', every: 1, unit: 'days' }), 'daily');
eq('legacyToken weekly', legacyRepeatToken({ type: 'interval', every: 1, unit: 'weeks' }), 'weekly');
eq('legacyToken custom', legacyRepeatToken({ type: 'interval', every: 2, unit: 'hours' }), 'custom');
eq('legacyToken none', legacyRepeatToken(null), 'none');

// ── skip_hours / skip_days ───────────────────────────────────────────────────
// All anchors/afters are explicit UTC instants so these stay clock-independent.
// Weekday map (UTC): Sun=0 Mon=1 Tue=2 Wed=3 Thu=4 Fri=5 Sat=6.
{
  // every 2h, nights skipped (00:00–07:00 + 23:00). Anchor Mon 08:00 keeps the
  // 2h cadence on even hours; from Mon 23:00 the next even step is Tue 00:00
  // (skipped) and the loop must advance past the night to Tue 08:00.
  const rec = { type: 'interval', every: 2, unit: 'hours', skip_hours: [0, 1, 2, 3, 4, 5, 6, 7, 23] };
  const anchor = Date.UTC(2026, 5, 15, 8, 0, 0);   // Mon 08:00
  const after = Date.UTC(2026, 5, 15, 23, 0, 0);   // Mon 23:00 (a skipped hour)
  const n = nextOccurrence(rec, anchor, after);
  eq('skip_hours: 2h cadence skips the night into next allowed hour', n, Date.UTC(2026, 5, 16, 8, 0, 0));
  ok('skip_hours: result hour is not in skip_hours', ![0, 1, 2, 3, 4, 5, 6, 7, 23].includes(new Date(n).getUTCHours()));
}
{
  // daily at 09:00, weekend skipped. Anchor Fri 09:00; from Fri 12:00 the next
  // slot is Sat 09:00 (skip) → Sun 09:00 (skip) → Mon 09:00.
  const rec = { type: 'interval', every: 1, unit: 'days', skip_days: ['sat', 'sun'] };
  const anchor = Date.UTC(2026, 5, 19, 9, 0, 0);   // Fri 2026-06-19 09:00
  const after = Date.UTC(2026, 5, 19, 12, 0, 0);   // Fri 12:00
  const n = nextOccurrence(rec, anchor, after);
  eq('skip_days: weekend slot advances to Monday', n, Date.UTC(2026, 5, 22, 9, 0, 0));
  eq('skip_days: lands on Monday (dow=1)', new Date(n).getUTCDay(), 1);
}
{
  // "co 2h, dni robocze 8–22": every 2h, skip nights (outside 08–22) AND weekends.
  // Anchor Mon 08:00; from Fri 22:00 the cadence rolls through Sat/Sun (both the
  // weekend days and their night hours are skipped) and lands on Mon 08:00.
  const rec = { type: 'interval', every: 2, unit: 'hours', skip_hours: [0, 1, 2, 3, 4, 5, 6, 7, 23], skip_days: ['sat', 'sun'] };
  const anchor = Date.UTC(2026, 5, 15, 8, 0, 0);   // Mon 08:00
  const after = Date.UTC(2026, 5, 19, 22, 0, 0);   // Fri 22:00 (last working slot of the week)
  const n = nextOccurrence(rec, anchor, after);
  eq('combined skip_hours+skip_days: weekend+night roll to Mon 08:00', n, Date.UTC(2026, 5, 22, 8, 0, 0));
  const d = new Date(n);
  ok('combined: result is a working day in the 08–22 window', d.getUTCDay() === 1 && d.getUTCHours() >= 8 && d.getUTCHours() <= 22);
}
{
  // weekly Wed 09:00 but Wed itself is skipped → no eligible slot exists in the
  // 365-day search window → null (engine never returns a skipped occurrence).
  const rec = { type: 'weekly', days: ['wed'], at: '09:00', skip_days: ['wed'] };
  ok('weekly: only wanted day skipped → null within 365-day bound', nextOccurrence(rec, NOW, NOW) === null);
}
{
  // weekly Mon/Wed/Fri 09:00 with Wed skipped: from Mon 12:00 NOW the next wanted
  // day is Wed (skipped) so it must advance to Fri, not silently fire on Wed.
  const rec = { type: 'weekly', days: ['mon', 'wed', 'fri'], at: '09:00', skip_days: ['wed'] };
  const n = nextOccurrence(rec, NOW, NOW);
  eq('weekly: skipped wanted day advances to next non-skipped wanted day (Fri)', n, Date.UTC(2026, 5, 19, 9, 0, 0));
  ok('weekly: never lands on a skipped weekday', new Date(n).getUTCDay() !== 3);
}
{
  // Pathological skip: every hour but ALL 24 hours skipped → the 1000-iteration
  // interval cap must terminate with null instead of looping forever.
  const all = []; for (let i = 0; i < 24; i++) all.push(i);
  const rec = { type: 'interval', every: 1, unit: 'hours', skip_hours: all };
  const t0 = Date.now();
  const n = nextOccurrence(rec, NOW, NOW);
  ok('interval cap: every hour fully skipped → null (no infinite loop)', n === null);
  ok('interval cap: returns promptly (cap, not hang)', Date.now() - t0 < 1000);
}
{
  // advanceReminder end-to-end honours skips: a daily reminder due Fri 09:00,
  // fired Fri 12:00, must roll its next due past the weekend to Monday.
  const r = { due: iso(Date.UTC(2026, 5, 19, 9, 0, 0)), recur: { type: 'interval', every: 1, unit: 'days', skip_days: ['sat', 'sun'] } };
  const adv = advanceReminder(r, Date.UTC(2026, 5, 19, 12, 0, 0));
  ok('advanceReminder honours skip_days (non-null)', adv !== null);
  eq('advanceReminder: daily skip-weekend next due = Mon', adv.due, iso(Date.UTC(2026, 5, 22, 9, 0, 0)));
  ok('advanceReminder: preserves skip_days on the carried recur', Array.isArray(adv.recur.skip_days) && adv.recur.skip_days.join(',') === 'sat,sun');
}

// ── DRIFT GUARD: monitor's inline copy must equal recur.cjs's shared block ────
{
  const START = '// <<<RECUR-SHARED-START>>>';
  const END = '// <<<RECUR-SHARED-END>>>';
  const extract = (txt, file) => {
    const a = txt.indexOf(START), b = txt.indexOf(END);
    if (a < 0 || b < 0) throw new Error(`sentinels not found in ${file}`);
    return txt.slice(a, b + END.length);
  };
  const lib = extract(readFileSync(join(HERE, 'recur.cjs'), 'utf8'), 'recur.cjs');
  const mon = extract(readFileSync(join(HERE, '..', '..', 'bot', 'reminder-monitor.sh'), 'utf8'), 'reminder-monitor.sh');
  ok('DRIFT GUARD: reminder-monitor.sh shared block == recur.cjs', lib === mon);
  if (lib !== mon) {
    const la = lib.split('\n'), ma = mon.split('\n');
    for (let i = 0; i < Math.max(la.length, ma.length); i++) {
      if (la[i] !== ma[i]) { console.log(`    first diff @ line ${i}:\n      recur.cjs: ${JSON.stringify(la[i])}\n      monitor:   ${JSON.stringify(ma[i])}`); break; }
    }
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
