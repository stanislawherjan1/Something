/**
 * The integrations store under a seeded random sequence of operations —
 * connect for the workspace or for oneself, change a field, add and remove
 * accounts, switch access, disconnect, a person leaving — with the
 * invariants checked after every step: a key decrypts to what was written,
 * ownership and reach match the key, nobody's own appears in another's list
 * or in the bot's config, only read-only team servers are in the access map,
 * a departed person leaves nothing behind.
 * Run: node lib/integrations-store-fuzz.test.mjs [seed]
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SEED = Number(process.argv[2]) || 7;
const ROOT = mkdtempSync(join(tmpdir(), `store-fuzz-${SEED}-`));
const STORE = mkdtempSync(join(tmpdir(), `store-fuzz-${SEED}-store-`));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '34'.repeat(32));
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
process.env.SECURE_FILES_DIR = join(STORE, 'files');
process.env.INTEGRATIONS_DATA_DIR = join(STORE, 'data');
mkdirSync(join(ROOT, '.team'), { recursive: true });
const PEOPLE = ['stan', 'kat', 'ann', 'bob', 'eve'];
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify(PEOPLE.map((slug, i) => ({ email: `${slug}@example.test`, role: i < 2 ? 'admin' : 'member', slug, displayName: slug, addedAt: '2026-09-01T00:00:00Z', slot: i + 1 }))));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: { 'workspace-api': { command: 'node', args: ['x'] } } }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let x = SEED >>> 0; const rnd = () => { x += 0x6D2B79F5; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('integrations-store-fuzz: no crypto key here — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
const runtime = await import('./integrations/runtime.js');
const catalog = await import('./integrations/catalog.js');
const T = await import('./team.js');

// What a connection of each service needs, with secrets that say whose they are.
const SERVICES = {
  trello:  (tag) => ({ TRELLO_API_KEY: `key-${tag}`, TRELLO_TOKEN: `tok-${tag}` }),
  shopify: (tag) => ({ SHOPIFY_STORE_DOMAIN: `${tag}.myshopify.com`, SHOPIFY_CLIENT_ID: `cid-${tag}`, SHOPIFY_CLIENT_SECRET: `sec-${tag}` }),
  github:  (tag) => ({ GITHUB_PERSONAL_ACCESS_TOKEN: `github_pat_${tag}`, GITHUB_TOOLSETS: 'repos', GITHUB_ALLOW_WRITE: 'no' }),
  granola: (tag) => ({ OAUTH_TOKENS: JSON.stringify({ access_token: `oauth-${tag}` }) }),
  otter:   (tag) => ({ OAUTH_TOKENS: JSON.stringify({ access_token: `oauth-${tag}` }) }),
};
const expect = new Map();   // key → { owner, reach, access, tag }
let alive = new Set(PEOPLE), step = 0;
const admins = () => ['stan', 'kat'].filter(a => alive.has(a));

function invariants(label) {
  const status = store.listStatus();
  for (const [key, e] of expect) {
    const plain = store.decryptFor(key);
    const want = SERVICES[catalog.baseId(key)](e.tag);
    const secret = Object.entries(want).find(([k]) => /TOKEN|SECRET|KEY/.test(k));
    ok(`${label}: ${key} decrypts to its own secret`, plain[secret[0]] === secret[1], { got: plain[secret[0]], want: secret[1] });
    const own = store.ownership(key);
    ok(`${label}: ${key} owner and reach match the key`, own.owner === e.owner && own.reach === e.reach && (e.reach === 'workspace' ? store.accessOf(key) === e.access : true), own);
    if (e.reach === 'personal') ok(`${label}: ${key} is listed as its person's`, store.personalIds(e.owner).includes(key) && store.peopleWith(catalog.baseId(key)).includes(e.owner));
  }
  for (const key of Object.keys(status)) ok(`${label}: ${key} in the store is one we connected`, expect.has(key), key);
  // nobody's own in another's list
  for (const p of PEOPLE) for (const k of store.personalIds(p)) ok(`${label}: ${k} belongs to ${p}`, catalog.slugOf(k) === p);
  // the bot's config: workspace + the primary admin's own
  runtime.syncMcpServers();
  const bot = Object.keys(JSON.parse(readFileSync(process.env.BOT_CLAUDE_CONFIG, 'utf8')).mcpServers);
  const operator = T.primaryAdminSlug();
  const mineInBot = bot.filter(n => n.endsWith('-mine'));
  const operatorOwn = store.personalIds(operator).map(k => catalog.get(k)?.mcp?.name || catalog.baseId(k)).map(n => `${n}-mine`);
  ok(`${label}: the bot's config carries only the operator's own among personal servers`, mineInBot.every(n => operatorOwn.includes(n)), { mineInBot, operatorOwn, operator });
  for (const [key, e] of expect) if (e.reach === 'workspace') ok(`${label}: the bot has the workspace's ${key}`, bot.includes(catalog.get(key)?.mcp?.name || key), bot);
  // the access map: exactly the read-only team servers
  const map = JSON.parse(readFileSync(join(ROOT, '.team', 'integration-access.json'), 'utf8'));
  const readOnly = [...expect].filter(([, e]) => e.reach === 'workspace' && e.access === 'read').map(([k]) => catalog.get(k)?.mcp?.name || k).sort();
  ok(`${label}: the access map names the read-only team servers and no other`, Object.keys(map).sort().join() === readOnly.join(), { map, readOnly });
  // each person's own servers: theirs only
  for (const p of alive) {
    const names = Object.keys(runtime.personalServers(p));
    const want = store.personalIds(p).map(k => `${catalog.get(k)?.mcp?.name || catalog.baseId(k)}-mine`).sort();
    ok(`${label}: ${p}'s own servers are exactly theirs`, names.sort().join() === want.join(), { names, want });
  }
}

for (step = 1; step <= 60; step++) {
  const op = pick(['connect', 'connect', 'connect', 'personal', 'personal', 'personal', 'change', 'access', 'disconnect', 'leave']);
  try {
    if (op === 'connect' && admins().length) {
      const id = pick(Object.keys(SERVICES)); const owner = pick(admins()); const access = pick(['read', 'write']);
      const tag = `ws${step}`;
      store.activate(id, { fields: SERVICES[id](tag) }, { owner, reach: 'workspace', access });
      expect.set(id, { owner, reach: 'workspace', access, tag });
    } else if (op === 'personal') {
      const id = pick(Object.keys(SERVICES)); const owner = pick([...alive]);
      const key = store.personalKey(id, owner); const tag = `${owner}${step}`;
      store.activate(key, { fields: SERVICES[id](tag) }, { owner, reach: 'personal' });
      expect.set(key, { owner, reach: 'personal', access: 'write', tag });
      runtime.forgetPersonalServers(owner);
    } else if (op === 'change' && expect.size) {
      const key = pick([...expect.keys()]); const e = expect.get(key); const tag = `${e.tag}c`;
      store.activate(key, { fields: SERVICES[catalog.baseId(key)](tag) }, { owner: e.owner, reach: e.reach, access: e.access });
      e.tag = tag;
      if (e.reach === 'personal') runtime.forgetPersonalServers(e.owner);
    } else if (op === 'access') {
      const ws = [...expect].filter(([, e]) => e.reach === 'workspace');
      if (ws.length) { const [key, e] = pick(ws); e.access = e.access === 'read' ? 'write' : 'read'; store.setAccess(key, e.access); }
    } else if (op === 'disconnect' && expect.size) {
      const key = pick([...expect.keys()]); const e = expect.get(key);
      store.remove(key); expect.delete(key);
      if (e.reach === 'personal') runtime.forgetPersonalServers(e.owner);
    } else if (op === 'leave' && alive.size > 2) {
      const members = [...alive].filter(p => !['stan'].includes(p));
      const who = pick(members);
      T.remove({ email: `${who}@example.test`, actor: 'stan@example.test' });
      alive.delete(who);
      for (const [key, e] of [...expect]) if (e.reach === 'personal' && e.owner === who) expect.delete(key);
      runtime.forgetPersonalServers(who);
      ok(`step ${step}: ${who} left and their own connections went with them`, store.personalIds(who).length === 0, store.personalIds(who));
    }
  } catch (err) { ok(`step ${step}: ${op} did not throw`, false, err.message); }
  invariants(`step ${step} (${op})`);
}
console.log(`integrations-store-fuzz (seed ${SEED}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
