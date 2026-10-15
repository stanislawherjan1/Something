/**
 * The workspace archetypes (test-fixtures/archetypes/*.json) and the
 * invariants that must hold in each: who sees which connection, which servers
 * a turn gets, whose imports run, what the sharing gate does per mode, what a
 * departure leaves behind. One process per archetype (the modules read their
 * environment once); without an argument this file runs them all.
 * Run: node lib/archetypes.test.mjs [archetype]
 */
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'test-fixtures', 'archetypes');
const which = process.argv[2];

if (!which) {
  let pass = 0, fail = 0;
  for (const f of readdirSync(DIR).filter(f => f.endsWith('.json')).sort()) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), basename(f, '.json')], { encoding: 'utf8', env: { ...process.env, INTEGRATIONS_RATE_MAX: '1000' } });
    const m = /archetype [^:]+: (\d+) passed, (\d+) failed/.exec(r.stdout + r.stderr);
    const lines = (r.stdout + r.stderr).split('\n').filter(l => /FAIL|archetype /.test(l));
    for (const l of lines) console.log(l);
    if (!m) { fail++; console.log(`  FAIL: ${f} did not finish\n${(r.stdout + r.stderr).slice(-800)}`); }
    else { pass += Number(m[1]); fail += Number(m[2]); }
  }
  console.log(`archetypes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const A = JSON.parse(readFileSync(join(DIR, `${which}.json`), 'utf8'));
const ROOT = mkdtempSync(join(tmpdir(), `arch-${which}-`));
const STORE = mkdtempSync(join(tmpdir(), `arch-${which}-store-`));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ef'.repeat(32));
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
process.env.INTEGRATIONS_RATE_MAX = '1000';
mkdirSync(join(ROOT, '.team'), { recursive: true });
for (const p of A.people) mkdirSync(join(ROOT, 'memory', 'users', p.slug), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify(A.people));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: A.teamMode, groups: A.groups.map(chatId => ({ chatId, title: `Group ${chatId}`, members: A.people.map(p => p.slug) })) }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: { 'workspace-api': { command: 'node', args: ['x'] } } }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL [${which}]: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log(`archetype ${which}: 0 passed, 0 failed (no crypto key here)`); process.exit(0); }
const express = (await import('express')).default;
const store = await import('./integrations/store.js');
const runtime = await import('./integrations/runtime.js');
const router = (await import('../routes/integrations.js')).default;
const C = await import('./claude.js');
const T = await import('./team.js');
const Sources = await import('./memory-sources.js');
const S = await import('./memory-sharing.js');
const L = await import('./memory-ledger.js');
(await import('./memory-llm.js')).configureRunner(async ({ schema }) => (schema?.properties?.decisions ? { decisions: [] } : {}));

const admins = A.people.filter(p => p.role === 'admin'), members = A.people.filter(p => p.role !== 'admin');
const bySlug = Object.fromEntries(A.people.map(p => [p.slug, p]));
for (const c of A.connections) {
  const key = c.reach === 'personal' ? store.personalKey(c.id, c.owner) : c.id;
  store.activate(key, { fields: c.fields }, { owner: c.owner, reach: c.reach, access: c.access || 'write' });
}
const wsIds = A.connections.filter(c => c.reach === 'workspace').map(c => c.id);
const ownIds = (slug) => A.connections.filter(c => c.reach === 'personal' && c.owner === slug).map(c => c.id);

// ─── who sees which connection ───────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', router());
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const call = async (who, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-actor': who }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
for (const p of A.people) {
  const r = await call(p.email, 'GET', '/integrations');
  const list = r.body.integrations || [];
  const byId = Object.fromEntries(list.map(i => [i.id, i]));
  ok(`${p.slug} sees every workspace connection as active`, wsIds.every(id => byId[id]?.active), wsIds.map(id => [id, byId[id]?.active]));
  ok(`${p.slug} sees their own connections as theirs`, ownIds(p.slug).every(id => byId[id]?.mine?.active === true), ownIds(p.slug).map(id => [id, byId[id]?.mine]));
  const others = A.connections.filter(c => c.reach === 'personal' && c.owner !== p.slug);
  if (p.role === 'admin') {
    ok(`${p.slug} (admin) sees who has their own account, by name only`, others.every(c => (byId[c.id]?.activeFor || []).some(x => x.slug === c.owner) && !JSON.stringify(byId[c.id]).includes(c.fields.OAUTH_TOKENS || c.fields.GITHUB_PERSONAL_ACCESS_TOKEN || '§')), others.map(c => [c.id, byId[c.id]?.activeFor]));
  } else {
    ok(`${p.slug} (member) sees no one else's connection and no credential summary`, others.every(c => byId[c.id]?.activeFor === undefined) && list.every(i => i.credentialSummary == null), list.filter(i => i.activeFor || i.credentialSummary).map(i => i.id));
  }
  const text = JSON.stringify(list);
  const secrets = A.connections.flatMap(c => Object.entries(c.fields).filter(([k, v]) => /TOKEN|SECRET|KEY|PASS/.test(k) && String(v).length > 6).map(([, v]) => v));
  ok(`${p.slug} gets no secret through the list`, !secrets.some(v => text.includes(v)));
}
// ─── which servers a turn gets ───────────────────────────────────────────────
runtime.syncMcpServers();
const bot = Object.keys(JSON.parse(readFileSync(process.env.BOT_CLAUDE_CONFIG, 'utf8')).mcpServers);
const operator = T.primaryAdminSlug();
ok('the bot\'s own config carries the workspace servers and the operator\'s own, nobody else\'s', wsIds.every(id => bot.includes(id)) && bot.filter(n => n.endsWith('-mine')).sort().join() === ownIds(operator).map(id => `${id}-mine`).sort().join(), { bot, operator });
for (const p of A.people) {
  const mine = Object.keys(C.turnMcpServers({ actor: p.slug }));
  ok(`${p.slug}'s turn: the workspace set plus their own, nobody else's`, wsIds.every(id => mine.includes(id)) && ownIds(p.slug).every(id => mine.includes(`${id}-mine`)) && mine.filter(n => n.endsWith('-mine')).length === ownIds(p.slug).length, mine);
  if (A.groups.length) {
    const g = Object.keys(C.turnMcpServers({ actor: p.slug, groupContext: true }));
    ok(`a group turn of ${p.slug}: the workspace set alone`, wsIds.every(id => g.includes(id)) && !g.some(n => n.endsWith('-mine')), g);
  }
}
// ─── whose imports run ───────────────────────────────────────────────────────
const people = Sources.people().sort();
const expectPeople = Object.keys(A.notetakers).filter(s => A.notetakers[s].length).sort();
ok('the nightly import runs for those with a notetaker of their own or the workspace\'s', people.join() === expectPeople.join(), { people, expectPeople });
for (const [slug, ids] of Object.entries(A.notetakers)) {
  const keys = Sources.listFor(slug).map(s => s.key).sort();
  const want = A.connections.filter(c => ids.includes(c.id) && c.owner === slug).map(c => c.reach === 'personal' ? store.personalKey(c.id, slug) : c.id).sort();
  ok(`${slug}'s sources are their own keys`, keys.join() === want.join(), { keys, want });
}
// ─── the sharing gate, per person and mode ───────────────────────────────────
const routed = { shared: 'X: The Quarry launch moves to October 3.\nX: Jarek pushes for more office presence.\nX: My therapist moved our sessions to Thursdays.', ask: '', askQuestion: '' };
const work = { title: 'Quarry launch', text: 'The Quarry launch moves to 3 October.', kind: 'fact', evidence: 'The Quarry launch moves to October 3', subject: 'Quarry', concerns: "the team's work", entities: [{ name: 'Quarry', kind: 'project' }] };
const person = { title: 'Jarek office', text: 'Jarek pushes for more office presence.', kind: 'fact', evidence: 'Jarek pushes for more office presence', subject: 'Jarek', concerns: 'another person', entities: [{ name: 'Jarek', kind: 'person' }] };
const health = { title: 'Therapy', text: 'Therapy on Thursdays.', kind: 'fact', evidence: 'My therapist moved our sessions to Thursdays', subject: null, concerns: 'the person themselves' };
for (const p of A.people) {
  const mode = S.modeOf(p.slug);
  ok(`${p.slug}'s mode is their own (${mode})`, mode === (p.sharing || 'ask'));
  const w = S.decide({ mode, fact: work, routed }).outcome, j = S.decide({ mode, fact: person, routed }).outcome, h = S.decide({ mode, fact: health, routed }).outcome;
  ok(`${p.slug}: a work fact goes by the mode`, w === ({ ask: 'ask', auto: 'team', never: 'private' })[mode], { mode, w });
  ok(`${p.slug}: a fact about a person and a health fact never cross by themselves`, [j, h].every(o => o === (mode === 'never' ? 'private' : 'ask')), { mode, j, h });
}
// ─── what a team fact carries, and where a private line may live ─────────────
if (A.teamMode) {
  const sharer = members[0] || admins[0];
  const r = await S.fileTeamFact(sharer.slug, work, { ts: '2026-10-13T10:00:00Z', conv: 'c-private-1', source: 'web', name: sharer.displayName });
  const shared = L.read({ scopes: ['shared'] });
  ok('a shared fact is a record in the sharer\'s name, marked as a shared fact, with the fact only', r.recordId && shared.every(x => x.tags?.sharedFact === true && x.tags?.from && x.origin === `user:${x.tags.from}`), shared.map(x => [x.origin, x.tags]));
  for (const p of A.people) {
    const scopes = L.readableScopes({ actor: p.slug, memberGroups: T.memberGroupsOf(p.slug) });
    ok(`${p.slug} reads shared, their own and their groups — never another person's`, scopes.includes('shared') && scopes.includes(`user:${p.slug}`) && !scopes.some(s => s.startsWith('user:') && s !== `user:${p.slug}`), scopes);
  }
  if (A.groups.length) ok('a group turn reads shared and that group only', L.readableScopes({ actor: admins[0].slug, groupId: A.groups[0] }).join() === `shared,group:${A.groups[0]}`);
}
// ─── a departure ─────────────────────────────────────────────────────────────
if (members.length) {
  const gone = members[members.length - 1];
  const before = Object.keys(C.turnMcpServers({ actor: admins[0].slug })).sort().join();
  try { T.remove({ email: gone.email, actor: admins[0].email }); } catch (e) { ok('removing a member does not throw', false, e.message); }
  ok(`${gone.slug}'s own connections went with them`, store.personalIds(gone.slug).length === 0, store.personalIds(gone.slug));
  ok(`${gone.slug}'s slot is free`, T.slotOf(gone.slug) == null);
  ok(`${gone.slug} is off the roster`, !T.isAllowed(gone.email) && !T.find(gone.email));
  const r = await call(gone.email, 'GET', '/integrations');
  ok(`${gone.slug} gets nothing of anyone's through the list`, r.status !== 200 || !(r.body.integrations || []).some(i => i.mine?.active || i.credentialSummary), { status: r.status });
  ok('the others\' turns are as before', Object.keys(C.turnMcpServers({ actor: admins[0].slug })).sort().join() === before);
  const sawIt = await call(admins[0].email, 'GET', '/integrations');
  ok('no card still names them as having their own account', !(sawIt.body.integrations || []).some(i => (i.activeFor || []).some(x => x.slug === gone.slug)));
}
server.close();
console.log(`archetype ${which}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
