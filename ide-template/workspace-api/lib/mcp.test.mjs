// The MCP endpoint for coding agents, as a real MCP client sees it: nobody
// without the gate's signed identity gets in (no headers, a bad or stale
// signature, a session cookie, a stranger); a person's agent reads exactly
// what that person's browser reads — the shared memory and files, their own,
// never a colleague's, admins included — and every read is on the person's
// Changes. Run: node lib/mcp.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = mkdtempSync(join(tmpdir(), 'mcp-agent-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'on';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123';
process.env.FRONTEND_DOMAIN = 'ws.example.test';
process.env.TELEGRAM_LOG_PATH = join(ROOT, 'telegram.jsonl');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

// ── A workspace: three people, cards, memory, tasks, files ──
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', sharing: 'never', preferredLanguage: 'Polish' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {} }));
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), '{}');
writeFileSync(join(ROOT, 'memory', 'MISSION.md'), '---\ncard: MISSION\n---\n# Mission\n\n- Saltmarsh Ceramics makes stoneware for restaurants in Lisbon.\n- Wholesale is 60% of revenue.\n');
writeFileSync(join(ROOT, 'memory', 'RULES.md'), '---\ncard: RULES\n---\n# Rules\n\n- Never quote a price below the September list without Nora.\n');
mkdirSync(join(ROOT, 'memory', 'users', 'ann'), { recursive: true });
writeFileSync(join(ROOT, 'memory', 'users', 'ann', 'USER_PROFILE.md'), '---\ncard: USER_PROFILE\n---\n# Profile\n\n- Ann runs sales; based in Porto.\n');
writeFileSync(join(ROOT, 'memory', 'users', 'ann', 'USER_PREFERENCES.md'), '---\ncard: USER_PREFERENCES\n---\n# Preferences\n\n- Short messages, no emoji.\n');
mkdirSync(join(ROOT, 'memory', 'users', 'bob'), { recursive: true });
writeFileSync(join(ROOT, 'memory', 'users', 'bob', 'USER_PROFILE.md'), '---\ncard: USER_PROFILE\n---\n# Profile\n\n- Bob is the BOB-ONLY glaze chemist.\n');
mkdirSync(join(ROOT, 'Sales'), { recursive: true });
writeFileSync(join(ROOT, 'Sales', 'pipeline.md'), '# Pipeline\n\n| Orbis | proposal by Thursday |\n');
writeFileSync(join(ROOT, 'Sales', 'access.md'), '# Shop access\n\nThe shop admin password: Kiln-Harbour-42!\nOrders ship on Tuesdays.\n');
mkdirSync(join(ROOT, 'users', 'ann'), { recursive: true });
writeFileSync(join(ROOT, 'users', 'ann', 'notes.md'), '# Ann notes\n\nANN-NOTE call Orbis on Monday\n');
mkdirSync(join(ROOT, 'users', 'bob'), { recursive: true });
writeFileSync(join(ROOT, 'users', 'bob', 'secret.md'), '# Bob\n\nBOB-SECRET door code 4417\n');
mkdirSync(join(ROOT, '.claude'), { recursive: true });
writeFileSync(join(ROOT, '.claude', 'CLAUDE.md'), 'bot instructions');
writeFileSync(join(ROOT, '.tasks.json'), JSON.stringify([
  { id: 't_board1', title: 'Prepare the Orbis glaze quote', description: 'Orbis wants it by Thursday.', status: 'backlog', owner: 'ann', scope: 'shared', createdAt: '2026-10-28T08:00:00Z' },
  { id: 't_board2', title: 'Order packing tape', status: 'backlog', owner: 'stan', scope: 'shared', createdAt: '2026-10-28T08:00:00Z' },
]));

const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const T = await import('./tasks.js');
const { signatureFor } = await import('./mcp/identity.js');
const { default: mcpRouter } = await import('../routes/mcp.js');
const ts = '2026-10-20T10:00:00.000Z';
const recS = await L.append({ scope: 'shared', source: 'web', ts, text: 'Stan: Orbis wants the offer by Thursday.' });
await F.apply('shared', [{ op: 'add', fact: { title: 'Orbis offer deadline', text: 'Orbis Logistics wants the offer by Thursday 29 October.', kind: 'status', about: 'deadline', when: '2026-10-29' } }], { record: recS.id, standing: 'said', by: 'web', ts });
const recA = await L.append({ scope: 'user:ann', source: 'web', ts, text: 'Ann: I promised Orbis a 5% discount.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Orbis discount', text: 'Ann promised Orbis a 5% discount on the first order (ANN-PRIVATE).', kind: 'fact' } }], { record: recA.id, standing: 'said', by: 'web', ts });
const recB = await L.append({ scope: 'user:bob', source: 'web', ts, text: 'Bob: Orbis kiln is BOB-PRIVATE.' });
await F.apply('user:bob', [{ op: 'add', fact: { title: 'Orbis kiln', text: 'Bob thinks the Orbis kiln is BOB-PRIVATE.', kind: 'fact' } }], { record: recB.id, standing: 'said', by: 'web', ts });
const recP = await L.append({ scope: 'user:ann', source: 'web', ts, text: 'Ann: the shop admin login is ann@shop, password Kiln-Harbour-42!' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Shop admin login', text: 'The shop admin login is ann@shop, password Kiln-Harbour-42! (ANN-SECRET)', kind: 'fact' } }], { record: recP.id, standing: 'said', by: 'web', ts });
const recD = await L.append({ scope: 'user:ann', source: 'web', ts, text: 'Ann: the door code is 4417.' });
await F.apply('user:ann', [{ op: 'add', fact: { title: 'Door code', text: 'The door code to the studio is 4417 (ANN-DOOR).', kind: 'fact' } }], { record: recD.id, standing: 'said', by: 'web', ts });
T.writeScope('user:ann', [{ id: 't_ann1', title: 'Renew the van insurance (ANN-OWN)', status: 'backlog', owner: 'ann', scope: 'user:ann', createdAt: '2026-10-28T08:00:00Z' }]);
T.writeScope('user:bob', [{ id: 't_bob1', title: 'BOB-OWN task', status: 'backlog', owner: 'bob', scope: 'user:bob', createdAt: '2026-10-28T08:00:00Z' }]);

// The writes go through the person's own routes (tasks, the memory note), as
// workspace-api calls itself over loopback: mount them, point the self-calls here.
const { default: tasksRouter } = await import('../routes/tasks.js');
const { default: memoryV4Router } = await import('../routes/memory-v4.js');
const LLM = await import('./memory-llm.js');
// No model in a test: every structured call answers empty, the note is filed whole.
LLM.configureRunner(async () => ({}));
const PL = await import('./integrations/private-lookup.js');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(mcpRouter());
app.use('/api', tasksRouter());
app.use('/api', memoryV4Router());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const url = `http://127.0.0.1:${server.address().port}/mcp`;
process.env.WSAPI_SELF_URL = `http://127.0.0.1:${server.address().port}`;

// The gate's headers, as nginx would forward them after auth-service signed them.
const headersFor = (email, { scopes = ['read'], client = 'Claude Code', exp = Date.now() + 60_000, grant = 'g_test1', sig = null } = {}) => ({
  'X-IDE-User': email, 'X-IDE-Agent-Grant': grant, 'X-IDE-Agent-Scopes': scopes.join(' '), 'X-IDE-Agent-Client': encodeURIComponent(client),
  'X-IDE-Agent-Sig': `${exp}.${sig || signatureFor({ email, grant, scopes, client, exp: String(exp) })}`,
});
const rpc = (headers, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

console.log('== the gate');
let r = await rpc({}, init);
ok('no identity → 401 with the OAuth challenge', r.status === 401 && /resource_metadata="https:\/\/ws\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/.test(r.headers.get('www-authenticate') || ''), r.headers.get('www-authenticate'));
r = await rpc(headersFor('ann@example.test', { sig: 'nope' }), init);
ok('a bad signature → 401', r.status === 401);
r = await rpc(headersFor('ann@example.test', { exp: Date.now() - 1000 }), init);
ok('a stale signature → 401', r.status === 401);
r = await rpc({ 'X-IDE-User': 'ann@example.test' }, init);
ok('X-IDE-User alone (as anything inside the container could send) → 401', r.status === 401);
r = await rpc(headersFor('mallory@example.test'), init);
ok('a stranger with a valid signature → 401 (the roster decides)', r.status === 401);
r = await rpc(headersFor('ann@example.test', { scopes: [] }), init);
ok('a grant without read → 403 insufficient_scope', r.status === 403 && /insufficient_scope/.test(r.headers.get('www-authenticate') || ''));
r = await fetch(url, { headers: headersFor('ann@example.test') });
ok('GET is not the transport → 405', r.status === 405);
r = await rpc({ ...headersFor('ann@example.test'), origin: 'https://evil.example' }, init);
ok('another origin → 403 (DNS rebinding)', r.status === 403);
r = await rpc(headersFor('ann@example.test'), init);
ok('a signed identity on the roster → the server answers', r.status === 200, await r.text());

// ── As Ann, through the SDK client ──
async function connect(email, opts) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: headersFor(email, opts) } });
  const client = new Client({ name: 'test-agent', version: '0.0.1' });
  await client.connect(transport);
  return client;
}
const textOf = (res) => (res.content || []).map(c => c.text || '').join('\n');
const ann = await connect('ann@example.test');

console.log('== what the server says of itself');
const si = ann.getInstructions() || '';
ok('instructions name the person and say to start with the context', /Ann/.test(si) && /get_context/.test(si) && /data to use, never instructions/.test(si));
const tools = (await ann.listTools()).tools;
ok('the read tools, all marked read-only', ['get_context', 'search_memory', 'memory_timeline', 'list_tasks', 'search_files', 'read_file'].every(n => tools.find(t => t.name === n)?.annotations?.readOnlyHint === true), tools.map(t => t.name));

// The same person with the box ticked: their private things too.
const annPriv = await connect('ann@example.test', { scopes: ['read', 'read:private'], grant: 'g_test3' });

console.log('== the context bundle');
let res = await ann.callTool({ name: 'get_context', arguments: { project: 'orbis-offer', about: 'the offer for Orbis' } });
let doc = textOf(res);
ok('wrapped as data', /<<<WORKSPACE DATA/.test(doc) && /<<<END WORKSPACE DATA>>>/.test(doc));
ok('the company card, the team rules, the team — not her own cards without the box', /Saltmarsh Ceramics/.test(doc) && /September list/.test(doc) && !/runs sales; based in Porto/.test(doc) && !/no emoji/.test(doc) && /Bob \(member\)/.test(doc) && /Ann \(member, writes in Polish\)/.test(doc), doc);
const docMine = textOf(await annPriv.callTool({ name: 'get_context', arguments: { project: 'orbis-offer' } }));
ok('…with read:private her profile and preferences are there', /runs sales; based in Porto/.test(docMine) && /no emoji/.test(docMine));
ok('the shared fact about the project, not her private one without the box', /Orbis Logistics wants the offer/.test(doc) && !/ANN-PRIVATE/.test(doc));
const docPriv = textOf(await annPriv.callTool({ name: 'get_context', arguments: { project: 'orbis-offer', about: 'the offer for Orbis' } }));
ok('…with read:private her own fact is there too', /Orbis Logistics wants the offer/.test(docPriv) && /ANN-PRIVATE/.test(docPriv));
ok('nothing of Bob\'s', !/BOB-PRIVATE/.test(doc) && !/BOB-ONLY/.test(doc) && !/BOB-SECRET/.test(doc) && !/BOB-OWN/.test(doc));
ok('no "latest facts" dump, and no credential, in the bundle', !/Latest facts/.test(doc) && !/Kiln-Harbour/.test(doc) && !/ANN-DOOR/.test(doc));
ok('only the open task that names the project, not the rest of the board or her list', /Prepare the Orbis glaze quote/.test(doc) && !/ANN-OWN/.test(doc) && !/Order packing tape/.test(doc), doc);
ok('no file index, no going-on list: the bundle is about the project, the rest is a tool call away', !/Sales\/pipeline\.md/.test(doc) && !/users\/ann\/notes\.md/.test(doc) && !/Going on/.test(doc) && /search_files/.test(doc));

console.log('== memory');
res = await ann.callTool({ name: 'search_memory', arguments: { query: 'Orbis' } });
doc = textOf(res);
ok('search returns the shared facts with dates, not her private ones without the box', /Orbis offer deadline/.test(doc) && /2026-10-20/.test(doc) && !/ANN-PRIVATE/.test(doc));
const sPriv = textOf(await annPriv.callTool({ name: 'search_memory', arguments: { query: 'Orbis' } }));
ok('…with read:private her own facts come too, marked own', /ANN-PRIVATE/.test(sPriv) && /· own ·/.test(sPriv) && !/BOB-PRIVATE/.test(sPriv));
ok('…and never Bob\'s', !/BOB-PRIVATE/.test(doc));
ok('…as facts, not the conversation\'s lines', !/Stan: Orbis wants/.test(doc) && !/Ann: I promised/.test(doc));
res = await annPriv.callTool({ name: 'search_memory', arguments: { query: 'shop admin login password door code' } });
doc = textOf(res);
ok('even with read:private a fact that looks like a credential is held back, and said so', !/Kiln-Harbour/.test(doc) && !/ANN-SECRET/.test(doc) && !/4417/.test(doc) && /held back: they look like credentials/.test(doc), doc);
res = await ann.callTool({ name: 'search_memory', arguments: { query: 'zzz-nothing-here' } });
ok('nothing found says so', /nothing in memory matches/.test(textOf(res)));
res = await ann.callTool({ name: 'memory_timeline', arguments: { term: 'Orbis' } });
ok('the timeline lists the facts oldest first', /oldest first/.test(textOf(res)) && /Orbis offer deadline/.test(textOf(res)) && !/BOB-PRIVATE/.test(textOf(res)));

console.log('== tasks');
res = await ann.callTool({ name: 'list_tasks', arguments: { which: 'mine' } });
doc = textOf(res);
ok('mine without the box: what is assigned to her on the board, not her own list', /t_board1/.test(doc) && /team board/.test(doc) && !/t_ann1/.test(doc) && !/t_board2/.test(doc) && !/t_bob1/.test(doc));
const mPriv = textOf(await annPriv.callTool({ name: 'list_tasks', arguments: { which: 'mine' } }));
ok('mine with read:private: her own list too', /t_ann1/.test(mPriv) && /own list/.test(mPriv) && /t_board1/.test(mPriv) && !/t_bob1/.test(mPriv));
res = await ann.callTool({ name: 'list_tasks', arguments: { which: 'board' } });
ok('board: the team board only', /t_board2/.test(textOf(res)) && !/t_ann1/.test(textOf(res)));
res = await ann.callTool({ name: 'list_tasks', arguments: { which: 'all' } });
ok('all without the box: the board only, never anyone\'s own', /t_board2/.test(textOf(res)) && !/t_ann1/.test(textOf(res)) && !/t_bob1/.test(textOf(res)));

console.log('== files');
res = await ann.callTool({ name: 'search_files', arguments: { query: 'Orbis' } });
doc = textOf(res);
ok('search finds the shared file, not her private folder without the scope', /Sales\/pipeline\.md/.test(doc) && !/users\/ann/.test(doc) && !/users\/bob/.test(doc));
res = await ann.callTool({ name: 'read_file', arguments: { path: 'Sales/pipeline.md' } });
ok('a shared file reads', /proposal by Thursday/.test(textOf(res)) && !res.isError);
res = await ann.callTool({ name: 'read_file', arguments: { path: 'Sales/access.md' } });
ok('a line shaped like a credential is held back from a shared file, the rest reads', !/Kiln-Harbour/.test(textOf(res)) && /held back/.test(textOf(res)) && /ship on Tuesdays/.test(textOf(res)), textOf(res));
res = await ann.callTool({ name: 'search_files', arguments: { query: 'password' } });
ok('…and from a search hit\'s line', /Sales\/access\.md/.test(textOf(res)) && !/Kiln-Harbour/.test(textOf(res)), textOf(res));
res = await ann.callTool({ name: 'read_file', arguments: { path: 'users/ann/notes.md' } });
ok('her own file is closed without read:private', res.isError === true && !/ANN-NOTE/.test(textOf(res)) && /private folder/.test(textOf(res)));
const annOwn = annPriv;
res = await annOwn.callTool({ name: 'read_file', arguments: { path: 'users/ann/notes.md' } });
ok('with read:private her own file reads', /ANN-NOTE/.test(textOf(res)) && !res.isError);
res = await annOwn.callTool({ name: 'search_files', arguments: { query: 'Orbis' } });
ok('…and search finds it', /users\/ann\/notes\.md/.test(textOf(res)) && !/users\/bob/.test(textOf(res)));
res = await annOwn.callTool({ name: 'read_file', arguments: { path: 'users/bob/secret.md' } });
ok('…and Bob\'s folder is still nobody\'s business', res.isError === true && !/BOB-SECRET/.test(textOf(res)));
res = await ann.callTool({ name: 'read_file', arguments: { path: 'users/bob/secret.md' } });
ok('Bob\'s file does not exist for her', res.isError === true && !/BOB-SECRET/.test(textOf(res)));
res = await ann.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
ok('traversal is refused', res.isError === true);
res = await ann.callTool({ name: 'read_file', arguments: { path: 'memory/MISSION.md' } });
ok('memory is not a file here', res.isError === true);
res = await ann.callTool({ name: 'read_file', arguments: { path: '.allowed-emails.json' } });
ok('the roster file is hidden', res.isError === true && !/stan@example/.test(textOf(res)));

console.log('== resources and the prompt');
const rl = (await ann.listResources()).resources.map(x => x.uri);
ok('the context resources are listed, her own cards not without the box', ['workspace://company/mission', 'workspace://company/rules', 'workspace://team/roster'].every(u => rl.includes(u)) && !rl.includes('workspace://me/profile') && !rl.includes('workspace://me/preferences'), rl);
const rlPriv = (await annPriv.listResources()).resources.map(x => x.uri);
ok('…with it, her profile and preferences too', rlPriv.includes('workspace://me/profile') && rlPriv.includes('workspace://me/preferences'), rlPriv);
let rr = await annPriv.readResource({ uri: 'workspace://me/profile' });
ok('the profile resource is Ann\'s', /based in Porto/.test(rr.contents[0].text) && !/BOB-ONLY/.test(rr.contents[0].text));
rr = await ann.readResource({ uri: 'workspace://company/mission' });
ok('the mission resource', /Saltmarsh/.test(rr.contents[0].text));
rr = await ann.readResource({ uri: 'workspace://files/Sales/pipeline.md' });
ok('a file by resource URI', /proposal by Thursday/.test(rr.contents[0].text));
let threw = false;
try { await ann.readResource({ uri: 'workspace://files/users/bob/secret.md' }); } catch { threw = true; }
ok('Bob\'s file is not a resource for her', threw);
const pr = await ann.getPrompt({ name: 'company-context', arguments: { project: 'orbis-offer' } });
ok('the prompt carries the bundle and the instruction to check memory', /Saltmarsh/.test(pr.messages[0].content.text) && /search_memory/.test(pr.messages[0].content.text));

console.log('== writes');
const W = ['add_task', 'update_task', 'remember', 'log_session', 'write_file'];
const toolsRead = (await ann.listTools()).tools.map(t => t.name);
ok('a read-only grant sees no write tool and no ask tool', W.every(n => !toolsRead.includes(n)) && !toolsRead.some(n => /^ask_/.test(n)), toolsRead);
const annW = await connect('ann@example.test', { scopes: ['read', 'write:tasks', 'write:memory', 'write:files'], grant: 'g_test4' });
const tools2 = (await annW.listTools()).tools;
ok('with the write scopes the write tools are there, not read-only, asking the person first', W.every(n => { const t = tools2.find(x => x.name === n); return t && t.annotations?.readOnlyHint === false && t._meta?.['anthropic/requiresUserInteraction'] === true; }), tools2.map(t => [t.name, t.annotations?.readOnlyHint, t._meta]));
const annT = await connect('ann@example.test', { scopes: ['read', 'write:tasks'], grant: 'g_test7' });
const toolsT = (await annT.listTools()).tools.map(t => t.name);
ok('…each only with its own scope (write:tasks alone: the task tools)', toolsT.includes('add_task') && toolsT.includes('update_task') && !toolsT.includes('remember') && !toolsT.includes('write_file'), toolsT);
await annT.close();
res = await annW.callTool({ name: 'add_task', arguments: { title: 'WRITE-1 call Orbis', description: 'Orbis wants the offer by Thursday; Ann promised to call on Monday.' } });
ok('with write:tasks it is added — to her own list, as from her own chat', !res.isError && /own list/.test(textOf(res)) && T.readScope('user:ann').some(t => t.title === 'WRITE-1 call Orbis' && t.createdBy === 'ann'), textOf(res));
const newId = T.readScope('user:ann').find(t => t.title === 'WRITE-1 call Orbis')?.id;
res = await annW.callTool({ name: 'add_task', arguments: { title: 'WRITE-2 for the team', board: true } });
ok('board: true puts it on the team board', /team board/.test(textOf(res)) && T.readScope('shared').some(t => t.title === 'WRITE-2 for the team'));
res = await annW.callTool({ name: 'add_task', arguments: { title: 'Fix login', description: 'the admin password is Hunter-Kiln-77!' } });
ok('a credential in a task is refused', res.isError === true && /credential/.test(textOf(res)) && !T.readScope('user:ann').some(t => t.title === 'Fix login'));
res = await annW.callTool({ name: 'update_task', arguments: { id: newId, status: 'done' } });
ok('update_task changes her own task', !res.isError && T.readScope('user:ann').find(t => t.id === newId)?.status === 'done', textOf(res));
res = await annW.callTool({ name: 'update_task', arguments: { id: 't_bob1', status: 'done' } });
ok('…never Bob\'s', res.isError === true && T.readScope('user:bob').find(t => t.id === 't_bob1')?.status === 'backlog');
res = await annW.callTool({ name: 'remember', arguments: { text: 'Staging runs on the Hetzner box in Falkenstein.', said: 'Staging runs on the Hetzner box in Falkenstein.' } });
ok('remember files the person\'s words in her own memory', !res.isError && L.read({ scopes: ['user:ann'] }).some(r => /Falkenstein/.test(r.text)), textOf(res));
res = await annW.callTool({ name: 'remember', arguments: { text: 'The CMS password is Kiln-Harbour-42!', said: 'The CMS password is Kiln-Harbour-42!' } });
ok('…a credential is refused', res.isError === true && !L.read({ scopes: ['user:ann'] }).some(r => /Kiln-Harbour-42/.test(r.text) && r.source === 'note'));
res = await annW.callTool({ name: 'log_session', arguments: { project: 'orbis-landing', summary: 'Built the pricing section from the September list. Decided: no discount shown publicly. Open: the OG image.' } });
const sess = () => F.visible(['user:ann']).filter(f => /^Context MCP: orbis-landing \(/.test(f.title || ''));
ok('log_session files one fact in her own memory, by the agent, as a plain fact', !res.isError && sess().length === 1 && sess()[0].by === 'agent:claude-code' && sess()[0].kind === 'fact' && /According to a Claude Code session/.test(sess()[0].text), [textOf(res), sess()]);
ok('…the record is the agent\'s, private', L.read({ scopes: ['user:ann'] }).some(r => r.source === 'agent' && r.speaker === 'Claude Code' && /orbis-landing/.test(r.text)) && !L.read({ scopes: ['shared'] }).some(r => r.source === 'agent'));
res = await annW.callTool({ name: 'log_session', arguments: { project: 'orbis-landing', summary: 'Also added the FAQ block.' } });
ok('a second summary the same day stays one fact (updated), not two', !res.isError && sess().length === 1, sess().map(f => f.text));
res = await annW.callTool({ name: 'write_file', arguments: { path: 'pricing.md', content: '# Pricing\n\n| tier | price |\n' } });
ok('a bare file name goes into her own folder', !res.isError && existsSync(join(ROOT, 'users', 'ann', 'pricing.md')), textOf(res));
res = await annW.callTool({ name: 'write_file', arguments: { path: 'Sales/tiers.csv', content: 'tier,price\nbasic,100\n' } });
ok('an existing shared folder takes a file', !res.isError && existsSync(join(ROOT, 'Sales', 'tiers.csv')));
for (const [path, why] of [['memory/MISSION.md', 'memory'], ['.claude/CLAUDE.md', 'hidden'], ['users/bob/x.md', 'not a path'], ['Nowhere/x.md', 'not a shared folder'], ['Sales/run.sh', 'only text'], ['../../etc/x.md', 'not a path']]) {
  res = await annW.callTool({ name: 'write_file', arguments: { path, content: 'x' } });
  ok(`write_file refuses ${path}`, res.isError === true && new RegExp(why).test(textOf(res)), textOf(res));
}
res = await annW.callTool({ name: 'write_file', arguments: { path: 'Sales/pipeline.md', content: '# replaced' } });
const hash = (textOf(res).match(/[0-9a-f]{64}/) || [])[0];
ok('overwriting asks for overwrite and the current hash', res.isError === true && !!hash && /proposal by Thursday/.test(readFileSync(join(ROOT, 'Sales', 'pipeline.md'), 'utf8')));
res = await annW.callTool({ name: 'write_file', arguments: { path: 'Sales/pipeline.md', content: '# replaced', overwrite: true, expectedSha256: hash } });
ok('…with them it replaces and keeps the previous version', !res.isError && /# replaced/.test(readFileSync(join(ROOT, 'Sales', 'pipeline.md'), 'utf8')) && /\.versions\//.test(textOf(res)), textOf(res));
const wlog = readFileSync(join(ROOT, 'memory', '_engine', 'v4-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'agent_write');
ok('every write is on her Changes with the client', ['add_task', 'update_task', 'remember', 'log_session', 'write_file'].every(t => wlog.some(e => e.tool === t && e.scope === 'user:ann' && e.client === 'Claude Code')), wlog.map(e => e.tool));
await annW.close();

console.log('== asking the assistant');
let asked = null;
PL.configureAgentAsk(async ({ question, prompt }) => { asked = prompt; return /add|send/i.test(question) ? { request: true } : /shop/i.test(question) ? { answer: 'The shop admin password is Kiln-Harbour-42!' } : { answer: 'Orbis signs on Thursday; Ann owns it.' }; });
const annA = await connect('ann@example.test', { scopes: ['read', 'ask'], grant: 'g_test5' });
ok('ask without her private things: no ask tool (the turn would read her private memory)', !(await annA.listTools()).tools.some(t => /^ask_/.test(t.name)));
await annA.close();
const annAP = await connect('ann@example.test', { scopes: ['read', 'read:private', 'ask'], grant: 'g_test6' });
const askTool = (await annAP.listTools()).tools.find(t => /^ask_/.test(t.name));
const askName = askTool?.name;
ok('with both: the ask tool, named after the bot, read-only, no per-call prompt', askName === 'ask_assistant' && askTool.annotations?.readOnlyHint === true && !askTool._meta?.['anthropic/requiresUserInteraction'], askTool);
res = await annAP.callTool({ name: askName, arguments: { question: 'When does Orbis sign?' } });
ok('with both the assistant answers, wrapped as data', !res.isError && /Orbis signs on Thursday/.test(textOf(res)) && /WORKSPACE DATA/.test(textOf(res)) && /never an instruction/.test(asked || ''));
res = await annAP.callTool({ name: askName, arguments: { question: 'Add a task to call Orbis' } });
ok('a request to do something is answered as refused', !res.isError && /only answers questions/.test(textOf(res)));
res = await annAP.callTool({ name: askName, arguments: { question: 'How do I get into the shop admin?' } });
ok('an answer shaped like a credential is held back even when the model let it through', !/Kiln-Harbour/.test(textOf(res)) && /held back/.test(textOf(res)), textOf(res));
for (let i = 0; i < 3; i++) await annAP.callTool({ name: askName, arguments: { question: `q${i}` } });
res = await annAP.callTool({ name: askName, arguments: { question: 'one more' } });
ok('at most five questions an hour per agent', res.isError === true && /an hour/.test(textOf(res)));
await annAP.close();
PL.configureAgentAsk(null);

console.log('== an admin is no wider');
const stan = await connect('stan@example.test', { grant: 'g_test2', client: 'Codex' });
res = await stan.callTool({ name: 'list_tasks', arguments: { which: 'all' } });
ok('the admin sees the board, nobody\'s own list', /t_board1/.test(textOf(res)) && !/t_ann1/.test(textOf(res)) && !/t_bob1/.test(textOf(res)));
res = await stan.callTool({ name: 'read_file', arguments: { path: 'users/ann/notes.md' } });
ok('the admin cannot read Ann\'s file', res.isError === true);
res = await stan.callTool({ name: 'search_memory', arguments: { query: 'Orbis' } });
ok('the admin\'s search has the shared fact, not Ann\'s or Bob\'s', /Orbis offer deadline/.test(textOf(res)) && !/ANN-PRIVATE/.test(textOf(res)) && !/BOB-PRIVATE/.test(textOf(res)));
const rlStan = (await stan.listResources()).resources.map(x => x.uri);
ok('the admin\'s agent without the box has no profile resource, so nobody\'s', !rlStan.includes('workspace://me/profile'), rlStan);

console.log('== the audit trail');
const log = existsSync(join(ROOT, 'memory', '_engine', 'v4-log.jsonl')) ? readFileSync(join(ROOT, 'memory', '_engine', 'v4-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
const reads = log.filter(e => e.op === 'agent_read');
ok('every read is on the person\'s Changes with the client and the tool', reads.some(e => e.scope === 'user:ann' && e.client === 'Claude Code' && e.tool === 'search_memory' && e.what === 'Orbis') && reads.some(e => e.scope === 'user:stan' && e.client === 'Codex' && e.tool === 'list_tasks'), reads.slice(0, 3));
ok('…under the person, never under the other', !reads.some(e => e.scope === 'user:bob'));

await ann.close(); await annPriv.close(); await stan.close();
server.close();
console.log(`mcp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
