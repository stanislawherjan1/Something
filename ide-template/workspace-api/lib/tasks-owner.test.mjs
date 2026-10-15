// A new task with no owner named is the person asking's: the signed-in
// person in the browser, the person whose turn the bot runs on loopback.
// A group's turn, an explicit null and a stranger leave it unowned.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
const ROOT = mkdtempSync(join(tmpdir(), 'tasks-owner-'));
process.env.PROJECT_DIR = ROOT;
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
writeFileSync(join(ROOT, '.tasks.json'), '[]');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL', name, extra ?? ''); } };
const { default: tasksRouter } = await import('../routes/tasks.js');
const { issueTurnToken } = await import('./turn-identity.js');
const app = express();
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', tasksRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/tasks`;
const add = async (headers, body) => (await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).json()).task;
const annTurn = issueTurnToken({ actor: 'ann' });
const groupTurn = issueTurnToken({ actor: 'ann', group: true, groupId: '-100777' });
ok('browser: the signed-in person owns it', (await add({ 'x-test-actor': 'stan@example.test' }, { title: 'A' })).owner === 'stan');
ok('bot, on a person\'s turn: that person owns it', (await add({ 'x-ide-turn': annTurn }, { title: 'B' })).owner === 'ann');
ok('...unless someone else is named', (await add({ 'x-ide-turn': annTurn }, { title: 'C', owner: 'stan' })).owner === 'stan');
ok('...or nobody, on purpose', (await add({ 'x-ide-turn': annTurn }, { title: 'D', owner: null })).owner === null);
ok('a group\'s turn is nobody\'s', (await add({ 'x-ide-turn': groupTurn }, { title: 'E' })).owner === null);
ok('no identity at all: unowned', (await add({}, { title: 'F' })).owner === null);
ok('a name off the roster is dropped', (await add({ 'x-ide-turn': annTurn }, { title: 'G', owner: 'nobody' })).owner === null);
ok('all seven on the board', JSON.parse(readFileSync(join(ROOT, '.tasks.json'), 'utf8')).length === 7);

// ── done → the memory fact that carried the task is retired ─────────────────
process.env.MEMORY_V4 = 'on';
const F = await import('./memory-facts.js');
const ts = '2026-10-10T10:00:00Z';
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Deck for Orbis', text: 'Ann will prepare the deck for Orbis by Friday.', kind: 'status' } }], { record: 'r1', standing: 'said', by: 'web', ts });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Orbis contract', text: 'Orbis signed a two-year contract in September.', kind: 'fact' } }], { record: 'r2', standing: 'said', by: 'web', ts });
await F.apply('shared', [{ op: 'add', fact: { title: 'Deck for Orbis', text: 'The team owes Orbis a deck; Ann will prepare the deck for Orbis.', kind: 'fact' } }], { record: 'r3', standing: 'said', by: 'web', ts });
await F.apply('user:stan', [{ op: 'add', fact: { title: 'Stan deck', text: 'Stan also wants to prepare the deck for Orbis for his own pitch.', kind: 'fact' } }], { record: 'r4', standing: 'said', by: 'web', ts });
const deck = await add({ 'x-ide-turn': annTurn }, { title: 'Prepare the deck for Orbis' });
const patch = async (id, body, headers = {}) => (await fetch(`${url}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).json();
let r = await patch(deck.id, { status: 'in_progress' }, { 'x-ide-turn': annTurn });
ok('moving a task along retires nothing', !r.retiredFacts && F.all('user:ann').every(f => !f.retired));
r = await patch(deck.id, { status: 'done' }, { 'x-ide-turn': annTurn });
const annFacts = F.all('user:ann');
ok('done: the fact that carried the task is retired, with why', r.retiredFacts === 2 && annFacts.find(f => f.title === 'Deck for Orbis')?.retired && annFacts.find(f => f.title === 'Deck for Orbis')?.retiredWhy === 'done on the task board', r);
ok('...a fact about the same client that is not the task stays', !annFacts.find(f => f.title === 'Orbis contract')?.retired);
ok('...the team\'s copy goes too', F.all('shared').find(f => f.title === 'Deck for Orbis')?.retired);
ok('...another person\'s private memory is not touched', !F.all('user:stan')[0]?.retired);
r = await patch(deck.id, { status: 'done' }, { 'x-ide-turn': annTurn });
ok('done again retires nothing more', !r.retiredFacts);
const tiny = await add({ 'x-ide-turn': annTurn }, { title: 'Deck' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Deck style', text: 'Ann likes a dark deck style.', kind: 'preference' } }], { record: 'r5', standing: 'said', by: 'web', ts });
r = await patch(tiny.id, { status: 'done' }, { 'x-ide-turn': annTurn });
ok('a short title matches nothing (too easy to hit by accident)', !r.retiredFacts && !F.all('user:ann').find(f => f.title === 'Deck style')?.retired);

// ── a task linked to the fact it came from ──────────────────────────────────
const L = await import('./memory-ledger.js');
const rec = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-11T09:00:00Z', text: 'Ann: Orbis asked for a pricing sheet by the 20th.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Orbis pricing sheet request', text: 'Orbis asked Ann for a pricing sheet by 20 October.', kind: 'status', about: 'deadline', when: '2026-10-20' } }], { record: rec.id, standing: 'said', by: 'web', ts: '2026-10-11T09:00:00Z' });
const pricingFact = F.all('user:ann').find(f => f.title === 'Orbis pricing sheet request');
let t1 = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ide-turn': annTurn }, body: JSON.stringify({ title: 'Send Orbis the pricing sheet', record: rec.id }) })).json();
ok('link by the excerpt id: the task points at the fact', t1.link === 'linked' && t1.task.fact?.id === pricingFact.id && t1.task.fact.title === 'Orbis pricing sheet request', t1);
ok('...and the fact points at the task', F.get('user:ann', pricingFact.id)?.task?.id === t1.task.id && F.get('user:ann', pricingFact.id).task.title === 'Send Orbis the pricing sheet');
let t2 = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ide-turn': annTurn }, body: JSON.stringify({ title: 'Follow up on the pricing sheet', fact: pricingFact.id }) })).json();
ok('link by the fact id works too', t2.link === 'linked' && t2.task.fact?.id === pricingFact.id);
ok('...the fact now points at the newer task', F.get('user:ann', pricingFact.id)?.task?.id === t2.task.id);
r = await patch(t2.id ?? t2.task.id, { fact: null }, { 'x-ide-turn': annTurn });
ok('unlinking clears both sides', r.link === 'cleared' && !r.task.fact && F.get('user:ann', pricingFact.id)?.task == null);
r = await patch(t1.task.id, { title: 'Send Orbis the final pricing sheet' }, { 'x-ide-turn': annTurn });
r = await patch(t1.task.id, { fact: pricingFact.id }, { 'x-ide-turn': annTurn });
ok('a renamed task carries its new title into the fact', F.get('user:ann', pricingFact.id)?.task?.title === 'Send Orbis the final pricing sheet');
const stanFact = F.all('user:stan')[0];
r = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ide-turn': annTurn }, body: JSON.stringify({ title: 'Peek at Stan', fact: stanFact.id }) })).json();
ok('another person\'s private fact cannot be linked', r.link === 'not found' && !r.task.fact && !F.get('user:stan', stanFact.id)?.task);
r = await patch(t1.task.id, { status: 'done' }, { 'x-ide-turn': annTurn });
ok('done: the linked fact is closed even though the title differs', r.retiredFacts === 1 && F.get('user:ann', pricingFact.id)?.retired && F.get('user:ann', pricingFact.id).retiredWhy === 'done on the task board', r);

// ── a private fact's title stays with its owner on the shared board ─────────
const stanTurn = issueTurnToken({ actor: 'stan' });
const boardAs = async (h) => (await (await fetch(url, { headers: h })).json()).tasks;
const linkedT = (await boardAs({ 'x-ide-turn': annTurn })).find(t => t.fact?.id === pricingFact.id);
ok('the owner sees the private fact on the board', linkedT?.fact?.title === 'Orbis pricing sheet request', linkedT?.fact);
const asStan = (await boardAs({ 'x-ide-turn': stanTurn })).find(t => t.id === linkedT?.id);
ok('...a teammate sees only that it has a source', asStan?.fact?.private === true && !asStan.fact.title && !asStan.fact.id, asStan?.fact);

// ── the audit: no lost writes, no probing or changing someone else's memory ──
const many = await Promise.all(Array.from({ length: 12 }, (_, i) => add({ 'x-ide-turn': annTurn }, { title: `Parallel ${i}` })));
const onBoard = JSON.parse(readFileSync(join(ROOT, '.tasks.json'), 'utf8'));
ok('twelve creates at once: all twelve are on the board', many.every(t => t?.id) && many.every(t => onBoard.some(x => x.id === t.id)), onBoard.length);
await F.apply('user:stan', [{ op: 'add', fact: { title: 'Stan private plan', text: 'Stan plans to leave the Orbis account quietly in December.', kind: 'status', about: 'deadline', when: '2026-12-01' } }], { record: 'r-stan', standing: 'said', by: 'web', ts });
const probe = await add({ 'x-ide-turn': annTurn }, { title: 'Leave the Orbis account quietly in December', owner: 'stan', status: 'done' });
ok('a done task on Stan\'s behalf neither closes nor reveals Stan\'s private fact', !probe.retiredFacts && !F.all('user:stan').find(f => f.title === 'Stan private plan')?.retired, probe);
F.apply('group:-100777', [{ op: 'add', fact: { title: 'Group launch decision', text: 'The group decided to launch on Monday.', kind: 'fact' } }], { record: 'r-g', standing: 'said', by: 'group', ts });
const T = await import('./tasks.js');
const gf = (await new Promise(r => setTimeout(r, 50)), F.all('group:-100777')[0]);
T.writeTasks([...T.readTasks(), { id: 't_group', title: 'Launch', status: 'backlog', fact: { id: gf.id, scope: 'group:-100777', title: 'Group launch decision' }, linkTried: { at: ts, facts: 42 } }]);
const asAnn = (await boardAs({ 'x-ide-turn': annTurn })).find(t => t.id === 't_group');
ok('a group fact\'s title stays with the group\'s members', asAnn?.fact?.private === true && !asAnn.fact.title, asAnn?.fact);
ok('the seeding\'s bookkeeping never leaves the server', !('linkTried' in (asAnn || {})));

server.close();
console.log(`tasks-owner: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
