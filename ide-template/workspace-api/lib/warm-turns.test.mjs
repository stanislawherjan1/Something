// Warm sessions (WARM_TURNS=1): a conversation's CLI process stays open between
// messages and the next one goes down its stdin; it ends when idle, when the
// session changes, on an error, and the cap keeps the operator's place.
// Run: node lib/warm-turns.test.mjs
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'warm-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'off';
process.env.WARM_TURNS = '1';
process.env.WARM_MAX = '1';
process.env.WARM_IDLE_MS = '1500';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'tom@example.test', role: 'admin', slug: 'tom', displayName: 'Tom', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
const SPAWNS = join(ROOT, 'spawns.log');
// A stand-in CLI: in stream-json input mode it answers every user line and
// stays until stdin closes; otherwise it answers the one message and exits.
const FAKE = join(ROOT, 'fake-claude.mjs');
writeFileSync(FAKE, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const streamIn = process.argv.includes('--input-format');
const ri = process.argv.indexOf('--resume');
const sid = ri > 0 ? process.argv[ri + 1] : 'S-' + process.pid;
appendFileSync(${JSON.stringify(SPAWNS)}, process.pid + ' ' + (streamIn ? 'stream' : 'once') + ' ' + sid + '\\n');
let buf = '';
let slow = null;
const answer = (text) => {
  const say = (s) => process.stdout.write(JSON.stringify({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n');
  if (/fail/.test(text)) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, session_id: sid, result: 'boom' }) + '\\n'); return; }
  if (/slowly/.test(text)) {
    // Thinking for a while: an interrupt control request ends it as the CLI does.
    say('thinking');
    slow = setTimeout(() => { slow = null; say(' done'); process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, result: '' }) + '\\n'); }, 1500);
    return;
  }
  say('pid ' + process.pid + ' says: ' + text.slice(-20));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, result: '' }) + '\\n');
};
const control = (req) => {
  if (req?.request?.subtype === 'interrupt') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: {} } }) + '\\n');
    if (slow) { clearTimeout(slow); slow = null; process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, result: '' }) + '\\n'); }
  }
};
process.stdin.on('data', (d) => {
  buf += d;
  if (!streamIn) return;
  let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const o = JSON.parse(line); if (o.type === 'control_request') control(o); else answer(o.message.content); } catch {} }
});
process.stdin.on('end', () => { if (!streamIn) { if (/slowly/.test(buf)) { const t = setInterval(() => {}, 1000); setTimeout(() => { clearInterval(t); answer(buf); process.exit(0); }, 1500); return; } answer(buf); } process.exit(0); });
`);
chmodSync(FAKE, 0o755);
process.env.CLAUDE_BIN = FAKE;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const spawns = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, 'utf8').trim().split('\n').filter(Boolean) : []);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { runClaudeTurn, warmStatus, endWarm } = await import('./claude.js');
const turn = (o) => new Promise((resolve) => {
  let text = '';
  const proc = runClaudeTurn({ onText: (t) => { text += t; }, onToolStart() {}, onToolEnd() {}, onImage() {}, onError: (e) => resolve({ error: String(e), text, proc }), onDone: (r) => resolve({ ...r, text, proc }), ...o });
});

// The operator's conversation: one process, two messages.
let r1 = await turn({ actor: 'tom', warmKey: 'tom:telegram', message: 'hello one' });
ok('the first message spawns a stream-json process and answers', spawns().length === 1 && /stream/.test(spawns()[0]) && /says: hello one/.test(r1.text) && r1.sessionId, { r1: r1.text, spawns: spawns() });
ok('…and the process stays, idle, on that session', warmStatus().length === 1 && warmStatus()[0].busy === false && warmStatus()[0].sessionId === r1.sessionId && r1.proc.exitCode === null, warmStatus());
let r2 = await turn({ actor: 'tom', warmKey: 'tom:telegram', sessionId: r1.sessionId, message: 'hello two' });
ok('the second message goes down the same process', spawns().length === 1 && /says: hello two/.test(r2.text) && r2.proc.pid === r1.proc.pid, { r2: r2.text, spawns: spawns() });

// Another person while the cap is 1: an ordinary one-turn process, the operator keeps the place.
let r3 = await turn({ actor: 'ann', warmKey: 'ann:telegram', message: 'hi from ann' });
ok('at the cap another conversation runs cold and the operator\'s process stays', spawns().length === 2 && /says: hi from ann/.test(r3.text) && warmStatus().length === 1 && warmStatus()[0].key === 'tom:telegram', { spawns: spawns(), warm: warmStatus() });
await sleep(100);
ok('…and the cold process has exited', r3.proc.exitCode !== null);

// A different session (the person started over): the old process goes, a new one comes.
let r4 = await turn({ actor: 'tom', warmKey: 'tom:telegram', sessionId: 'S-other', message: 'after restart' });
await sleep(100);
ok('a session change ends the old process and starts a fresh one on the new session', spawns().length === 3 && /S-other/.test(spawns()[2]) && r1.proc.exitCode !== null && r4.proc.pid !== r1.proc.pid, { spawns: spawns() });

// Idle: the process ends by itself after WARM_IDLE_MS.
await sleep(1900);
ok('an idle process ends after WARM_IDLE_MS', warmStatus().length === 0 && r4.proc.exitCode !== null, { warm: warmStatus(), code: r4.proc.exitCode });

// An error result ends the turn with onError and the process.
let r5 = await turn({ actor: 'tom', warmKey: 'tom:telegram', message: 'please fail' });
await sleep(100);
ok('an error result reaches onError and the process is let go', /boom/.test(r5.error || '') && warmStatus().length === 0, { r5: r5.error, warm: warmStatus() });

// Without the flag: one process per turn, as before.
delete process.env.WARM_TURNS;
const before = spawns().length;
let r6 = await turn({ actor: 'tom', warmKey: 'tom:telegram', message: 'cold again' });
await sleep(100);
ok('with WARM_TURNS off every turn is its own process', spawns().length === before + 1 && /once/.test(spawns().at(-1)) && r6.proc.exitCode !== null && /cold again/.test(r6.text), { spawns: spawns().slice(-2) });
process.env.WARM_TURNS = '1';

// An interruption: a warm turn is cut short by a control request, the process stays, the next message continues.
{
  let interrupted = 0;
  const t1 = (() => { let text = ''; let proc; const p = new Promise((resolve) => { proc = runClaudeTurn({ actor: 'tom', warmKey: 'tom:telegram', message: 'answer slowly please', onText: (t) => { text += t; }, onToolStart() {}, onToolEnd() {}, onImage() {}, onError: (e) => resolve({ error: String(e), text }), onDone: (r) => resolve({ ...r, text }), onInterrupted: () => { interrupted++; resolve({ interrupted: true, text }); } }); }); p.proc = () => proc; return p; })();
  await sleep(300);
  const info = t1.proc().turnInfo();
  ok('a running turn reports it is not over and what tools it started', info.finished === false && Array.isArray(info.tools) && info.tools.length === 0, info);
  ok('interruptTurn on a warm turn is accepted', t1.proc().interruptTurn() === true);
  const r1 = await t1;
  ok('…the turn ends as interrupted, with the text so far', r1.interrupted === true && interrupted === 1 && /thinking/.test(r1.text) && !/done/.test(r1.text), r1);
  ok('…and the process stays warm', warmStatus().length === 1 && warmStatus()[0].busy === false && t1.proc().exitCode === null, warmStatus());
  const r2 = await turn({ actor: 'tom', warmKey: 'tom:telegram', sessionId: warmStatus()[0].sessionId, message: 'and now?' });
  ok('the next message continues in the same process', /says: and now\?/.test(r2.text) && r2.proc.pid === t1.proc().pid, r2.text);
  ok('interrupting a finished turn is refused', t1.proc().interruptTurn() === false);
}
// An interruption of a one-turn (cold) process: it is ended, and reported as interrupted.
{
  delete process.env.WARM_TURNS;
  let cold; const p = new Promise((resolve) => { cold = runClaudeTurn({ actor: 'ann', message: 'answer slowly please', onText() {}, onToolStart() {}, onToolEnd() {}, onImage() {}, onError: (e) => resolve({ error: String(e) }), onDone: (r) => resolve(r), onInterrupted: () => resolve({ interrupted: true }) }); });
  await sleep(300);
  ok('a cold turn can be interrupted too', cold.interruptTurn() === true);
  const r = await p;
  ok('…it is reported as interrupted, not as a crash', r.interrupted === true, r);
  process.env.WARM_TURNS = '1';
}

// endWarm, for a /restart or shutdown.
await turn({ actor: 'tom', warmKey: 'tom:telegram', message: 'one more' });
ok('endWarm closes a warm process', endWarm('tom:telegram', 'test') === true && warmStatus().length === 0);

console.log(`warm-turns: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
