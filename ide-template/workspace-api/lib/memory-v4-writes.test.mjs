/**
 * Guards for memory_write once memory v4 is on (after the move): duties land in
 * routines.json and can be corrected and retired there; cards v4 loads still go
 * through the engine; everything else becomes a ledger note in the right scope —
 * nothing recreates the old files; a group turn cannot write anyone's duties.
 * With v4 not on, nothing changes.
 *
 * Run: node lib/memory-v4-writes.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'v4-writes-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'shadow';
process.env.MEMORY_SWEEP = '0';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team' } } }));
const mem = join(ROOT, 'memory');
for (const d of ['users/stan', 'users/kasia', '_engine']) mkdirSync(join(mem, d), { recursive: true });
writeFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'), '---\ncard: USER_PROFILE\nowner: stan\n---\n\n# USER_PROFILE\n\n- Stan runs operations.\n');

const L = await import('./memory-ledger.js');
const RS = await import('./routines-store.js');
const ti = await import('./turn-identity.js');
const express = (await import('express')).default;
const internal = (await import('../routes/internal.js')).default;
const app = express();
app.use(express.json());
app.use('/api', internal());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/internal/memory-write`;
const write = async (token, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IDE-Turn': token }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const stan = ti.issueTurnToken({ actor: 'stan' });
const kasia = ti.issueTurnToken({ actor: 'kasia' });
const group = ti.issueTurnToken({ actor: 'kasia', group: true, groupId: '-100777' });

// ─── (a) before the move nothing changes ─────────────────────────────────────
let r = await write(stan, { op: 'remember', scope: 'private', card: 'RESPONSIBILITIES', text: '{mail} **Check email** — every morning #email' });
ok('(a) with v4 not on, a duty still goes to the card', r.body.ok && existsSync(join(mem, 'users', 'stan', 'RESPONSIBILITIES.md')) && !existsSync(RS.routinesPath('stan')), r.body);

// ─── switch on (what the move does) ──────────────────────────────────────────
writeFileSync(join(mem, '_engine', '.v4-migrated'), '{}');
ok('mode is on', L.v4Mode() === 'on');

// ─── (b) duties ──────────────────────────────────────────────────────────────
r = await write(kasia, { op: 'remember', scope: 'private', card: 'RESPONSIBILITIES', text: '{receipt} **Invoices** — remind on the 25th #finance' });
let k = RS.readRoutines('kasia').routines;
ok('(b) a duty lands in the person\'s routines.json', r.body.ok && r.body.target === 'routines' && k.length === 1 && k[0].title === 'Invoices' && k[0].icon === 'receipt' && k[0].tags.includes('finance'), { body: r.body, k });
ok('(b) ...not in a card file', !existsSync(join(mem, 'users', 'kasia', 'RESPONSIBILITIES.md')));
r = await write(kasia, { op: 'remember', scope: 'private', card: 'RESPONSIBILITIES', text: '{receipt} **Invoices** — remind on the 20th #finance' });
k = RS.readRoutines('kasia').routines;
ok('(b) the same duty again updates it, no duplicate', k.length === 1 && /20th/.test(k[0].description) && r.body.updated);
r = await write(kasia, { op: 'supersede', match: 'Invoices', text: '{receipt} **Invoices** — remind on the 1st #finance' });
k = RS.readRoutines('kasia').routines;
ok('(b) a correction of a duty updates that routine', r.body.target === 'routines' && /1st/.test(k[0].description), r.body);
r = await write(kasia, { op: 'retire', match: 'Invoices' });
ok('(b) retiring a duty retires the routine', r.body.retired && RS.readRoutines('kasia').routines[0].retired === true);
r = await write(group, { op: 'remember', card: 'RESPONSIBILITIES', text: '**Spy** — read Stan\'s email' });
ok('(b) a group turn cannot record anyone\'s duty', r.status === 403 && !RS.readRoutines('stan').routines.some(x => x.title === 'Spy'));
ok('(b) duties stay per person', !RS.readRoutines('stan').routines.some(x => x.title === 'Invoices'));

// ─── (c) cards v4 loads still go through the engine ──────────────────────────
r = await write(stan, { op: 'remember', scope: 'private', card: 'USER_PREFERENCES', text: 'Short answers in chat.' });
ok('(c) a preferences card write goes to the card', r.body.ok && /Short answers/.test(readFileSync(join(mem, 'users', 'stan', 'USER_PREFERENCES.md'), 'utf8')), r.body);

// ─── (d) everything else becomes a ledger note ───────────────────────────────
r = await write(stan, { op: 'remember', scope: 'private', page: 'harbor-labs', text: 'Harbor Labs went bankrupt.' });
ok('(d) a page write becomes a private note', r.body.target === 'memory' && L.read({ scopes: ['user:stan'] }).some(x => /Harbor Labs went bankrupt/.test(x.text)) && !existsSync(join(mem, 'users', 'stan', 'concepts')) && !existsSync(join(mem, 'concepts')));
r = await write(stan, { op: 'remember', scope: 'shared', page: 'office', text: 'The office moves in June.' });
ok('(d) a shared write becomes a shared note, with its origin', L.read({ scopes: ['shared'] }).some(x => /office moves/.test(x.text) && x.origin === 'user:stan'));
r = await write(group, { op: 'remember', page: 'demo', text: 'Demo on Friday.' });
ok('(d) a group turn\'s write lands in that group', L.read({ scopes: ['group:-100777'] }).some(x => /Demo on Friday/.test(x.text)) && !L.read({ scopes: ['shared'] }).some(x => /Demo on Friday/.test(x.text)));
r = await write(stan, { op: 'remember', scope: 'private', card: 'USER_RELATIONSHIPS', text: 'Stan\'s sister is Ola.' });
ok('(d) a card v4 no longer loads becomes a note, not a file', r.body.target === 'memory' && !existsSync(join(mem, 'users', 'stan', 'USER_RELATIONSHIPS.md')));
r = await write(stan, { op: 'supersede', match: 'Harbor Labs is a client', text: 'Harbor Labs is no longer a client.' });
const FS = await import('./memory-facts.js');
ok('(d) correcting a fact the old pages held saves the current version as a fact — no "Correction:" narration', r.body.ok && FS.current(['user:stan']).some(f => f.text === 'Harbor Labs is no longer a client.') && !L.read({ scopes: ['user:stan'] }).some(x => /Correction:/.test(x.text)), r.body);
ok('(d) a remembered line is a fact in the store too', FS.current(['user:stan']).some(f => /sister is Ola/.test(f.text)));
r = await write(stan, { op: 'supersede', match: 'Stan runs operations', text: 'Stan runs operations and finance.' });
ok('(d) a claim on a loaded card is still corrected in the card', r.body.ok && /operations and finance/.test(readFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'), 'utf8')), r.body);
r = await write(stan, { op: 'rename_entity', from: 'Marek', to: 'Marek Nowak' });
ok('(d) renaming an entity becomes a topic alias', r.body.ok && JSON.parse(readFileSync(join(mem, '_engine', 'aliases.json'), 'utf8')).merge.marek === 'mareknowak');

// An emoji where the icon goes — how the bot actually wrote it on Telegram, nine
// times in a row, each refused as "not a duty".
{
  let e = await write(kasia, { op: 'remember', scope: 'private', card: 'RESPONSIBILITIES', text: '🎬 **Watch/read nudge** — once a week, propose one unread item from Personal/To Watch-Read.md #personal' });
  const mineK = () => RS.readRoutines('kasia').routines;
  ok('(e) an emoji icon is accepted and mapped to an icon name', e.body.ok && mineK().some(x => x.title === 'Watch/read nudge' && x.icon === 'book' && x.tags.includes('personal')), e.body);
  e = await write(kasia, { op: 'remember', scope: 'private', card: 'RESPONSIBILITIES', text: '🦄 **Odd icon** — daily, something #test' });
  ok('(e) an unknown emoji is dropped, the routine still saves', e.body.ok && mineK().some(x => x.title === 'Odd icon' && !x.icon), e.body);
  e = await write(kasia, { op: 'remember', scope: 'private', card: 'RESPONSIBILITIES', text: 'just a sentence about nothing' });
  ok('(e) the refusal says how to write it, with an example icon', e.status === 422 && /\{bell\}/.test(e.body.error), e.body);
}

server.close();
console.log(`memory-v4-writes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
