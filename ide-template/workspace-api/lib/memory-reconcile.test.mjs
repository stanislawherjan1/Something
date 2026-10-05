/**
 * The decisions behind one fact per thing: which current facts are close, what
 * the model may conclude, and the guard that a combined fact keeps every name,
 * number and date of both sides. The store's behaviour is in memory-facts.test.
 * Run: node lib/memory-reconcile.test.mjs   (wired into `npm test`)
 */
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};
const { configureEmbedder } = await import('./embedder-client.js');
const { configureRunner } = await import('./memory-llm.js');
const R = await import('./memory-reconcile.js');
configureEmbedder(async () => { throw new Error('none'); });
let next = null, calls = 0;
configureRunner(async () => { calls++; if (next instanceof Error) throw next; return next; });

const cur = [
  { id: 'a', text: 'Ola flies to Lisbon on 7 October, landing at 21:00.', kind: 'status', ts: '2026-10-01T10:00:00Z' },
  { id: 'b', text: 'Harbor Works moved its office to Porto in May.', kind: 'fact', ts: '2026-09-01T10:00:00Z' },
];
let c = await R.candidates('Ola flight to Lisbon on 7 October lands 21:00', cur);
ok('candidates: the close one, by word overlap when the embedder is down', c.length === 1 && c[0].id === 'a', c);
ok('candidates: nothing close → none', (await R.candidates('the plants need water on Fridays', cur)).length === 0);

calls = 0;
ok('decide: no candidates → unrelated, no model call', (await R.decide({ text: 'x' }, [])).verdict === 'unrelated' && calls === 0);
next = { decisions: [{ n: 1, verdict: 'same' }] };
let d = await R.decide({ text: 'Ola flies to Lisbon on 7 Oct.' }, c);
ok('decide: same names the existing fact', d.verdict === 'same' && d.target.id === 'a');
next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Lisbon flight', text: 'Ola flies to Lisbon on 8 October (moved from 7 October), landing at 22:30 instead of 21:00.' } }] };
d = await R.decide({ text: 'Ola flight to Lisbon moved to 8 October, landing 22:30.' }, c);
ok('decide: a merge that keeps both sides is accepted', d.verdict === 'merge' && /8 October/.test(d.merged.text));
next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Lisbon', text: 'Ola flies to Lisbon.' } }] };
d = await R.decide({ text: 'Ola flight to Lisbon moved to 8 October, landing 22:30.' }, c);
ok('decide: a merge that drops a date or a number is refused → unrelated', d.verdict === 'unrelated');
next = new Error('down');
ok('decide: a model failure is unrelated', (await R.decide({ text: 'Ola flight to Lisbon' }, c)).verdict === 'unrelated');

calls = 0; next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Meetings', text: 'Ola meets Kamil on 5 and 20 October.' } }] };
d = await R.decide({ text: 'Ola has a call with Kamil on 20 October.', when: '2026-10-20' }, [{ id: 'm', text: 'Ola meets Kamil on 5 October.', when: '2026-10-05', kind: 'status', ts: '2026-10-01T00:00:00Z' }]);
ok('decide: two things on different days are never merged, whatever the model says', d.verdict === 'unrelated', { d, calls });
ok('covers: every name, number and date kept', R.covers('Harbor Works moved to Porto in May; Ana Lima is CFO since June 2026.', 'Ana Lima is CFO since June 2026.'));
ok('covers: a lost number is not kept', !R.covers('Ana Lima is CFO.', 'Ana Lima is CFO since June 2026, paid 12k.'));
const inh = R.inheritStatus({ kind: 'fact' }, { kind: 'status', expires: '2026-10-13', about: 'travel', when: '2026-10-12' });
ok('inheritStatus: the combined fact is a status with the later end, about and when', inh.kind === 'status' && inh.expires === '2026-10-13' && inh.about === 'travel' && inh.when === '2026-10-12', inh);


// ─── corrects / supersedes ───────────────────────────────────────────────────
{
  const old = { id: 'p', title: 'Defence tech work with a co-founder', text: 'Ola co-founded a defence startup with Nils Berglund; it no longer operates. Ola is connecting a founder to her contact at Borealis Defence, met at an event.', kind: 'fact', ts: '2026-10-01T10:00:00Z' };
  next = { decisions: [{ n: 1, verdict: 'corrects' }] };
  let d = await R.decide({ text: 'Ola has no personal contact at Borealis Defence; she only crossed paths with them once at an event.', kind: 'fact', ts: '2026-10-05T10:00:00Z' }, [old]);
  ok('corrects: names the fact that gets the remark, rewrites nothing', d.verdict === 'corrects' && d.target === old && !d.merged, d);
  next = { decisions: [{ n: 1, verdict: 'supersedes' }] };
  d = await R.decide({ text: 'Ola did not get the job at Harbor Works.', kind: 'fact', ts: '2026-10-05T10:00:00Z' }, [{ id: 'q', text: 'Ola will probably get the job at Harbor Works.', kind: 'fact', ts: '2026-09-20T10:00:00Z' }]);
  ok('supersedes: the new note stands alone and names what it makes untrue', d.verdict === 'supersedes' && d.target?.id === 'q', d);
}


// ─── another day ─────────────────────────────────────────────────────────────
{
  const meet = { id: 'm6', text: 'Ola meets Nils on 6 October at 13:00.', kind: 'status', when: '2026-10-06T13:00', ts: '2026-10-01T10:00:00Z' };
  next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Nils meeting', text: 'Ola meets Nils on 7 October at 13:00.' } }] };
  let d = await R.decide({ text: 'Ola meets Nils on 7 October at 13:00.', kind: 'status', when: '2026-10-07T13:00', ts: '2026-10-05T10:00:00Z' }, [meet]);
  ok('a meeting on another day is never merged with one on this day', d.verdict === 'unrelated', d);
  next = { decisions: [{ n: 1, verdict: 'supersedes' }] };
  d = await R.decide({ text: 'The Nils meeting moved from the 6th to 7 October at 13:00.', kind: 'status', when: '2026-10-07T13:00', ts: '2026-10-05T10:00:00Z' }, [meet]);
  ok('...but a note that says it moved may supersede it', d.verdict === 'supersedes' && d.target.id === 'm6', d);
}

console.log(`memory-reconcile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
