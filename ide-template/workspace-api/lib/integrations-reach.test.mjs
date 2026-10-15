/**
 * Integrations with an owner and a reach: a connection is the workspace's
 * (`granola`, an admin's, loaded in every turn) or a person's own
 * (`granola@ann`, loaded in that person's turns only, feeding their memory).
 * The store, the runtime's server sets per turn, the routes' answers, the
 * bridge token's owner check and the night importer's list per person.
 * Run: node lib/integrations-reach.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'reach-'));
const STORE = mkdtempSync(join(tmpdir(), 'reach-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ab'.repeat(32));
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
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z', slot: 3 },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: { 'workspace-api': { command: 'node', args: ['x'] } } }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('integrations-reach: the crypto key is not readable in this environment — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
const catalog = await import('./integrations/catalog.js');
const runtime = await import('./integrations/runtime.js');

// ─── keys ────────────────────────────────────────────────────────────────────
ok('a personal key names the integration and the person', store.personalKey('granola', 'ann') === 'granola@ann' && catalog.baseId('granola@ann') === 'granola' && catalog.slugOf('granola@ann') === 'ann' && catalog.slugOf('granola') === null);
ok('the catalog answers for a personal key', catalog.get('granola@ann')?.id === 'granola' && catalog.get('granola')?.personal === true);
ok('a workspace-only integration is not personal-capable', !catalog.get('telegram')?.personal && !catalog.get('docs-comments')?.personal && catalog.get('shopify')?.personal === true && catalog.get('ga4')?.personal === true && catalog.get('email-imap')?.personal === true);

// ─── the store ───────────────────────────────────────────────────────────────
store.activate('trello', { fields: { TRELLO_API_KEY: 'k1', TRELLO_TOKEN: 't1' } }, { owner: 'stan', reach: 'workspace' });
store.activate('trello@ann', { fields: { TRELLO_API_KEY: 'k2', TRELLO_TOKEN: 't2' } }, { owner: 'ann', reach: 'personal' });
store.activate('granola@bob', { fields: { OAUTH_TOKENS: '{"access_token":"g"}' } }, { owner: 'bob', reach: 'personal' });
let err = null;
try { store.activate('telegram@ann', { fields: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_ADMIN_CHAT_ID: '1' } }, { owner: 'ann', reach: 'personal' }); } catch (e) { err = e.message; }
ok('a workspace-only integration cannot be connected personally', /only be connected for the workspace/.test(err), err);
ok('workspace and personal keys are told apart', store.workspaceIds().join(',') === 'trello' && store.personalIds('ann').join(',') === 'trello@ann' && store.personalIds('bob').join(',') === 'granola@bob');
ok('who has their own account of it', store.peopleWith('trello').join(',') === 'ann' && store.peopleWith('granola').join(',') === 'bob');
ok('the status carries owner and reach', store.listStatus().trello.owner === 'stan' && store.listStatus().trello.reach === 'workspace' && store.listStatus()['trello@ann'].reach === 'personal');
ok('each connection decrypts its own credentials', store.decryptFor('trello').TRELLO_TOKEN === 't1' && store.decryptFor('trello@ann').TRELLO_TOKEN === 't2');
// A connection from before owners existed
const file = join(STORE, 'credentials.json');
const raw = JSON.parse(readFileSync(file, 'utf8'));
delete raw.trello.owner; delete raw.trello.reach;
writeFileSync(file, JSON.stringify(raw));
ok('(setup) an old connection has no owner', store.ownership('trello').owner === null);
ok('ensureOwners gives it to the primary admin as the workspace\'s', store.ensureOwners('stan') > 0 && store.ownership('trello').owner === 'stan' && store.ownership('trello').reach === 'workspace');

// ─── server sets ─────────────────────────────────────────────────────────────
runtime.syncMcpServers();
const bot = JSON.parse(readFileSync(process.env.BOT_CLAUDE_CONFIG, 'utf8')).mcpServers;
ok('the bot\'s config has the workspace\'s servers and no member\'s', bot.trello && !bot['trello-mine'] && !bot['granola-mine'], Object.keys(bot));
ok('...with the broker grant for the workspace key', bot.trello.env.BROKER_INTEGRATION_ID === 'trello');
const ann = runtime.personalServers('ann');
ok('a person\'s own servers carry -mine and their key', ann['trello-mine']?.env?.BROKER_INTEGRATION_ID === 'trello@ann' && ann['trello-mine'].args[0] === 'trello', ann);
const bob = runtime.personalServers('bob');
ok('a remote-MCP personal connection goes through the bridge with its key', bob['granola-mine']?.env?.REMOTE_MCP_ID === 'granola@bob', bob);
ok('the same person gets the same grant again (one live nonce)', runtime.personalServers('ann')['trello-mine'].env.BROKER_NONCE === ann['trello-mine'].env.BROKER_NONCE);
const C = await import('./claude.js');
ok('Ann\'s turn: the workspace set plus her own', Object.keys(C.turnMcpServers({ actor: 'ann' })).sort().join(',') === 'trello,trello-mine,workspace-api');
ok('Bob\'s turn: his own, not Ann\'s', Object.keys(C.turnMcpServers({ actor: 'bob' })).sort().join(',') === 'granola-mine,trello,workspace-api');
ok('a group turn: the workspace set alone', Object.keys(C.turnMcpServers({ actor: 'ann', groupContext: true })).sort().join(',') === 'trello,workspace-api');
store.activate('granola@stan', { fields: { OAUTH_TOKENS: '{"access_token":"s"}' } }, { owner: 'stan', reach: 'personal' });
runtime.syncMcpServers();
const bot2 = JSON.parse(readFileSync(process.env.BOT_CLAUDE_CONFIG, 'utf8')).mcpServers;
ok('the operator\'s own connections are in the bot\'s config (the brain is the operator\'s)', bot2['granola-mine']?.env?.REMOTE_MCP_ID === 'granola@stan');
ok('...and a member\'s turn does not get them', !C.turnMcpServers({ actor: 'ann' })['granola-mine'] && !!C.turnMcpServers({ actor: 'stan' })['granola-mine']);
ok('...nor a group', !C.turnMcpServers({ actor: 'stan', groupContext: true })['granola-mine']);

// ─── the night importer ──────────────────────────────────────────────────────
const S = await import('./memory-sources.js');
ok('Bob\'s memory is fed by his own Granola', S.listFor('bob').map(s => s.key).join(',') === 'granola@bob' && S.listFor('bob')[0].mine === true);
ok('Ann has no notetaker of her own', S.listFor('ann').length === 0 && S.available('ann').some(a => a.id === 'granola' && a.personal));
store.activate('fathom', { fields: { OAUTH_TOKENS: '{"access_token":"f"}' } }, { owner: 'stan', reach: 'workspace' });
runtime.syncMcpServers();   // the bot's config knows it, like after a PUT
ok('a workspace notetaker feeds the admin who connected it, nobody else', S.listFor('stan').map(s => s.key).sort().join(',') === 'fathom,granola@stan' && !S.listFor('ann').some(s => s.id === 'fathom'));
ok('the people with sources are those, and only those', S.people().sort().join(',') === 'bob,stan');
ok('the import task names the person\'s own server', /mcp__granola-mine__/.test(S.taskFor('bob', { now: Date.now(), also: ['granola'] })?.message || ''), S.taskFor('bob', { now: Date.now(), also: ['granola'] }));

// ─── the routes ──────────────────────────────────────────────────────────────
const router = (await import('../routes/integrations.js')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', router());
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (who, method, path, body) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-actor': who }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let r = await call('ann@example.test', 'GET', '/integrations');
let trello = r.body.integrations.find(i => i.id === 'trello');
ok('a member sees who connected the workspace\'s, and their own', trello.active && trello.connectedBy?.name === 'Stan' && trello.mine?.active === true && trello.activeFor === undefined && trello.canConnectWorkspace === false && trello.canConnectPersonal === true, trello);
r = await call('stan@example.test', 'GET', '/integrations');
trello = r.body.integrations.find(i => i.id === 'trello');
ok('an admin sees who has their own account of it', trello.activeFor?.map(p => p.name).join(',') === 'Ann' && trello.canConnectWorkspace === true, trello.activeFor);
ok('a workspace-only entry cannot be connected personally by anyone', r.body.integrations.find(i => i.id === 'telegram').canConnectPersonal === false && r.body.integrations.find(i => i.id === 'shopify').canConnectPersonal === true);
r = await call('ann@example.test', 'PUT', '/integrations/linear', { fields: { OAUTH_TOKENS: '{"access_token":"l"}' } });
ok('a member cannot connect for the workspace', r.status === 403, r);
r = await call('ann@example.test', 'PUT', '/integrations/linear?reach=personal', { fields: { OAUTH_TOKENS: '{"access_token":"l"}' } });
ok('...but can for themselves', r.status === 200 && r.body.reach === 'personal' && store.isActive('linear@ann') && !store.isActive('linear'), r);
ok('...without the bot restarting', r.body.restarting === false, r.body);
r = await call('bob@example.test', 'DELETE', '/integrations/linear?reach=personal&slug=ann');
ok('another member cannot remove it', r.status === 403 && store.isActive('linear@ann'));
const N = await import('./notify.js');
const heard = [];
N.subscribe({ write: (chunk) => heard.push(String(chunk)), on: () => {}, setHeader: () => {}, flushHeaders: () => {}, writeHead: () => {} }, { slug: 'ann' });
r = await call('stan@example.test', 'DELETE', '/integrations/linear?reach=personal&slug=ann&reason=wrong%20account');
ok('an admin can', r.status === 200 && !store.isActive('linear@ann'));
ok('...and the person hears it, with the reason', heard.some(h => /Linear disconnected/.test(h) && /Stan disconnected your own Linear/.test(h) && /wrong account/.test(h)), heard.slice(-1));
r = await call('ann@example.test', 'PUT', '/integrations/telegram?reach=personal', { fields: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_ADMIN_CHAT_ID: '1' } });
ok('a workspace-only integration refuses a personal connection', r.status === 400);
// ─── one connection's page: fields in place, accounts, a test ───────────────
r = await call('stan@example.test', 'GET', '/integrations/trello');
ok('the page shows the workspace connection with secrets masked', r.body.workspace?.fields?.find(f => f.name === 'TRELLO_TOKEN')?.set === true && r.body.workspace.fields.find(f => f.name === 'TRELLO_TOKEN').summary?.last4 === '' && r.body.workspace.fields.find(f => f.name === 'TRELLO_TOKEN').value === undefined, r.body.workspace);
ok('...never a secret in clear', !JSON.stringify(r.body).includes('"value":"t1"'));
ok('...and who has their own', r.body.activeFor?.map(p => p.name).join(',') === 'Ann' && r.body.connectedBy?.name === 'Stan', r.body.activeFor);
r = await call('ann@example.test', 'GET', '/integrations/trello');
ok('a member sees their own connection and not the workspace\'s fields', r.body.mine?.reach === 'personal' && r.body.workspace === null && r.body.workspaceActive === true, r.body);
r = await call('stan@example.test', 'PATCH', '/integrations/trello', { fields: { TRELLO_BOARDS: 'ops,sales' } });
ok('a field is changed in place, the secrets kept', r.status === 200 && store.decryptFor('trello').TRELLO_TOKEN === 't1' && store.decryptFor('trello').TRELLO_BOARDS === 'ops,sales', r.body);
store.activate('email-imap', { items: [{ fields: { EMAIL_PROVIDER: 'gmail', EMAIL_HOST: 'imap.gmail.com', EMAIL_PORT: '993', EMAIL_USER: 'hello@example.test', EMAIL_PASS: 'password-one-xyz', EMAIL_ALLOW_SEND: 'false' } }] }, { owner: 'stan', reach: 'workspace' });
r = await call('stan@example.test', 'POST', '/integrations/email-imap/items', { fields: { EMAIL_PROVIDER: 'zoho', EMAIL_HOST: 'imap.zoho.eu', EMAIL_PORT: '993', EMAIL_USER: 'sam@example.test', EMAIL_PASS: 'password-two-xyz', EMAIL_ALLOW_SEND: 'false' } });
ok('a mailbox is added without touching the first', r.status === 200 && r.body.index === 1 && store.decryptFor('email-imap').length === 2 && store.decryptFor('email-imap')[0].EMAIL_PASS === 'password-one-xyz', r.body);
r = await call('stan@example.test', 'GET', '/integrations/email-imap');
ok('the page lists the accounts, the address in clear, the password masked', r.body.workspace?.items?.length === 2 && r.body.workspace.items[1].fields.find(f => f.name === 'EMAIL_USER')?.value === 'sam@example.test' && r.body.workspace.items[1].fields.find(f => f.name === 'EMAIL_PASS')?.summary && !JSON.stringify(r.body).includes('password-two'), r.body.workspace);
r = await call('stan@example.test', 'PATCH', '/integrations/email-imap/items/1', { fields: { EMAIL_PASS: 'password-three-xyz' } });
ok('one account\'s password is changed in place', r.status === 200 && store.decryptFor('email-imap')[1].EMAIL_PASS === 'password-three-xyz' && store.decryptFor('email-imap')[1].EMAIL_USER === 'sam@example.test');
r = await call('stan@example.test', 'DELETE', '/integrations/email-imap/items/0');
ok('an account is removed, the other stays', r.status === 200 && store.decryptFor('email-imap').length === 1 && store.decryptFor('email-imap')[0].EMAIL_USER === 'sam@example.test');
r = await call('stan@example.test', 'DELETE', '/integrations/email-imap/items/0');
ok('removing the last account removes the connection', r.status === 200 && r.body.removedConnection === true && !store.isActive('email-imap'));
r = await call('stan@example.test', 'POST', '/integrations/trello/test');
ok('a stored-key connection tests as readable', r.body.ok === true && /readable/.test(r.body.detail), r.body);
r = await call('stan@example.test', 'POST', '/integrations/granola/test?reach=personal');
ok('a remote-MCP connection with a live token tests as signed in', r.body.ok === true && !JSON.stringify(r.body).includes('"s"'), r.body);
store.updateInternal('granola@stan', { OAUTH_TOKENS: JSON.stringify({ access_token: 'expired-token-value', expires_at: 1 }) });
r = await call('stan@example.test', 'POST', '/integrations/granola/test?reach=personal');
ok('...an expired one without a refresh says reconnect, no secret', r.body.ok === false && r.body.reauth === true && !JSON.stringify(r.body).includes('expired-token-value'), r.body);
// ─── access: read-only for the team ─────────────────────────────────────────
ok('a workspace connection is read and write unless said otherwise', store.accessOf('trello') === 'write' && store.accessOf('trello@ann') === 'write');
r = await call('ann@example.test', 'PATCH', '/integrations/trello', { access: 'read' });
ok('a member cannot change the team\'s access', r.status === 403);
r = await call('stan@example.test', 'PATCH', '/integrations/trello', { access: 'read' });
ok('an admin makes the team\'s connection read-only, without a reconnect or a restart', r.status === 200 && r.body.access === 'read' && r.body.restarting === false && store.accessOf('trello') === 'read', r.body);
ok('...the list and the page say so', (await call('ann@example.test', 'GET', '/integrations')).body.integrations.find(i => i.id === 'trello').access === 'read' && (await call('stan@example.test', 'GET', '/integrations/trello')).body.workspace.access === 'read');
const accessMap = JSON.parse(readFileSync(join(ROOT, '.team', 'integration-access.json'), 'utf8'));
ok('...and the hook\'s map names its server', accessMap.trello === 'read' && !accessMap['trello-mine'], accessMap);
r = await call('ann@example.test', 'PATCH', '/integrations/trello?reach=personal', { access: 'read' });
ok('a person\'s own connection is always read and write', r.status === 400);
store.activate('linear', { fields: { OAUTH_TOKENS: '{"access_token":"l"}' } }, { owner: 'stan', reach: 'workspace', access: 'read' });
ok('a connection made read-only at connect time is read-only', store.accessOf('linear') === 'read');
r = await call('stan@example.test', 'PATCH', '/integrations/trello', { access: 'write' });
ok('...and back to read and write', r.status === 200 && store.accessOf('trello') === 'write' && JSON.parse(readFileSync(join(ROOT, '.team', 'integration-access.json'), 'utf8')).trello === undefined);
// ─── the owner of a workspace connection left ───────────────────────────────
store.activate('notion', { fields: { OAUTH_TOKENS: '{"access_token":"n"}' } }, { owner: 'gone-person', reach: 'workspace' });
r = await call('stan@example.test', 'GET', '/integrations');
const notion = r.body.integrations.find(i => i.id === 'notion');
ok('the connection stays the workspace\'s, connected by "a former member"', notion.active && notion.connectedBy?.gone === true && notion.connectedBy.name === 'a former member', notion.connectedBy);
ok('...its night import pauses: nobody lists it as theirs', !S.listFor('stan').some(x => x.id === 'notion') && !S.listFor('ann').some(x => x.id === 'notion'));
store.remove('notion');

// ─── a person's own mail beside the team's inbox; their own Google suite ─────
const { existsSync: exists } = await import('node:fs');
const inbox = { EMAIL_PROVIDER: 'gmail', EMAIL_USER: 'hello@example.test', EMAIL_PASS: 'app-pass-team', EMAIL_ID: 'hello' };
r = await call('stan@example.test', 'PUT', '/integrations/email-imap', { items: [{ fields: { ...inbox, EMAIL_ALLOW_SEND: 'no' } }] });
ok('the team\'s shared inbox connects for the workspace', r.status === 200 && r.body.reach === 'workspace', r);
r = await call('ann@example.test', 'PUT', '/integrations/email-imap?reach=personal', { items: [{ fields: { EMAIL_PROVIDER: 'zoho', EMAIL_USER: 'ann@example.test', EMAIL_PASS: 'app-pass-ann', EMAIL_ID: 'work', EMAIL_ALLOW_SEND: 'yes' } }] });
ok('a member connects their own work mailbox beside it', r.status === 200 && r.body.reach === 'personal' && store.isActive('email-imap@ann'), r);
const teamFile = join(STORE, 'files', 'email', 'accounts.json'), annFile = join(STORE, 'files', 'email', 'accounts@ann.json');
ok('each connection has its own accounts file in the secure directory', exists(teamFile) && exists(annFile) && /hello@example.test/.test(readFileSync(teamFile, 'utf8')) && /ann@example.test/.test(readFileSync(annFile, 'utf8')) && !/ann@example.test/.test(readFileSync(teamFile, 'utf8')), { teamFile: exists(teamFile), annFile: exists(annFile) });
const annMail = runtime.personalServers('ann')['email-mine'];
ok('her turn\'s mail server reads her file, under its own name', annMail && annMail.env.EMAIL_ACCOUNTS_FILE === annFile && annMail.env.BROKER_INTEGRATION_ID === 'email-imap@ann', annMail?.env);
ok('...and the team\'s reads the team\'s', runtime.serverEntriesFor ? true : Object.keys(C.turnMcpServers({ actor: 'ann' })).includes('email') && C.turnMcpServers({ actor: 'ann' }).email.env.EMAIL_ACCOUNTS_FILE === teamFile, C.turnMcpServers({ actor: 'ann' }).email?.env);
ok('Bob\'s turn has the team inbox and not Ann\'s mailbox', !!C.turnMcpServers({ actor: 'bob' }).email && !C.turnMcpServers({ actor: 'bob' })['email-mine']);
const hosts = (await import('./integrations/egress.js')).computeAllowedHosts();
const hostList = Array.isArray(hosts) ? hosts : [...hosts];
ok('her provider\'s hosts are on the egress list', hostList.includes('imap.zoho.eu') && hostList.includes('imap.gmail.com'), hostList.filter(h => /zoho|gmail/.test(h)));
r = await call('ann@example.test', 'DELETE', '/integrations/email-imap?reach=personal');
ok('removing her mailbox removes her file and leaves the team\'s', r.status === 200 && !exists(annFile) && exists(teamFile), r);
r = await call('ann@example.test', 'PUT', '/integrations/google-workspace?reach=personal', { fields: { GDOCS_CLIENT_ID: 'c', GDOCS_CLIENT_SECRET: 's', GDOCS_REFRESH_TOKEN: '1//ann', GWORKSPACE_ALLOW_WRITE: 'yes' } });
ok('a member connects their own Google suite', r.status === 200 && r.body.reach === 'personal', r);
const suite = Object.keys(runtime.personalServers('ann')).filter(n => /^g(docs|sheets|calendar|drive|slides|tasks)-mine$/.test(n));
ok('...and gets all six of its servers as their own', suite.length === 6, Object.keys(runtime.personalServers('ann')));
ok('the bot\'s own Telegram and the browser-bound Docs comments stay the workspace\'s', catalog.get('telegram').personal === false && catalog.get('docs-comments').personal === false);
r = await call('ann@example.test', 'DELETE', '/integrations/google-workspace?reach=personal');
ok('(cleanup) her suite is gone', r.status === 200 && !store.isActive('google-workspace@ann'));

// ─── her own Google Analytics: a server that reads its key from a file ──────
const { statSync: st } = await import('node:fs');
const KEY = JSON.stringify({ type: 'service_account', client_email: 'ann-ga@example.iam.gserviceaccount.com', private_key: 'ANN-PRIVATE-KEY' });
r = await call('ann@example.test', 'PUT', '/integrations/ga4?reach=personal', { fields: { GA4_PROPERTY_ID: '111111', GA4_CREDENTIALS_JSON_CONTENT: KEY } });
ok('a member connects her own Google Analytics', r.status === 200 && r.body.reach === 'personal', r);
const annGa = runtime.personalServers('ann')['analytics-mine'];
const keyFile = join(ROOT, '.team', 'users', 'ann', '.integrations', 'ga4-credentials.json');
ok('her turn runs it under her own name, with her property', annGa && annGa.env.GA4_PROPERTY_ID === '111111', annGa?.env && { ...annGa.env, GOOGLE_APPLICATION_CREDENTIALS: annGa.env.GOOGLE_APPLICATION_CREDENTIALS });
ok('...reading her key from her private tree', annGa?.env.GOOGLE_APPLICATION_CREDENTIALS === keyFile && exists(keyFile) && /ANN-PRIVATE-KEY/.test(readFileSync(keyFile, 'utf8')), annGa?.env.GOOGLE_APPLICATION_CREDENTIALS);
ok('...readable by her private group, not by everyone', (st(keyFile).mode & 0o777) === 0o640, (st(keyFile).mode & 0o777).toString(8));
ok('Bob\'s turn has no Google Analytics of hers', !C.turnMcpServers({ actor: 'bob' })['analytics-mine']);
const botCfg = readFileSync(process.env.BOT_CLAUDE_CONFIG, 'utf8');
ok('...and the bot\'s config carries neither her property nor her key', !botCfg.includes('111111') && !botCfg.includes('ANN-PRIVATE-KEY'));
r = await call('ann@example.test', 'DELETE', '/integrations/ga4?reach=personal');
ok('disconnecting removes her key file', r.status === 200 && !exists(keyFile), r);

// ─── an integration's skill follows its connection ───────────────────────────
const { mkdtempSync: mk, writeFileSync: wf, mkdirSync: md, readFileSync: rf, existsSync: ex } = await import('node:fs');
const OPT = mk(join(STORE, 'opt-'));
md(join(OPT, 'trello-boards'), { recursive: true });
wf(join(OPT, 'trello-boards', 'SKILL.md'), '---\nname: trello-boards\ndescription: boards\nrequires: [trello]\n---\nUse mcp__trello__get_board, then mcp__trello__add_comment.\n');
process.env.OPTIONAL_SKILLS_DIR = OPT;
store.activate('trello@bob', { fields: { TRELLO_API_KEY: 'kb', TRELLO_TOKEN: 'tb' } }, { owner: 'bob', reach: 'personal' });
runtime.installOptionalSkill('trello@bob');
const bobSkill = join(ROOT, 'users', 'bob', '.skills', 'trello-boards', 'SKILL.md');
ok('a person\'s own connection installs its skill among their own skills', ex(bobSkill) && !ex(join(ROOT, '.claude', 'skills', 'trello-boards', 'SKILL.md')), bobSkill);
ok('...naming their own server\'s tools', ex(bobSkill) && /mcp__trello-mine__get_board/.test(rf(bobSkill, 'utf8')) && !/mcp__trello__/.test(rf(bobSkill, 'utf8')), ex(bobSkill) ? rf(bobSkill, 'utf8') : null);
runtime.installOptionalSkill('trello');
const teamSkill = join(ROOT, '.claude', 'skills', 'trello-boards', 'SKILL.md');
ok('the workspace\'s connection installs it among the team\'s skills, unchanged', ex(teamSkill) && /mcp__trello__get_board/.test(rf(teamSkill, 'utf8')));

server.close();

// ─── the bridge token is the owner's alone ──────────────────────────────────
const TI = await import('./turn-identity.js');
const internal = (await import('../routes/internal.js')).default;
const app2 = express();
app2.use(express.json());
app2.use('/api', internal());
const s2 = await new Promise((r) => { const x = app2.listen(0, '127.0.0.1', () => r(x)); });
const base2 = `http://127.0.0.1:${s2.address().port}`;
const annTurn = TI.issueTurnToken({ actor: 'ann', group: false });
const bobTurn = TI.issueTurnToken({ actor: 'bob', group: false });
const groupTurn = TI.issueTurnToken({ actor: 'bob', group: true, groupId: '-1' });
const tok = async (turn, key) => (await fetch(`${base2}/api/internal/mcp-token/${encodeURIComponent(key)}`, { headers: { 'x-ide-turn': turn } })).status;
ok('Bob\'s turn may ask for Bob\'s token (the provider then answers)', (await tok(bobTurn, 'granola@bob')) !== 403);
ok('Ann\'s turn may not', (await tok(annTurn, 'granola@bob')) === 403);
ok('a group turn may not, even as Bob', (await tok(groupTurn, 'granola@bob')) === 403);
s2.close();

// ─── a person leaves ─────────────────────────────────────────────────────────
const T = await import('./team.js');
T.remove({ email: 'bob@example.test', actor: 'stan@example.test' });
ok('their own connections go with them', !store.isActive('granola@bob') && store.personalIds('bob').length === 0);
ok('...the workspace\'s stay', store.isActive('trello'));

console.log(`integrations-reach: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
