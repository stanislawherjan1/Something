/**
 * The nightly invariants find what they are meant to find, and nothing in a clean store.
 * Run: node lib/memory-invariants.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'mem-inv-'));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${n}${x !== undefined ? `\n        ${JSON.stringify(x).slice(0, 500)}` : ''}`); } };
const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const I = await import('./memory-invariants.js');
const S = 'user:ola';
const r1 = (await L.append({ scope: S, source: 'web', ts: '2026-10-01T10:00:00Z', text: 'Ola: lunch with Marek on 15 October at 13:00' })).id;
const add = async (f) => (await F.apply(S, [{ op: 'add', fact: f }], { record: r1, standing: 'said', ts: '2026-10-01T10:00:00Z', entities: [{ name: 'Marek', kind: 'person' }, { name: 'Porto', kind: 'topic' }] })).ids[0];
await add({ title: 'Lunch with Marek', text: 'Ola has lunch with Marek on 15 October at 13:00.', kind: 'status', about: 'meeting', when: '2026-10-15T13:00', whenFrom: 'on 15 October at 13:00', expires: '2026-10-15', subject: 'Marek', evidence: 'lunch with Marek on 15 October at 13:00' });
ok('a clean store has no violations', I.check([S]).length === 0, I.check([S]));
await add({ title: 'Lunch with Marek again', text: 'Ola has lunch with Marek on 15 October.', kind: 'status', about: 'meeting', when: '2026-10-15', whenFrom: 'on 15 October', subject: 'Marek', evidence: 'lunch with Marek on 15 October' });
await add({ title: 'Porto trip', text: 'Ola flies to Porto on 22 October.', kind: 'status', about: 'travel', when: '2026-10-22', whenFrom: 'on 22 October', subject: 'Porto', evidence: 'lunch with Marek' });
await add({ text: 'Correction: the lunch is with Marek, not Jan.', kind: 'fact', evidence: 'lunch with Marek' });
const ghost = await add({ text: 'Ola owns a bike.', kind: 'fact', evidence: 'x' });
appendFileSync(F.factsPath(S), JSON.stringify({ op: 'replace', id: ghost, by: 'no-such-fact', ts: '2026-10-02T00:00:00Z' }) + '\n');
const v = I.check([S]);
const kinds = (k) => v.filter(x => x.kind === k);
ok('twin: two current facts with one key', kinds('twin').length === 1, v);
ok('date: a day whose quoted words are not in its conversation', kinds('date').some(x => /Porto/.test(x.title)) && !kinds('date').some(x => /Marek/.test(x.title)), v);
ok('no word-list check on wording: a fact starting with "Correction:" is not flagged for that', !kinds('narration').length, v);
ok('...a replacement by a missing fact is not dangling once the fold drops it — the fact is simply current', !kinds('dangling').length, v);
L.redact(S, [r1], 'ola');
await new Promise(r => setTimeout(r, 30));
ok('orphan: facts whose record is gone', I.check([S]).filter(x => x.kind === 'orphan').length >= 4, I.check([S]));
{
  const F = await import('./memory-facts.js');
  const scope = 'user:inv';
  const base = (await L.append({ scope, source: 'web', ts: '2026-10-01T10:00:00Z', text: 'Ola: the kiosk is in Porto.' })).id;
  const made = await F.apply(scope, [{ op: 'add', fact: { title: 'Kiosk in Porto', text: 'The kiosk is in Porto.', kind: 'fact' } }], { record: base, ts: '2026-10-01T10:00:00Z' });
  await F.apply(scope, [{ op: 'update', target: F.get(scope, made.ids[0]), fact: { text: 'The kiosk moved to Braga.', kind: 'fact' } }], { record: 'rec-that-never-existed', ts: '2026-10-05T10:00:00Z' });
  const v = I.check([scope]);
  ok('an update standing on a record that does not exist is flagged', v.some(x => x.kind === 'stale-update' && x.id === made.ids[0]), v);
  ok('the word-list "narration" check is gone', !v.some(x => x.kind === 'narration'));
}

console.log(`memory-invariants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
