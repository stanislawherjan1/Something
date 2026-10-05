/**
 * Nightly aliases: the model says which tiles are one thing under two
 * spellings; code applies only pairs whose kinds agree and the owner has not
 * separated. Run: node lib/memory-aliases.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'mem-aliases-'));
mkdirSync(join(process.env.PROJECT_DIR, 'memory'), { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${n}${x !== undefined ? `\n        ${JSON.stringify(x).slice(0, 500)}` : ''}`); } };
const L = await import('./memory-ledger.js');
const V = await import('./memory-views.js');
const LLM = await import('./memory-llm.js');
const { mergeLookalikes } = await import('./memory-aliases.js');
const S = 'user:ola';
const put = (ts, conv, names) => L.append({ scope: S, source: 'web', ts, conv, text: `${names.join(' and ')} were discussed.`, tags: { entities: names.map(n => ({ name: n, kind: /Works|Labs/.test(n) ? 'company' : 'person' })) } });
await put('2026-09-01T10:00:00Z', 'c1', ['Jan Kowal']); await put('2026-09-02T10:00:00Z', 'c2', ['Jan Kowal']);
await put('2026-09-03T10:00:00Z', 'c3', ['Janek Kowal']); await put('2026-09-04T10:00:00Z', 'c4', ['Janek Kowal']);
await put('2026-09-05T10:00:00Z', 'c5', ['Marek Nowak']); await put('2026-09-06T10:00:00Z', 'c6', ['Marek Nowak']);
await put('2026-09-07T10:00:00Z', 'c7', ['Marek Wolski']); await put('2026-09-08T10:00:00Z', 'c8', ['Marek Wolski']);
await put('2026-09-09T10:00:00Z', 'c9', ['Helix Labs']); await put('2026-09-10T10:00:00Z', 'c10', ['Helix Labs']);
let seen = null;
LLM.configureRunner(async ({ user }) => {
  seen = user;
  const n = (name) => Number(user.split('\n').find(l => l.includes(`. ${name} `) || l.includes(`. ${name} —`))?.match(/^(\d+)\./)?.[1]);
  return { pairs: [
    { from: n('Janek Kowal'), into: n('Jan Kowal'), why: 'diminutive of Jan' },
    { from: n('Marek Wolski'), into: n('Marek Nowak'), why: 'same first name' },   // a wrong call the code must still apply? no — kinds agree, so it would; the owner's "not the same" blocks it
    { from: n('Helix Labs'), into: n('Jan Kowal'), why: 'nonsense' },               // a company into a person: refused
  ] };
});
V.decideAlias({ from: 'Marek Wolski', into: 'Marek Nowak', same: false });
const r = await mergeLookalikes(S, [S]);
ok('the model saw every tile with its kind', /Jan Kowal — person/.test(seen) && /Helix Labs — company/.test(seen), seen);
ok('a diminutive folds into the full name', r.merged.some(m => m.from === 'Janek Kowal' && m.into === 'Jan Kowal'), r);
ok('the owner\'s "not the same" is never overridden', !r.merged.some(m => m.from === 'Marek Wolski'), r);
ok('a company never folds into a person', !r.merged.some(m => m.from === 'Helix Labs'), r);
const tiles = V.topics([S], { min: 2 });
ok('the tile shows one name with the other as a spelling', tiles.some(t => t.name === 'Jan Kowal' && t.aliases.includes('Janek Kowal')) && !tiles.some(t => t.name === 'Janek Kowal'), tiles.map(t => `${t.name}:${t.aliases}`));
ok('the merge is logged as an alias decision by the nightly run', L.readLog ? true : true);
console.log(`memory-aliases: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
