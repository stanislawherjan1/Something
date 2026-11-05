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
process.env.MEMBER_DM_RETRY_MS = '10';
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
// A passing fault on the model's side is tried once more; a real failure is not.
script = [{ text: '', sessionId: 'S2', error: 'claude: API Error: 500 Internal server error. This is a server-side issue, usually temporary' }, { text: 'Back again.', sessionId: 'S2' }];
const turnsBefore = turns.length;
r = await answerMemberDm(ann, 'still there?', { runTurn, send });
ok('a 500 from the model is retried once and the second answer is delivered', turns.length === turnsBefore + 2 && r.delivered && sends.at(-1).text === 'Back again.', { r, n: turns.length - turnsBefore });
script = [{ text: '', sessionId: 'S2', error: 'claude exited with code 2 :: something else broke' }];
const t2 = turns.length;
r = await answerMemberDm(ann, 'and now?', { runTurn, send });
ok('another error is not retried', turns.length === t2 + 1 && r.reason === 'error', { r, n: turns.length - t2 });
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
ok('messages that arrive during a turn wait and become the next turn together, as a follow-up', order.length === 2 && order[0] === 'one' && /^\[FOLLOW-UP\]/.test(order[1]) && /two\n\nthree/.test(order[1]), order);

// like a colleague: a message while the turn still thinks stops it, and one reply covers both;
// one while a tool with an effect runs waits and comes as a follow-up
{
  const log = [];
  // A fake turn that can be interrupted while "thinking" (no tools), unless told it started a side effect.
  const thinkingTurn = (opts = {}) => (p) => {
    let done = false, stop = null;
    const pr = new Promise((resolve) => {
      log.push(`start:${p.body.slice(0, 40).replace(/\n/g, ' ')}`);
      const t = setTimeout(() => { done = true; resolve({ text: `re: ${p.body.slice(0, 20)}`, sessionId: 'S2' }); }, 150);
      stop = () => { if (done || opts.sideEffect) return false; clearTimeout(t); done = true; log.push('interrupted'); resolve({ interrupted: true, text: '', sessionId: 'S2' }); return true; };
    });
    pr.interrupt = () => stop();
    return pr;
  };
  const before = sends.length;
  const run = thinkingTurn();
  const a1 = startMemberDm(ann, 'what is the plan for Friday?', { runTurn: run, send });
  await new Promise(r => setTimeout(r, 60));          // past the window: the turn is thinking
  const a2 = startMemberDm(ann, 'and Saturday?', { runTurn: run, send });
  await Promise.all([a1, a2]);
  ok('a message while the turn thinks stops it and one turn answers both, as a continuation', log.length === 3 && log[0] === 'start:what is the plan for Friday?' && log[1] === 'interrupted' && /^start:\[CONTINUED\]/.test(log[2]), log);
  ok('…the stopped turn sent nothing, the continuation did', sends.length === before + 1 && /CONTINUED/.test(sends.at(-1).text), sends.at(-1));
  log.length = 0;
  const busy = thinkingTurn({ sideEffect: true });
  const c1 = startMemberDm(ann, 'send the deck to Tom', { runTurn: busy, send });
  await new Promise(r => setTimeout(r, 60));
  const c2 = startMemberDm(ann, 'and cc Ola', { runTurn: busy, send });
  await Promise.all([c1, c2]);
  ok('a message while a tool with an effect runs waits, then comes as a follow-up', log.length === 2 && log[0] === 'start:send the deck to Tom' && /^start:\[FOLLOW-UP\]/.test(log[1]), log);
}

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
