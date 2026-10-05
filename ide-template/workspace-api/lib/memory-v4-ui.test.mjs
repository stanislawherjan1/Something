/**
 * Guards for the memory v4 screen's API (/api/memory/v4/*): each person sees only
 * what they could read in the ledger, acts only on their own records and what
 * they shared, and there is no admin bypass.
 *
 * Real router on 127.0.0.1; the signed-in person comes from a test header in
 * place of the session cookie. Run: node lib/memory-v4-ui.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-v4-ui-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'read';
process.env.MEMORY_TOPIC_MIN = '2';   // these tests are about how tiles behave, written for two conversations

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', telegramChatId: '2220002', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team', addedAt: '2026-09-01T00:00:00Z', members: { '2220002': 'Kasia' } } } }));
const mem = join(ROOT, 'memory');
for (const d of ['users/stan', 'users/kasia', '_engine']) mkdirSync(join(mem, d), { recursive: true });
writeFileSync(join(mem, 'RULES.md'), '---\ncard: RULES\n---\n\n# RULES\n\n- Never deploy on Fridays.  [Source: conversation, 2026-09-01]\n');
writeFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'), '---\ncard: USER_PROFILE\nowner: stan\n---\n\n# USER_PROFILE\n\n- Stan runs operations.\n');
writeFileSync(join(mem, 'users', 'kasia', 'USER_PROFILE.md'), '---\ncard: USER_PROFILE\nowner: kasia\n---\n\n# USER_PROFILE\n\n- Kasia is interviewing elsewhere.\n');

const L = await import('./memory-ledger.js');
const A = await import('./memory-asks.js');
const E = await import('./embedder-client.js');
const LLM = await import('./memory-llm.js');
E.configureEmbedder(async () => { throw new Error('none'); });
const soon = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

const s1 = await L.append({ scope: 'user:stan', source: 'telegram', ts: '2026-09-20T10:00:00Z', text: 'Stan: Orion kickoff is Tuesday.\nAda: Noted.',
  notes: [{ text: 'Orion kickoff is on Tuesday.', kind: 'fact', importance: 2, evidence: 'Orion kickoff is Tuesday' }, { text: 'Stan is in Lisbon this week.', kind: 'status', expires: soon }],
  tags: { entities: [{ name: 'Orion', kind: 'company' }], rules: ['Keep answers short.'] } });
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-21T10:00:00Z', text: 'Stan: Orion wants SSO.', notes: [{ text: 'Orion asked for SSO.', kind: 'fact' }], tags: { entities: [{ name: 'Orion', kind: 'company' }] } });
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-08-01T10:00:00Z', text: 'Stan: trip to Berlin.', notes: [{ text: 'Stan was in Berlin.', kind: 'status', expires: '2026-08-05' }] });
const k1 = await L.append({ scope: 'user:kasia', source: 'web', ts: '2026-09-22T10:00:00Z', text: 'Kasia: my side project is secret.', notes: [{ text: 'Kasia has a secret side project.', kind: 'fact' }] });
const sh = await L.append({ scope: 'shared', source: 'telegram', ts: new Date().toISOString(), text: 'Stan: Orion kickoff is Tuesday.', origin: 'user:stan', notes: [{ text: 'Team: Orion kickoff Tuesday.', kind: 'fact' }] });
await L.append({ scope: 'group:-100777', source: 'group', ts: '2026-09-23T10:00:00Z', text: 'Marek: demo Friday.', notes: [{ text: 'Group demo on Friday.', kind: 'fact' }] });
const askId = A.addAsk('stan', { text: 'Stan: Harbor budget might be cut.', question: 'Share the Harbor budget news with the team?', ts: '2026-09-24T10:00:00Z', source: 'telegram' });

const express = (await import('express')).default;
const router = (await import('../routes/memory-v4.js')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/memory/v4`;
const as = (email) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(email ? { 'x-test-actor': email } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const stan = as('stan@example.test');
const kasia = as('kasia@example.test');

// ─── (a) who may ask ─────────────────────────────────────────────────────────
ok('(a) signed out → 401', (await as(null)('GET', '/facts')).status === 401);
ok('(a) not on the team → 403', (await as('stranger@example.test')('GET', '/facts')).status === 403);

// ─── (b) reading ─────────────────────────────────────────────────────────────
let r = await stan('GET', '/facts');
const texts = r.body.items.map(x => x.text);
ok('(b) own notes and shared notes are listed', texts.includes('Orion kickoff is on Tuesday.') && texts.includes('Team: Orion kickoff Tuesday.'));
ok('(b) never a teammate\'s private note', !texts.some(t => /secret/.test(t)));
ok('(b) nor a group the person is not in', !texts.some(t => /Group demo/.test(t)));
ok('(b) newest first, past statuses hidden by default', r.body.items[0].text === 'Team: Orion kickoff Tuesday.' && !texts.includes('Stan was in Berlin.'));
ok('(b) a shared note says so', r.body.items.find(x => x.text.startsWith('Team:')).scope === 'shared');
r = await stan('GET', '/facts?history=1&scope=private');
ok('(b) "past" shows ended statuses; the scope filter works', r.body.items.some(x => x.text === 'Stan was in Berlin.' && x.past) && r.body.items.every(x => x.scope === 'private'));
r = await kasia('GET', '/facts');
ok('(b) a member sees their group\'s notes', r.body.items.some(x => /Group demo/.test(x.text)) && r.body.items.some(x => /secret/.test(x.text)));

r = await stan('GET', `/records/${s1.id}`);
ok('(b) a record opens as a transcript', r.body.messages?.length === 2 && r.body.messages[0].who === 'Stan' && r.body.messages[1].who === 'Ada', r.body);
r = await stan('GET', `/records/${k1.id}`);
ok('(b) a teammate\'s record does not open', r.status === 404);

r = await stan('GET', '/overview');
ok('(b) right now shows the current status only', r.body.now.length === 1 && /Lisbon/.test(r.body.now[0].text));
// The nightly pass first: a legacy record's facts wore every name of the
// record — "Stan is in Lisbon this week" is not about Orion.
await (await import('./memory-titles.js')).narrowNames(['user:stan', 'shared']);
r = await stan('GET', '/topics');
const orion = r.body.items.find(t => t.name === 'Orion');
ok('(b) topics carry kind and a latest line', orion && orion.kind === 'company' && orion.line === 'Orion asked for SSO.', r.body.items);
r = await stan('GET', `/topics/${orion.key}/timeline`);
ok('(b) a topic\'s timeline: how it came up first, then the rest newest first', r.body.total === 2 && r.body.first.length === 2 && r.body.first[0].text === 'Orion kickoff is on Tuesday.' && r.body.items.length === 0, r.body);
ok('(b) the timeline lists the facts about the topic — a fact from the same conversation about something else is not there', r.body.first.every(x => x.factId && /Orion/.test(x.text)), r.body.first);
r = await stan('GET', `/topics/${orion.key}/timeline?all=1`);
ok('(b) ...and all of them newest first on request', r.body.items.length === 2 && r.body.items[0].text === 'Orion asked for SSO.' && r.body.first.length === 0);

r = await stan('GET', '/search?q=orion');
ok('(b) the screen\'s search answers with the topic, its facts best match first, and the excerpts', r.body.topics?.some(t => t.name === 'Orion') && r.body.facts?.length >= 2 && r.body.facts.every(f => /Orion/.test(`${f.title} ${f.text}`)) && r.body.hits?.length >= 1, { topics: r.body.topics, facts: r.body.facts?.map(f => f.text), hits: r.body.hits?.length });

{
  const FX = await import('./memory-facts.js');
  const o = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-10T10:00:00Z', text: 'Stan: I will probably get the Harbor job.' });
  const a = await FX.apply('user:stan', [{ op: 'add', fact: { title: 'Harbor job likely', text: 'Stan will probably get the job at Harbor Works.', kind: 'fact' } }], { record: o.id, ts: '2026-09-10T10:00:00Z' });
  const n = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-12T10:00:00Z', text: 'Stan: I did not get the Harbor job.' });
  await FX.apply('user:stan', [{ op: 'add', fact: { title: 'Harbor job not obtained', text: 'Stan did not get the job at Harbor Works.', kind: 'fact' }, supersedes: FX.get('user:stan', a.ids[0]) }], { record: n.id, ts: '2026-09-12T10:00:00Z' });
  r = await stan('GET', '/facts?history=1&limit=500');
  const struck = r.body.items.find(x => x.id === a.ids[0]);
  ok('(b) a superseded fact says it is no longer true and what says so now', struck && struck.past && struck.supersededWhy === 'superseded' && struck.supersededByTitle === 'Harbor job not obtained', struck);
  r = await stan('GET', '/facts');
  ok('(b) ...and is off the default list while the new one is on it', !r.body.items.some(x => x.id === a.ids[0]) && r.body.items.some(x => x.title === 'Harbor job not obtained'));
  const nowRow = r.body.items.find(x => x.title === 'Harbor job not obtained');
  ok('(b) the current fact carries the version it made untrue, as its history', nowRow?.history?.length === 1 && nowRow.history[0].id === a.ids[0] && nowRow.history[0].why === 'superseded', nowRow?.history);
}

{
  const FX = await import('./memory-facts.js');
  const o = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-14T10:00:00Z', text: 'Stan: Orion contact via Ada.' });
  const a = await FX.apply('user:stan', [{ op: 'add', fact: { title: 'Orion contact via Ada', text: 'Stan reaches Orion through Ada, met at a conference.', kind: 'fact' } }], { record: o.id, ts: '2026-09-14T10:00:00Z' });
  const n = await L.append({ scope: 'user:stan', source: 'note', ts: '2026-09-16T10:00:00Z', text: 'Stan: Ada left Orion.' });
  await FX.apply('user:stan', [{ op: 'update', target: FX.get('user:stan', a.ids[0]), fact: { text: 'Ada has left Orion; the contact there is now Ben.', kind: 'fact' } }], { record: n.id, ts: '2026-09-16T10:00:00Z' });
  r = await stan('GET', '/facts');
  const upd = r.body.items.find(x => x.id === a.ids[0]);
  ok('(b) a corrected fact shows its words and the dated remark under them', upd && upd.text.startsWith('Stan reaches Orion') && upd.updates?.length === 1 && /Ada has left Orion/.test(upd.updates[0].text) && upd.updates[0].recordId === n.id && upd.sources === 1, upd);
}

// ─── (b2) who a topic is ─────────────────────────────────────────────────────
const V = await import('./memory-views.js');
let profileCalls = [];
LLM.configureRunner(async ({ user }) => {
  profileCalls.push(user);
  return { topics: [
    { key: orion.key, line: 'Orion is a client; asked for SSO in September 2026.', evidence: 'Orion wants SSO' },
    { key: `${orion.key}x`, line: 'made up', evidence: 'nothing here' },
  ] };
});
let pr = await V.updateProfiles('user:stan', ['shared', 'user:stan']);
ok('(b2) a line with verbatim evidence is written; one without is dropped', pr.updated === 1 && V.readProfiles('user:stan').topics[orion.key].line.startsWith('Orion is a client'), pr);
ok('(b2) the model saw only this viewer\'s records', !profileCalls.some(u => /secret/.test(u)));
r = await stan('GET', '/topics');
ok('(b2) the tile carries the line', r.body.items.find(t => t.key === orion.key).who === 'Orion is a client; asked for SSO in September 2026.');
r = await stan('GET', `/topics/${orion.key}/timeline`);
ok('(b2) the timeline carries it with its evidence record', r.body.who.line.startsWith('Orion is a client') && !!r.body.who.recordId && r.body.who.evidence === 'Orion wants SSO', r.body.who);
profileCalls = [];
pr = await V.updateProfiles('user:stan', ['shared', 'user:stan']);
ok('(b2) nothing new → no model call', pr.due === 0 && profileCalls.length === 0, pr);
r = await stan('POST', `/topics/${orion.key}/who`, { line: 'Orion — our biggest client, contact Nina.' });
ok('(b2) the owner\'s own wording is stored', r.body.who.line === 'Orion — our biggest client, contact Nina.' && r.body.who.edited === true, r.body);
await L.append({ scope: 'user:stan', source: 'web', ts: new Date().toISOString(), text: 'Stan: Orion churned last week.', notes: [], tags: { entities: [{ name: 'Orion', kind: 'company' }] } });
LLM.configureRunner(async () => ({ topics: [{ key: orion.key, line: 'Orion was a client; churned in September 2026.', evidence: 'Orion churned last week' }] }));
pr = await V.updateProfiles('user:stan', ['shared', 'user:stan']);
r = await stan('GET', `/topics/${orion.key}/timeline`);
ok('(b2) new information becomes a suggestion, the owner\'s line stays', pr.suggested === 1 && r.body.who.line === 'Orion — our biggest client, contact Nina.' && r.body.who.suggested?.line.startsWith('Orion was a client'), r.body.who);
r = await stan('POST', `/topics/${orion.key}/who`, { takeSuggestion: true });
ok('(b2) ...until the owner takes it', r.body.who.line.startsWith('Orion was a client') && r.body.who.edited === false && !r.body.who.suggested, r.body);

// ─── (b3) a topic nobody tagged with a kind gets one from the profile pass ───
// A migrated page's title is a bare name: on the canary every such topic sat
// under "Topics" although it was a person or a company.
await L.append({ scope: 'user:stan', source: 'migration', ts: '2026-09-02T12:00:00Z', conv: 'migration:memory/users/stan/concepts/harbor-works.md', text: 'Harbor Works — Claims\n- A fund in Lisbon.', notes: [{ text: 'Harbor Works is a fund in Lisbon.', kind: 'fact' }], tags: { entities: [{ name: 'Harbor Works' }] } });
// One tag says "topic": that is "none of the others", not an answer — still asked.
await L.append({ scope: 'user:stan', source: 'migration', ts: '2026-09-03T12:00:00Z', conv: 'migration:memory/users/stan/topics/harbor-works-notes.md', text: 'Harbor Works notes\n- Intro call done.', notes: [], tags: { entities: [{ name: 'Harbor Works', kind: 'topic' }] } });
r = await stan('GET', '/topics');
ok('(b3) without a kind it is a plain topic', r.body.items.find(t => t.key === 'harborworks')?.kind === 'topic');
let kindCalls = 0;
LLM.configureRunner(async ({ user }) => { kindCalls++; return { topics: [{ key: 'harborworks', line: 'Harbor Works is a fund in Lisbon; intro call done in September 2026.', evidence: 'A fund in Lisbon', kind: 'company' }] }; });
pr = await V.updateProfiles('user:stan', ['shared', 'user:stan']);
r = await stan('GET', '/topics');
ok('(b3) the profile pass decides the kind once', kindCalls === 1 && V.readKinds().harborworks === 'company' && r.body.items.find(t => t.key === 'harborworks')?.kind === 'company', { kinds: V.readKinds(), pr });
kindCalls = 0;
pr = await V.updateProfiles('user:stan', ['shared', 'user:stan']);
ok('(b3) ...and does not ask again', kindCalls === 0 && pr.due === 0, pr);
r = await kasia('POST', `/topics/${orion.key}/who`, { line: 'hacked' });
ok('(b2) a teammate cannot edit another person\'s view of a topic', r.status === 404);
ok('(b2) ...nor does a viewer\'s line leak to another viewer', !V.readProfiles('user:kasia').topics[orion.key]);
r = await stan('GET', '/prefs');
ok('(b) prefs: the profile card, stated rules, the team\'s rules', r.body.about.lines[0] === 'Stan runs operations.' && r.body.rules[0].text === 'Keep answers short.' && r.body.team.lines[0] === 'Never deploy on Fridays.' && r.body.team.editable === true, r.body);
r = await kasia('GET', '/prefs');
ok('(b) ...each person their own', r.body.about.lines[0] === 'Kasia is interviewing elsewhere.' && !r.body.rules.length && r.body.team.editable === false);
r = await stan('GET', '/search?q=Orion kickoff');
ok('(b) "ask what I remember" runs the turn\'s search for this person', r.body.hits.length > 0 && !r.body.hits.some(h => /secret/.test(JSON.stringify(h))));

// ─── (c) privacy screen ──────────────────────────────────────────────────────
r = await stan('GET', '/privacy');
ok('(c) pending questions and what I shared', r.body.asks.length === 1 && r.body.sharedFromMe.some(x => x.id === sh.id));
ok('(c) ...as the facts, never the conversation', r.body.teamMode === true && r.body.sharedFromMe.every(x => x.facts?.length && x.text === undefined) && !JSON.stringify(r.body.sharedFromMe).includes('Stan:'));
r = await kasia('GET', '/privacy');
ok('(c) a teammate sees none of that', !r.body.asks.length && !r.body.sharedFromMe.length);
r = await kasia('POST', `/asks/${askId}`, { decision: 'share' });
ok('(c) nobody answers another person\'s question', r.status === 422);
r = await stan('POST', `/asks/${askId}`, { decision: 'share' });
ok('(c) the owner shares it', r.body.ok && L.read({ scopes: ['shared'] }).some(x => /Harbor budget/.test(x.text)));

// ─── (d) acting on records ───────────────────────────────────────────────────
r = await stan('POST', `/records/${k1.id}/erase`);
ok('(d) nobody erases a teammate\'s record — admins included', r.status === 404 && L.read({ scopes: ['user:kasia'] }).some(x => x.id === k1.id));
r = await kasia('POST', `/records/${sh.id}/hide`);
ok('(d) nor hides what someone else shared', r.status === 404);
r = await stan('POST', `/records/${sh.id}/hide`);
ok('(d) "make private": the sharer hides the shared copy', r.body.ok && !L.read({ scopes: ['shared'] }).some(x => x.id === sh.id));
r = await stan('GET', '/privacy');
ok('(d) ...listed as hidden with its erase date', r.body.hidden.some(x => x.id === sh.id && /^\d{4}-\d{2}-\d{2}$/.test(x.eraseOn)));
r = await stan('POST', `/records/${sh.id}/unhide`);
ok('(d) ...and can be restored', L.read({ scopes: ['shared'] }).some(x => x.id === sh.id));
r = await stan('POST', `/records/${s1.id}/erase`);
ok('(d) the owner erases their own record for good', r.body.ok && !L.read({ scopes: ['user:stan'], includeHidden: true }).some(x => x.id === s1.id));
r = await stan('GET', '/privacy');
ok('(d) the erasure is listed without its content', r.body.erased.length === 1 && r.body.erased[0].by === 'you' && !JSON.stringify(r.body.erased).includes('Orion'));

// ─── (d1) an admin manages what the team holds in common ────────────────────
// After the move most shared records have no author; without this nobody
// could take them down. Private records stay out of reach — by path.
const sh0 = await L.append({ scope: 'shared', source: 'telegram', ts: '2026-09-25T10:00:00Z', text: 'Stan: the office closes at six.', notes: [{ text: 'The office closes at six.', kind: 'fact' }] });
r = await kasia('POST', `/records/${sh0.id}/hide`);
ok('(d1) a teammate cannot hide a shared record nobody authored', r.status === 404);
r = await stan('GET', '/facts');
ok('(d1) the admin sees it as theirs to manage, not as their own', r.body.items.some(x => x.recordId === sh0.id && x.mine && !x.owned), r.body.items.filter(x => x.recordId === sh0.id));
r = await stan('POST', `/records/${sh0.id}/hide`);
ok('(d1) ...and hides it', r.body.ok && !L.read({ scopes: ['shared'] }).some(x => x.id === sh0.id));
r = await stan('GET', '/changes');
ok('(d1) which the feed calls "Hidden", not "Made private"', r.body.items.some(x => x.recordId === sh0.id && x.label === 'Hidden'), r.body.items.filter(x => x.recordId === sh0.id));
r = await stan('POST', '/records/bulk', { op: 'unhide', ids: [sh0.id, k1.id] });
ok('(d1) bulk: the same rule per record — done and refused', r.body.done.includes(sh0.id) && r.body.refused.includes(k1.id) && L.read({ scopes: ['shared'] }).some(x => x.id === sh0.id), r.body);

// ─── (d1b) one fact at a time: the conversation it came from stays ──────────
const multi = await L.append({ scope: 'user:stan', source: 'migration', ts: '2026-09-18T12:00:00Z', conv: 'migration:memory/users/stan/topics/funds.md', text: 'Funds — Claims\n- Fund A: intro call done.\n- Fund B: passed.\n- Fund C: waiting on deck.',
  notes: [{ text: 'Fund A: intro call done.', kind: 'fact' }, { text: 'Fund B: passed.', kind: 'fact' }, { text: 'Fund C: waiting on deck.', kind: 'fact' }] });
// A fact is its own thing with a stable id (lib/memory-facts.js); a legacy note's id is `<record>n<index>`.
const FS = await import('./memory-facts.js');
const fid = (rec, i) => `${rec.id}n${i}`;
r = await stan('POST', '/facts/bulk', { op: 'hide', ids: [fid(multi, 1)] });
ok('(d1b) hiding one fact leaves the record and its other facts', r.body.done.length === 1 && L.get(multi.id, ['user:stan']) && FS.forRecord('user:stan', multi.id).length === 2, r.body);
r = await stan('GET', '/facts');
ok('(d1b) ...the hidden fact is off the screen, the others keep their ids', !r.body.items.some(x => x.id === fid(multi, 1)) && r.body.items.some(x => x.id === fid(multi, 0)) && r.body.items.some(x => x.id === fid(multi, 2)));
r = await stan('GET', '/changes');
const hf = r.body.items.find(x => x.op === 'hide_fact');
ok('(d1b) ...Changes offers its undo, by fact id, never text', hf && hf.undo === 'unhide_fact' && hf.factIds.length === 1 && !JSON.stringify(hf).includes('passed'), hf);
r = await stan('POST', '/facts/unhide', { ids: hf.factIds });
ok('(d1b) ...and the undo brings exactly that fact back', r.body.restored === 1 && FS.forRecord('user:stan', multi.id).length === 3);
r = await stan('POST', '/facts/bulk', { op: 'erase', ids: [fid(multi, 0), fid(multi, 2), fid(k1, 0)] });
ok('(d1b) erasing facts drops them for good, refuses what is not the person\'s', r.body.done.length === 2 && r.body.refused.includes(fid(k1, 0)) && FS.forRecord('user:stan', multi.id).length === 1 && FS.forRecord('user:stan', multi.id)[0].text === 'Fund B: passed.', r.body);
ok('(d1b) ...the conversation itself is still there for search', L.get(multi.id, ['user:stan']) && /Fund A/.test(L.get(multi.id, ['user:stan']).text));

// ─── (d3) "replaced by a later record" is live, not a mark ───────────────────
const newer = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-26T10:00:00Z', text: 'Stan: I am head of ops now.', notes: [{ text: 'Stan is head of ops.', kind: 'fact' }] });
const older = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-10T10:00:00Z', text: 'Stan: I run operations.', notes: [{ text: 'Stan runs operations.', kind: 'fact', supersededBy: newer.id }] });
r = await stan('GET', '/facts');
ok('(d3) the older note is past while the record that replaced it exists', !r.body.items.some(x => x.recordId === older.id) && r.body.items.some(x => x.recordId === newer.id));
await stan('POST', `/records/${newer.id}/erase`);
r = await stan('GET', '/facts');
ok('(d3) erase the newer and the older is current again', r.body.items.some(x => x.recordId === older.id && !x.past), r.body.items.filter(x => x.recordId === older.id));

// ─── (d4) removing a topic ───────────────────────────────────────────────────
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-27T10:00:00Z', text: 'Stan: Orion signed.', notes: [{ text: 'Orion signed the contract.', kind: 'fact' }], tags: { entities: [{ name: 'Orion', kind: 'company' }] } });
r = await stan('GET', '/topics');
ok('(d4) Orion is a topic', r.body.items.some(x => x.key === 'orion'), r.body.items.map(x => x.key));
r = await stan('POST', '/topics/orion/dismiss');
ok('(d4) removed: the tag came off the records this person manages, the records stay', r.body.ok && r.body.records >= 2 && !L.read({ scopes: ['user:stan'] }).some(x => (x.tags?.entities || []).some(e => /orion/i.test(e.name || e))) && L.read({ scopes: ['user:stan'] }).some(x => /Orion signed/.test(x.text)), r.body);
r = await stan('GET', '/topics');
ok('(d4) ...no tile', !r.body.items.some(x => x.key === 'orion'));
ok('(d4) ...and the extractor will skip the name', (await import('./memory-views.js')).dismissedNames('user:stan').includes('Orion'));
r = await stan('GET', '/changes');
const dis = r.body.items.find(x => x.op === 'dismiss_topic');
ok('(d4) ...listed in Changes with its undo', dis && dis.undo === 'restore_topic' && dis.topicKey === 'orion' && !dis.preview, dis);
r = await stan('POST', '/topics/orion/restore');
r = await stan('GET', '/topics');
ok('(d4) restored: the tag is back on the same records and the tile returns', r.body.items.some(x => x.key === 'orion'), r.body.items.map(x => x.key));
ok('(d4) ...with the kind the tags carried, not as a plain topic', r.body.items.find(x => x.key === 'orion')?.kind === 'company' && L.read({ scopes: ['user:stan'] }).some(x => (x.tags?.entities || []).some(e => e.name === 'Orion' && e.kind === 'company')));
// A full name folds its bare first name into it; removing the tile removes both.
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-28T10:00:00Z', text: 'Stan: Nina called.', notes: [], tags: { entities: [{ name: 'Nina', kind: 'person' }] } });
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-28T11:00:00Z', text: 'Stan: Nina Kowal again.', notes: [], tags: { entities: [{ name: 'Nina Kowal', kind: 'person' }] } });
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-28T12:00:00Z', text: 'Stan: Nina Kowal sent the deck.', notes: [], tags: { entities: [{ name: 'Nina Kowal', kind: 'person' }] } });
r = await stan('GET', '/topics');
ok('(d4) the bare first name folded into the full name', r.body.items.some(x => x.key === 'ninakowal') && !r.body.items.some(x => x.key === 'nina'));
r = await stan('POST', '/topics/ninakowal/dismiss');
r = await stan('GET', '/topics');
ok('(d4) removing the full name does not leave a tile for the bare one', !r.body.items.some(x => x.key === 'ninakowal' || x.key === 'nina'), r.body.items.map(x => x.key));
r = await kasia('POST', '/topics/alias', { from: 'Orion', into: 'Harbor Works', same: true });
ok('(d4) a teammate cannot merge topics for the whole team', r.status === 403);

// ─── (d2) the changes feed ───────────────────────────────────────────────────
r = await stan('GET', '/changes');
const labels = r.body.items.map(x => x.label);
ok('(d2) my hide, share and erase are in the feed, newest first', labels.includes('Made private') && labels.includes('Shared with the team') && labels.includes('Erased') && labels.includes('Restored') && r.body.items[0].ts >= r.body.items[r.body.items.length - 1].ts, labels);
ok('(d2) an erasure shows counts, never text', r.body.items.filter(x => x.label === 'Erased').every(x => !x.preview && /1 record/.test(x.detail)));
ok('(d2) a shared record still there offers its undo', r.body.items.some(x => x.label === 'Shared with the team' && x.undo === 'hide' && /Harbor/.test(x.preview)), r.body.items.filter(x => x.label === 'Shared with the team'));
r = await kasia('GET', '/changes');
ok('(d2) a teammate sees the shared events, not mine', r.body.items.some(x => x.label === 'Shared with the team') && !r.body.items.some(x => x.scope === 'private'), r.body.items);

// ─── (e) rules ───────────────────────────────────────────────────────────────
r = await stan('POST', '/rules', { text: 'No meetings before 11:00.' });
r = await stan('GET', '/prefs');
ok('(e) a rule added on the screen joins the rules card', r.body.rules.some(x => x.text === 'No meetings before 11:00.'));
await stan('POST', '/rules', { text: 'No meetings before 11:00.', retired: true });
r = await stan('GET', '/prefs');
ok('(e) ...and can be removed', !r.body.rules.some(x => x.text === 'No meetings before 11:00.'));

server.close();
console.log(`memory-v4-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
