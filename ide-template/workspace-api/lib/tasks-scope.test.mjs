// Two lists, one board. A task a person makes in their own chat or the browser
// is on their own list (a file in their private tree); one from a room, one
// given to someone else or wanted on the team board is on the team board.
// Someone else's own task does not exist for you: not listed, 404 to touch.
// A fact's pointer at a task carries the task's list and never a private
// task's title outside its person's memory. Run: node lib/tasks-scope.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
const ROOT = mkdtempSync(join(tmpdir(), 'tasks-scope-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'on';
process.env.TELEGRAM_LOG_PATH = join(ROOT, 'telegram.jsonl');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team', addedAt: '2026-09-01T00:00:00Z' } } }));
writeFileSync(join(ROOT, '.tasks.json'), '[]');
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), '{}');

const T = await import('./tasks.js');
const PT = await import('./private-tree.js');
const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const TL = await import('./memory-task-links.js');
const SH = await import('./memory-sharing.js');
const { issueTurnToken } = await import('./turn-identity.js');
const { default: tasksRouter } = await import('../routes/tasks.js');
const app = express();
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', tasksRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/tasks`;
const ann = { 'x-ide-turn': issueTurnToken({ actor: 'ann' }) };
const bob = { 'x-ide-turn': issueTurnToken({ actor: 'bob' }) };
const stanWeb = { 'x-test-actor': 'stan@example.test' };
const group = { 'x-ide-turn': issueTurnToken({ actor: 'ann', group: true, groupId: '-100777' }) };
const nobody = {};
const call = async (method, path, body, headers) => { const r = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json()) }; };
const post = (body, h) => call('POST', '', body, h);
const patch = (id, body, h) => call('PATCH', `/${id}`, body, h);
const del = (id, h) => call('DELETE', `/${id}`, null, h);
const list = async (h) => (await call('GET', '', null, h)).tasks;
const shared = () => JSON.parse(readFileSync(join(ROOT, '.tasks.json'), 'utf8'));
const own = (slug) => T.readScope(`user:${slug}`);

// ─── where a new task goes ──────────────────────────────────────────────────
let r = await post({ title: 'Call the dentist' }, ann);
ok('a person in their own chat: their own list', r.task.scope === 'user:ann' && r.task.owner === 'ann' && own('ann').length === 1 && !shared().length, r);
ok('...in a file in their private tree', existsSync(join(ROOT, '.team', 'users', 'ann', 'tasks.json')));
const dentist = r.task;
r = await post({ title: 'Stan in the browser' }, stanWeb);
ok('a person in the browser: their own list', r.task.scope === 'user:stan' && own('stan').length === 1, r);
r = await post({ title: 'Deck for the client', owner: 'bob' }, ann);
ok('given to someone else: the team board', r.task.scope === 'shared' && r.task.owner === 'bob', r);
r = await post({ title: 'Nobody yet', owner: null }, ann);
ok('unowned on purpose: the team board', r.task.scope === 'shared' && r.task.owner === null, r);
r = await post({ title: 'From the room' }, group);
ok('a group\'s turn: the team board, nobody\'s', r.task.scope === 'shared' && r.task.owner === null, r);
r = await post({ title: 'From nowhere' }, nobody);
ok('no identity: the team board', r.task.scope === 'shared', r);
r = await post({ title: 'For the team', scope: 'shared' }, ann);
ok('asked for the team board: there, owned by the asker', r.task.scope === 'shared' && r.task.owner === 'ann', r);
const forTeam = r.task;
r = await post({ title: 'Mine please', scope: 'mine' }, ann);
ok('asked for own list: there', r.task.scope === 'user:ann', r);
r = await post({ title: 'x', scope: 'mine' }, group);
ok('a group may not ask for an own list', r.status === 400 && !r.ok, r);
r = await post({ title: 'x', scope: 'mine' }, nobody);
ok('nor may a caller nobody can place', r.status === 400, r);
r = await post({ title: 'x', scope: 'mine', owner: 'bob' }, ann);
ok('own list and someone else as owner contradict: refused', r.status === 400, r);
r = await post({ title: 'x', scope: 'user:bob' }, ann);
ok('someone else\'s list by name: refused', r.status === 400, r);
ok('own list spelled out is fine', (await post({ title: 'Spelled', scope: 'user:ann' }, ann)).task.scope === 'user:ann');

// ─── who sees what ──────────────────────────────────────────────────────────
const seen = (tasks) => tasks.map(t => t.title).sort().join('|');
ok('Ann sees the team board and her own list', seen(await list(ann)).includes('Call the dentist') && seen(await list(ann)).includes('For the team'));
ok('...each task saying which list it is on', (await list(ann)).every(t => t.scope === 'shared' || t.scope === 'user:ann'));
ok('Bob sees the team board, not Ann\'s list', !seen(await list(bob)).includes('Call the dentist') && seen(await list(bob)).includes('For the team'));
ok('Stan (an admin) sees the team board and his own, not Ann\'s', !seen(await list(stanWeb)).includes('Call the dentist') && seen(await list(stanWeb)).includes('Stan in the browser'));
ok('a group\'s turn sees the team board only', (await list(group)).every(t => t.scope === 'shared') && (await list(group)).length === shared().length);
ok('no identity: the team board only', (await list(nobody)).every(t => t.scope === 'shared'));
ok('Bob cannot change Ann\'s task: 404, not 403', (await patch(dentist.id, { title: 'x' }, bob)).status === 404);
ok('...nor delete it', (await del(dentist.id, bob)).status === 404);
ok('...nor can an admin', (await patch(dentist.id, { title: 'x' }, stanWeb)).status === 404 && (await del(dentist.id, stanWeb)).status === 404);
ok('...nor a group\'s turn', (await patch(dentist.id, { status: 'done' }, group)).status === 404);
ok('...and nothing changed', own('ann').find(t => t.id === dentist.id).title === 'Call the dentist');
ok('Ann can', (await patch(dentist.id, { title: 'Call the dentist today' }, ann)).ok);

// ─── moving between the lists ───────────────────────────────────────────────
r = await patch(dentist.id, { scope: 'shared' }, ann);
ok('Ann shares her task: on the team board, off her list', r.ok && r.moved === 'shared' && shared().some(t => t.id === dentist.id) && !own('ann').some(t => t.id === dentist.id), r);
ok('...Bob sees it now', seen(await list(bob)).includes('Call the dentist today'));
r = await patch(dentist.id, { scope: 'mine' }, ann);
ok('Ann takes back a task she owns', r.ok && r.moved === 'user:ann' && own('ann').some(t => t.id === dentist.id) && !shared().some(t => t.id === dentist.id), r);
ok('...a crashed move leaves no second copy visible: ids are unique across the lists', new Set((await list(ann)).map(t => t.id)).size === (await list(ann)).length);
r = await patch(forTeam.id, { scope: 'mine' }, bob);
ok('Bob cannot take Ann\'s shared task to his list', r.status === 403 && shared().some(t => t.id === forTeam.id), r);
const unowned = shared().find(t => t.title === 'Nobody yet');
r = await patch(unowned.id, { scope: 'mine' }, bob);
ok('an unowned task is not taken quietly', r.status === 403, r);
r = await patch(unowned.id, { scope: 'mine', owner: 'bob' }, bob);
ok('...claiming it in the same call takes it', r.ok && r.task.scope === 'user:bob' && r.task.owner === 'bob' && own('bob').length === 1, r);
r = await patch(dentist.id, { owner: 'bob' }, ann);
ok('giving an own task to someone moves it to the team board', r.ok && r.moved === 'shared' && r.task.owner === 'bob' && shared().some(t => t.id === dentist.id), r);
r = await patch(dentist.id, { scope: 'mine' }, ann);
ok('...Ann created it, so she may still take it back (and it becomes hers)', r.ok && r.task.scope === 'user:ann' && r.task.owner === 'ann', r);
r = await patch(dentist.id, { scope: 'mine', owner: 'bob' }, ann);
ok('own list with another owner: refused', r.status === 400, r);
r = await patch(dentist.id, { scope: 'shared' }, group);
ok('a group cannot move what it cannot see', r.status === 404, r);
ok('a group may not ask for an own list on a change either', (await patch(forTeam.id, { scope: 'mine' }, group)).status === 400);
// order is kept per list, per column
await post({ title: 'A1' }, ann); await post({ title: 'A2' }, ann);
const orders = own('ann').filter(t => t.status === 'backlog').map(t => t.order).sort((a, b) => a - b);
ok('own list numbers its own columns', orders.every((o, i) => o === i), orders);
const gone = own('ann').find(t => t.title === 'A1');
await del(gone.id, ann);
ok('deleting from the own list closes the column up there', own('ann').filter(t => t.status === 'backlog').map(t => t.order).sort((a, b) => a - b).every((o, i) => o === i));

// ─── the memory side ────────────────────────────────────────────────────────
const ts = '2026-10-11T09:00:00Z';
const recA = await L.append({ scope: 'user:ann', source: 'web', ts, text: 'Ann: I must send Orbis the pricing sheet by the 20th.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Orbis pricing sheet', text: 'Ann must send Orbis the pricing sheet by 20 October.', kind: 'status', about: 'deadline', when: '2026-10-20' } }], { record: recA.id, standing: 'said', by: 'web', ts });
const annFact = F.all('user:ann').find(f => f.title === 'Orbis pricing sheet');
const recS = await L.append({ scope: 'shared', source: 'web', ts, text: 'Stan: the team owes Orbis a pricing sheet; Ann sends it.' });
await F.apply('shared', [{ op: 'add', fact: { title: 'Orbis pricing sheet owed', text: 'The team owes Orbis a pricing sheet; Ann will send Orbis the pricing sheet.', kind: 'status', about: 'deadline', when: '2026-10-20' } }], { record: recS.id, standing: 'said', by: 'web', ts });
const teamFact = F.all('shared').find(f => f.title === 'Orbis pricing sheet owed');

r = await post({ title: 'Send Orbis the pricing sheet', record: recA.id }, ann);
ok('an own task links to the person\'s own fact', r.link === 'linked' && r.task.scope === 'user:ann' && r.task.fact?.id === annFact.id, r);
const pricing = r.task;
let p = F.get('user:ann', annFact.id)?.task;
ok('...the fact\'s pointer carries the list and, in her own memory, the title', p?.id === pricing.id && p.scope === 'user:ann' && p.title === 'Send Orbis the pricing sheet', p);
r = await patch(pricing.id, { fact: teamFact.id }, ann);
ok('an own task may point at a shared fact', r.link === 'linked' && r.task.fact?.id === teamFact.id, r);
p = F.get('shared', teamFact.id)?.task;
ok('...and the shared fact\'s pointer then carries the list but NOT the private title', p?.id === pricing.id && p.scope === 'user:ann' && !('title' in p), p);
ok('...the own fact let go', !F.get('user:ann', annFact.id)?.task);
const hitsOf = (scopes, id) => TL.attachTasks(L.read({ scopes }).filter(x => x.id === id), scopes);
let h = hitsOf(['shared', 'user:ann'], recS.id)[0];
ok('Ann reads the task\'s state under the shared excerpt', /^task "Send Orbis the pricing sheet": on the board, not started, Ann's$/.test(h.tasks?.[0] || ''), h.tasks);
h = hitsOf(['shared', 'user:bob'], recS.id)[0];
ok('Bob reads nothing under it — not even "no longer on the board"', !h.tasks, h.tasks);
h = hitsOf(['shared', 'group:-100777'], recS.id)[0];
ok('a group\'s turn reads nothing under it', !h.tasks, h.tasks);
r = await patch(pricing.id, { status: 'done' }, ann);
ok('done: an own task does not close the shared fact it points at', !F.get('shared', teamFact.id)?.retired, r);
ok('...but closes the own fact that carries its words', r.retiredFacts === 1 && F.get('user:ann', annFact.id)?.retired && F.get('user:ann', annFact.id).retiredWhy === 'done on the task board', r);
// shared task, private fact: the title shows only to its person (as before)
r = await post({ title: 'Prepare the Orbis call notes', scope: 'shared', fact: annFact.id }, ann);
ok('a shared task may point at the person\'s own fact', r.link === 'linked' && r.task.fact?.title, r);
const callNotes = (await list(bob)).find(t => t.id === r.task.id);
ok('...Bob sees the task, and only that it has a source', callNotes?.fact?.private === true && !callNotes.fact.title, callNotes?.fact);
// taking a shared task private rewrites the pointer in a shared fact
r = await post({ title: 'Chase Orbis for the signed pricing sheet', scope: 'shared', fact: teamFact.id }, ann);
p = F.get('shared', teamFact.id)?.task;
ok('a shared task\'s pointer in a shared fact carries the title', p?.title === 'Chase Orbis for the signed pricing sheet' && p.scope === 'shared', p);
await patch(r.task.id, { scope: 'mine' }, ann);
p = F.get('shared', teamFact.id)?.task;
ok('...taken to her list, the pointer drops the title and names the list', p?.id === r.task.id && p.scope === 'user:ann' && !('title' in p), p);
// what the nightly filing is offered
T.writeScope('user:ann', own('ann').map(t => ({ ...t, createdAt: new Date().toISOString(), fact: undefined })));
const cands = TL.tasksCreatedDuring({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString(), owner: 'ann' }).map(t => t.id);
ok('a person\'s conversation is offered their own tasks (with the board\'s by or for them)', own('ann').every(t => cands.includes(t.id)) && cands.every(id => own('ann').some(t => t.id === id) || shared().some(t => t.id === id && (t.owner === 'ann' || t.createdBy === 'ann'))), cands);
ok('a group\'s conversation is offered the team board only', TL.tasksCreatedDuring({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString(), group: true }).every(x => shared().some(t => t.id === x.id)));
// linkFactToTask: one person's task never links to another person's fact
await F.apply('user:bob', [{ op: 'add', fact: { title: 'Bob plan', text: 'Bob will chase Orbis for the signed pricing sheet.', kind: 'status' } }], { record: 'rb', standing: 'said', by: 'web', ts });
const bobFact = F.all('user:bob')[0];
const annTask = own('ann')[0];
ok('Bob\'s fact cannot link to Ann\'s own task', (await TL.linkFactToTask('user:bob', bobFact.id, annTask.id, { taskScope: 'user:ann' })) === false && !F.get('user:bob', bobFact.id)?.task);
ok('...nor find it by searching', (await TL.linkFactToTask('user:bob', bobFact.id, annTask.id)) === false);
// sharing a fact never carries a task pointer along
const linkedFact = F.all('user:ann').find(f => f.task?.id);
if (linkedFact) {
  const got = await SH.fileTeamFact('ann', linkedFact, { ts, name: 'Ann' });
  ok('a fact shared with the team carries no task pointer', got.ids.length && got.ids.every(id => !F.get('shared', id)?.task), got);
} else ok('a fact with a task pointer exists to share', false);

// ─── solo: one person, one board, as before ─────────────────────────────────
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));
r = await post({ title: 'Solo task' }, { 'x-test-actor': 'stan@example.test' });
ok('solo: on the board', r.task.scope === 'shared' && shared().some(t => t.title === 'Solo task'), r);
ok('solo: "mine" has nowhere to go', (await post({ title: 'x', scope: 'mine' }, { 'x-test-actor': 'stan@example.test' })).status === 400);
ok('solo: the board lists the board only', (await list({ 'x-test-actor': 'stan@example.test' })).every(t => t.scope === 'shared'));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {} }));

// ─── the private-tree guard ─────────────────────────────────────────────────
const groupFile = join(ROOT, 'group');
writeFileSync(groupFile, 'root:x:0:\nworkspace:x:1500:\npriv-03:x:2003:\nturn:x:1005:\n');
const dirStat = (gid) => () => ({ isDirectory: () => true, gid });
ok('owned by a priv group: ready', PT.privateTreeReady('ann', { helper: true, groupFile, statFn: dirStat(2003) }));
ok('the workspace group (a directory of our own making): not ready', !PT.privateTreeReady('ann', { helper: true, groupFile, statFn: dirStat(1500) }));
ok('an unknown group: not ready', !PT.privateTreeReady('ann', { helper: true, groupFile, statFn: dirStat(4242) }));
ok('no directory: not ready', !PT.privateTreeReady('ann', { helper: true, groupFile, statFn: () => { throw new Error('ENOENT'); } }));
ok('a file where the directory should be: not ready', !PT.privateTreeReady('ann', { helper: true, groupFile, statFn: () => ({ isDirectory: () => false, gid: 2003 }) }));
ok('no helper on this machine (dev, tests): ready', PT.privateTreeReady('ann', { helper: false }));
ok('"default" and bad slugs are nobody\'s tree', !PT.privateTreeReady('default', { helper: false }) && !PT.privateTreeReady('../x', { helper: false }) && !PT.privateTreeReady('', { helper: false }));
// Through the API: the helper is "present" (any file will do) and the tmp
// tree's group is not a priv group → the own list refuses, the board is not
// written instead.
process.env.PRIV_TREE_BIN = join(ROOT, '.tasks.json');
const before = shared().length;
r = await post({ title: 'Not yet' }, ann);
ok('a tree not yet the person\'s: 503, said plainly', r.status === 503 && /not ready/.test(r.error), r);
ok('...and nothing went to the team board instead', shared().length === before && !own('ann').some(t => t.title === 'Not yet'));
ok('...a shared task still works', (await post({ title: 'Team still fine', scope: 'shared' }, ann)).ok);
ok('...the person\'s list still reads', (await list(ann)).some(t => t.scope === 'user:ann'));
delete process.env.PRIV_TREE_BIN;
const mode = statSync(join(ROOT, '.team', 'users', 'ann', 'tasks.json')).mode & 0o777;
ok('a private file: group may read, nobody else (0660 before the umask)', (mode & 0o007) === 0 && (mode & 0o040) !== 0 && (mode & 0o600) === 0o600, mode.toString(8));

server.close();
console.log(`tasks-scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
