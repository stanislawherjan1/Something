/**
 * One sentence for a spent plan, on every surface, in the reader's language
 * and clock: the CLI's printed reset read into an instant, the hour said in
 * the person's zone (a room names the zone), a teammate's or a Slack direct
 * message told once per reset, a room in its own language. No model is called.
 *
 * Run: node lib/usage-limit.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'usage-limit-'));
process.env.PROJECT_DIR = ROOT;
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', timezone: 'Asia/Tokyo', preferredLanguage: 'Polish', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'mara@example.test', role: 'member', slug: 'mara', displayName: 'Mara', timezone: 'Europe/London', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, defaultTimezone: 'Europe/Warsaw' }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };
const U = await import('./usage-limit.js');
const { NOTICE } = await import('./i18n/limit-notice.js');
// The Polish sentence's fixed words, read from the table (no other language in tests).
const plHead = NOTICE.pl('§', '¤').split('§')[0].trim(), plAt = NOTICE.pl('§', '¤').split('§')[1].split('¤')[0].trim();

// ─── the printed reset → an instant ──────────────────────────────────────────
const now = Date.parse('2026-10-22T15:00:00Z');
const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
ok('"resets 6pm (UTC)" is today 18:00 UTC', iso(U.resetInstant("You've hit your weekly limit · resets 6pm (UTC)", now)) === '2026-10-22T18:00:00.000Z');
ok('a day named is that day', iso(U.resetInstant('resets Oct 23, 3am (UTC)', now)) === '2026-10-23T03:00:00.000Z');
ok('a zone named is that zone', iso(U.resetInstant('resets 18:00 (Europe/Warsaw)', now)) === '2026-10-22T16:00:00.000Z');
ok('a time already past today is tomorrow', iso(U.resetInstant('resets 9am (UTC)', now)) === '2026-10-23T09:00:00.000Z');
ok('nothing readable is nothing, never a guess', U.resetInstant('limit reached, try later', now) === null && U.resetInstant('resets 25:00 (UTC)', now) === null && U.resetInstant('resets 6pm (Mars/Olympus)', now) === null);

// ─── the sentence ────────────────────────────────────────────────────────────
const secs = Date.parse('2026-10-22T16:00:00Z') / 1000;
ok('the reader\'s own clock', U.limitNotice(secs, 'Aria', { tz: 'Asia/Tokyo' }) === 'Claude usage limit reached. Aria is back at 01:00.');
ok('a room names the zone', /back at 18:00 (CEST|GMT\+2)\./.test(U.limitNotice(secs, 'Aria', { tz: 'Europe/Warsaw', zoneLabel: true })), U.limitNotice(secs, 'Aria', { tz: 'Europe/Warsaw', zoneLabel: true }));
ok('in Polish for a Polish reader', U.limitNotice(secs, 'Aria', { tz: 'Europe/Warsaw', lang: 'pl' }) === NOTICE.pl('Aria', '18:00'));
ok('no reset known: says it comes back when the plan renews', /once the plan renews/.test(U.limitNotice(null, 'Aria')) && U.limitNotice(null, 'Aria', { lang: 'pl' }) === NOTICE.pl('Aria', null));
ok('a language preference in any spelling', U.noticeLang('Polish') === 'pl' && U.noticeLang('pl') === 'pl' && U.noticeLang('polski') === 'pl' && U.noticeLang('English') === 'en' && U.noticeLang(null) === 'en');
ok('the English sentence is recognised as a limit by the surfaces that re-say it', U.isUsageLimit(U.limitNotice(secs, 'X')) === true);
ok('the instant tag is read back', U.noticeResetsAt(`Claude usage limit reached. X is back at 18:00. [resets=${secs}]`) === secs && U.noticeResetsAt('nothing') === null);

// ─── a direct message (a teammate on Telegram, anyone on Slack): told once per reset ─
const { answerMemberDm } = await import('./integrations/member-dm.js');
const mara = { slug: 'mara', displayName: 'Mara', role: 'member', telegramChatId: '2220002' };
const stan = { slug: 'stan', displayName: 'Stan', role: 'admin', preferredLanguage: 'Polish' };
const sent = [];
const send = async (target, text) => { sent.push({ target, text }); return { ok: true }; };
const spent = async () => ({ text: '', sessionId: null, error: `Claude usage limit reached. Aria is back at 18:00. [resets=${secs}]` });
let r = await answerMemberDm(mara, 'hi', { runTurn: spent, send, surface: 'slack', target: 'D1' });
ok('a DM on a spent plan gets the sentence, in the person\'s clock', r.reason === 'limit' && sent.length === 1 && /back at 17:00\.$/.test(sent[0].text) && sent[0].target === 'D1', sent);
r = await answerMemberDm(mara, 'still there?', { runTurn: spent, send, surface: 'slack', target: 'D1' });
ok('...once: the next message during the same limit is not answered again', sent.length === 1 && r.reason === 'limit (told)', r);
r = await answerMemberDm(stan, 'hej', { runTurn: spent, send, surface: 'telegram', target: '1110001' });
ok('...a Polish reader in Polish, in their own zone', sent.length === 2 && (sent[1]?.text || '').startsWith(plHead) && (sent[1]?.text || '').endsWith(`${plAt} 01:00.`), sent[1]);
const crash = async () => ({ text: '', sessionId: null, error: 'claude exited with code 1 :: boom' });
r = await answerMemberDm(mara, 'x', { runTurn: crash, send, surface: 'slack', target: 'D1' });
ok('a crash is not a limit: nothing is said', r.reason === 'error' && sent.length === 2);

// ─── a room: its language, the zone named ────────────────────────────────────
const { __test } = await import('./integrations/group-watcher.js');
const roomEn = __test.failureNoticeText({ chatId: '-100777', title: 'Team' }, 'limit', `Claude usage limit reached. Aria is back at 23:00. [resets=${secs}]`);
ok('a room hears the same sentence, the hour with its zone', /^Claude usage limit reached\. .+ is back at 18:00 (CEST|GMT\+2)\.$/.test(roomEn), roomEn);
const roomPl = __test.failureNoticeText({ chatId: '-100777', title: 'Team', language: 'Polish' }, 'limit', "exit 1: You've hit your weekly limit · resets 6pm (UTC)");
ok('a Polish room in Polish, the hour from the CLI\'s printed reset', roomPl.startsWith(plHead) && / 20:00 (CEST|GMT\+2)\.$/.test(roomPl) && roomPl.includes(plAt), roomPl);

console.log(`usage-limit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
