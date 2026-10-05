/**
 * Guards for v4 retrieval: scope fences hold at search time, BM25 works on any
 * script without word lists, the embedder is optional, session dedupe works,
 * and appends / redactions are visible on the next search without invalidation.
 *
 * Run: node lib/memory-search.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'search-'));
process.env.PROJECT_DIR = ROOT;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};

const L = await import('./memory-ledger.js');
const S = await import('./memory-search.js');
const E = await import('./embedder-client.js');
E.configureEmbedder(async () => { throw new Error('no embedder in this test'); });

const put = (scope, ts, text, source = 'telegram') => L.append({ scope, source, ts, text });
await put('user:stan', '2026-09-03T10:00:00Z', 'Stan: the round is a SAFE after all, 500k at a 12M valuation');
await put('user:stan', '2026-08-20T10:00:00Z', 'Stan: Teleport offers a term sheet for 2 million');
await put('user:stan', '2026-09-10T10:00:00Z', 'Stan: our contact Юрий lives in Kyiv and works with us as a contractor');
await put('user:kasia', '2026-09-11T10:00:00Z', 'Kasia: I am talking to another company about a job, tell no one');
await put('shared', '2026-09-01T10:00:00Z', 'Stan: standup moves to Wednesdays at 10');
await put('group:-1004242', '2026-09-12T10:00:00Z', 'Marek: demo for Northbeam on October 15');
for (let i = 0; i < 30; i++) await put('shared', `2026-09-0${1 + (i % 9)}T12:00:00Z`, `Bot: reminder number ${i} about coffee and lunch`);

// ─── (a) BM25 without an embedder ────────────────────────────────────────────
let r = await S.search({ query: 'what is the valuation of the SAFE round', scopes: ['shared', 'user:stan'] });
ok('(a) BM25 finds the record', r.hits.some(h => h.text.includes('SAFE after all')), r.hits.map(h => h.text));
ok('(a) embeddings are reported as absent', r.vectors === false);
ok('(a) total counts every record in the scopes (coverage line)', r.total === 34, r.total);
ok('(a) hits come oldest first', r.hits.every((h, i) => i === 0 || r.hits[i - 1].ts <= h.ts));
r = await S.search({ query: 'where does Юрий live', scopes: ['shared', 'user:stan'] });
ok('(a) a name in another script is a token like any other', r.hits[0]?.text.includes('Юрий') || r.hits.some(h => h.text.includes('Юрий')), r.hits.map(h => h.text));
ok('(a) k caps the result', (await S.search({ query: 'reminder coffee', scopes: ['shared'], k: 10 })).hits.length === 10);

// ─── (b) scope fences at search time ────────────────────────────────────────
r = await S.search({ query: 'job another company tell no one', scopes: L.readableScopes({ actor: 'stan' }) });
ok('(b) the operator never finds a teammate\'s private record', !r.hits.some(h => h.text.includes('Kasia')), r.hits.map(h => h.text));
r = await S.search({ query: 'job another company tell no one', scopes: L.readableScopes({ actor: 'kasia' }) });
ok('(b) the teammate finds their own', r.hits.some(h => h.text.includes('Kasia')));
r = await S.search({ query: 'round SAFE valuation Teleport', scopes: L.readableScopes({ actor: 'stan', groupId: '-1004242' }) });
ok('(b) a group turn finds nothing private', !r.hits.some(h => h.scope.startsWith('user:')), r.hits.map(h => h.scope));
r = await S.search({ query: 'demo Northbeam', scopes: L.readableScopes({ actor: 'kasia', memberGroups: ['-1004242'] }) });
ok('(b) a member finds their group\'s records', r.hits.some(h => h.text.includes('Northbeam')));
r = await S.search({ query: 'demo Northbeam', scopes: L.readableScopes({ actor: 'kasia' }) });
ok('(b) ...but not a group they are not in', !r.hits.some(h => h.text.includes('Northbeam')));

// ─── (c) session dedupe ─────────────────────────────────────────────────────
const first = await S.search({ query: 'term sheet Teleport', scopes: ['user:stan'], k: 1 });
const second = await S.search({ query: 'term sheet Teleport', scopes: ['user:stan'], k: 1, exclude: first.hits.map(h => h.id) });
ok('(c) excluded ids are not shown twice', first.hits[0] && !second.hits.some(h => h.id === first.hits[0].id));

// ─── (d) hybrid with an embedder ────────────────────────────────────────────
// A toy embedder: one dimension per concept, so "money" matches the SAFE record
// that shares no word with the query.
const concepts = [['safe', 'valuation', 'round', 'money', 'funding'], ['coffee', 'lunch'], ['юрий', 'kyiv']];
E.configureEmbedder(async (texts) => texts.map(t => {
  const low = t.toLowerCase();
  const v = concepts.map(c => (c.some(w => low.includes(w)) ? 1 : 0));
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));
S._resetForTests();
r = await S.search({ query: 'money', scopes: ['shared', 'user:stan'] });
ok('(d) embeddings take part when available', r.vectors === true);
ok('(d) a semantic match without shared words is found', r.hits.some(h => h.text.includes('SAFE')), r.hits.map(h => h.text));

// ─── (e) freshness: appends and redactions without invalidation ─────────────
const added = await put('user:stan', '2026-09-20T10:00:00Z', 'Stan: Riverstone signed the SAFE');
r = await S.search({ query: 'Riverstone', scopes: ['user:stan'] });
ok('(e) an append is searchable at once', r.hits.some(h => h.id === added.id));
await L.redact('user:stan', [added.id], 'stan');
r = await S.search({ query: 'Riverstone', scopes: ['user:stan'] });
ok('(e) a redacted record is gone from search at once', !r.hits.some(h => h.id === added.id));

// ─── (e2) a shared excerpt is not shown twice to the person it came from ─────
await L.append({ scope: 'user:kasia', source: 'telegram', ts: '2026-09-21T10:00:00Z', text: 'Kasia: the Quarry demo moves to Friday. Also my knee still hurts.' });
await L.append({ scope: 'shared', source: 'telegram', ts: '2026-09-21T10:00:00Z', text: 'Kasia: the Quarry demo moves to Friday.', origin: 'user:kasia' });
r = await S.search({ query: 'Quarry demo', scopes: L.readableScopes({ actor: 'kasia' }) });
ok('(e2) the owner gets the whole conversation, not the copy too', r.hits.filter(h => h.text.includes('Quarry')).length === 1 && r.hits.find(h => h.text.includes('Quarry')).scope === 'user:kasia', r.hits.map(h => h.scope));
r = await S.search({ query: 'Quarry demo', scopes: L.readableScopes({ actor: 'stan' }) });
ok('(e2) a teammate gets the shared excerpt only', r.hits.some(h => h.text.includes('Quarry') && h.scope === 'shared') && !r.hits.some(h => h.text.includes('knee')));

// ─── (f) timeline ───────────────────────────────────────────────────────────
const tl = S.timeline({ term: 'SAFE', scopes: ['user:stan'] });
ok('(f) timeline lists every mention in time order', tl.length === 1 && tl[0].text.includes('SAFE after all'), tl.map(x => x.text));
const tl2 = S.timeline({ term: 'term sheet', scopes: ['user:stan', 'shared'] });
ok('(f) multi-word terms need every word', tl2.length === 1 && tl2[0].text.includes('Teleport'));

// ─── (g) stored vectors ──────────────────────────────────────────────────────
const { readFileSync, existsSync } = await import('node:fs');
let embedCalls = 0;
E.configureEmbedder(async (texts) => { embedCalls += texts.length; return texts.map((t, i) => { const v = [t.length % 7 + 1, i + 1, 3]; const n = Math.hypot(...v); return v.map(x => x / n); }); });
S._resetForTests();
r = await S.search({ query: 'Teleport', scopes: ['user:stan'] });
const vfile = join(L.scopeDir('user:stan'), '_vectors.json');
ok('(g) vectors are stored in the scope\'s own directory', r.vectors && existsSync(vfile) && JSON.parse(readFileSync(vfile, 'utf8')).model === E.EMBEDDER_MODEL);
S._resetForTests();
embedCalls = 0;
r = await S.search({ query: 'Teleport', scopes: ['user:stan'] });
ok('(g) after a restart they are read back, not embedded again', r.vectors === true && embedCalls === 1, { embedCalls });
const doomed = L.read({ scopes: ['user:stan'] }).find(x => /Teleport/.test(x.text));
await L.redact('user:stan', [doomed.id], 'stan');
await S.search({ query: 'anything', scopes: ['user:stan'] });
ok('(g) an erased record\'s vector leaves the disk too', !Object.keys(JSON.parse(readFileSync(vfile, 'utf8')).rows).includes(doomed.id));

// ─── (h) a large backlog fills in the background ─────────────────────────────
for (let i = 0; i < 300; i++) await L.append({ scope: 'group:-1004242', source: 'group', ts: '2026-09-15T10:00:00Z', text: `Marek: backlog message ${i}` });
S._resetForTests();
r = await S.search({ query: 'backlog message', scopes: ['group:-1004242'] });
ok('(h) a turn does not wait for a large backlog (BM25 now)', r.vectors === false && r.hits.length > 0);
await S.settled();
r = await S.search({ query: 'backlog message', scopes: ['group:-1004242'] });
ok('(h) ...and has vectors once it is filled', r.vectors === true);


// ─── near words, relevance order ─────────────────────────────────────────────
{
  const N = 'user:near';
  await L.append({ scope: N, source: 'web', ts: '2026-09-01T10:00:00Z', text: 'Ola: Tomas Bergman will send the deck on Monday.' });
  await L.append({ scope: N, source: 'web', ts: '2026-09-02T10:00:00Z', text: 'Ola: the kiosk vendor called about the invoice.' });
  await L.append({ scope: N, source: 'web', ts: '2026-09-03T10:00:00Z', text: 'Ola: lunch with Bergmanem on Friday, he is bringing the deck.' });
  // A suffix bends; a vowel that drops (a dropped vowel) does not — that is the alias layer's.
  ok('near: a suffix-inflected form of a word is the same word', S.near('bergman', 'bergmana') && S.near('lindholm', 'lindholmowi') && !S.near('janek', 'janka') && !S.near('rose', 'roses') && !S.near('berg', 'bergman') && !S.near('bergm', 'bergmania'));
  const r = await S.search({ query: 'Bergmana', scopes: [N], k: 10 });
  // (the stand-in embedder ranks every record, so the kiosk line may trail in; it must not lead)
  ok('a search for an inflected spelling finds the base one too', r.hits.some(h => /Bergman will/.test(h.text)) && r.hits.some(h => /Bergmanem/.test(h.text)), r.hits.map(h => h.text));
  ok('`hits` stay oldest first for the reader; `ranked` puts the best matches first', r.hits[0].ts < r.hits[1].ts && r.ranked.slice(0, 2).every(h => /Bergman/.test(h.text)), { hits: r.hits.map(h => h.ts), ranked: r.ranked.map(h => h.text) });
}

console.log(`memory-search: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
