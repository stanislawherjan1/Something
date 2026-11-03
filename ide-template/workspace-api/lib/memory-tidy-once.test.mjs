// The one-off tidy at boot: the follow-ups a notetaker import filed beside a
// meeting's summary go away, and the private copy of a fact already shared is
// put away as moved. Idempotent; ordinary hides (undo in Changes), no erasing.
// Run: node lib/memory-tidy-once.test.mjs
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'tidy-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'tidy-store-'));
process.env.MEMORY_V4 = 'on';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ola@example.test', role: 'admin', slug: 'ola', displayName: 'Ola', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const S = await import('./memory-sharing.js');
const T = await import('./memory-tidy-once.js');
(await import('./memory-reconcile.js')).configureDecider?.(null);

const scope = 'user:ola';
const ts = '2026-10-05T09:00:00Z';
const imp = { integration: 'granola', item: 'm-1', title: 'Pilot', at: ts, url: null, participants: ['Marta'] };
// A meeting as an import filed it before: the summary fact and two follow-ups, on import records.
const notes = await L.append({ scope, source: 'integration', ts, conv: 'import:granola:m-1', text: 'Meeting: Pilot\nWith: Marta\nNotes:\n- pilot from 4 November', tags: { import: { ...imp, kind: 'notes' } } });
const part = await L.append({ scope, source: 'integration', ts, conv: 'import:granola:m-1', text: 'Meeting: Pilot\nWith: Marta\nTranscript:\nMarta: we decided three months', tags: { import: { ...imp, kind: 'transcript', part: 1, of: 1 } } });
const summary = { title: 'Call with Marta (5 Oct 2026)', text: 'Ola and Marta agreed the pilot starts on 4 November and runs three months.', kind: 'fact', about: 'meeting', when: '2026-10-05', subject: 'Marta', evidence: null, entities: [{ name: 'Marta', kind: 'person' }] };
const follow = { title: 'Pilot runs three months', text: 'The pilot runs three months from 4 November.', kind: 'status', about: 'deadline', when: '2026-11-04', evidence: 'we decided three months', entities: [{ name: 'Marta', kind: 'person' }] };
const voice = { title: 'Voice note: ideas for Q4', text: 'Ola wants to try a referral bonus in Q4.', kind: 'fact', evidence: null, entities: [] };
const s1 = await F.remember(scope, [summary], { record: notes.id, ts, entities: summary.entities, by: 'integration', standing: 'found', conv: 'import:granola:m-1' });
const f1 = await F.remember(scope, [follow], { record: part.id, ts, entities: follow.entities, by: 'integration', standing: 'said', conv: 'import:granola:m-1' });
const v1 = await F.remember(scope, [voice], { record: notes.id, ts, entities: [], by: 'integration', standing: 'said', conv: 'import:granola:m-1' });
// A chat-made fact that also cites the import record stays: not every source is an import.
const chat = await L.append({ scope, source: 'web', ts: '2026-10-06T09:00:00Z', conv: 'web:ola:s1', speaker: 'Ola', text: 'Marta confirmed the pilot budget is 18k.' });
const mixed = await F.remember(scope, [{ title: 'Pilot budget', text: 'The pilot budget is 18k PLN.', kind: 'fact', evidence: 'pilot budget is 18k', entities: [] }], { record: chat.id, ts: '2026-10-06T09:00:00Z', entities: [], by: 'web', standing: 'said', conv: 'web:ola:s1' });

ok('setup: the follow-up is a fact of its own before the tidy', F.current([scope]).some(f => f.id === f1.ids[0]));
const ups = T.importFollowUps(scope).map(f => f.id);
ok('the follow-up beside a summary is found; the summary, the voice note and the chat-made fact are not', ups.length === 1 && ups[0] === f1.ids[0], { ups, summary: s1.ids, voice: v1.ids, mixed: mixed.ids });

// A fact shared before the rule: the shared copy with origin, the private one still showing.
const priv = { title: 'Orbis showcase approved', text: 'Ola got the Orbis showcase slot approved.', kind: 'fact', evidence: 'showcase slot approved', subject: 'Orbis', concerns: 'a company or project', entities: [{ name: 'Orbis', kind: 'project' }] };
const pr = await L.append({ scope, source: 'telegram', ts: '2026-10-07T09:00:00Z', conv: 'tg:1', speaker: 'Ola', text: 'Orbis showcase slot approved.' });
const p1 = await F.remember(scope, [priv], { record: pr.id, ts: '2026-10-07T09:00:00Z', entities: priv.entities, by: 'telegram', standing: 'said', conv: 'tg:1' });
const sr = await L.append({ scope: 'shared', source: 'telegram', ts: '2026-10-07T09:00:00Z', conv: 'tg:1', speaker: 'Ola', text: 'Orbis showcase approved. Ola got the Orbis showcase slot approved.', origin: scope, tags: { sharedFact: true, from: 'ola' } });
await F.remember('shared', [priv], { record: sr.id, ts: '2026-10-07T09:00:00Z', entities: priv.entities, by: 'telegram', standing: 'said', conv: 'tg:1' });
ok('setup: the person sees the shared fact twice before the tidy', F.current([scope, 'shared']).filter(f => /Orbis showcase slot/.test(f.text)).length === 2);
const copies = T.privateCopies();
ok('the private copy of a shared fact is found by its origin and text', copies.length === 1 && copies[0].slug === 'ola' && copies[0].id === p1.ids[0], copies);

const r = await T.tidy();
ok('the tidy hides one follow-up and one private copy', r.followUps === 1 && r.copies === 1, r);
ok('the follow-up is hidden, with why', F.get(scope, f1.ids[0]).hidden && F.get(scope, f1.ids[0]).hiddenWhy === 'import follow-up');
ok('the private copy is hidden as shared; the person sees the fact once', F.get(scope, p1.ids[0]).hiddenWhy === S.WHY_SHARED && F.current([scope, 'shared']).filter(f => /Orbis showcase slot/.test(f.text)).length === 1);
ok('the summary, the voice note and the chat-made fact still show', [s1.ids[0], v1.ids[0], mixed.ids[0]].every(id => F.current([scope]).some(f => f.id === id)));
ok('nothing is erased: the hidden ones are still there to undo', F.all(scope).some(f => f.id === f1.ids[0]) && F.all(scope).some(f => f.id === p1.ids[0]));
ok('the hides are in Changes', L.readEvents({}).filter(e => e.op === 'hide' && e.by === 'tidy').length === 2, L.readEvents({}).filter(e => e.op === 'hide'));
const r2 = await T.tidy();
ok('a second run finds nothing', r2.followUps === 0 && r2.copies === 0, r2);

// The boot facade: once, by marker.
const first = T.tidyOnce();
await new Promise(res => setTimeout(res, 200));
ok('the boot run writes its marker', first.ran && existsSync(join(ROOT, 'memory', '_engine', '.tidy-2026-11-03')) && /follow-ups=0 copies=0/.test(readFileSync(join(ROOT, 'memory', '_engine', '.tidy-2026-11-03'), 'utf8')), first);
ok('...and does not run again', T.tidyOnce().ran === false);

console.log(`memory-tidy-once: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
