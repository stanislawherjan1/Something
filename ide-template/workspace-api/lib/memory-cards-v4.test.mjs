/**
 * Guards for sorting the loaded cards into v4 (migration 0006) and for the
 * duties file's unparsed lines.
 *
 * What must hold: the model only labels, so every kept line is the original
 * bullet verbatim; facts and statuses leave the profile as dated records in
 * that person's own scope; projects become topic records; tool tips move to
 * AGENT_TOOLS; a later duplicate is dropped and the earlier line stays; a line
 * the model does not label keeps its card; a fact on the duties card becomes a
 * record and `unparsed` ends up empty; a fact written to RESPONSIBILITIES is
 * refused with a pointer to memory_note; the owner can place an unparsed line
 * from the Routines screen. No model is called — the runner is a fake.
 *
 * Run: node lib/memory-cards-v4.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'cards-v4-'));
const STORE = mkdtempSync(join(tmpdir(), 'cards-v4-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'on';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ana@example.test', role: 'admin', slug: 'ana', displayName: 'Ana', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
const mem = join(ROOT, 'memory');
mkdirSync(join(mem, 'users', 'ana'), { recursive: true });
mkdirSync(join(mem, '_engine'), { recursive: true });
writeFileSync(join(mem, '_engine', '.v4-migrated'), '{}');
writeFileSync(join(mem, 'users', 'ana', 'USER_PROFILE.md'), [
  '---', 'card: USER_PROFILE', 'owner: ana', '---', '', '# USER_PROFILE', '',
  '## Identity',
  '- Name: Ana Kowal',
  '- Languages: Polish, English',
  '## Projects',
  '- **Beacon** — a lamp company she runs with Leo',
  '## Notes',
  '- Ana stopped working for Northgate as of 2026-09-29.  [Source: conversation, 2026-09-29]',
  '- Ana is currently in Lisbon (UTC+1).  [Source: conversation, 2026-09-27]',
  '- Ana works at Northgate part-time.  [Source: conversation, 2026-06-01]',
  '- Ana has left Northgate.  [Source: conversation, 2026-09-30]',
  '- Ana is moving the office to Porto.  [Source: conversation, 2026-09-30]',
  '- Ana prefers replies in Polish.',
  '- Some line the sorter does not label.',
].join('\n') + '\n');
writeFileSync(join(mem, 'users', 'ana', 'USER_PREFERENCES.md'), [
  '---', 'card: USER_PREFERENCES', 'owner: ana', '---', '', '# USER_PREFERENCES', '',
  '## Communication',
  '- Polish in chat, English for documents',
  '## Tools',
  '- Reminders: set_reminder MCP only (never CronCreate)',
  '## Writing',
  '- In the pitch deck, avoid the "X, not Y" construction.  [Source: conversation, 2026-08-17]',
].join('\n') + '\n');
writeFileSync(join(mem, 'RULES.md'), '# RULES\n\n## Never\n- Read another member\'s private files\n- Save screenshots outside .tmp/\n- Send a message for a run meant to be silent\n');
writeFileSync(join(mem, 'AGENT_TOOLS.md'), '# AGENT_TOOLS\n\n## reminders (active)\n- one line already here\n');
mkdirSync(join(ROOT, '.team', 'users', 'ana'), { recursive: true });
writeFileSync(join(ROOT, '.team', 'users', 'ana', 'routines.json'), JSON.stringify({ version: 1, routines: [{ id: 'r_1', title: 'Morning brief', source: 'ui' }], unparsed: ['- The user sold their Notely account and stopped using the digest.', '- Watch the invoices every 25th #finance'] }));

const L = await import('./memory-ledger.js');
const C = await import('./memory-cards-v4.js');
const migrate = await import('./migrate.js');
const RS = await import('./routines-store.js');

// A record the move (0005) made from a page: every bullet a note, the page
// title an entity — spec lines and a contact line beside one real fact.
const migrated = await L.append({
  scope: 'user:ana', source: 'migration', ts: '2026-09-09T12:00:00Z', conv: 'migration:memory/users/ana/concepts/beacon-app.md',
  text: 'Beacon App — Claims\n- Beacon uses Expo for iOS; Android is out of MVP scope.\n- Same-day entries from each partner show as separate cards.\n- Email: leo@example.test\n- Ana is building the Beacon app with Leo.',
  notes: [
    { text: 'Beacon uses Expo for iOS; Android is out of MVP scope.', kind: 'fact', evidence: 'Beacon uses Expo for iOS; Android is out of MVP scope.' },
    { text: 'Same-day entries from each partner show as separate cards.', kind: 'fact', evidence: 'Same-day entries from each partner show as separate cards.' },
    { text: 'Email: leo@example.test', kind: 'fact', evidence: 'Email: leo@example.test' },
    { text: 'Ana is building the Beacon app with Leo.', kind: 'fact', evidence: 'Ana is building the Beacon app with Leo.' },
  ],
  tags: { entities: [{ name: 'Beacon App' }, { name: 'Verification Failures' }] },
});
const roleOld = await L.append({ scope: 'user:ana', source: 'migration', ts: '2026-06-01T12:00:00Z', conv: 'migration:memory/users/ana/concepts/northgate.md',
  text: 'Northgate — Claims\n- Ana is Chief of Staff at Northgate.', notes: [{ text: 'Ana is Chief of Staff at Northgate.', kind: 'fact', evidence: 'Ana is Chief of Staff at Northgate.' }], tags: { entities: [{ name: 'Northgate' }] } });
const roleNew = await L.append({ scope: 'user:ana', source: 'migration', ts: '2026-09-29T12:00:00Z', conv: 'migration:memory/users/ana/concepts/northgate.md',
  text: 'Northgate — Claims\n- Ana left Northgate on 2026-09-29.', notes: [{ text: 'Ana left Northgate on 2026-09-29.', kind: 'fact', evidence: 'Ana left Northgate on 2026-09-29.' }], tags: { entities: [{ name: 'Northgate' }] } });
const runlog = await L.append({ scope: 'shared', source: 'migration', ts: '2026-09-28T12:00:00Z', conv: 'migration:memory/topics/repo-audit-log.md',
  text: 'repo-audit-log — Run history\n- 2026-09-07 weekly audit: auto-wiped 2 stale .playwright-mcp files; flagged 3 items.', notes: [{ text: '2026-09-07 weekly audit: auto-wiped 2 stale .playwright-mcp files; flagged 3 items.', kind: 'fact', evidence: 'x' }], tags: { entities: [{ name: 'repo-audit-log' }] } });
const about = await L.append({ scope: 'shared', source: 'migration', ts: '2026-05-16T12:00:00Z', conv: 'migration:memory/topics/ABOUT.md',
  text: 'ABOUT — Topics\n- Use a topic page when a card section is growing past ~60 lines.', notes: [{ text: 'Use a topic page when a card section is growing past ~60 lines.', kind: 'fact', evidence: 'x' }], tags: { entities: [{ name: 'About' }] } });

// ─── (a) the fake labeller — decides by content, like the model would ─────────
const label = (text) => {
  if (/^Name:|^Languages:/.test(text)) return 'profile';
  if (/^\*\*Beacon\*\*/.test(text)) return 'project';
  if (/stopped working|sold their Notely/.test(text)) return 'fact';
  if (/has left Northgate/.test(text)) return 'duplicate';
  if (/moving the office to Porto/.test(text)) return 'duplicate';   // of nothing — the model's slip on the canary
  if (/works at Northgate/.test(text)) return 'fact';
  if (/run meant to be silent/.test(text)) return 'preference';   // on the shared card: a rule for the bot, stays
  if (/currently in Lisbon/.test(text)) return 'status';
  if (/Polish in chat|prefers replies in Polish/.test(text)) return 'preference';
  if (/set_reminder|screenshots/.test(text)) return 'tool';
  if (/pitch deck, avoid/.test(text)) return 'one-off';
  if (/private files/.test(text)) return 'team';
  if (/Watch the invoices/.test(text)) return 'preference';   // a duty shape; the migration re-parses it as a routine
  // The migrated page's notes: specs and a contact line are not facts about the person.
  if (/Expo for iOS|separate cards/.test(text)) return 'tool';
  if (/^Email:/.test(text)) return 'profile';
  if (/building the Beacon app/.test(text)) return 'project';
  if (/Chief of Staff at Northgate/.test(text)) return 'superseded';
  if (/left Northgate on/.test(text)) return 'fact';
  if (/weekly audit: auto-wiped/.test(text)) return 'log';
  return null;   // "Some line the sorter does not label"
};
let runnerCalls = 0;
const runner = async ({ user }) => ({
  labels: (runnerCalls++, (() => {
    const only = user.match(/LABEL ONLY THESE NUMBERS: ([\d, ]+)/);
    const want = only ? new Set(only[1].split(',').map(x => Number(x.trim()))) : null;
    return user.split('\n').filter(l => /^\d+\. /.test(l)).filter(l => !want || want.has(Number(l.match(/^(\d+)\./)[1])));
  })()).map(l => {
    const n = Number(l.match(/^(\d+)\./)[1]);
    const text = l.replace(/^\d+\. \[[^\]]*\] /, '');
    const kind = label(text);
    if (!kind) return null;
    const lab = { n, kind, expires: kind === 'status' ? '2026-12-15' : null };
    if (kind === 'superseded') {
      const later = user.split('\n').find(x => /^\d+\. .*left Northgate on/.test(x));
      lab.by = later ? Number(later.match(/^(\d+)\./)[1]) : null;
    }
    if (kind === 'duplicate' && /has left Northgate/.test(text)) {
      const earlier = user.split('\n').find(x => /^\d+\. .*works at Northgate/.test(x));
      lab.by = earlier ? Number(earlier.match(/^(\d+)\./)[1]) : null;
    }
    return lab;
  }).filter(Boolean),
});

const sorted = await C.sortCard({ card: 'USER_PROFILE', md: readFileSync(join(mem, 'users', 'ana', 'USER_PROFILE.md'), 'utf8'), name: 'Ana', runner });
ok('(a) every bullet comes back, verbatim, with its section', sorted.length === 10 && sorted.every(b => b.line.startsWith('- ')) && sorted[0].section === 'Identity');
ok('(a) kinds land where the labels say', sorted.find(b => /Name:/.test(b.text)).kind === 'profile' && sorted.find(b => /Beacon/.test(b.text)).kind === 'project' && sorted.find(b => /has left/.test(b.text)).kind === 'duplicate');
ok('(a) an unlabelled bullet keeps kind null', sorted.find(b => /does not label/.test(b.text)).kind === null);
ok('(a) a status carries its expiry; a date stamp is read off the line', sorted.find(b => /Lisbon/.test(b.text)).expires === '2026-12-15' && sorted.find(b => /stopped working/.test(b.text)).date === '2026-09-29');

// ─── (b) the migration never runs by itself; the plan reads right ─────────────
const ctx = await migrate.buildContext({ runner });
const auto = await migrate.autoApply({ ctx });
ok('(b) boot only reports the sort', auto.pendingContent.includes('0006-cards-v4') && /Beacon/.test(readFileSync(join(mem, 'users', 'ana', 'USER_PROFILE.md'), 'utf8')), auto);
const seen = [];
const plan = await migrate.plan('0006-cards-v4', { ctx, onProgress: (done, total, label) => seen.push({ done, total, label }) });
ok('(b) progress is reported from the first call with the total known up front', seen.length > 2 && seen[0].done === 0 && seen[0].total > 0 && seen.every(x => x.total === seen[0].total) && seen[seen.length - 1].done === seen[0].total, seen.slice(0, 3));
ok('(b) the plan carries the labels for apply to reuse', Array.isArray(plan.plan.labels?.cards) && plan.plan.labels.cards.some(c => c.kinds.length) && Array.isArray(plan.plan.labels?.resort), Object.keys(plan.plan.labels || {}));
// Card lines: profile keeps 3 (Name, Languages, the unlabelled one), prefs 1, RULES 2
// (the team rule and the "preference" that has no person on a shared card); 5 profile
// lines go to the ledger (fact, status, project, older fact, the duplicate of nothing)
// and the one-off from prefs; the tool tip from prefs and the one from RULES move;
// the duplicate that names its earlier line drops.
ok('(b) the plan counts stay / ledger / move / drop', plan.plan.kept === 6 && plan.plan.toLedger === 6 && plan.plan.moved === 3 && plan.plan.dropped === 1, plan.plan);
ok('(b) ...and the routines row says what each unparsed line becomes', plan.plan.actions.some(a => /routines\.json/.test(a.path) && /1 → ledger, 0 routine\(s\), 1 still need a title/.test(a.detail)), plan.plan.actions);

// ─── (c) apply ───────────────────────────────────────────────────────────────
const callsBeforeApply = runnerCalls;
await migrate.apply('0006-cards-v4', { ctx });
ok('(c) apply reuses the plan\'s labels — no sorter call is paid for twice', runnerCalls === callsBeforeApply, { before: callsBeforeApply, after: runnerCalls });
const profile = readFileSync(join(mem, 'users', 'ana', 'USER_PROFILE.md'), 'utf8');
ok('(c) the profile keeps identity lines, verbatim, under their section', /## Identity\n- Name: Ana Kowal\n- Languages: Polish, English/.test(profile), profile);
ok('(c) ...and the unlabelled line', /Some line the sorter does not label/.test(profile));
ok('(c) facts, statuses, projects and the duplicate left the profile', !/Northgate|Lisbon|Beacon/.test(profile), profile);
ok('(c) the frontmatter survived', profile.startsWith('---\ncard: USER_PROFILE'));
const recs = L.read({ scopes: ['user:ana'] });
ok('(c) a fact became a record dated by its stamp, in the owner\'s scope', recs.some(r => r.source === 'migration' && /stopped working for Northgate/.test(r.text) && r.ts.startsWith('2026-09-29')));
ok('(c) a status became a record with its expiry', recs.some(r => /Lisbon/.test(r.text) && r.notes[0]?.kind === 'status' && r.notes[0]?.expires === '2026-12-15'));
ok('(c) a project became a topic record', recs.some(r => /Beacon/.test(r.text) && r.tags?.entities?.[0]?.name === 'Beacon' && r.tags.entities[0].kind === 'project'));
ok('(c) ...as plain text: the card\'s bold markers do not reach the Facts tab', recs.some(r => r.text.startsWith('Beacon — a lamp company') && r.notes[0].text === r.text));
ok('(c) plainText strips emphasis, code and links, keeps the words', C.plainText('**Beacon** — dormant `Expo` project. Detail: [[beacon|Beacon page]] and [docs](http://x)') === 'Beacon — dormant Expo project. Detail: beacon and docs');
{
  // The migrated "Chief of Staff" note was labelled superseded by the "left
  // Northgate" record: it points at that record, not at a date alone, so the
  // Facts tab can let it back when the newer record is erased.
  const old = L.read({ scopes: ['user:ana'], includeHidden: true }).flatMap(r => r.notes || []).find(n => /Chief of Staff at Northgate/.test(n.text));
  ok('(c) a superseded migrated note points at the record that replaced it', old && old.supersededBy === roleNew.id && /^\d{4}-\d{2}-\d{2}$/.test(old.superseded), old);
}
ok('(c) the duplicate was dropped, the earlier fact kept', !recs.some(r => /has left Northgate/.test(r.text)) && recs.some(r => /works at Northgate/.test(r.text)));
ok('(c) a "duplicate" that names no earlier line is not dropped — it becomes a dated record', !/moving the office to Porto/.test(profile) && recs.some(r => /moving the office to Porto/.test(r.text) && r.ts.startsWith('2026-09-30')));
ok('(c) nothing landed in shared memory', !L.read({ scopes: ['shared'] }).some(r => /Northgate|Lisbon|Beacon/.test(r.text)));
const tools = readFileSync(join(mem, 'AGENT_TOOLS.md'), 'utf8');
ok('(c) tool tips moved to AGENT_TOOLS, the existing line kept', /one line already here/.test(tools) && /set_reminder MCP only/.test(tools) && /Save screenshots outside/.test(tools), tools);
const prefs = readFileSync(join(mem, 'users', 'ana', 'USER_PREFERENCES.md'), 'utf8');
ok('(c) the preferences keep the standing rule and lose the tool tip', /Polish in chat/.test(prefs) && !/set_reminder/.test(prefs));
// The profile's preference line moved to the preferences card, which was
// rebuilt AFTER it: on the canary that move was lost with the snapshot.
ok('(c) a line moved to a card rebuilt later survives the rebuild', /prefers replies in Polish/.test(prefs) && !/prefers replies in Polish/.test(profile), prefs);
ok('(c) a one-task rule leaves the preferences and becomes a dated record, not a standing rule', !/pitch deck/.test(prefs) && recs.some(r => /pitch deck/.test(r.text) && r.ts.startsWith('2026-08-17')), prefs);
const rules = readFileSync(join(mem, 'RULES.md'), 'utf8');
ok('(c) RULES keeps the team rule and loses the tool tip', /private files/.test(rules) && !/screenshots/.test(rules));
ok('(c) a "preference" on the shared card stays there — no flat USER_PREFERENCES.md that team mode never loads', /run meant to be silent/.test(rules) && !existsSync(join(mem, 'USER_PREFERENCES.md')), rules);
const store = RS.readRoutines('ana');
ok('(c) the fact on the duties card became a record and left unparsed', recs.some(r => /sold their Notely/.test(r.text)) && !store.unparsed.some(l => /Notely/.test(l)));
ok('(c) a duty-shaped line without a title is kept for the owner to name, not invented', store.unparsed.length === 1 && /invoices/.test(store.unparsed[0]) && !store.routines.some(r => /invoices/.test(r.title)), store);
ok('(c) a second run has nothing to do', (await migrate.status({ ctx })).find(m => m.id === '0006-cards-v4').needed === false);

// ─── (c2) migrated records: junk notes leave the Facts tab, the text stays ───
const mig = L.read({ scopes: ['user:ana'] }).find(r => r.id === migrated.id);
ok('(c2) spec lines and the contact line are gone from the notes', mig.notes.length === 0 || !mig.notes.some(n => /Expo|separate cards|Email:/.test(n.text)), mig.notes);
ok('(c2) the project note became a project entity (the page title), not a Facts row', mig.tags.entities.some(e => e.name === 'Beacon App' && e.kind === 'project') && !mig.notes.some(n => /building the Beacon/.test(n.text)), mig.tags);
ok('(c2) the page-title entity that nothing kept names is gone', !mig.tags.entities.some(e => e.name === 'Verification Failures'), mig.tags);
ok('(c2) the record\'s text is untouched — retrieval still finds it', /Same-day entries from each partner/.test(mig.text) && mig.ts === '2026-09-09T12:00:00.000Z');
const old = L.read({ scopes: ['user:ana'] }).find(r => r.id === roleOld.id);
const cur = L.read({ scopes: ['user:ana'] }).find(r => r.id === roleNew.id);
ok('(c2) an old value is marked superseded by the date of its successor; the successor stays current', old.notes[0]?.superseded === '2026-09-29' && !cur.notes[0]?.superseded, { old: old.notes, cur: cur.notes });
const aboutRec = L.read({ scopes: ['shared'] }).find(r => r.id === about.id);
ok('(c2) the old wiki\'s own documentation (an ABOUT page) loses its notes and entity before any model sees it', aboutRec.notes.length === 0 && aboutRec.tags.entities.length === 0, aboutRec);
const logRec = L.read({ scopes: ['shared'] }).find(r => r.id === runlog.id);
ok('(c2) the bot\'s own run log loses its notes and its topic; the text stays for search', logRec.notes.length === 0 && logRec.tags.entities.length === 0 && /auto-wiped/.test(logRec.text), logRec);
ok('(c2) a real fact that merely mentions a file path is not treated as self-description', !C.isSystemSelfDescription({ page: 'memory/users/ana/concepts/x.md', text: 'The vision doc is at Beacon/vision-doc.md in the project root.' }) && C.isSystemSelfDescription({ page: 'memory/topics/ABOUT.md', text: 'anything' }));

// ─── (c3a) a failing batch does not fail the run ─────────────────────────────
// On the canary one sorter call timed out and the whole 20-minute run was
// lost. A batch that fails leaves its lines unlabelled (they keep their card);
// the rest of the run completes and the plan says how many batches failed.
{
  let calls = 0;
  const flaky = async (args) => { calls++; if (calls === 2) throw new Error('timeout'); return runner(args); };
  const md = Array.from({ length: 30 }, (_, i) => `- Name: person ${i}`).join('\n') + '\n';   // 3 batches of 12/12/6
  const sorted = await C.sortCard({ card: 'USER_PROFILE', md, runner: flaky, concurrency: 1 });
  ok('(c3a) the run completes with one batch failed', sorted.length === 30 && sorted.failures.length === 1 && /timeout/.test(sorted.failures[0].error), sorted.failures);
  ok('(c3a) the failed batch\'s lines are unlabelled — they keep their card', sorted.slice(12, 24).every(b => b.kind === null) && sorted.slice(0, 12).every(b => b.kind === 'profile'));
}

// ─── (c3) cancel: stops between batches, before anything is written ──────────
let cancelThrew = null;
try { await C.sortCard({ card: 'X', md: '- one\n- two\n- three\n', runner, shouldStop: () => true }); } catch (e) { cancelThrew = e.message; }
ok('(c3) a cancel is honoured before the next batch', cancelThrew === 'cancelled');

// ─── (d) the source: a fact cannot be written as a duty any more ─────────────
const W = await import('./memory-v4-writes.js');
let r = await W.v4Write({ op: 'remember', body: { card: 'RESPONSIBILITIES', text: 'The user sold their Notely account.' }, actor: 'ana', inGroup: false, scope: 'private', owner: 'ana' });
ok('(d) a fact written to RESPONSIBILITIES is refused and pointed at memory_note', r.status === 422 && /memory_note/.test(r.body.error), r);
r = await W.v4Write({ op: 'remember', body: { card: 'RESPONSIBILITIES', text: '{mail} **Check email** — every morning #email' }, actor: 'ana', inGroup: false, scope: 'private', owner: 'ana' });
ok('(d) a real duty still lands in routines', r.status === 200 && RS.readRoutines('ana').routines.some(x => x.title === 'Check email'));

// ─── (e) the owner places an unparsed line from the Routines screen ──────────
RS.writeRoutines('ana', { routines: RS.readRoutines('ana').routines, unparsed: ['- Ana bought a boat in June.'] });
const express = (await import('express')).default;
const router = (await import('../routes/memory-v4.js')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', router());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const call = async (path, body) => {
  const rs = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-actor': 'ana@example.test' }, body: JSON.stringify(body) });
  return { status: rs.status, body: await rs.json() };
};
r = await call('/routines/unparsed', { line: '- Ana bought a boat in June.', as: 'memory' });
ok('(e) "this is a fact" makes a record and clears the line', r.body.ok && RS.readRoutines('ana').unparsed.length === 0 && L.read({ scopes: ['user:ana'] }).some(x => /bought a boat/.test(x.text)));
RS.writeRoutines('ana', { routines: RS.readRoutines('ana').routines, unparsed: ['- keep an eye on the board'] });
r = await call('/routines/unparsed', { line: '- keep an eye on the board', as: 'routine', title: 'Board watch' });
ok('(e) "make it a routine" needs a title and keeps the text as its description', r.body.ok && RS.readRoutines('ana').routines.some(x => x.title === 'Board watch' && /board/.test(x.description)));
r = await call('/routines/unparsed', { line: '- not there', as: 'memory' });
ok('(e) a line that is not there → 404', r.status === 404);
const facts = await (await fetch(`http://127.0.0.1:${server.address().port}/api/memory/v4/facts?history=0`, { headers: { 'x-test-actor': 'ana@example.test' } })).json();
ok('(f) a superseded fact is folded away from the current Facts by default', !facts.items.some(x => /Chief of Staff at Northgate/.test(x.text)) && facts.items.some(x => /left Northgate/.test(x.text)), facts.items.map(x => x.text));
const factsAll = await (await fetch(`http://127.0.0.1:${server.address().port}/api/memory/v4/facts?history=1`, { headers: { 'x-test-actor': 'ana@example.test' } })).json();
ok('(f) ...and shows under "past" with the date it was superseded', factsAll.items.some(x => /Chief of Staff at Northgate/.test(x.text) && x.past && x.superseded === '2026-09-29'));
// ─── (g) routines follow the team-mode switch (canary: "Nothing yet" after it) ─
{
  const W = await import('./memory-v4-writes.js');
  const setMode = (on) => writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: on }));
  const before = RS.readRoutines('ana').routines.map(x => x.title);
  setMode(false);
  const solo = await (await fetch(`http://127.0.0.1:${server.address().port}/api/routines`, { headers: { 'x-test-actor': 'ana@example.test' } })).json();
  ok('(g) switched to solo, the admin\'s routines are still on the screen', before.length > 0 && before.every(t => solo.routines.some(x => x.title === t)), solo.routines.map(x => x.title));
  ok('(g) ...moved, not copied: the per-person file is gone', !existsSync(RS.routinesPath('ana')));
  RS.writeRoutines('default', { routines: [...RS.readRoutines('default').routines, { title: 'Solo-era duty', description: 'added while solo' }], unparsed: [] });
  setMode(true);
  const key = W.routinesOwner('ana');
  const team = RS.readRoutines(key).routines.map(x => x.title);
  ok('(g) switched back on, everything is the admin\'s again — nothing lost, nothing doubled', key === 'ana' && before.every(t => team.includes(t)) && team.includes('Solo-era duty') && new Set(team).size === team.length, team);
  ok('(g) ...and the solo file is folded away', !existsSync(RS.routinesPath('default')));
  RS.writeRoutines('default', { routines: [{ title: 'Board watch', description: 'duplicate by title' }], unparsed: [] });
  W.routinesOwner('ana');
  ok('(g) a routine already there (same title) is not duplicated', RS.readRoutines('ana').routines.filter(x => x.title === 'Board watch').length === 1);
}
// ─── (h) the routines marketplace ────────────────────────────────────────────
{
  const port = server.address().port;
  const get = async () => (await fetch(`http://127.0.0.1:${port}/api/routines/catalog`, { headers: { 'x-test-actor': 'ana@example.test' } })).json();
  const send = async (method, id) => { const rs = await fetch(`http://127.0.0.1:${port}/api/routines/catalog/${id}`, { method, headers: { 'x-test-actor': 'ana@example.test' } }); return { status: rs.status, body: await rs.json() }; };
  // Nothing connected: Everyday only.
  writeFileSync(join(STORE, 'credentials.json'), '{}');
  let cat = await get();
  ok('(h) with nothing connected, Everyday comes first and is available', cat.ok && cat.groups[0].id === 'everyday' && cat.groups[0].routines.every(x => x.available), cat.groups?.map(g => g.id));
  ok('(h) ...and every integration section is shown, not available', cat.groups.slice(1).length > 5 && cat.groups.slice(1).every(g => !g.connected && g.routines.every(x => !x.available)));
  ok('(h) an integration routine cannot be added before it is connected', (await send('POST', 'stockout-forecast')).status === 409);
  // Connect Shopify: its section appears, headed by its catalog label.
  writeFileSync(join(STORE, 'credentials.json'), JSON.stringify({ shopify: { fields: {} } }));
  cat = await get();
  const shop = cat.groups.find(g => g.id === 'shopify');
  ok('(h) connecting Shopify makes its section available, right after Everyday', shop && shop.connected && shop.label && shop.logo && cat.groups[1].id === 'shopify' && shop.routines.find(x => x.id === 'stockout-forecast').available, cat.groups.map(g => g.id));
  const nb = cat.groups.flatMap(g => g.routines).find(x => x.id === 'new-bookings');
  ok('(h) a routine names every integration it works with (filterable by each)', nb && nb.integrations.includes('calcom') && nb.integrations.includes('calendly'));
  ok('(h) the filter list has every catalog integration, connected first', cat.integrations[0].id === 'shopify' && cat.integrations.some(i => i.id === 'calendly' && !i.connected));
  ok('(h) the others stay listed but locked', cat.groups.find(g => g.id === 'github') && !cat.groups.find(g => g.id === 'github').connected);
  // Add: a normal routine in the person's list, marked Added.
  let r = await send('POST', 'stockout-forecast');
  const mine = () => RS.readRoutines(W.routinesOwner('ana')).routines;
  ok('(h) Add writes an ordinary routine with its catalog id', r.status === 200 && r.body.added && mine().some(x => x.catalogId === 'stockout-forecast' && x.source === 'catalog' && !x.retired));
  r = await send('POST', 'stockout-forecast');
  ok('(h) adding twice does not duplicate', r.body.added === false && mine().filter(x => x.catalogId === 'stockout-forecast' && !x.retired).length === 1);
  cat = await get();
  ok('(h) the Marketplace shows it as Added', cat.groups.find(g => g.id === 'shopify').routines.find(x => x.id === 'stockout-forecast').added === true);
  ok('(h) catalog entries never expose `requires`', !JSON.stringify(cat).includes('"requires"'));
  // Remove = retire (kept in history), and it can be added again.
  r = await send('DELETE', 'stockout-forecast');
  ok('(h) Remove retires it', r.status === 200 && mine().some(x => x.catalogId === 'stockout-forecast' && x.retired) && !(await get()).groups.find(g => g.id === 'shopify').routines.find(x => x.id === 'stockout-forecast').added);
  ok('(h) unknown id → 404', (await send('POST', 'no-such-routine')).status === 404 && (await send('DELETE', 'morning-brief')).status === 404);
  r = await send('POST', 'morning-brief');
  ok('(h) an Everyday routine adds with nothing connected', r.status === 200 && r.body.added);
}

// ─── (i) your own routines: add, edit, delete from the screen ────────────────
{
  const port = server.address().port;
  const call = async (method, path, body) => {
    const rs = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'x-test-actor': 'ana@example.test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: rs.status, body: await rs.json() };
  };
  const mine = () => RS.readRoutines(W.routinesOwner('ana')).routines;
  ok('(i) a routine needs a title and what to do', (await call('POST', '/routines', { title: 'No body' })).status === 400);
  let r = await call('POST', '/routines', { title: 'Supplier emails', description: 'Every weekday at 10:00, check supplier email for delays.', icon: 'mail', tags: '#email #daily' });
  const id = r.body.routine?.id;
  ok('(i) New routine lands in the list', r.status === 200 && mine().some(x => x.id === id && x.source === 'ui' && x.tags.join() === 'email,daily'), r.body);
  // A catalog routine edited: its one-liner goes, it stays "Added".
  const cat = mine().find(x => x.catalogId === 'morning-brief' && !x.retired);
  r = await call('PATCH', `/routines/${cat.id}`, { description: 'Each morning at 7, only the three most urgent tasks.' });
  const edited = mine().find(x => x.id === cat.id);
  ok('(i) editing a catalog routine keeps its catalog id and drops the stale summary', r.status === 200 && edited.catalogId === 'morning-brief' && !edited.summary && /three most urgent/.test(edited.description), edited);
  ok('(i) an empty title is refused', (await call('PATCH', `/routines/${id}`, { title: '' })).status === 400);
  r = await call('DELETE', `/routines/${id}`);
  ok('(i) Delete retires it', r.status === 200 && mine().find(x => x.id === id).retired);
  ok('(i) another person\'s or unknown id → 404', (await call('PATCH', '/routines/r_000000000000', { title: 'x' })).status === 404 && (await call('DELETE', `/routines/${id}`)).status === 404);
}

// ─── (j) the bot adds a Marketplace routine (add_routine), never from a group ─
{
  const port = server.address().port;
  const { issueTurnToken } = await import('./turn-identity.js');
  const add = async (id, tok) => {
    const rs = await fetch(`http://127.0.0.1:${port}/api/internal/routines/catalog/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ide-turn': tok, 'x-ide-actor': 'ana' }, body: '{}' });
    return { status: rs.status, body: await rs.json() };
  };
  const mine = () => RS.readRoutines(W.routinesOwner('ana')).routines;
  const dm = issueTurnToken({ actor: 'ana' });
  const grp = issueTurnToken({ actor: 'ana', group: true, groupId: '-1001234567' });
  ok('(j) refused in a group chat', (await add('weather-morning', grp)).status === 403 && !mine().some(x => x.catalogId === 'weather-morning'));
  let r = await add('weather-morning', dm);
  ok('(j) a direct conversation adds it, as a catalog routine', r.status === 200 && r.body.added && mine().some(x => x.catalogId === 'weather-morning' && x.source === 'catalog'), r.body);
  r = await add('weather-morning', dm);
  ok('(j) adding again changes nothing', r.body.added === false && mine().filter(x => x.catalogId === 'weather-morning' && !x.retired).length === 1);
  ok('(j) unknown id → 404', (await add('no-such-routine', dm)).status === 404);
  ok('(j) no turn identity → 403', (await add('good-news', 'not-a-token')).status === 403);
}

// ─── (k) memory_now: the person's current context, fresh, never in a group ──
{
  const port = server.address().port;
  const { issueTurnToken } = await import('./turn-identity.js');
  const now = async (tok) => { const rs = await fetch(`http://127.0.0.1:${port}/api/internal/memory/v4/now`, { headers: { 'x-ide-turn': tok, 'x-ide-actor': 'ana' } }); return { status: rs.status, body: await rs.json() }; };
  let r = await now(issueTurnToken({ actor: 'ana' }));
  ok('(k) a direct turn gets settings and routines', r.status === 200 && /Time zone:/.test(r.body.text) && /routines/i.test(r.body.text), r.body);
  r = await now(issueTurnToken({ actor: 'ana', group: true, groupId: '-1001234567' }));
  ok('(k) refused in a group chat', r.status === 403);
  ok('(k) no turn identity → 403', (await now('not-a-token')).status === 403);
}
server.close();

console.log(`memory-cards-v4: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
