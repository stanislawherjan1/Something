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
  if (schema?.properties?.notes) {
    const m = String(user).match(/(call|meeting) with Kamil on (\d+) October/i);
    if (m) return { notes: [{ title: `Kamil ${m[2]} October`, text: `A ${m[1]} with Kamil on ${m[2]} October.`, kind: 'status', about: 'meeting', when: `2026-10-${m[2].padStart(2, '0')}`, whenFrom: `on ${m[2]} October`, dayStated: true, subject: 'Kamil', evidence: m[0], names: [] }], rules: [], entities: [] };
    // The stand-in split: one entry per sentence of the NOTE that WORDS support (a word in common), worded plainly.
    const note = String(user).match(/NOTE: ([^]*?)\n\nWORDS: [^:]+: ([^]*)$/);
    if (!note) return { notes: [], rules: [], entities: [] };
    const words = note[2].trim();
    const entries = note[1].split(/(?<=\.)\s+/).map(t => t.trim()).filter(Boolean).map(t => ({ title: t.replace(/^Correction:\s*/i, '').split(' ').slice(0, 4).join(' '), text: t.replace(/^Correction:\s*/i, ''), kind: 'fact', evidence: t.toLowerCase().match(/\p{L}{5,}/gu)?.some(w => words.toLowerCase().includes(w)) ? words : '', names: [] }));
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
ok('(b) the bot token acting for a teammate reads that teammate', /side project/.test(r.body.text) && !/term sheet/.test(r.body.text));
ok('(b) excerpts are fenced', r.body.text.startsWith('<<<MEMORY') && r.body.text.trim().endsWith('<<<END MEMORY>>>'));

r = await call('GET', '/timeline?term=Orion', { token: stanTurn });
ok('(b) timeline respects the same scopes', /term sheet/.test(r.body.text) && !/side project/.test(r.body.text) && r.body.text.indexOf('new client') < r.body.text.indexOf('term sheet'));

// ─── (c) notes ───────────────────────────────────────────────────────────────
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Kasia prefers morning meetings.' } });
ok('(c) a note without the person\'s words is refused', r.status === 400 && /said required/.test(r.body.error), r.body);
r = await call('POST', '/note', { token: kasiaTurn, body: { text: 'Kasia prefers morning meetings.', said: 'I prefer morning meetings' } });
ok('(c) a note is private by default', r.body.ok && r.body.scope === 'private' && L.read({ scopes: ['user:kasia'] }).some(x => /morning meetings/.test(x.text)));
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

server.close();
console.log(`memory-v4-routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
