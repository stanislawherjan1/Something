/**
 * Nightly titles: an untitled fact gets a title; a dated meeting, trip or
 * deadline without a subject gets one — and with it the key that tells it from
 * other things, so the same trip said in a DM and in a group shows once.
 * Run: node lib/memory-titles.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'mem-titles-'));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${n}${x !== undefined ? `\n        ${JSON.stringify(x).slice(0, 500)}` : ''}`); } };
const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const V = await import('./memory-views.js');
const LLM = await import('./memory-llm.js');
const { titleUntitled } = await import('./memory-titles.js');
// The stand-in model: a title for each note, and the place each trip is to.
LLM.configureRunner(async ({ system, user }) => {
  // The names question: a name the fact's words carry, bent or not (the real model's judgment; here a prefix match stands in).
  if (/names \(people, companies, projects\)/.test(system)) {
    return { items: String(user).split('\n\n').map((block, i) => { const names = (block.match(/NAMES: (.*)/)?.[1] || '').split(' | ').filter(Boolean); const fact = block.match(/FACT: ([\s\S]*)/)?.[1] || ''; return { n: i + 1, mentioned: names.filter(n => fact.toLowerCase().includes(n.toLowerCase().split(' ')[0].slice(0, 5))) }; }) };
  }
  return { items: String(user).split('\n').map((l, i) => ({ n: i + 1, title: `Title ${i + 1}`, subject: /Lisbon/.test(l) ? 'Lisbon' : null })) };
});
const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
await L.append({ scope: 'user:ola', source: 'telegram', ts: new Date().toISOString(), text: 'Ola: Lisbon soon', notes: [{ title: 'Lisbon trip', text: `Ola flies to Lisbon on ${day}.`, kind: 'status', about: 'travel', when: day }] });
await L.append({ scope: 'group:-100777', source: 'group', ts: new Date().toISOString(), text: 'Ola: off to Lisbon', notes: [{ text: `Ola is flying to Lisbon on ${day}.`, kind: 'status', about: 'travel', when: day }] });
await L.append({ scope: 'user:ola', source: 'telegram', ts: new Date().toISOString(), text: 'Ola: my plants', notes: [{ text: 'Ola waters the plants on Fridays.', kind: 'fact' }] });
let now = V.now(['user:ola', 'group:-100777']);
ok('before: the same trip shows twice (no subject, no key)', now.filter(x => /Lisbon/.test(x.text)).length === 2, now.map(x => x.title || x.text));
const counts = await titleUntitled(['user:ola', 'group:-100777']);
ok('the titled trip gets a subject, not a new title', F.current(['user:ola']).find(f => /Lisbon/.test(f.text))?.title === 'Lisbon trip' && F.current(['user:ola']).find(f => /Lisbon/.test(f.text))?.subject === 'Lisbon');
ok('the untitled ones get a title', F.current(['user:ola']).find(f => /plants/.test(f.text))?.title && F.current(['group:-100777'])[0]?.title, counts);
ok('a plain fact gets no subject', !F.current(['user:ola']).find(f => /plants/.test(f.text))?.subject);
now = V.now(['user:ola', 'group:-100777']);
ok('after: the trip shows once, the private copy, marked as also in the group', now.filter(x => /Lisbon/.test(x.text)).length === 1 && now.find(x => /Lisbon/.test(x.text))?.scope === 'user:ola', now.map(x => `${x.scope} ${x.title}`));
const again = await titleUntitled(['user:ola', 'group:-100777']);
ok('a second night has nothing to do', Object.values(again).every(n => n === 0), again);

// ─── the names a legacy fact is about ────────────────────────────────────────
{
  const { narrowNames } = await import('./memory-titles.js');
  const r = await L.append({ scope: 'user:ola', source: 'web', ts: new Date().toISOString(), text: 'Ola: Quillwork site is up; Tuesday I meet Marek.',
    notes: [{ title: 'Quillwork website live', text: 'Quillwork launched its website.', kind: 'fact' }, { title: 'Marek on Tuesday', text: 'Ola meets Marek on Tuesday.', kind: 'fact' }, { title: 'Kiosk', text: 'Ola has a kiosk project.', kind: 'fact' }],
    tags: { entities: [{ name: 'Quillwork', kind: 'project' }, { name: 'Marek', kind: 'person' }] } });
  const before = F.forRecord('user:ola', r.id);
  ok('before: every fact of the record wears both names', before.every(f => f.entities?.length === 2), before);
  const n = await narrowNames(['user:ola']);
  const after = (re) => F.forRecord('user:ola', r.id).find(f => re.test(f.text));
  ok('after: each fact keeps the name its words mention', n.narrowed === 3 && after(/website/).entities?.map(e => e.name).join() === 'Quillwork' && after(/Marek/).entities?.map(e => e.name).join() === 'Marek', F.forRecord('user:ola', r.id));
  ok('a fact that mentions none is about none of them', !after(/kiosk/).entities, after(/kiosk/));
  ok('a second pass has nothing to do — and asks the model nothing', (await narrowNames(['user:ola'])).judged === 0);
  // An inflected form is the model's to recognise: the stand-in says yes to "Vellmarkowi".
  const r2 = await L.append({ scope: 'user:ola', source: 'web', ts: new Date().toISOString(), text: 'Ola: offer sent.',
    notes: [{ title: 'Offer sent', text: 'Ola sent the offer to Vellmarkowi.', kind: 'fact' }], tags: { entities: [{ name: 'Vellmark Logistics', kind: 'company' }, { name: 'Marek', kind: 'person' }] } });
  await narrowNames(['user:ola']);
  ok('a name the model says the words carry stays, whatever its form', F.forRecord('user:ola', r2.id)[0]?.entities?.map(e => e.name).join() === 'Vellmark Logistics', F.forRecord('user:ola', r2.id));
  // A fact whose names change is asked about again.
  await F.amend('user:ola', F.forRecord('user:ola', r2.id)[0].id, { entities: [{ name: 'Vellmark Logistics', kind: 'company' }, { name: 'Quillwork', kind: 'project' }] });
  ok('new names on a fact are judged afresh', (await narrowNames(['user:ola'])).judged === 1 && F.forRecord('user:ola', r2.id)[0]?.entities?.map(e => e.name).join() === 'Vellmark Logistics');
  // The model's silence on a fact leaves it as it is, to be asked again.
  LLM.configureRunner(async () => ({ items: [] }));
  await F.amend('user:ola', F.forRecord('user:ola', r2.id)[0].id, { entities: [{ name: 'Vellmark Logistics', kind: 'company' }, { name: 'Quillwork', kind: 'project' }] });
  const r3 = await narrowNames(['user:ola']);
  ok('no verdict: nothing dropped, asked again next night', r3.narrowed === 0 && F.forRecord('user:ola', r2.id)[0]?.entities?.length === 2 && (await narrowNames(['user:ola'])).judged === 1);
}
LLM.configureRunner(null);

console.log(`memory-titles: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
