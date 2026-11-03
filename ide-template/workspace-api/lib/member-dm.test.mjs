/**
 * A teammate's Telegram DM is answered by a turn as that teammate: the
 * conversation resumes from message to message, a lost session starts over
 * once, a silent or self-sent reply is not sent again, and messages from one
 * person are answered in order. The turn and the send are injected.
 * Run: node lib/member-dm.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'member-dm-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'member-dm-store-'));
process.env.MEMBER_DM_QUIET_MS = '40';   // the burst window, short for the test
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', telegramChatId: '2220002', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const { answerMemberDm, startMemberDm } = await import('./integrations/member-dm.js');
const { listSessions } = await import('./sessions.js');
const { readUndelivered } = await import('./chatHistory.js');
const ann = { slug: 'ann', displayName: 'Ann', role: 'member', telegramChatId: '2220002' };

const turns = [], sends = [];
let script = [];
const runTurn = async (p) => { turns.push(p); return script.shift() || { text: 'hello', sessionId: 'S1' }; };
const send = async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; };

script = [{ text: 'Hi Ann, what can I do?', sessionId: 'S1' }];
let r = await answerMemberDm(ann, 'hello?', { runTurn, send });
ok('the reply is sent to the member on Telegram', r.delivered && sends[0]?.chatId === '2220002' && /Hi Ann/.test(sends[0].text), sends);
ok('the turn ran as the member, with no session yet', turns[0].member.slug === 'ann' && turns[0].sessionId === null);
const sessFile = join(ROOT, '.team/users/ann/telegram-session.json');
ok('the session is kept in the member\'s private tree', existsSync(sessFile) && JSON.parse(readFileSync(sessFile, 'utf8')).sessionId === 'S1');

script = [{ text: 'Sure.', sessionId: 'S1' }];
await answerMemberDm(ann, 'thanks', { runTurn, send });
ok('the next message resumes that session', turns[1].sessionId === 'S1');

script = [{ text: '', sessionId: null, error: 'claude exited with code 1 :: No conversation found with session ID S1' }, { text: 'Starting over.', sessionId: 'S2' }];
await answerMemberDm(ann, 'still there?', { runTurn, send });
ok('a lost session is replaced after one fresh retry', turns[2].sessionId === 'S1' && turns[3].sessionId === null && JSON.parse(readFileSync(sessFile, 'utf8')).sessionId === 'S2');
ok('...and the fresh reply is delivered', sends.at(-1).text === 'Starting over.');

const before = sends.length;
script = [{ text: '[[SILENT]]', sessionId: 'S2' }];
r = await answerMemberDm(ann, 'ok', { runTurn, send });
ok('a silent reply is not sent', !r.delivered && sends.length === before);
// A reaction marker is done and removed; a silent line after it is still silence.
const reactions = [];
const react = async (e) => { reactions.push(e); return { ok: true }; };
script = [{ text: '[[REACT 🫡]]\n[[SILENT]]', sessionId: 'S2' }];
r = await answerMemberDm(ann, 'thanks!', { runTurn, send, react });
ok('[[REACT e]] reacts on the message and nothing is sent', r.reason === 'reaction' && reactions[0] === '🫡' && sends.length === before, { r, reactions, last: sends.at(-1) });
script = [{ text: '[[REACT 👀]]\nOn it, give me a minute.', sessionId: 'S2' }];
r = await answerMemberDm(ann, 'can you check?', { runTurn, send, react });
ok('a reaction beside text: both, and the marker is gone from the text', reactions[1] === '👀' && sends.at(-1).text === 'On it, give me a minute.', sends.at(-1));
script = [{ text: 'Noted.\n[[SEND]]\n[[SILENT]]', sessionId: 'S2' }];
const b2 = sends.length;
r = await answerMemberDm(ann, 'noted?', { runTurn, send, react });
ok('a silent line anywhere means silence; stray markers never reach the chat', !r.delivered && sends.length === b2, r);
script = [{ text: '[[REACT 👍]] thanks', sessionId: 'S2' }];
r = await answerMemberDm(ann, 'k', { runTurn, send });
ok('with no way to react, the marker is just dropped', sends.at(-1).text === 'thanks' && !/REACT/.test(sends.at(-1).text));
const b3 = sends.length;
script = [{ text: 'Done, I told them.', sessionId: 'S2', sentItself: true }];
r = await answerMemberDm(ann, 'tell stan hi', { runTurn, send });
ok('a reply the model already sent itself is not sent again', r.delivered && sends.length === b3);

const web = listSessions('ann').find(s => s.title === 'Telegram');
ok('the exchange is recorded in the member\'s web history', !!web && readUndelivered('ann', web.id, 0).messages.filter(m => m.role === 'assistant').length >= 2);

// a burst is one turn; what arrives during a turn is the next turn, in order
let order = [];
const slowTurn = async (p) => { await new Promise(r => setTimeout(r, 120)); order.push(p.body); return { text: `re: ${p.body}`, sessionId: 'S2' }; };
const sendsBefore = sends.length;
const burst = await Promise.all([startMemberDm(ann, 'first', { runTurn: slowTurn, send }), startMemberDm(ann, 'second', { runTurn: slowTurn, send })]);
ok('two messages sent together are one turn, in order, with one reply', order.length === 1 && order[0] === 'first\n\nsecond' && sends.length === sendsBefore + 1 && burst.every(r => r.delivered), { order, burst });
order = [];
const p1 = startMemberDm(ann, 'one', { runTurn: slowTurn, send });
await new Promise(r => setTimeout(r, 70));          // the turn for "one" is running
const p2 = startMemberDm(ann, 'two', { runTurn: slowTurn, send });
const p3 = startMemberDm(ann, 'three', { runTurn: slowTurn, send });
await Promise.all([p1, p2, p3]);
ok('messages that arrive during a turn wait and become the next turn together', order.join(' | ') === 'one | two\n\nthree', order);

// the Slack surface: its own session, its own web chat, the reply into the Slack conversation
const slackSends = [];
const slackSend = async (target, text) => { slackSends.push({ target, text }); return { ok: true }; };
script = [{ text: 'Hi from Slack.', sessionId: 'K1' }];
r = await answerMemberDm(ann, 'hello from slack', { runTurn, send: slackSend, surface: 'slack', target: 'D123' });
ok('a Slack DM is answered into the Slack conversation it came from', r.delivered && r.reason === 'slack' && slackSends[0]?.target === 'D123' && slackSends[0].text === 'Hi from Slack.', slackSends);
ok('the Slack session is kept apart from the Telegram one', existsSync(join(ROOT, '.team/users/ann/slack-session.json')) && JSON.parse(readFileSync(join(ROOT, '.team/users/ann/slack-session.json'), 'utf8')).sessionId === 'K1' && JSON.parse(readFileSync(sessFile, 'utf8')).sessionId === 'S2');
ok('the turn is told which surface it is on', turns.at(-1).surface === 'slack' && turns.at(-1).sessionId === null);
const slackWeb = listSessions('ann').find(s => s.title === 'Slack');
const slackMsgs = slackWeb ? readUndelivered('ann', slackWeb.id, 0).messages : [];
ok('the exchange is recorded in a "Slack" chat in the web history, the person\'s line marked as Slack', !!slackWeb && slackMsgs.some(m => m.role === 'user' && m.kind === 'slack') && slackMsgs.some(m => m.role === 'assistant' && m.delivery?.channel === 'slack' && m.delivery.slackChannel === 'D123'), slackMsgs);
// a file the reply hands over: attached, the marker gone; a path outside the project is refused in words
mkdirSync(join(ROOT, 'Reports'), { recursive: true });
writeFileSync(join(ROOT, 'Reports', 'audit.md'), '# audit\n');
const filesSent = [];
const sendFile = async (target, f) => { filesSent.push({ target, name: f.name, abs: f.abs }); return { ok: true }; };
script = [{ text: 'Saved it as Reports/audit.md — here it is.\n[[SEND_FILE Reports/audit.md]]', sessionId: 'K1' }];
r = await answerMemberDm(ann, 'send me the audit', { runTurn, send: slackSend, sendFile, surface: 'slack', target: 'D123' });
ok('a [[SEND_FILE]] in the reply attaches the file into the conversation', r.delivered && filesSent.length === 1 && filesSent[0].target === 'D123' && filesSent[0].name === 'audit.md' && filesSent[0].abs.endsWith('/Reports/audit.md'), filesSent);
ok('...and the marker is gone from the text', slackSends.at(-1).text === 'Saved it as Reports/audit.md — here it is.', slackSends.at(-1));
script = [{ text: '[[SEND_FILE ../../etc/passwd]]', sessionId: 'K1' }];
r = await answerMemberDm(ann, 'send /etc/passwd', { runTurn, send: slackSend, sendFile, surface: 'slack', target: 'D123' });
ok('a path outside the project is not sent, and the person is told', filesSent.length === 1 && /couldn't attach/.test(slackSends.at(-1).text), slackSends.at(-1));
script = [{ text: '[[SEND_FILE Reports/audit.md]]', sessionId: 'K1' }];
const n0 = slackSends.length;
r = await answerMemberDm(ann, 'just the file', { runTurn, send: slackSend, sendFile, surface: 'slack', target: 'D123' });
ok('a file alone is delivered with no empty message after it', r.delivered && filesSent.length === 2 && slackSends.length === n0, r);
ok('an unknown surface name falls back to Telegram', (await import('./integrations/member-dm.js')).surfaceOf('fax') === 'telegram');

console.log(`member-dm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
