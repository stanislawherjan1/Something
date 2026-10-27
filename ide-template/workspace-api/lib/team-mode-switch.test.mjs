/**
 * Switching collaboration off and on: off is refused while anyone else is on
 * the team (the answer names them), allowed once the owner is alone; on
 * switching on, a workspace connection can be made the owner's own —
 * re-encrypted under their key, its server renamed, the team's gone.
 * Run: node lib/team-mode-switch.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'mode-'));
const STORE = mkdtempSync(join(tmpdir(), 'mode-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '56'.repeat(32));
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
process.env.INTEGRATIONS_RATE_MAX = '1000';
process.env.SECURE_FILES_DIR = join(STORE, 'files');
process.env.INTEGRATIONS_DATA_DIR = join(STORE, 'data');
mkdirSync(join(ROOT, '.team'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', slot: 1 },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', slot: 2 },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('team-mode-switch: no crypto key here — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
const T = await import('./team.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/team.js')).default());
app.use('/api', (await import('../routes/integrations.js')).default());
app.use('/api', (await import('../routes/memory-v4.js')).default());
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const call = async (who, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { 'x-test-actor': who } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// A routine that needs a service: a person's own connection counts for them.
mkdirSync(join(ROOT, 'memory', 'users', 'ann'), { recursive: true });
let r = await call('ann@example.test', 'POST', '/routines/catalog/inbox-hourly');
ok('with no mailbox at all, the inbox routine waits for one', r.status === 409, r);
store.activate('email-imap@ann', { items: [{ fields: { EMAIL_PROVIDER: 'gmail', EMAIL_USER: 'ann@example.test', EMAIL_PASS: 'pw-ann', EMAIL_ID: 'work', EMAIL_ALLOW_SEND: 'no' } }] }, { owner: 'ann', reach: 'personal' });
r = await call('ann@example.test', 'POST', '/routines/catalog/inbox-hourly');
ok('her own mailbox is enough for her', r.status === 200 || r.status === 201, r);
r = await call('stan@example.test', 'POST', '/routines/catalog/inbox-hourly');
ok('...but not for the admin, who has none', r.status === 409, r);
r = await call('ann@example.test', 'GET', '/routines/catalog');
ok('her Marketplace shows mail as connected', (r.body.groups || []).some(g => g.id === 'email-imap' && g.connected === true), r.body.groups?.map(g => [g.id, g.connected]));
store.remove('email-imap@ann');

r = await call('stan@example.test', 'PUT', '/team/mode', { enabled: false });
ok('switching off with someone else on the team is refused', r.status === 409 && T.getTeamMode() === true, r);
ok('...and the answer names them', (r.body.others || []).map(o => o.name).join() === 'Ann', r.body.others);
r = await call('ann@example.test', 'PUT', '/team/mode', { enabled: false });
ok('a member cannot switch at all', r.status === 403 && T.getTeamMode() === true, r.status);
T.remove({ email: 'ann@example.test', actor: 'stan@example.test' });
r = await call('stan@example.test', 'PUT', '/team/mode', { enabled: false });
ok('alone, the owner switches off', r.status === 200 && T.getTeamMode() === false, r);
// Solo keeps the owner's cards flat; switching on hands them over at once, not at the next boot.
mkdirSync(join(ROOT, 'memory'), { recursive: true });
writeFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), '# USER_PROFILE\n- Lives in SOLO-TOWN\n');
// What solo left in shared memory (the migration's) is the owner's when collaboration comes on.
const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const mig = await L.append({ scope: 'shared', source: 'migration', ts: '2026-06-01T10:00:00Z', text: 'Stan founded ResearchTech in 2023 (SOLO-HISTORY).', tags: { entities: [{ name: 'ResearchTech', kind: 'company' }] } });
F.apply('shared', [{ op: 'add', fact: { title: 'ResearchTech founding', text: 'Stan founded ResearchTech in 2023 (SOLO-HISTORY).', kind: 'fact', entities: [{ name: 'ResearchTech', kind: 'company' }] } }], { record: mig.id, standing: 'said', by: 'migration', ts: '2026-06-01T10:00:00Z' });
const kept = await L.append({ scope: 'shared', source: 'note', ts: '2026-06-02T10:00:00Z', text: 'The team uses Linear for issues (TEAM-KNOWLEDGE).', origin: 'user:stan', tags: { sharedFact: true, from: 'stan' } });
F.apply('shared', [{ op: 'add', fact: { title: 'Linear for issues', text: 'The team uses Linear for issues (TEAM-KNOWLEDGE).', kind: 'fact' } }], { record: kept.id, standing: 'said', by: 'note', ts: '2026-06-02T10:00:00Z' });
// The solo board is the owner's: it becomes their own list with the switch.
const TK = await import('./tasks.js');
TK.writeTasks([{ id: 't_solo1', title: 'SOLO-TASK one', status: 'backlog', owner: 'me', order: 0, createdAt: '2026-06-01T10:00:00Z' }, { id: 't_solo2', title: 'SOLO-TASK two', status: 'done', owner: null, order: 0, createdAt: '2026-06-01T10:00:00Z', completed: '2026-06-02' }]);
r = await call('stan@example.test', 'PUT', '/team/mode', { enabled: true });
ok('...and on again', r.status === 200 && T.getTeamMode() === true, r);
ok('the solo board is the owner\'s own list now', TK.readScope('user:stan').map(t => t.title).sort().join() === 'SOLO-TASK one,SOLO-TASK two' && TK.readScope('user:stan').every(t => t.owner === 'stan'), TK.readScope('user:stan'));
ok('...and the team starts with an empty board', TK.readTasks().length === 0);
ok('...the answer says so', r.body.movedTasks?.moved === 2, r.body);
ok('the owner\'s profile card moves to their private memory with the switch', (() => { try { return /SOLO-TOWN/.test(readFileSync(join(ROOT, 'memory', 'users', 'stan', 'USER_PROFILE.md'), 'utf8')); } catch { return false; } })());
ok('...and no flat copy is left for the team', (() => { try { readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md')); return false; } catch { return true; } })());
ok('solo history leaves shared memory', !F.all('shared').some(f => /SOLO-HISTORY/.test(f.text)) && !L.read({ scopes: ['shared'] }).some(x => /SOLO-HISTORY/.test(x.text)), F.all('shared').map(f => f.text));
ok('...and is the owner\'s private memory', F.all('user:stan').some(f => /SOLO-HISTORY/.test(f.text)) && L.read({ scopes: ['user:stan'] }).some(x => /SOLO-HISTORY/.test(x.text)));
ok('a fact shared on purpose stays shared', F.all('shared').some(f => /TEAM-KNOWLEDGE/.test(f.text)));
ok('the answer says what moved', r.body.movedToOwner?.moved === 1 && r.body.movedToOwner?.facts === 1, r.body);
r = await call('stan@example.test', 'PUT', '/team/mode', { enabled: true });
ok('switching on again moves nothing twice', r.status === 200 && !r.body.movedToOwner && !r.body.movedTasks && F.all('user:stan').filter(f => /SOLO-HISTORY/.test(f.text)).length === 1, r.body);
// Off again (the route calls this; the switch itself is rate-limited here): the
// owner's list rejoins the board, and on again it is theirs once more.
ok('off again: the owner\'s list rejoins the board', (() => {
  const off = TK.ownerListToSolo('stan');
  const back = TK.readTasks().map(t => t.title).sort().join() === 'SOLO-TASK one,SOLO-TASK two' && TK.readScope('user:stan').length === 0;
  const on = TK.soloBoardToOwner('stan');
  return off.moved === 2 && back && on.moved === 2 && TK.readScope('user:stan').length === 2 && TK.readTasks().length === 0;
})());

// On switching on: a connection the owner keeps for themselves.
store.activate('trello', { fields: { TRELLO_API_KEY: 'k-solo', TRELLO_TOKEN: 't-solo' } }, { owner: 'stan', reach: 'workspace', access: 'write' });
store.activate('email-imap', { items: [{ fields: { EMAIL_PROVIDER: 'gmail', EMAIL_USER: 'stan@example.test', EMAIL_PASS: 'pw-solo', EMAIL_ID: 'me', EMAIL_ALLOW_SEND: 'no' } }] }, { owner: 'stan', reach: 'workspace', access: 'write' });
r = await call('stan@example.test', 'POST', '/integrations/trello/make-personal');
ok('the owner keeps Trello for themselves', r.status === 200 && r.body.key === 'trello@stan' && !store.isActive('trello') && store.isActive('trello@stan'), r);
ok('...its secret intact under the new key', store.decryptFor('trello@stan').TRELLO_TOKEN === 't-solo');
ok('...as their own', store.ownership('trello@stan').reach === 'personal' && store.ownership('trello@stan').owner === 'stan');
r = await call('stan@example.test', 'POST', '/integrations/email-imap/make-personal');
ok('a mailbox with accounts moves too', r.status === 200 && store.isActive('email-imap@stan') && store.decryptFor('email-imap@stan')[0].EMAIL_PASS === 'pw-solo', r);
ok('...its accounts file is the owner\'s now', (() => { try { return /stan@example.test/.test(readFileSync(join(STORE, 'files', 'email', 'accounts@stan.json'), 'utf8')); } catch { return false; } })());
const bot = Object.keys(JSON.parse(readFileSync(process.env.BOT_CLAUDE_CONFIG, 'utf8')).mcpServers);
ok('the brain (the owner\'s) has them under their own names', bot.includes('trello-mine') && !bot.includes('trello'), bot);
r = await call('stan@example.test', 'POST', '/integrations/telegram/make-personal');
ok('the bot\'s own Telegram cannot be made anyone\'s', r.status === 400 || r.status === 404, r.status);
r = await call('stan@example.test', 'POST', '/integrations/trello/make-personal');
ok('a connection already moved: refused', r.status === 400, r.status);

// The whole answer in one request: several connections, one hit on the rate limit.
store.activate('linear', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 'l-solo' }) } }, { owner: 'stan', reach: 'workspace', access: 'write' });
store.activate('notion', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 'n-solo' }) } }, { owner: 'stan', reach: 'workspace', access: 'write' });
store.activate('shopify', { fields: { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' } }, { owner: 'stan', reach: 'workspace', access: 'write' });
r = await call('stan@example.test', 'POST', '/integrations/make-personal', { ids: ['linear', 'notion', 'shopify', 'telegram'] });
ok('several move at once; one that cannot be anyone\'s is named', r.status === 200 && r.body.moved.sort().join() === 'linear@stan,notion@stan,shopify@stan' && r.body.failed.map(f => f.id).join() === 'telegram', r.body);
ok('...each with its secret intact', store.decryptFor('linear@stan').OAUTH_TOKENS.includes('l-solo') && store.decryptFor('shopify@stan').SHOPIFY_CLIENT_SECRET === 'b');
r = await call('ann@example.test', 'POST', '/integrations/make-personal', { ids: ['parallel'] });
ok('a member cannot take the team\'s', r.status === 403 || r.status === 401, r.status);

server.close();
console.log(`team-mode-switch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
