// A task and the memory fact behind it are one truth: the bot reads the
// task's state from the board under every excerpt, the nightly filing ties a
// note to the task made for it, and "done" closes the fact. Run:
// node lib/task-links.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
const ROOT = mkdtempSync(join(tmpdir(), 'task-links-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'on';
process.env.TELEGRAM_LOG_PATH = join(ROOT, 'telegram.jsonl');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team', addedAt: '2026-09-01T00:00:00Z' } } }));
writeFileSync(join(ROOT, '.tasks.json'), '[]');
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), '{}');

const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const T = await import('./tasks.js');
const TL = await import('./memory-task-links.js');
const RC = await import('./memory-recall.js');
const C = await import('./memory-consolidator.js');
const LLM = await import('./memory-llm.js');
const { issueTurnToken } = await import('./turn-identity.js');
const { default: tasksRouter } = await import('../routes/tasks.js');
const app = express();
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', tasksRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/tasks`;
const annTurn = issueTurnToken({ actor: 'ann' });
const post = async (body, headers = { 'x-ide-turn': annTurn }) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).json();
const patch = async (id, body, headers = { 'x-ide-turn': annTurn }) => (await fetch(`${url}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).json();
const del = async (id) => (await fetch(`${url}/${id}`, { method: 'DELETE' })).json();

// ─── (a) what the bot reads under an excerpt, state by state ────────────────
const ts = '2026-10-11T09:00:00Z';
const rec = await L.append({ scope: 'user:ann', source: 'web', ts, text: 'Ann: Orbis asked for a pricing sheet by the 20th of October.', tags: { entities: [{ name: 'Orbis', kind: 'company' }] } });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Orbis pricing sheet request', text: 'Orbis asked Ann for a pricing sheet by 20 October.', kind: 'status', about: 'deadline', when: '2026-10-20', entities: [{ name: 'Orbis', kind: 'company' }] } }], { record: rec.id, standing: 'said', by: 'web', ts });
const fact = F.all('user:ann').find(f => f.title === 'Orbis pricing sheet request');
let r = await post({ title: 'Send Orbis the pricing sheet', record: rec.id, deadline: '2026-10-20' });
ok('(a) the task links to the fact behind the excerpt', r.link === 'linked' && r.task.fact?.id === fact.id, r);
const task = r.task;
const hitsOf = (scopes) => TL.attachTasks(L.read({ scopes }).filter(x => x.id === rec.id), scopes);
let h = hitsOf(['user:ann'])[0];
ok('(a) not started: the excerpt says so, with the deadline and whose', h.tasks?.[0] === 'task "Send Orbis the pricing sheet": on the board, not started, due 2026-10-20, Ann\'s', h.tasks);
ok('(a) ...and it is rendered under the excerpt text', /↳ task "Send Orbis the pricing sheet"/.test(RC.excerpt(h)) && RC.excerpt(h).indexOf('↳') > RC.excerpt(h).indexOf('pricing sheet by the 20th'), RC.excerpt(h));
await patch(task.id, { status: 'in_progress' });
h = hitsOf(['user:ann'])[0];
ok('(a) in progress', /in progress, due 2026-10-20, Ann's$/.test(h.tasks?.[0] || ''), h.tasks);
ok('(a) a reader without that scope gets no task line', !hitsOf(['shared'])[0], 'the record is not even theirs');
ok('(a) a group turn (shared + the group) sees nothing of a private task', !TL.attachTasks(L.read({ scopes: ['user:ann'] }).filter(x => x.id === rec.id), ['shared', 'group:-100777'])[0].tasks);

// ─── (b) the recall block the bot starts a turn with ────────────────────────
let b = await RC.buildRecallBlock({ actor: 'ann', message: 'Did I send Orbis the pricing sheet?' });
ok('(b) Ann\'s block carries the task and its state', /↳ task "Send Orbis the pricing sheet": in progress/.test(b.block || ''), b.block);
b = await RC.buildRecallBlock({ actor: 'stan', message: 'Did Ann send Orbis the pricing sheet?' });
ok('(b) Stan\'s block has neither the private excerpt nor the task', !/pricing sheet/.test(b.block || ''), b.block);

// ─── (c) done on the board: the fact closes, the excerpt says done ──────────
r = await patch(task.id, { status: 'done' });
ok('(c) done retires the linked fact', r.retiredFacts === 1 && F.get('user:ann', fact.id)?.retired && F.get('user:ann', fact.id).retiredWhy === 'done on the task board', r);
h = hitsOf(['user:ann'])[0];
ok('(c) the excerpt now says done, with the day', /^task "Send Orbis the pricing sheet": done on \d{4}-\d{2}-\d{2}$/.test(h.tasks?.[0] || ''), h.tasks);
RC._resetForTests();
b = await RC.buildRecallBlock({ actor: 'ann', message: 'Did I send Orbis the pricing sheet?' });
ok('(c) ...and so does the block the bot reads', /↳ task "Send Orbis the pricing sheet": done on/.test(b.block || ''), b.block);

// ─── (d) the task is deleted: the fact stays, the line says so ──────────────
await del(task.id);
h = hitsOf(['user:ann'])[0];
ok('(d) a deleted task lets go of its fact: the fact keeps only that it was done on the board', /^done on the task board on \d{4}-\d{2}-\d{2}$/.test(h.tasks?.[0] || '') && !F.get('user:ann', fact.id)?.task, h.tasks);

// ─── (e) done without a link: the title net, visible the same way ──────────
const rec2 = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-12T09:00:00Z', text: 'Ann: Kowalski wants the invoice summary by Monday.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Invoice summary for Kowalski', text: 'Ann will send Kowalski the invoice summary by Monday.', kind: 'fact' } }], { record: rec2.id, standing: 'said', by: 'web', ts: '2026-10-12T09:00:00Z' });
r = await post({ title: 'Send Kowalski the invoice summary' });
ok('(e) a task made without a link has no fact', !r.task.fact && !r.link);
r = await patch(r.task.id, { status: 'done' });
h = TL.attachTasks(L.read({ scopes: ['user:ann'] }).filter(x => x.id === rec2.id), ['user:ann'])[0];
ok('(e) done closes the fact that carries the title, and the excerpt says done on the board', r.retiredFacts === 1 && /^done on the task board on \d{4}-\d{2}-\d{2}$/.test(h.tasks?.[0] || ''), { r, tasks: h.tasks });

// ─── (f) which tasks the nightly filing may offer ───────────────────────────
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
T.writeTasks([
  { id: 't_in',    title: 'In the window, Ann\'s',      status: 'backlog', owner: 'ann',  createdAt: iso(-5 * 60_000) },
  { id: 't_early', title: 'An hour before',             status: 'backlog', owner: 'ann',  createdAt: iso(-60 * 60_000) },
  { id: 't_stan',  title: 'Stan\'s, same minute',       status: 'backlog', owner: 'stan', createdAt: iso(-4 * 60_000) },
  { id: 't_byann', title: 'Made by Ann for Stan',       status: 'backlog', owner: 'stan', createdBy: 'ann', createdAt: iso(-3 * 60_000) },
  { id: 't_done',  title: 'Already linked',             status: 'backlog', owner: 'ann',  createdAt: iso(-2 * 60_000), fact: { id: 'x', scope: 'user:ann', title: 'x' } },
]);
let cands = TL.tasksCreatedDuring({ from: iso(-8 * 60_000), to: iso(0), owner: 'ann' }).map(t => t.id).sort();
ok('(f) a person\'s conversation offers the tasks made in it, by or for them, unlinked', cands.join() === 't_byann,t_in', cands);
cands = TL.tasksCreatedDuring({ from: iso(-8 * 60_000), to: iso(0), group: true }).map(t => t.id).sort();
ok('(f) a group\'s conversation offers every task of the window', cands.join() === 't_byann,t_in,t_stan', cands);
ok('(f) nothing outside the window', !TL.tasksCreatedDuring({ from: iso(-30 * 60_000), to: iso(-20 * 60_000), owner: 'ann' }).length);

// ─── (g) the nightly filing ties a note to the task made for it ─────────────
const calls = [];
let notesAnswer = () => ({ notes: [], rules: [] });
let seedAnswer = () => ({ pick: 0, why: 'none' });
LLM.configureRunner(async ({ system, user, schema }) => {
  if (schema.properties?.pick) { calls.push({ kind: 'seed', system, user }); return seedAnswer(user); }
  const kind = schema.properties?.shared ? 'route' : 'notes';
  calls.push({ kind, system, user });
  if (kind === 'route') return { shared: '', private: user, ask: '', ask_question: '' };
  return notesAnswer(user);
});
const NOW = Date.now();
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const chat = (slug, session, rows) => { const d = join(ROOT, '.team', 'users', slug, 'chats'); mkdirSync(d, { recursive: true }); for (const row of rows) appendFileSync(join(d, `${session}.jsonl`), JSON.stringify(row) + '\n'); };
chat('ann', 'budget', [
  { ts: at(40), role: 'user', text: 'Nowak wants the Q4 budget draft by Friday 24 October. Add a task for me to prepare it.' },
  { ts: at(39), role: 'assistant', text: 'Added "Prepare the Q4 budget draft for Nowak" to your tasks, due 24 October.' },
]);
T.writeTasks([{ id: 't_budget', title: 'Prepare the Q4 budget draft for Nowak', status: 'backlog', owner: 'ann', createdBy: 'ann', createdAt: at(39), deadline: '2026-10-24' },
              { id: 't_other', title: 'Unrelated, a day earlier', status: 'backlog', owner: 'ann', createdAt: at(24 * 60) }]);
notesAnswer = () => ({ notes: [{ title: 'Nowak Q4 budget draft', text: 'Nowak wants the Q4 budget draft from Ann by 24 October 2026.', importance: 2, kind: 'status', about: 'deadline', when: '2026-10-24', whenFrom: 'by Friday 24 October', dayStated: true, concerns: 'a company or project', evidence: 'Nowak wants the Q4 budget draft by Friday 24 October', task: 't_budget' },
                                { title: 'Nowak likes drafts early', text: 'Nowak prefers to see drafts early.', importance: 1, kind: 'fact', concerns: 'another person', evidence: 'Nowak wants the Q4 budget draft', task: 't_nope' }], rules: [], entities: [{ name: 'Nowak', kind: 'person' }] });
let s = await C.consolidateIdle({ now: NOW + 20 * 60_000 });
const noteCall = calls.find(c => c.kind === 'notes');
ok('(g) the model is offered the task made in that conversation, and no other', /TASKS PUT ON THE BOARD DURING THIS CONVERSATION:\nt_budget: Prepare the Q4 budget draft for Nowak/.test(noteCall?.user || '') && !/t_other/.test(noteCall?.user || ''), noteCall?.user?.slice(-300));
ok('(g) ...with the rule in its instructions', /set "task" to that id/.test(noteCall?.system || ''));
const budgetFact = F.all('user:ann').find(f => f.title === 'Nowak Q4 budget draft');
const budgetTask = T.readTasks().find(t => t.id === 't_budget');
ok('(g) the filed fact and the task point at each other', s.linked === 1 && budgetFact?.task?.id === 't_budget' && budgetTask?.fact?.id === budgetFact?.id && budgetTask.fact.title === 'Nowak Q4 budget draft', { linked: s.linked, factTask: budgetFact?.task, taskFact: budgetTask?.fact });
ok('(g) a task id the conversation did not make is ignored', !F.all('user:ann').find(f => f.title === 'Nowak likes drafts early')?.task);
RC._resetForTests();
b = await RC.buildRecallBlock({ actor: 'ann', message: 'Where is the Q4 budget draft for Nowak?' });
ok('(g) next time Ann asks, the block names the task and its state', /↳ task "Prepare the Q4 budget draft for Nowak": on the board, not started, due 2026-10-24, Ann's/.test(b.block || ''), b.block);
r = await patch('t_budget', { status: 'done' });
RC._resetForTests();
b = await RC.buildRecallBlock({ actor: 'ann', message: 'Did I prepare the Q4 budget draft for Nowak?' });
ok('(g) done on the board, memory answers done', r.retiredFacts >= 1 && /↳ task "Prepare the Q4 budget draft for Nowak": done on/.test(b.block || ''), b.block);

// ─── (h) the files a conversation wrote, tied to the fact and named under the excerpt ─
const FL = await import('./memory-file-links.js');
const wf = (rel, text = '# note\n') => { const p = join(ROOT, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
wf('notes/nowak-q4-budget-plan.md'); wf('users/ann/drafts/q4-budget-outline.md'); wf('users/stan/private-plan.md'); wf('memory/RULES.md'); wf('.team/users/ann/scratch.md');
const old = wf('notes/last-month.md'); const { utimesSync } = await import('node:fs'); utimesSync(old, new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));
let wfiles = FL.filesWrittenDuring({ from: iso(-5 * 60_000), to: iso(0), owner: 'ann' }).map(f => f.path).sort();
ok('(h) a person\'s conversation offers the workspace\'s new files and their own, nothing hidden, nothing old', wfiles.join() === 'notes/nowak-q4-budget-plan.md,users/ann/drafts/q4-budget-outline.md', wfiles);
wfiles = FL.filesWrittenDuring({ from: iso(-5 * 60_000), to: iso(0), group: true }).map(f => f.path);
ok('(h) a group\'s conversation offers only the workspace\'s', wfiles.join() === 'notes/nowak-q4-budget-plan.md', wfiles);
wf('notes/for-the-next-chat.md'); utimesSync(join(ROOT, 'notes', 'for-the-next-chat.md'), new Date(now + 3 * 60_000), new Date(now + 3 * 60_000));
ok('(h) a file written minutes after the conversation ended is not its file', !FL.filesWrittenDuring({ from: iso(-5 * 60_000), to: iso(0), owner: 'ann' }).some(f => f.path === 'notes/for-the-next-chat.md'));
chat('ann', 'plan', [
  { ts: at(10), role: 'user', text: 'Write up the plan for the Nowak Q4 budget as a note, and remember that Nowak signs off on the final numbers.' },
  { ts: at(9), role: 'assistant', text: 'Written to notes/nowak-q4-budget-plan.md. Noted: Nowak signs off on the final numbers.' },
]);
T.writeTasks([]);
calls.length = 0;
notesAnswer = () => ({ notes: [{ title: 'Nowak signs off the budget', text: 'Nowak signs off on the final numbers of the Q4 budget.', importance: 2, kind: 'fact', concerns: 'another person', evidence: 'Nowak signs off on the final numbers', files: ['notes/nowak-q4-budget-plan.md', 'somewhere/else.md'] }], rules: [], entities: [{ name: 'Nowak', kind: 'person' }] });
// the chat's rows are "now"-ish; the files were written seconds ago, inside the span
const plan = join(ROOT, 'notes', 'nowak-q4-budget-plan.md'); utimesSync(plan, new Date(NOW - 9 * 60_000), new Date(NOW - 9 * 60_000));
s = await C.consolidateIdle({ now: NOW + 20 * 60_000 });
const planCall = calls.find(c => c.kind === 'notes');
ok('(h) the model is offered the files written during the conversation', /FILES WRITTEN DURING THIS CONVERSATION:\n[\s\S]*notes\/nowak-q4-budget-plan\.md/.test(planCall?.user || ''), planCall?.user?.slice(-300));
const signFact = F.all('user:ann').find(f => f.title === 'Nowak signs off the budget');
ok('(h) the fact carries the file it was tied to, and only a file the conversation wrote', s.filesLinked === 1 && JSON.stringify(signFact?.files) === JSON.stringify(['notes/nowak-q4-budget-plan.md']), { linked: s.filesLinked, files: signFact?.files });
RC._resetForTests();
b = await RC.buildRecallBlock({ actor: 'ann', message: 'Who signs off the Nowak Q4 budget numbers?' });
ok('(h) the excerpt names the file', /↳ files from this conversation: notes\/nowak-q4-budget-plan\.md/.test(b.block || ''), b.block);
const { rmSync } = await import('node:fs'); rmSync(plan);
RC._resetForTests();
b = await RC.buildRecallBlock({ actor: 'ann', message: 'Who signs off the Nowak Q4 budget numbers?' });
ok('(h) a removed file reads as gone', /notes\/nowak-q4-budget-plan\.md \(gone\)/.test(b.block || ''), b.block);
ok('(h) the screen gets the same, with whether it exists', JSON.stringify(FL.filesOfFact(signFact)) === JSON.stringify([{ path: 'notes/nowak-q4-budget-plan.md', exists: false }]));

// ─── (i) one file written, the model names none: it is the conversation's file all the same ─
chat('ann', 'brief', [
  { ts: at(6), role: 'user', text: 'Write the Orbis brief to a note and remember Orbis moved its HQ to Gdansk.' },
  { ts: at(5), role: 'assistant', text: 'Written to notes/orbis-brief.md. Noted: Orbis moved its HQ to Gdansk.' },
]);
for (const rel of ['users/ann/drafts/q4-budget-outline.md', 'users/stan/private-plan.md']) utimesSync(join(ROOT, rel), new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));   // the earlier scenario's files are old news now
const brief = wf('notes/orbis-brief.md'); utimesSync(brief, new Date(NOW - 5 * 60_000 - 20_000), new Date(NOW - 5 * 60_000 - 20_000));
notesAnswer = () => ({ notes: [{ title: 'Orbis HQ in Gdansk', text: 'Orbis moved its headquarters to Gdansk.', importance: 2, kind: 'fact', concerns: 'a company or project', evidence: 'Orbis moved its HQ to Gdansk' }], rules: [], entities: [{ name: 'Orbis', kind: 'company' }] });
s = await C.consolidateIdle({ now: NOW + 20 * 60_000 });
const hq = F.all('user:ann').find(f => f.title === 'Orbis HQ in Gdansk');
ok('(i) the only file a conversation wrote is linked without the model naming it', s.filesLinked === 1 && JSON.stringify(hq?.files) === JSON.stringify(['notes/orbis-brief.md']), { linked: s.filesLinked, files: hq?.files });

// ─── (j) the bot names nothing: the excerpt its turn was handed carries the task's words ─
const { setTurnRecall } = await import('./turn-identity.js');
const recK = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-13T09:00:00Z', text: 'Ann: Kowalski asked me for the invoice summary by Monday.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Invoice summary for Kowalski', text: 'Kowalski asked Ann for the invoice summary by Monday.', kind: 'status', about: 'deadline', when: '2026-10-20' } }], { record: recK.id, standing: 'said', by: 'web', ts: '2026-10-13T09:00:00Z' });
const recU = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-13T10:00:00Z', text: 'Ann: the office plants need watering on Fridays.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Office plants', text: 'The office plants are watered on Fridays.', kind: 'fact' } }], { record: recU.id, standing: 'said', by: 'web', ts: '2026-10-13T10:00:00Z' });
const handed = issueTurnToken({ actor: 'ann' });
setTurnRecall(handed, [recU.id, recK.id]);
r = await post({ title: 'Send Kowalski the invoice summary (E2E)' }, { 'x-ide-turn': handed });
const kFact = F.all('user:ann').find(f => f.title === 'Invoice summary for Kowalski' && !f.retired);   // (e) retired an older one of that title
ok('(j) linked to the handed excerpt that carries the task\'s words, not the other', r.link === 'linked' && r.task.fact?.id === kFact.id, r);
r = await post({ title: 'Order new desk lamps' }, { 'x-ide-turn': handed });
ok('(j) a task none of the handed excerpts is about stays unlinked', !r.task.fact && !r.link, r);
const groupHanded = issueTurnToken({ actor: 'ann', group: true, groupId: '-100777' });
setTurnRecall(groupHanded, [recK.id]);
r = await post({ title: 'Send Kowalski the invoice summary again' }, { 'x-ide-turn': groupHanded });
ok('(j) a group turn links nothing private', !r.task.fact, r);

// ─── (k) done without a link: a fact that carries the task's words closes too ─
const recM = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-13T11:00:00Z', text: 'Ann: Malinowski wants the audit checklist before Thursday.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Audit checklist for Malinowski', text: 'Malinowski wants the audit checklist from Ann before Thursday.', kind: 'status', about: 'deadline', when: '2026-10-16' } }], { record: recM.id, standing: 'said', by: 'web', ts: '2026-10-13T11:00:00Z' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Audit firm', text: 'The audit firm is Malinowski & Partners.', kind: 'fact' } }], { record: recM.id, standing: 'said', by: 'web', ts: '2026-10-13T11:00:00Z' });
r = await post({ title: 'Send Malinowski the audit checklist (E2E-999999)' });
ok('(k) made without context: unlinked', !r.task.fact);
const recP = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-13T12:00:00Z', text: 'Ann: Piotrowski needs the vendor contract draft by Friday.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Vendor contract for Piotrowski', text: 'Piotrowski needs the vendor contract draft from Ann by Friday.', kind: 'status', about: 'deadline', when: '2026-10-17' } }], { record: recP.id, standing: 'said', by: 'web', ts: '2026-10-13T12:00:00Z' });
const handedP = issueTurnToken({ actor: 'ann' }); setTurnRecall(handedP, [recP.id]);
let rp = await post({ title: 'Sende Piotrowski the vendor contract draft' }, { 'x-ide-turn': handedP });
ok('(k) a title with a verb in another language still links by its name and nouns', rp.link === 'linked' && rp.task.fact?.title === 'Vendor contract for Piotrowski', rp);
rp = await post({ title: 'Send Piotrowski the vendor contract draft', status: 'done' }, { 'x-ide-turn': handedP });
ok('(k) a task born done closes the fact it was about', rp.retiredFacts === 1 && F.all('user:ann').find(f => f.title === 'Vendor contract for Piotrowski')?.retired, rp);
r = await patch(r.task.id, { status: 'done' });
const aud = F.all('user:ann');
ok('(k) done closes the fact that carries its words (title words all present), and only that one', r.retiredFacts === 1 && aud.find(f => f.title === 'Audit checklist for Malinowski')?.retired && !aud.find(f => f.title === 'Audit firm')?.retired, { r, retired: aud.filter(f => f.retired).map(f => f.title) });

// ─── (l) the bot already noted the fact during the turn; the night only confirms it — the file still lands on it ─
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Orbis payment terms', text: 'Orbis pays invoices net 30, in euros.', kind: 'status', about: 'deadline', when: '2026-10-30', subject: 'Orbis', entities: [{ name: 'Orbis', kind: 'company' }] } }], { record: 'note-during-turn', standing: 'note', by: 'note', ts: at(3) });
chat('ann', 'terms', [
  { ts: at(3), role: 'user', text: 'Remember this: Orbis pays invoices net 30, in euros. Then write the terms to a note file.' },
  { ts: at(2), role: 'assistant', text: 'Noted. Written to notes/orbis-terms.md.' },
]);
const terms = wf('notes/orbis-terms.md'); utimesSync(terms, new Date(NOW - 2 * 60_000 - 10_000), new Date(NOW - 2 * 60_000 - 10_000));
for (const rel of ['notes/orbis-brief.md']) utimesSync(join(ROOT, rel), new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));
notesAnswer = () => ({ notes: [{ title: 'Orbis payment terms', text: 'Orbis pays invoices net 30, in euros.', importance: 2, kind: 'status', about: 'deadline', when: '2026-10-30', whenFrom: 'net 30', dayStated: true, subject: 'Orbis', concerns: 'a company or project', evidence: 'Orbis pays invoices net 30, in euros' }], rules: [], entities: [{ name: 'Orbis', kind: 'company' }] });
s = await C.consolidateIdle({ now: NOW + 20 * 60_000 });
const termsFacts = F.all('user:ann').filter(f => f.title === 'Orbis payment terms' && !f.retired);
ok('(l) the night confirmed the fact the bot had noted (one fact, not two)', termsFacts.length === 1 && termsFacts[0].sources.length >= 2, termsFacts.map(f => [f.id, f.sources]));
ok('(l) ...and the file is on that one fact', s.filesLinked === 1 && JSON.stringify(termsFacts[0].files) === JSON.stringify(['notes/orbis-terms.md']), { linked: s.filesLinked, files: termsFacts[0]?.files });

// ─── (m) done on a task linked to a fact that only holds it: the fact stays ─
const recMt = await L.append({ scope: 'user:ann', source: 'web', ts: '2026-10-13T14:00:00Z', text: 'Ann: notes from the call with Zielinski.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Call with Zielinski', text: 'In the call with Zielinski: pricing agreed, Ann to send the contract, launch in November.', kind: 'fact' } }], { record: recMt.id, standing: 'said', by: 'web', ts: '2026-10-13T14:00:00Z' });
const meet = F.all('user:ann').find(f => f.title === 'Call with Zielinski');
let rm = await post({ title: 'Send Zielinski the contract', fact: meet.id });
rm = await patch(rm.task.id, { status: 'done' });
ok('(m) a meeting\'s notes are not closed by one of its action items', !F.get('user:ann', meet.id).retired, rm);
const hm = TL.attachTasks(L.read({ scopes: ['user:ann'] }).filter(x => x.id === recMt.id), ['user:ann'])[0];
ok('(m) ...the excerpt says the task is done', /task "Send Zielinski the contract": done on/.test(hm.tasks?.[0] || ''), hm.tasks);

// ─── (n) the nightly seeding of links for tasks that have none ──────────────
const factNo = (user, re) => { const m = user.split('\n').find(l => re.test(l)); return m ? Number(m.split('.')[0]) : 0; };
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Rebuild onboarding by Oct 31', text: 'Ann committed to rebuilding the onboarding flow by 31 October.', kind: 'status', about: 'deadline', when: '2026-10-31' } }], { record: 'r-onb', standing: 'said', by: 'web', ts: '2026-10-11T09:00:00Z' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Project Atlas', text: 'Project Atlas: website, README and the launch are in progress.', kind: 'fact' } }], { record: 'r-atlas', standing: 'said', by: 'web', ts: '2026-10-11T09:00:00Z' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Call with Wrona', text: 'Call with Wrona: budget agreed, Ann sends the brief, kickoff on Monday.', kind: 'fact' } }], { record: 'r-wrona', standing: 'said', by: 'web', ts: '2026-10-11T09:00:00Z' });
T.writeTasks([
  { id: 'n_onb',   title: 'Zaprojektuj nowy onboarding', status: 'backlog', owner: null, createdBy: null, createdAt: '2026-10-11T10:00:00Z' },
  { id: 'n_web',   title: 'Atlas website',               status: 'done', owner: 'ann', createdAt: '2026-10-11T10:00:00Z', completed: '2026-10-12' },
  { id: 'n_readme',title: 'Atlas README',                status: 'done', owner: 'ann', createdAt: '2026-10-11T10:00:00Z', completed: '2026-10-12' },
  { id: 'n_brief', title: 'Send Wrona the brief',        status: 'done', owner: 'ann', createdAt: '2026-10-11T10:00:00Z', completed: '2026-10-12' },
]);
// the workspace's owner here is stan; make the unowned task's pool ann's by naming her the creator
T.writeTasks(T.readTasks().map(t => t.id === 'n_onb' ? { ...t, createdBy: 'ann' } : t));
seedAnswer = (user) => {
  if (/TASK: Zaprojektuj nowy onboarding/.test(user)) return { pick: factNo(user, /Rebuild onboarding by Oct 31/), why: 'same work' };
  if (/TASK: Atlas (website|README)/.test(user)) return { pick: factNo(user, /Project Atlas/), why: 'part of Atlas' };
  if (/TASK: Send Wrona the brief/.test(user)) return { pick: factNo(user, /Call with Wrona/), why: 'from the call' };
  return { pick: 0, why: 'none' };
};
calls.length = 0;
let sd = await TL.seedLinks({ now: Date.now() });
const byId = (id) => T.readTasks().find(t => t.id === id);
ok('(n) a task in another language links to the fact it came from', byId('n_onb').fact?.title === 'Rebuild onboarding by Oct 31' && F.all('user:ann').find(f => f.title === 'Rebuild onboarding by Oct 31')?.task?.id === 'n_onb', byId('n_onb'));
ok('(n) a fact two tasks pick is broad: neither links', !byId('n_web').fact && !byId('n_readme').fact);
ok('(n) a done task linked to a meeting\'s notes leaves them standing', byId('n_brief').fact?.title === 'Call with Wrona' && !F.all('user:ann').find(f => f.title === 'Call with Wrona')?.retired, byId('n_brief'));
ok('(n) the seeding uses the stronger model and says what it did', sd.asked === 4 && sd.linked === 2 && calls.filter(c => c.kind === 'seed').length === 4, sd);
calls.length = 0;
sd = await TL.seedLinks({ now: Date.now() + 3600_000 });
ok('(n) the next night does not ask again about the same tasks', sd.asked === 0 && !calls.some(c => c.kind === 'seed'), sd);
sd = await TL.seedLinks({ now: Date.now() + 8 * 86400_000 });
ok('(n) a week later, with nothing new in memory, still no call', !calls.some(c => c.kind === 'seed'), sd);

// ─── (o) a request with its who-and-when words is still the matter itself ─
ok('(o) "Orbis asked Stan for a pricing sheet by 20 October 2026" is the matter of "Send Orbis the pricing sheet"', TL.isTheMatter({ kind: 'fact', title: 'Orbis pricing sheet', text: 'Orbis asked Stan for a pricing sheet by 20 October 2026.' }, 'Send Orbis the pricing sheet (E2E-1)'));
ok('(o) a call\'s notes are not the matter of one of its items', !TL.isTheMatter({ kind: 'fact', title: 'Call with Zielinski', text: 'In the call with Zielinski: pricing agreed, Ann to send the contract, launch in November.' }, 'Send Zielinski the contract'));

server.close();
console.log(`task-links: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
