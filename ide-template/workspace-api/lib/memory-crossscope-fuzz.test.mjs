/**
 * Cross-scope fuzz: seeded random private, shared and group memory for a
 * team of six, then every memory route, the turn-only routes and the turn
 * prefix read as each person and as a group turn. No other person's private
 * text may ever show; the team's shows to all; a group's to its members only.
 * Run: node lib/memory-crossscope-fuzz.test.mjs [seed]
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const SEED = Number(process.argv[2]) || 20261014;
const ROOT = mkdtempSync(join(tmpdir(), `xscope-${SEED}-`));
const STORE = mkdtempSync(join(tmpdir(), `xscope-${SEED}-store-`));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
const PEOPLE = [['stan', 'admin'], ['kat', 'admin'], ['ann', 'member'], ['bob', 'member'], ['eve', 'member'], ['tom', 'member']];
const GROUP = '-100777000333', IN_GROUP = ['stan', 'ann', 'bob'];
mkdirSync(join(ROOT, '.team'), { recursive: true });
for (const [s] of PEOPLE) mkdirSync(join(ROOT, 'memory', 'users', s), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify(PEOPLE.map(([slug, role], i) => ({ email: `${slug}@example.test`, role, slug, displayName: slug[0].toUpperCase() + slug.slice(1), addedAt: '2026-09-01T00:00:00Z', slot: i + 1, telegramChatId: String(1000 + i) }))));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { [GROUP]: { title: 'Ops', addedAt: '2026-09-01T00:00:00Z', members: Object.fromEntries(IN_GROUP.map((s, i) => [String(1000 + PEOPLE.findIndex(p => p[0] === s)), s])) } } }));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let x = SEED >>> 0; const rnd = () => { x += 0x6D2B79F5; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const S = await import('./memory-sharing.js');
const T = await import('./team.js');
const C = await import('./claude.js');
const ti = await import('./turn-identity.js');
(await import('./embedder-client.js')).configureEmbedder(async () => { throw new Error('none'); });
(await import('./memory-llm.js')).configureRunner(async ({ schema }) => (schema?.properties?.decisions ? { decisions: [] } : {}));

// ─── the memory: private lines per person, team facts, a group's lines ───────
const TOPICS = ['Quarry', 'Vellmark', 'Harbor', 'Orbis', 'Pakto'];
const mine = {};     // slug → their private tokens
for (const [slug] of PEOPLE) {
  mine[slug] = [];
  const n = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const tok = `SECRET-${slug.toUpperCase()}-${i}`;
    const topic = pick(TOPICS);
    const r = await L.append({ scope: `user:${slug}`, source: pick(['web', 'telegram']), ts: new Date(Date.parse('2026-10-01T09:00:00Z') + Math.floor(rnd() * 12 * 86400_000)).toISOString(), conv: `c-${slug}-${i}`, speaker: slug, text: `${slug}: ${topic} ${tok} ${pick(['pays late', 'starts the pilot', 'renews in March', 'wants a demo'])}.`, tags: { entities: [{ name: topic, kind: 'company' }] } });
    await F.remember(`user:${slug}`, [{ title: `${topic} ${tok}`, text: `${topic}: ${tok} ${pick(['pays late', 'starts the pilot'])}.`, kind: 'fact', subject: topic, concerns: 'a company or project', entities: [{ name: topic, kind: 'company' }] }], { record: r.id, by: 'web', standing: 'said', conv: `c-${slug}-${i}` });
    mine[slug].push(tok);
  }
}
const team = [];
for (const [slug] of PEOPLE) if (rnd() < 0.7) {
  const tok = `TEAM-${slug.toUpperCase()}`;
  const topic = pick(TOPICS);
  const out = await S.fileTeamFact(slug, { title: `${topic} ${tok}`, text: `${topic} ${tok} moves to October.`, kind: 'fact', subject: topic, concerns: "the team's work", evidence: `${topic} ${tok} moves to October`, entities: [{ name: topic, kind: 'project' }] }, { ts: '2026-10-05T10:00:00Z', conv: `c-${slug}-share`, source: 'web', name: slug });
  if (out.recordId) team.push(tok);
}
const group = [];
for (let i = 0; i < 4; i++) {
  const tok = `GROUP-${i}`;
  await L.append({ scope: `group:${GROUP}`, source: 'group', ts: `2026-10-0${i + 2}T10:00:00Z`, conv: `g-${i}`, speaker: pick(IN_GROUP), text: `${pick(IN_GROUP)}: ${pick(TOPICS)} ${tok} demo in the group.` });
  group.push(tok);
}

// ─── every way of reading, as each person ────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/memory-v4.js')).default());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api`;
const get = async (path, { actor = null, token = null } = {}) => {
  const headers = {};
  if (actor) headers['x-test-actor'] = `${actor}@example.test`;
  if (token) headers['X-IDE-Turn'] = token;
  const r = await fetch(base + path, { headers });
  return { status: r.status, text: await r.text() };
};
const all = Object.values(mine).flat();
const foreign = (slug, text) => all.filter(t => !mine[slug].includes(t) && text.includes(t));
const READS = ['/memory/v4/facts?history=1&limit=500', '/memory/v4/overview', '/memory/v4/changes', '/memory/v4/privacy', '/memory/v4/topics', '/memory/v4/search?q=SECRET', '/memory/v4/search?q=pilot', '/memory/v4/prefs'];
const TURN_READS = ['/internal/memory/v4/search?q=SECRET', '/internal/memory/v4/search?q=Quarry', '/internal/memory/v4/timeline?term=SECRET', '/internal/memory/v4/timeline?term=Vellmark', '/internal/memory/v4/now'];
const everyRecord = L.allScopes().flatMap(sc => L.read({ scopes: [sc], includeHidden: true }).map(r => ({ scope: sc, id: r.id })));
for (const [slug] of PEOPLE) {
  const token = ti.issueTurnToken({ actor: slug });
  let seenOwn = false, seenTeam = false, seenGroup = false, leaks = [];
  for (const path of READS) {
    const r = await get(path, { actor: slug });
    ok(`${slug}: ${path.split('?')[0]} answers`, r.status === 200, { path, status: r.status, text: r.text.slice(0, 200) });
    leaks.push(...foreign(slug, r.text));
    if (mine[slug].some(t => r.text.includes(t))) seenOwn = true;
    if (team.some(t => r.text.includes(t))) seenTeam = true;
    if (group.some(t => r.text.includes(t))) seenGroup = true;
  }
  for (const path of TURN_READS) {
    const r = await get(path, { token });
    ok(`${slug}'s turn: ${path.split('?')[0]} answers`, r.status === 200, { path, status: r.status, text: r.text.slice(0, 200) });
    leaks.push(...foreign(slug, r.text));
    if (mine[slug].some(t => r.text.includes(t))) seenOwn = true;
    if (team.some(t => r.text.includes(t))) seenTeam = true;
    if (group.some(t => r.text.includes(t))) seenGroup = true;
  }
  const prefix = C.buildTurnPrefix({ actor: slug, groupContext: false }).block;
  leaks.push(...foreign(slug, prefix));
  ok(`${slug} sees nothing of anyone else's private memory, anywhere`, leaks.length === 0, [...new Set(leaks)]);
  ok(`${slug} sees their own`, seenOwn);
  if (team.length) ok(`${slug} sees the team's facts`, seenTeam);
  if (!IN_GROUP.includes(slug)) ok(`${slug}, not in the group, sees nothing of it`, !seenGroup);
  // every record of someone else by id: not found
  let opened = 0;
  for (const rec of everyRecord) {
    if (rec.scope === `user:${slug}` || rec.scope === 'shared' || (rec.scope.startsWith('group:') && IN_GROUP.includes(slug))) continue;
    const r = await get(`/memory/v4/records/${rec.id}`, { actor: slug });
    if (r.status === 200 && foreign(slug, r.text).length) opened++;
  }
  ok(`${slug} opens no other person's record by id`, opened === 0, opened);
}
// ─── the group's turn ────────────────────────────────────────────────────────
const gtoken = ti.issueTurnToken({ actor: 'ann', group: true, groupId: GROUP });
let gleaks = [], gseen = false;
for (const path of TURN_READS) {
  const r = await get(path, { token: gtoken });
  gleaks.push(...all.filter(t => r.text.includes(t)));
  if (group.some(t => r.text.includes(t))) gseen = true;
}
const gprefix = C.buildTurnPrefix({ actor: 'ann', groupContext: true, groupId: GROUP }).block;
gleaks.push(...all.filter(t => gprefix.includes(t)));
ok('a group turn sees no one\'s private memory', gleaks.length === 0, [...new Set(gleaks)]);
ok('...and its own group', gseen);
// ─── a departure ─────────────────────────────────────────────────────────────
T.remove({ email: 'eve@example.test', actor: 'stan@example.test' });
for (const [slug] of PEOPLE.filter(p => p[0] !== 'eve')) {
  const token = ti.issueTurnToken({ actor: slug });
  let seen = [];
  for (const path of [...READS, ...TURN_READS]) { const r = await get(path, path.startsWith('/internal') ? { token } : { actor: slug }); seen.push(...mine.eve.filter(t => r.text.includes(t))); }
  ok(`after Eve left, ${slug} still sees nothing of hers`, seen.length === 0, seen);
}
const gone = await get('/memory/v4/facts', { actor: 'eve' });
ok('Eve herself is refused now', gone.status === 401 || gone.status === 403, gone.status);

server.close();
console.log(`memory-crossscope-fuzz (seed ${SEED}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
