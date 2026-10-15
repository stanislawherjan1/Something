/**
 * The authorization matrix of the integrations and memory routes: every
 * route that touches a person's own things, called as an admin, as the
 * owner, as another member and as someone not on the roster. Nobody reaches
 * another person's connection, questions or sources; a member changes
 * nothing of the workspace's.
 * Run: node lib/integrations-authz.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'authz-'));
const STORE = mkdtempSync(join(tmpdir(), 'authz-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '12'.repeat(32));
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
process.env.INTEGRATIONS_RATE_MAX = '1000';
process.env.SECURE_FILES_DIR = join(STORE, 'files');
process.env.INTEGRATIONS_DATA_DIR = join(STORE, 'data');
mkdirSync(join(ROOT, '.team'), { recursive: true });
for (const s of ['stan', 'ann', 'bob']) mkdirSync(join(ROOT, 'memory', 'users', s), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', slot: 1 },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', slot: 2 },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z', slot: 3 },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('integrations-authz: the crypto key is not readable in this environment — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
const A = await import('./memory-asks.js');
(await import('./memory-llm.js')).configureRunner(async ({ schema }) => (schema?.properties?.decisions ? { decisions: [] } : {}));

store.activate('trello', { fields: { TRELLO_API_KEY: 'team-key-xyz', TRELLO_TOKEN: 'team-token-xyz' } }, { owner: 'stan', reach: 'workspace', access: 'read' });
store.activate('trello@ann', { fields: { TRELLO_API_KEY: 'ann-key-xyz', TRELLO_TOKEN: 'ann-token-xyz' } }, { owner: 'ann', reach: 'personal' });
store.activate('granola@bob', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 'bob-oauth-xyz' }) } }, { owner: 'bob', reach: 'personal' });
const askId = A.addAsk('ann', { text: 'Vellmark starts the pilot on 4 November.', question: 'Share?', ts: '2026-10-13T10:00:00Z', source: 'web' });

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/integrations.js')).default());
app.use('/api', (await import('../routes/memory-v4.js')).default());
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const WHO = { admin: 'stan@example.test', owner: 'ann@example.test', other: 'bob@example.test', stranger: 'zed@example.test', nobody: null };
const call = async (who, method, path, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (WHO[who]) headers['x-test-actor'] = WHO[who];
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), text: '' };
};
const refused = (s) => s === 401 || s === 403 || s === 404;
const SECRETS = ['team-key-xyz', 'team-token-xyz', 'ann-key-xyz', 'ann-token-xyz', 'bob-oauth-xyz'];
const leaks = (o) => { const t = JSON.stringify(o); return SECRETS.filter(v => t.includes(v)); };

// ─── another person's own connection: never reachable ────────────────────────
const annsTrello = '/integrations/trello?reach=personal&slug=ann';
for (const [who, want] of [['other', 'refused'], ['stranger', 'refused'], ['nobody', 'refused'], ['owner', 200]]) {
  if (who === 'owner') ok('Ann\'s token did not change under another member\'s hand', store.decryptFor('trello@ann').TRELLO_TOKEN === 'ann-token-xyz');
  for (const [method, path, body] of [
    ['GET', annsTrello], ['PATCH', annsTrello, { fields: { TRELLO_TOKEN: 'changed' } }], ['POST', '/integrations/trello/test?reach=personal&slug=ann'],
    ['POST', '/integrations/trello/items?reach=personal&slug=ann', { fields: { TRELLO_API_KEY: 'x', TRELLO_TOKEN: 'y' } }], ['PATCH', '/integrations/trello/items/0?reach=personal&slug=ann', { fields: {} }],
  ]) {
    const r = await call(who, method, path, body);
    if (want === 'refused' && method === 'GET') ok(`${who}: ${method} ${path.split('?')[0]} shows nothing of Ann's own`, refused(r.status) || (!r.body.mine?.active && !leaks(r.body).length && !JSON.stringify(r.body).includes('"owner":"ann"')), { status: r.status, mine: r.body.mine, leaks: leaks(r.body) });
    else if (want === 'refused') ok(`${who}: ${method} ${path.split('?')[0]} of Ann's own is refused`, refused(r.status), r.status);
    else ok(`${who}: ${method} ${path.split('?')[0]} of their own is not refused for being someone else's`, r.status !== 403, { status: r.status, body: r.body });
  }
}
// ─── the workspace's: admins only ─────────────────────────────────────────────
for (const who of ['owner', 'other', 'stranger', 'nobody']) {
  for (const [method, path, body] of [
    ['PUT', '/integrations/trello', { fields: { TRELLO_API_KEY: 'a', TRELLO_TOKEN: 'b' } }], ['PATCH', '/integrations/trello', { access: 'write' }], ['DELETE', '/integrations/trello'],
    ['PUT', '/integrations/trello/paused', { paused: true }], ['PUT', '/integrations/shopify', { fields: { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' } }],
  ]) {
    const r = await call(who, method, path, body);
    ok(`${who}: ${method} ${path} (the workspace's) is refused`, refused(r.status), r.status);
  }
}
ok('the workspace\'s Trello is still read-only and connected', store.isActive('trello') && store.accessOf('trello') === 'read');
// ─── what a list shows ────────────────────────────────────────────────────────
for (const who of ['owner', 'other']) {
  const r = await call(who, 'GET', '/integrations');
  const text = JSON.stringify(r.body);
  ok(`${who}: the list carries no secret of anyone`, !leaks(r.body).length, leaks(r.body));
  const trello = (r.body.integrations || []).find(i => i.id === 'trello');
  ok(`${who}: sees no one else's own connection`, trello && trello.activeFor === undefined && (who === 'owner' ? trello.mine?.active === true : !trello.mine?.active), trello?.mine);
}
for (const who of ['stranger', 'nobody']) { const r = await call(who, 'GET', '/integrations'); ok(`${who}: no list at all`, refused(r.status), r.status); }
// ─── a person's memory: their questions, their sources ───────────────────────
for (const who of ['other', 'stranger', 'nobody']) {
  const r = await call(who, 'POST', `/memory/v4/asks/${askId}`, { decision: 'share' });
  ok(`${who}: cannot answer Ann's question`, refused(r.status) || r.body.ok === false, { status: r.status, body: r.body });
}
ok('Ann\'s question is still pending', A.listAsks('ann', { status: 'pending' }).length === 1);
let r = await call('other', 'GET', '/memory/v4/privacy');
ok('Bob\'s Sharing tab shows none of Ann\'s questions', r.status === 200 && !(r.body.asks || []).some(a => /Vellmark/.test(a.text)), r.body.asks);
r = await call('other', 'GET', '/memory/v4/sources');
ok('Bob\'s sources are his own only', r.status === 200 && (r.body.items || []).every(s => s.key === 'granola@bob'), r.body.items?.map(s => s.key));
r = await call('owner', 'POST', '/memory/v4/sources/granola@bob', { on: false });
ok('Ann cannot switch Bob\'s source', refused(r.status) || r.body.ok === false, r.status);
r = await call('owner', 'POST', '/memory/v4/sources/granola@bob/run');
ok('...nor run it', refused(r.status) || r.status === 400, r.status);
for (const who of ['stranger', 'nobody']) {
  for (const path of ['/memory/v4/privacy', '/memory/v4/sources', '/memory/v4/facts', '/memory/v4/overview']) {
    const x = await call(who, 'GET', path);
    ok(`${who}: ${path} is refused`, refused(x.status), x.status);
  }
  const m = await call(who, 'POST', '/memory/v4/sharing/mode', { mode: 'auto' });
  ok(`${who}: cannot set a sharing mode`, refused(m.status), m.status);
}
// ─── the turn-only routes need a turn identity, whoever is on the socket ──────
for (const path of ['/internal/memory/v4/search?q=x', '/internal/memory/v4/timeline?term=x', '/internal/memory/v4/now']) {
  const x = await call('admin', 'GET', path);
  ok(`${path.split('?')[0]} without a turn token is refused`, x.status === 403, x.status);
}
r = await call('admin', 'POST', '/internal/memory/v4/note', { text: 'x', said: 'x' });
ok('a note without a turn token is refused', r.status === 403, r.status);
// ─── an admin: the workspace's, yes; a member's own, remove only ─────────────
r = await call('admin', 'PATCH', '/integrations/trello', { access: 'write' });
ok('the admin changes the workspace\'s access', r.status === 200 && store.accessOf('trello') === 'write', r.body);
r = await call('admin', 'GET', '/integrations');
ok('the admin sees who has their own, by name, without their secrets', (r.body.integrations.find(i => i.id === 'trello')?.activeFor || []).some(p => p.slug === 'ann') && !leaks(r.body).length, leaks(r.body));
r = await call('admin', 'DELETE', '/integrations/trello?reach=personal&slug=ann&reason=test');
ok('the admin may disconnect a member\'s own', r.status === 200 && !store.isActive('trello@ann'), r.body);

server.close();
console.log(`integrations-authz: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
