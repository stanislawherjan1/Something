/**
 * What the next plan learns: per routine, how the planner's reminders landed —
 * the run's outcome, whether the person wrote back within two hours (web chat
 * or Telegram), and routines they removed. An info reminder's silence is never
 * read as "ignored".
 *
 * Run: node lib/planner-feedback.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'pfb-'));
const STORE = mkdtempSync(join(tmpdir(), 'pfb-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.TELEGRAM_LOG_PATH = join(STORE, 'conversation.jsonl');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };

mkdirSync(join(ROOT, '.team', 'users', 'ann', 'chats'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', telegramChatId: '2220002', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

const NOW = Date.parse('2026-10-16T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600_000).toISOString();
const sent = (id, routine, kind, hoursAgo, extra = {}) => ({ id, kind: 'user', origin: 'planner', kind_of: kind, routine, title: routine, status: 'sent', settledAt: at(hoursAgo), due: at(hoursAgo), recipients: ['ann'], ...extra });
writeFileSync(join(ROOT, '.reminders.json'), JSON.stringify([
  sent('w1', 'Weather', 'info', 30), sent('w2', 'Weather', 'info', 54), sent('w3', 'Weather', 'info', 78),
  sent('a1', 'Client follow-up', 'action', 26), sent('a2', 'Client follow-up', 'action', 50), sent('a3', 'Client follow-up', 'action', 74),
  sent('old', 'Weather', 'info', 24 * 10),                                   // outside the week
  sent('k1', 'Kai brief', 'info', 20, { recipients: ['kai'] }),            // someone else's
  { id: 'mine', kind: 'user', title: 'Call the dentist', status: 'sent', settledAt: at(5), recipients: ['ann'] },  // her own, not the planner's
  sent('s1', 'suggest:Granola for meeting notes', 'info', 24 * 12),
  { id: 's2', kind: 'user', origin: 'planner', routine: 'suggest:Weekly plan routine', title: 'Offer the weekly plan', status: 'pending', due: at(-5), recipients: ['ann'] },
]));
// She answered one follow-up on the web (30 min after) and one on Telegram (90 min after); never after the weather.
writeFileSync(join(ROOT, '.team', 'users', 'ann', 'chats', 's1.jsonl'), JSON.stringify({ ts: at(25.5), role: 'user', text: 'Sent it, thanks.' }) + '\n');
writeFileSync(process.env.TELEGRAM_LOG_PATH, JSON.stringify({ ts: at(48.5), direction: 'inbound', chat_id: '2220002', text: 'ok done' }) + '\n');
// She removed a routine three days ago.
mkdirSync(join(ROOT, '.team', 'users', 'ann'), { recursive: true });
writeFileSync(join(ROOT, '.team', 'users', 'ann', 'routines.json'), JSON.stringify({ version: 1, routines: [
  { id: 'r1', title: 'Weekend ideas', description: 'x', retired: true, updatedAt: at(72) },
], unparsed: [] }));

const { recordOutcome, plannerFeedback } = await import('./planner-feedback.js');
recordOutcome({ id: 'w1', slug: 'ann', outcome: 'said' });
recordOutcome({ id: 'w2', slug: 'ann', outcome: 'silent' });
recordOutcome({ id: 'a1', slug: 'ann', outcome: 'said' });
const text = plannerFeedback('ann', { now: NOW });

ok('there is a summary for her', /How the plan's reminders landed for them \(last 7 days\)/.test(text), text);
ok('the weather is info, counted for the week only', /Weather \(info\): 3 fired/.test(text), text);
ok('...its silence is not read as ignored', /No reply is expected/.test(text) && !/Weather[^\n]*wrote within/.test(text), text);
ok('what the runs did is counted', /Weather[^\n]*spoke 1×, stayed silent 1×/.test(text), text);
ok('a follow-up counts a reply on the web and on Telegram', /Client follow-up \(action\): 3 fired[^\n]*wrote within 2 h after 2 of them/.test(text), text);
ok("someone else's and her own reminders are not in it", !/Kai brief|dentist/.test(text), text);
ok('a routine she removed is told', /removed the routine "Weekend ideas"/.test(text), text);
ok('suggestions are listed, fired and still to come, to never repeat them', /never offer these again[\s\S]*Granola for meeting notes[\s\S]*Weekly plan routine \([^)]*still to come\)/.test(text), text);
ok('...and are not counted as routines', !/suggest:/.test(text), text);
ok('nothing to tell, nothing said', plannerFeedback('kai', { now: NOW + 30 * 86400_000 }) === '');

console.log(`planner-feedback: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
