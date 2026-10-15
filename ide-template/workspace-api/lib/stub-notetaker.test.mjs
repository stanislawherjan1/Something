/**
 * Imports from a notetaker, with the stand-in server (test-fixtures/stub-notetaker):
 * the workspace's connection feeds its owner's scope, a member's own feeds the
 * member's, nothing reaches the other or the shared scope — and each is read
 * with its own token. Also: a loopback server is reached without the egress
 * proxy, and the local catalog reloads when its file changes.
 * Run: node lib/stub-notetaker.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'stub-nt-'));
const STORE = mkdtempSync(join(tmpdir(), 'stub-nt-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'cd'.repeat(32));
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
process.env.INTEGRATIONS_CATALOG_LOCAL = join(STORE, 'catalog.local.json');
mkdirSync(join(ROOT, '.team'), { recursive: true });
for (const s of ['stan', 'ann']) mkdirSync(join(ROOT, 'memory', 'users', s), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', timezone: 'UTC', addedAt: '2026-09-01T00:00:00Z', slot: 1 },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', timezone: 'UTC', addedAt: '2026-09-01T00:00:00Z', slot: 2 },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };

// The stand-in server first: the local catalog needs its port.
const stub = await import('../test-fixtures/stub-notetaker/server.mjs');
const LOG = join(STORE, 'stub.log');
const srv = await stub.start({ log: LOG });
const main = JSON.parse(readFileSync(join(here, '..', 'integrations.catalog.json'), 'utf8'));
const otter = main.integrations.find(i => i.id === 'otter');
const localCatalog = (url) => writeFileSync(process.env.INTEGRATIONS_CATALOG_LOCAL, JSON.stringify({ integrations: [{ ...otter, mcp: { ...otter.mcp, url } }] }));
localCatalog(srv.url);

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('stub-notetaker: the crypto key is not readable in this environment — skipped'); await srv.close(); process.exit(0); }
const catalog = await import('./integrations/catalog.js');
const store = await import('./integrations/store.js');
const L = await import('./memory-ledger.js');
const S = await import('./memory-sources.js');
const E = await import('./embedder-client.js');
E.configureEmbedder(async () => { throw new Error('none'); });
// A stand-in for the model: the meeting pass returns the bullets as the summary; the notes pass one note per bullet; nothing merges.
(await import('./memory-llm.js')).configureRunner(async ({ user, schema }) => {
  const text = String(user);
  const bullets = text.split('\n').filter(l => /^- /.test(l)).map(l => l.slice(2));
  if (schema?.properties?.summary) return { with: [], title: '', summary: bullets.join(' ').slice(0, 900), names: [], upcoming: [] };
  if (schema?.properties?.notes) return { notes: bullets.slice(0, 4).map(q => ({ title: q.split(' ').slice(0, 4).join(' '), text: q, kind: 'fact', evidence: q, names: [] })) };
  if (schema?.properties?.decisions) return { decisions: [] };
  return {};
});

ok('the local catalog points Otter at the stand-in', catalog.get('otter')?.mcp?.url === srv.url, catalog.get('otter')?.mcp?.url);

// The workspace's Otter (Stan's) and Ann's own, each with its own token.
store.activate('otter', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 'ws-token' }) } }, { owner: 'stan', reach: 'workspace', access: 'read' });
store.activate('otter@ann', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 'ann-token' }) } }, { owner: 'ann', reach: 'personal' });
ok('each person has one Otter source of their own', S.listFor('stan').map(s => s.key).join() === 'otter' && S.listFor('ann').map(s => s.key).join() === 'otter@ann', { stan: S.listFor('stan'), ann: S.listFor('ann') });

const lines = [];
const log = (m) => lines.push(m);
// The nightly turn, should anything fall back to it: a stand-in that only records the ask.
const turns = [];
const runTurn = async (o) => { turns.push(o); return '0 meetings'; };
const rs = await S.runFor('stan', { log, runTurn });
const ra = await S.runFor('ann', { log, runTurn });
ok('the workspace connection brought its two meetings', rs.items === 2 && !rs.error, { rs, lines });
ok('the member\'s own brought her one', ra.items === 1 && !ra.error, { ra, lines });
ok('nothing was read through a turn', turns.length === 0, turns.map(t => t.servers));

const convs = (scope) => [...new Set(L.read({ scopes: [scope], includeHidden: true }).map(r => r.conv))].filter(c => /^import:/.test(c)).sort();
ok('Stan\'s scope holds the workspace meetings only', convs('user:stan').join() === 'import:otter:m-ws-1,import:otter:m-ws-2', convs('user:stan'));
ok('Ann\'s scope holds her meeting only', convs('user:ann').join() === 'import:otter:m-ann-1', convs('user:ann'));
ok('nothing was imported into the shared scope', convs('shared').length === 0, convs('shared'));
ok('...nor into any other place under memory/', !existsSync(join(ROOT, 'memory', 'users', 'bob')));

const asked = readFileSync(LOG, 'utf8').trim().split('\n').map(l => l.split('\t'));
ok('the workspace connection was read with its token, the member\'s with hers', asked.filter(a => a[0] === 'ws-token' && a[2]).every(a => /^m-ws-/.test(a[2])) && asked.filter(a => a[0] === 'ann-token' && a[2]).every(a => a[2] === 'm-ann-1') && asked.some(a => a[0] === 'ws-token') && asked.some(a => a[0] === 'ann-token'), asked);
ok('no call carried another token', asked.every(a => ['ws-token', 'ann-token'].includes(a[0])), asked.map(a => a[0]));

// A second night: nothing new, nothing written twice.
const again = await S.runFor('stan', { log, runTurn });
ok('the same meetings again are skipped', again.items === 0 && !again.error && convs('user:stan').length === 2, again);

// The local catalog changes under a running server: the next lookup sees it.
await new Promise(r => setTimeout(r, 20));
localCatalog('http://127.0.0.1:1/mcp');
ok('the local catalog reloads when its file changes', catalog.get('otter')?.mcp?.url === 'http://127.0.0.1:1/mcp', catalog.get('otter')?.mcp?.url);
const dead = await S.runFor('stan', { log, runTurn });
ok('...and a server that is gone is a logged error, not a crash', dead.items === 0 && lines.some(l => /otter: /.test(l)), { dead, lines: lines.slice(-2) });

await srv.close();
console.log(`stub-notetaker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
