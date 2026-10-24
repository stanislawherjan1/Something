/**
 * Guards for the v4 memory tools' routes (memory_search / _timeline / _note /
 * _forget): identity from the turn token only, scopes by path, no admin bypass.
 *
 * Real router on 127.0.0.1, real turn tokens, a temp PROJECT_DIR.
 * Run: node lib/memory-v4-routes.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-v4-routes-'));
process.env.PROJECT_DIR = ROOT;
process.env.BOT_TURN_ID_HASH_FILE = join(ROOT, 'bot-turn-id.sha256');
const BOT_TOKEN = 'bot-token-for-tests-0123456789';
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));

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

const L = await import('./memory-ledger.js');
const FS = await import('./memory-facts.js');
const E = await import('./embedder-client.js');
const ti = await import('./turn-identity.js');
// memory_note asks a small model what a note adds that the person did not say;
// here a stand-in that flags one invented first name.
// ...and memory_note reads the person's words with the extractor: a stand-in
// that dates a meeting with Kamil from the words it is given.
(await import('./memory-llm.js')).configureRunner(async ({ user, schema }) => {
  // The router's reading of a person's words: a pilot is the team's, "between us" is private.
  if (schema?.properties?.ask_question) {
    const line = String(user).split('\n').pop() || '';
    return { shared: /between us/i.test(line) ? '' : line, private: /between us/i.test(line) ? line : '', ask: '', ask_question: '' };
  }
  // The meeting pass (an import): one summary, the people from "With:".
  if (schema?.properties?.summary) return { with: ['Marek'], title: 'Orion sync', summary: 'Orion wants SSO by March.', names: [{ name: 'Marek', kind: 'person' }], upcoming: [] };
  if (schema?.properties?.notes) {
    const m = String(user).match(/(call|meeting) with Kamil on (\d+) October/i);
    if (m) return { notes: [{ title: `Kamil ${m[2]} October`, text: `A ${m[1]} with Kamil on ${m[2]} October.`, kind: 'status', about: 'meeting', when: `2026-10-${m[2].padStart(2, '0')}`, whenFrom: `on ${m[2]} October`, dayStated: true, subject: 'Kamil', evidence: m[0], names: [] }], rules: [], entities: [] };
    // The stand-in split: one entry per sentence of the NOTE that WORDS support (a word in common), worded plainly.
    const note = String(user).match(/NOTE: ([^]*?)\n\nWORDS: [^:]+: ([^]*)$/);
    if (!note) return { notes: [], rules: [], entities: [] };
    const words = note[2].trim();
    const entries = note[1].split(/(?<=\.)\s+/).map(t => t.trim()).filter(Boolean).map(t => ({ title: t.replace(/^Correction:\s*/i, '').split(' ').slice(0, 4).join(' '), text: t.replace(/^Correction:\s*/i, ''), kind: 'fact', evidence: /receptionist|treasurer/i.test(t) ? '' : t.toLowerCase().match(/\p{L}{5,}/gu)?.some(w => words.toLowerCase().includes(w)) ? words : '', names: [], concerns: /pilot|launch/i.test(t) ? 'a company or project' : 'the person themselves', subject: /pilot/i.test(t) ? 'Vellmark' : null }));
    return { notes: entries, rules: [], entities: [] };
  }
  return { unsupported: /Krzysztof/.test(String(user).split('WORDS:')[0]) ? ['Krzysztof'] : [] };
});
E.configureEmbedder(async () => { throw new Error('none'); });

const stanPriv = await L.append({ scope: 'user:stan', source: 'telegram', ts: '2026-09-02T10:00:00Z', text: 'Stan: Orion term sheet arrives Monday.' });
const kasiaPriv = await L.append({ scope: 'user:kasia', source: 'web', ts: '2026-09-03T10:00:00Z', text: 'Kasia: my Orion side project is secret.' });
const teamRec = await L.append({ scope: 'shared', source: 'web', ts: '2026-09-01T10:00:00Z', text: 'Stan: Orion is the new client.' });
const kasiaShared = await L.append({ scope: 'shared', source: 'web', ts: '2026-09-04T10:00:00Z', text: 'Kasia: Orion kickoff is Tuesday.', origin: 'user:kasia' });
await L.append({ scope: 'group:-100777', source: 'group', ts: '2026-09-05T10:00:00Z', text: 'Marek: Orion demo in the group.' });

const express = (await import('express')).default;
const router = (await import('../routes/memory-v4.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/internal/memory/v4`;
const call = async (method, path, { token, actor, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-IDE-Turn'] = token;
  if (actor) headers['X-IDE-Actor'] = actor;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

const stanTurn = ti.issueTurnToken({ actor: 'stan' });
const kasiaTurn = ti.issueTurnToken({ actor: 'kasia' });
const groupTurn = ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' });

// ─── (a) identity ────────────────────────────────────────────────────────────
let r = await call('GET', '/search?q=Orion');
ok('(a) no turn token → refused', r.status === 403);
r = await call('GET', '/search?q=Orion', { token: 'made-up', actor: 'kasia' });
ok('(a) a made-up token → refused', r.status === 403);
r = await call('GET', '/search?q=Orion', { token: stanTurn, actor: 'kasia' });
ok('(a) a turn token\'s actor wins over a claimed header', /term sheet/.test(r.body.text) && !/side project/.test(r.body.text), r.body);

// ─── (b) search scopes ───────────────────────────────────────────────────────
r = await call('GET', '/search?q=Orion', { token: stanTurn });
ok('(b) a person finds their own and shared records', /term sheet/.test(r.body.text) && /new client/.test(r.body.text));
ok('(b) ...never a teammate\'s private one', !/side project/.test(r.body.text));
ok('(b) ...nor a group they are not in', !/Marek/.test(r.body.text));
r = await call('GET', '/search?q=Orion', { token: kasiaTurn });
ok('(b) a member finds their group\'s records from a 1:1 turn', /Marek/.test(r.body.text) && /side project/.test(r.body.text));
r = await call('GET', '/search?q=Orion', { token: groupTurn });
ok('(b) a group turn finds shared + its group only — not its sender\'s private', /Marek/.test(r.body.text) && /new client/.test(r.body.text) && !/side project/.test(r.body.text) && !/term sheet/.test(r.body.text), r.body.text);
r = await call('GET', '/search?q=Orion', { token: BOT_TOKEN });
ok('(b) the operator brain (bot token, no actor) is the primary admin', /term sheet/.test(r.body.text) && !/side project/.test(r.body.text));
r = await call('GET', '/search?q=Orion', { token: BOT_TOKEN, actor: 'kasia' });
ok('(b) the bot token stays the operator whatever slug is sent beside it', /term sheet/.test(r.body.text) && !/side project/.test(r.body.text), r.body.text);
ok('(b) excerpts are fenced', r.body.text.startsWith('<<<MEMORY') && r.body.text.trim().endsWith('<<<END MEMORY>>>'));

r = await call('GET', '/timeline?term=Orion', { token: stanTurn });
ok('(b) timeline respects the same scopes', /term sheet/.test(r.body.text) && !/side project/.test(r.body.text) && r.body.text.indexOf('new client') < r.body.text.indexOf('term sheet'));

// ─── (c) notes ───────────────────────────────────────────────────────────────
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Kasia prefers morning meetings.' } });
ok('(c) a note without the person\'s words is refused', r.status === 400 && /said required/.test(r.body.error), r.body);
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Kasia prefers morning meetings.', said: 'I prefer morning meetings' } });
ok('(c) a note is private by default', r.body.ok && r.body.scope === 'private' && L.read({ scopes: ['user:kasia'] }).some(x => /morning meetings/.test(x.text)));
// The split threw out every piece of a note dictated word for word: it is filed whole.
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'The spare office key is with the receptionist, code K-417.', said: 'Remember this: the spare office key is with the receptionist, code K-417.' } });
ok('(c) a note in the person\'s own words is saved even when the split rejects it all', r.body.ok && L.read({ scopes: ['user:kasia'] }).some(x => /K-417/.test(x.text)), r.body);
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'The new treasurer is appointed for three years.', said: 'We had a long meeting today.' } });
ok('(c) a note not in their words is still refused, and says nothing was saved', r.status === 400 && /^Nothing was saved/.test(r.body.error || ''), r.body);
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'The office closes on Friday.', said: 'the office closes on friday', share: true } });
const shared = L.read({ scopes: ['shared'] }).find(x => /office closes/.test(x.text));
ok('(c) share: true writes to shared, with its origin', r.body.scope === 'team' && shared?.origin === 'user:kasia');
r = await call('POST', '/note', { token: groupTurn, body: { text: 'Demo moved to the 20th.', said: 'demo moved to the 20th', share: true } });
ok('(c) a group turn writes its group only, whatever it asks', r.body.scope === 'group' && L.read({ scopes: ['group:-100777'] }).some(x => /20th/.test(x.text)) && !L.read({ scopes: ['shared', 'user:kasia'] }).some(x => /20th/.test(x.text)));
r = await call('POST', '/note', { token: stanTurn, body: { text: '', said: 'x' } });
ok('(c) an empty note is refused', r.status === 400);
r = await call('POST', '/note', { token: stanTurn, body: { text: 'The Monday contact is Krzysztof Nowak from Orion.', said: 'the monday contact is nowak, the orion guy' } });
ok('(c) a name the person did not use is refused, by name', r.status === 400 && /Krzysztof/.test(r.body.error) && !/Nowak|Orion/.test(r.body.error), r.body);
r = await call('POST', '/note', { token: stanTurn, body: { text: 'The Monday contact is Nowak from Orion, based in Lisbon.', said: 'the monday contact is nowak, the orion guy, he is in lisbon' } });
ok('(c) a note whose names the person used is saved', r.body.ok === true, r.body);
r = await call('POST', '/note', { token: stanTurn, body: { text: 'nowak on Telegram is the Orion contact; the notes are in Notion.', said: 'nowak to kontakt z orion, notatki ma w notion' } });
ok('(c) a product name (Telegram, Notion) is not an unknown person', r.body.ok === true, r.body);

// The note is stored as a note, not only as raw text — Facts and Right now read
// notes, and a record without one used to replace the old fact with nothing.
const noted = L.read({ scopes: ['user:kasia'] }).find(x => /morning meetings/.test(x.text));
ok('(c) a saved note is a fact in the store, standing on its record', FS.current(['user:kasia']).some(f => f.text === 'Kasia prefers morning meetings.' && f.record === noted?.id), FS.current(['user:kasia']));

// A note about two things is two facts; a part the person's words do not carry is left out and said so.
r = await call('POST', '/note', { token: stanTurn, body: { text: 'Stan has no contact at Nordic. Stan runs a kiosk project.', said: 'I have no contact at Nordic, only met them at an event' } });
ok('(c) a note is split into one fact per thing, grounded part by part', r.body.ok && r.body.titles?.length === 1 && r.body.leftOut === 1 && FS.current(['user:stan']).some(f => /no contact at Nordic/.test(f.text)) && !FS.current(['user:stan']).some(f => /kiosk project/.test(f.text)), r.body);
r = await call('POST', '/note', { token: stanTurn, body: { text: 'Stan runs a kiosk project.', said: 'something else entirely' } });
ok('(c) a note none of whose parts the words carry is refused, with the way out', r.status === 400 && /quote the part/.test(r.body.error), r.body);

// Notes are read for what they are: a meeting on the 5th and a call on the 20th
// with the same person are two dated facts, never merged into one.
r = await call('POST', '/note', { token: stanTurn, body: { text: 'Stan meets Kamil on 5 October about location analytics.', said: 'meeting with Kamil on 5 October about location analytics' } });
r = await call('POST', '/note', { token: stanTurn, body: { text: 'Stan has a call with Kamil on 20 October.', said: 'call with Kamil on 20 October' } });
const kamil = FS.current(['user:stan']).filter(f => /Kamil/.test(f.text));
ok('(c) two notes about one person on two days stay two dated facts', kamil.length === 2 && kamil.every(f => f.kind === 'status' && f.when) && new Set(kamil.map(f => f.when)).size === 2, kamil.map(f => `${f.kind} ${f.when} ${f.text}`));

// ─── (d) forget ──────────────────────────────────────────────────────────────
r = await call('POST', '/forget', { token: groupTurn, body: { ids: [kasiaPriv.id] } });
ok('(d) nothing can be hidden from a group turn', r.status === 403);
r = await call('POST', '/forget', { token: stanTurn, body: { ids: [kasiaPriv.id, teamRec.id, kasiaShared.id, stanPriv.id] } });
ok('(d) a person hides their own record', r.body.hidden.includes(stanPriv.id));
ok('(d) ...never a teammate\'s private one, nor what someone else shared', r.body.refused.includes(kasiaPriv.id) && r.body.refused.includes(kasiaShared.id));
ok('(d) a shared record without an origin is not anyone\'s to hide from a turn', r.body.refused.includes(teamRec.id));
r = await call('POST', '/forget', { token: kasiaTurn, body: { ids: [kasiaShared.id] } });
ok('(d) ...but its sharer can hide what they shared', r.body.hidden.includes(kasiaShared.id));
r = await call('GET', '/search?q=Orion', { token: stanTurn });
ok('(d) hidden records leave search at once', !/term sheet/.test(r.body.text) && !/kickoff/.test(r.body.text));
ok('(d) hiding is reversible (still on disk)', L.read({ scopes: ['user:stan'], includeHidden: true }).some(x => x.id === stanPriv.id && x.hidden));

// ─── (h) the import route: a turn's own scope, never a group, only a feeder ──
{
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(ROOT, '.integrations'), { recursive: true });
  writeFileSync(join(ROOT, '.integrations', 'credentials.json'), JSON.stringify({ granola: { activatedAt: '2026-10-01T00:00:00Z', fields: {} } }));
  const body = { integration: 'granola', item: 'g-9', title: 'Orion sync', at: '2026-10-05T10:00:00Z', participants: ['Marek'], summary: 'Orion wants SSO by March.' };
  r = await call('POST', '/import', { body });
  ok('(h) no turn token → refused', r.status === 403);
  r = await call('POST', '/import', { token: groupTurn, body });
  ok('(h) a group turn cannot import', r.status === 403 && /group/.test(r.body.error), r.body);
  r = await call('POST', '/import', { token: stanTurn, body: { ...body, integration: 'shopify' } });
  ok('(h) only a memory source', r.status === 400 && /not a memory source/.test(r.body.error), r.body);
  r = await call('POST', '/import', { token: stanTurn, body: { ...body, integration: 'fireflies' } });
  ok('(h) only a connected one', r.status === 400 && /not connected/.test(r.body.error), r.body);
  r = await call('POST', '/import', { token: stanTurn, body });
  ok('(h) imported into the turn\'s own scope', r.status === 200 && r.body.ok && r.body.records === 1 && L.read({ scopes: ['user:stan'] }).some(x => x.conv === 'import:granola:g-9'), r.body);
  ok('(h) ...and nowhere else', !L.read({ scopes: ['shared', 'user:kasia'] }).some(x => x.conv === 'import:granola:g-9'));
  r = await call('POST', '/import', { token: stanTurn, body });
  ok('(h) the same item again: already', r.status === 200 && r.body.already === true, r.body);
  // The workspace's Granola is the account of the admin who connected it:
  // what it brings in is theirs. Another person imports from their own.
  r = await call('POST', '/import', { token: kasiaTurn, body });
  ok('(h) another person cannot import from a notetaker that is not theirs', r.status === 400 && /not connected/.test(r.body.error), r.body);
  writeFileSync(join(ROOT, '.integrations', 'credentials.json'), JSON.stringify({ granola: { activatedAt: '2026-10-01T00:00:00Z', fields: {} }, 'granola@kasia': { activatedAt: '2026-10-02T00:00:00Z', fields: {}, owner: 'kasia', reach: 'personal' } }));
  r = await call('POST', '/import', { token: kasiaTurn, body });
  ok('(h) with their own account they get their own copy', r.status === 200 && r.body.ok && L.read({ scopes: ['user:kasia'] }).some(x => x.conv === 'import:granola:g-9'), r.body);
}

// ─── a note the bot makes goes through the sharing gate too ─────────────────
const T = await import('./team.js');
T.setSharing('kasia@example.test', 'auto');
const A = await import('./memory-asks.js');
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Vellmark starts the warehouse pilot on 4 November.', said: 'Vellmark starts the warehouse pilot on 4 November.' } });
ok('a work fact the bot notes in automatic mode reaches the team at once', r.status === 200 && r.body.shared === 1, r.body);
const crossed = L.read({ scopes: ['shared'] }).filter(x => x.tags?.sharedFact && /warehouse pilot/.test(x.text));
ok('...as a fact in her name, not the note', crossed.length === 1 && crossed[0].origin === 'user:kasia' && crossed[0].source === 'note', crossed);
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Kasia has a job offer from a recruiter.', said: 'I have a job offer from a recruiter, keep that between us.' } });
ok('what the person asked to keep between us stays, no question either', r.status === 200 && !r.body.shared && !r.body.asked, r.body);
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Kasia prefers remote work.', said: 'I prefer remote work, the launch is on 3 October.' } });
ok('a fact about the person becomes a question even in automatic mode', r.status === 200 && r.body.asked === 1 && A.listAsks('kasia', { status: 'pending' }).some(a => /remote work/.test(a.text)), r.body);
r = await call('POST', '/note', { token: groupTurn, body: { text: 'The pilot starts on 4 November.', said: 'The pilot starts on 4 November.' } });
ok('a group note is the group\'s: no gate, nothing crosses', r.status === 200 && !r.body.shared && !r.body.asked, r.body);
T.setSharing('kasia@example.test', 'ask');

// ─── (z) a member's own memory asked from a team room ────────────────────────
const PL = await import('./integrations/private-lookup.js');
const asked = [];
PL.configureLookup(async ({ member, question, people }) => { asked.push({ slug: member.slug, question, people }); return /glaze/.test(question) ? { answer: 'Harbor Glaze supplies the celadon at 14 GBP a kilo.' } : { nothing: true }; });
r = await call('POST', '/mine', { token: kasiaTurn, body: { question: 'the glaze?' } });
ok('(z) a person\'s own turn is refused: this is for a room', r.status === 403, r.body);
r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'team', group: true, groupId: '-100777' }), body: { question: 'the glaze?' } });
ok('(z) a group turn for an unknown sender is refused', r.status === 403 && /known person/.test(r.body.error), r.body);
r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'nobody', group: true, groupId: '-100777' }), body: { question: 'the glaze?' } });
ok('(z) a group turn for someone not on the roster is refused', r.status === 403, r.body);
r = await call('POST', '/mine', { token: groupTurn, body: {} });
ok('(z) a question is required', r.status === 400, r.body);
const kasiaRoom = ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' });
r = await call('POST', '/mine', { token: kasiaRoom, body: { question: 'what did we agree on the glaze?' } });
ok('(z) a roster member in the team\'s room gets their own memory\'s answer', r.status === 200 && r.body.ok && !r.body.nothing && /Harbor Glaze/.test(r.body.answer), r.body);
ok('(z) ...looked up as them, told who is in the room', asked.at(-1)?.slug === 'kasia' && Array.isArray(asked.at(-1)?.people), asked.at(-1));
ok('(z) ...and it is on their Changes as theirs', L.readEvents().some(e => e.op === 'private_lookup' && e.scope === 'user:kasia' && e.answered === true && e.group === '-100777'));
r = await call('POST', '/mine', { token: kasiaRoom, body: { question: 'the kiln schedule?' } });
ok('(z) nothing in their memory is "nothing", never a guess', r.body.ok && r.body.nothing === true && !r.body.answer, r.body);
r = await call('POST', '/mine', { token: kasiaRoom, body: { question: 'the glaze?' } });
ok('(z) a third lookup in one turn is not made', r.body.nothing === true && /twice/.test(r.body.note || ''), r.body);
PL.configureLookup(async () => { throw new Error('model down'); });
const lastKasia = ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' });
r = await call('POST', '/mine', { token: lastKasia, body: { question: 'the glaze?' } });
ok('(z) a failed lookup says so, not an answer', r.body.failed === true && !r.body.answer && /do not guess/.test(r.body.note || ''), r.body);
PL.configureLookup(async ({ member, question, people }) => { asked.push({ slug: member.slug, question, people }); return { answer: 'You prefer short replies in Polish.' }; });
T.recordGroupMember('-100777', '9999999', 'Olek');
r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: { question: 'how do I like my replies?' } });
ok('(z) with someone from outside in the room, the asker still gets their own answer (theirs to have said)', r.body.ok && r.body.answer === 'You prefer short replies in Polish.' && r.body.outsiders === 1, r.body);
ok('(z) ...and the one-shot is told who is there', asked.at(-1)?.people?.includes('Olek'), asked.at(-1));
PL.configureLookup(async () => ({ secret: true }));
r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: { question: 'what is my door code?' } });
ok('(z) a secret: never said in a room, the DM offered, never the value', r.body.ok && r.body.secret === true && !r.body.answer && /DM/.test(r.body.note || ''), r.body);
PL.configureLookup(async ({ member, question, people }) => { asked.push({ slug: member.slug, question, people }); return { answer: 'You prefer short replies in Polish.' }; });
{
  const fs = await import('node:fs');
  const f = join(ROOT, '.team-config.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.teamMode = false; fs.writeFileSync(f, JSON.stringify(c));
  r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'stan', group: true, groupId: '-100777' }), body: { question: 'where am I this week?' } });
  ok('(z) a solo workspace: its one person reaches their own memory from a room too', r.body.ok && !!r.body.answer && asked.at(-1)?.slug === 'stan', r.body);
  r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'team', group: true, groupId: '-100777' }), body: { question: 'where is Stan this week?' } });
  ok('(z) ...and nobody else does, solo or not', r.status === 403, r.body);
  c.teamMode = true; fs.writeFileSync(f, JSON.stringify(c));
}
T.touchGroupMeta('-100777', { privateAnswers: 'off' });
r = await call('POST', '/mine', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: { question: 'the glaze?' } });
ok('(z) the room\'s switch off: nothing', r.body.nothing === true && r.body.off === true, r.body);
T.touchGroupMeta('-100777', { privateAnswers: 'team' });
PL.configureLookup(null);

// ─── (z2) a member's own connections asked from a team room ──────────────────
r = await call('POST', '/mine/connections', { token: kasiaTurn, body: { question: 'how many rows in my users table?' } });
ok('(z2) a person\'s own turn is refused: this is for a room', r.status === 403, r.body);
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'team', group: true, groupId: '-100777' }), body: { question: 'x' } });
ok('(z2) an unknown sender in a room is refused', r.status === 403, r.body);
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'nobody', group: true, groupId: '-100777' }), body: { question: 'x' } });
ok('(z2) someone not on the roster is refused', r.status === 403, r.body);
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: {} });
ok('(z2) a question is required', r.status === 400, r.body);
const conn = [];
PL.configureConnections(async ({ member, servers, prompt }) => { conn.push({ slug: member.slug, servers, prompt }); return { answer: 'Your notetaker has 3 meetings from this week.' }; });
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: { question: 'how many meetings did I have this week?' } });
ok('(z2) a member asks their own account from the room and gets its answer', r.body.ok && /3 meetings/.test(r.body.answer || ''), r.body);
ok('(z2) ...asked as them, with their own servers alone', conn.at(-1)?.slug === 'kasia' && conn.at(-1).servers.length > 0 && conn.at(-1).servers.every(n => n.endsWith('-mine')), conn.at(-1) && { servers: conn.at(-1).servers });
ok('(z2) ...and the ask is on their Changes', L.readEvents().some(e => e.op === 'private_lookup' && e.kind === 'connections' && e.scope === 'user:kasia' && e.answered === true));
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'stan', group: true, groupId: '-100777' }), body: { question: 'my meetings?' } });
ok('(z2) someone with no account of their own is told so, and nothing runs as them', r.body.ok && r.body.none === true && !r.body.answer && conn.at(-1).slug === 'kasia', r.body);
PL.configureConnections(async ({ question }) => ({ answer: /rename/.test(question) ? 'Renamed it to "Kickoff".' : 'x' }));
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: { question: 'rename my last meeting to Kickoff' } });
ok('(z2) a change they ask for from the room is made as in their own chat, and said', r.body.ok && /Renamed/.test(r.body.answer || ''), r.body);
PL.configureConnections(null);
{
  const { groupTurnParams } = await import('./integrations/group-watcher.js');
  const asKasia = groupTurnParams(T.getGroup('-100777'), [], { message_id: '1', from_id: '2220002', who: 'Kasia', text: 'my meetings?' }).message;
  ok('(z2) the room turn names the sender\'s own accounts and the tool to ask them', /THEIR OWN ACCOUNTS: Kasia connected Granola/.test(asKasia) && /ask_my_connections/.test(asKasia), asKasia.split('\n').find(l => /ACCOUNTS/.test(l)));
  ok('(z2) ...and says anyone else\'s are not connected for this room, never that they do not exist', /not connected for this room/.test(asKasia) && /never that it does not exist/.test(asKasia));
}
T.touchGroupMeta('-100777', { privateAnswers: 'off' });
r = await call('POST', '/mine/connections', { token: ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' }), body: { question: 'x' } });
ok('(z2) the room\'s switch off covers their accounts too', r.body.off === true && !r.body.answer, r.body);
T.touchGroupMeta('-100777', { privateAnswers: 'team' });

server.close();
console.log(`memory-v4-routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
