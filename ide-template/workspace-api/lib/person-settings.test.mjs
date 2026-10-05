// A person's time zone and reply language (Settings, or the bot in auto mode),
// and the morning planning that follows their zone.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'person-settings-'));
process.env.PROJECT_DIR = ROOT;
delete process.env.IDE_TIMEZONE;
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'sam@example.com', role: 'admin', slug: 'sam', displayName: 'Sam' },
], null, 2));
const REM = join(ROOT, '.reminders.json');
const plan = () => JSON.parse(readFileSync(REM, 'utf8')).find(r => r.id === 'r_system_plan_day');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL', name, extra ?? ''); } };

const team = await import('./team.js');
const sched = await import('./planner-schedule.js');
const me = () => team.list().find(m => m.slug === 'sam');

// ── validation + defaults ────────────────────────────────────────────────────
ok('valid IANA zone', team.isValidTimezone('Europe/Warsaw'));
ok('unknown zone rejected', !team.isValidTimezone('Mars/Olympus'));
ok('defaults: unlocked, no own zone', !me().timezoneLocked && !me().languageLocked && !me().timezone);
ok('effective zone falls back to UTC', team.effectiveTimezone('sam') === 'UTC');
team.setDefaultTimezone('Asia/Tokyo', 'sam@example.com');
ok('admin default wins over UTC', team.effectiveTimezone('sam') === 'Asia/Tokyo');

// ── unlocked: the bot changes it when asked ──────────────────────────────────────
let r = team.setPreferences('sam@example.com', { timezone: 'Europe/Warsaw', preferredLanguage: 'Polish' }, { by: 'bot', from: 'said they are home in Warsaw' });
ok('bot sets zone + language when unlocked', r.changed.includes('timezone') && r.changed.includes('preferredLanguage') && !r.refused.length, r);
ok('bot change records where it came from', me().timezone === 'Europe/Warsaw' && /Warsaw/.test(me().timezoneFrom || ''));
let threw = false;
try { team.setPreferences('sam@example.com', { timezone: 'Nowhere/Land' }, { by: 'bot' }); } catch { threw = true; }
ok('bot cannot store an unknown zone', threw && me().timezone === 'Europe/Warsaw');

// ── locked: the person fixed it, the bot can't change it ────────────────────
team.setPreferences('sam@example.com', { timezoneLocked: true, timezone: 'America/New_York' }, { by: 'user' });
ok('person sets + locks the zone', me().timezoneLocked && me().timezone === 'America/New_York' && me().timezoneFrom === 'Settings');
r = team.setPreferences('sam@example.com', { timezone: 'Europe/Warsaw' }, { by: 'bot' });
ok('bot refused on a locked zone', r.refused.includes('timezone') && me().timezone === 'America/New_York', r);
r = team.setPreferences('sam@example.com', { timezoneLocked: false }, { by: 'bot' });
ok('bot cannot unlock', !r.changed.includes('timezoneLocked') && me().timezoneLocked);
team.setPreferences('sam@example.com', { languageLocked: true }, { by: 'user' });
r = team.setPreferences('sam@example.com', { preferredLanguage: 'German' }, { by: 'bot' });
ok('language: bot refused when locked', r.refused.includes('preferredLanguage') && me().preferredLanguage === 'Polish', me());
r = team.setPreferences('sam@example.com', { preferredLanguage: 'German' }, { by: 'user' });
ok('the person still changes a locked value', me().preferredLanguage === 'German');

// ── 06:00 local, DST-safe ────────────────────────────────────────────────────
const iso = (d) => d.toISOString();
ok('Warsaw summer → 04:00Z', iso(sched.nextLocalHour('Europe/Warsaw', 6, new Date('2026-07-10T03:00:00Z'))) === '2026-07-10T04:00:00.000Z');
ok('Warsaw winter → 05:00Z', iso(sched.nextLocalHour('Europe/Warsaw', 6, new Date('2026-11-10T03:00:00Z'))) === '2026-11-10T05:00:00.000Z');
ok('across the DST change', iso(sched.nextLocalHour('Europe/Warsaw', 6, new Date('2026-10-24T12:00:00Z'))) === '2026-10-25T05:00:00.000Z');
ok('Tokyo, past 06:00 → tomorrow', iso(sched.nextLocalHour('Asia/Tokyo', 6, new Date('2026-07-10T02:00:00Z'))) === '2026-07-10T21:00:00.000Z');

// ── the plan row follows the person (solo: the generic row is the admin's) ──
writeFileSync(REM, JSON.stringify([{ id: 'r_system_plan_day', due: '2026-07-11T06:00:00.000Z', status: 'pending' }], null, 2));
const now = new Date('2026-07-10T12:00:00Z');
sched.reschedulePlanFor('sam', now);   // America/New_York (locked, above)
ok('plan row moved to 06:00 New York', plan().due === '2026-07-11T10:00:00.000Z', plan());
writeFileSync(REM, JSON.stringify([{ id: 'r_system_plan_day', due: '2026-07-10T11:00:00.000Z', status: 'pending' }], null, 2));
sched.reschedulePlanFor('sam', now);
ok('a due already passed is left to fire', plan().due === '2026-07-10T11:00:00.000Z', plan());

// ── the bot's endpoint ──────────────────────────────────────────────────────
team.setPreferences('sam@example.com', { timezoneLocked: false }, { by: 'user' });
const { issueTurnToken } = await import('./turn-identity.js');
const { default: internalRouter } = await import('../routes/internal.js');
const app = express(); app.use(express.json()); app.use('/api', internalRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const post = (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/internal/me/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const groupTok = issueTurnToken({ actor: 'sam', group: true, groupId: '-1001234' });
let res = await post({ timezone: 'Europe/Lisbon' }, { 'x-ide-turn': groupTok, 'x-ide-actor': 'sam' });
ok('refused in a group conversation', res.status === 403 && me().timezone !== 'Europe/Lisbon');
const dmTok = issueTurnToken({ actor: 'sam' });
res = await post({ timezone: 'Europe/Lisbon', why: 'moved to Lisbon' }, { 'x-ide-turn': dmTok, 'x-ide-actor': 'sam' });
let body = await res.json();
ok('DM: bot updates the zone', res.ok && body.changed.includes('timezone') && me().timezone === 'Europe/Lisbon', body);
res = await post({ language: 'German' }, { 'x-ide-turn': dmTok, 'x-ide-actor': 'sam' });
body = await res.json();
ok('DM: locked language refused, with a note', res.ok && body.refused.includes('preferredLanguage') && body.note, body);
server.close();

// Old zone names Debian no longer ships (Asia/Calcutta): `TZ=Asia/Calcutta date` printed UTC
// and the morning planner thought it was 23:00. Stored, and read back, by the current name.
{
  const T = await import('./team.js');
  // A tzdata.zi of our own: the test does not depend on the machine's.
  const zi = join(ROOT, 'tzdata.zi');
  writeFileSync(zi, 'Z Europe/Kyiv 2:2:4 - LMT 1880\nL Europe/Kyiv Europe/Kiev\nL Asia/Kolkata Asia/Calcutta\n');
  process.env.TZDATA_ZI = zi;
  ok('an old zone name is stored by its current name (from tzdata\'s own links)', T.canonicalTimezone('Europe/Kiev') === 'Europe/Kyiv' && T.canonicalTimezone('Asia/Calcutta') === 'Asia/Kolkata' && T.canonicalTimezone('Europe/Warsaw') === 'Europe/Warsaw');
}
const C2 = await import('./claude.js');
{
  const card = C2.settingsCard('nobody-here');
  ok('the settings card says the local time, so a run never guesses the hour', /it was \w+day, \d{1,2} \w+ \d{4}/.test(card) || card === '', card);
}

console.log(`person-settings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
