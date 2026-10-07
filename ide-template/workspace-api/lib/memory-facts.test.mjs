/**
 * The facts store: one fact per thing, a stable id, events folded on read.
 * What must hold whatever a model answers — a keyed status is recognised with no
 * model call, a replace points at a fact (never a record), an erased text is not
 * learned again, a fact goes when its last conversation goes, and a scope with
 * no file yet reads the notes its records carry.
 * Run: node lib/memory-facts.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-facts-'));
process.env.PROJECT_DIR = ROOT;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 700)}` : ''}`); }
};

const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const { configureEmbedder } = await import('./embedder-client.js');
const { configureRunner } = await import('./memory-llm.js');
configureEmbedder(async () => { throw new Error('none'); });   // word overlap stands in
let next = { decisions: [] }, calls = 0;
configureRunner(async () => { calls++; if (next instanceof Error) throw next; return next; });

const S = 'user:ola';
const rec = async (ts, text, extra = {}) => (await L.append({ scope: S, source: 'telegram', ts, text, ...extra })).id;

// ─── 1. legacy: a scope with no file reads the notes its records carry ───────
const r1 = await rec('2026-09-20T10:00:00Z', 'Ola: Harbor moved to Porto', { notes: [{ title: 'Harbor moved to Porto', text: 'Harbor Works moved its office to Porto in May.', kind: 'fact', evidence: 'Harbor moved to Porto' }] });
const r2 = await rec('2026-09-21T10:00:00Z', 'Ola: old plan', { notes: [{ text: 'The launch is on 3 October.', kind: 'fact', supersededBy: 'no-such-record', supersededAt: '2026-09-22T00:00:00Z' }] });
ok('legacy notes read as facts, with ids from their place', F.all(S).length === 2 && F.get(S, `${r1}n0`)?.title === 'Harbor moved to Porto' && !existsSync(F.factsPath(S)));
ok('a note "replaced" by a record that holds no note is current — that pointer was the bug', F.current([S]).some(f => /launch is on 3 October/.test(f.text)));

// ─── 2. the first write materialises the file, once ──────────────────────────
calls = 0; next = { decisions: [] };
const r3 = await rec('2026-09-25T10:00:00Z', 'Ola: lunch with Marek on the 5th at 12');
let res = await F.remember(S, [{ title: 'Lunch with Marek', text: 'Ola has lunch with Marek Kowal on 5 October at 12:00.', kind: 'status', about: 'meeting', when: '2026-10-05T12:00', expires: '2026-10-05', evidence: 'lunch with Marek on the 5th at 12' }], { record: r3, ts: '2026-09-25T10:00:00Z', entities: [{ name: 'Marek Kowal', kind: 'person' }], by: 'telegram' });
ok('a new fact is added with its record, standing and key', res.added === 1 && F.get(S, res.ids[0])?.record === r3 && F.get(S, res.ids[0])?.key === 'meeting|2026-10-05|marekkowal', F.get(S, res.ids[0]));
ok('the file now holds the legacy facts too', existsSync(F.factsPath(S)) && F.all(S).length === 3 && F.get(S, `${r1}n0`));
const lunch = res.ids[0];

// ─── 3. the key: the same meeting said again is confirmed with no model call ─
calls = 0;
const r4 = await rec('2026-09-26T10:00:00Z', 'Ola: the Marek lunch on the 5th');
res = await F.remember(S, [{ title: 'Marek lunch', text: 'Ola has lunch with Marek on 5 October.', kind: 'status', about: 'meeting', when: '2026-10-05', evidence: 'the Marek lunch on the 5th' }], { record: r4, ts: '2026-09-26T10:00:00Z', entities: [{ name: 'Marek', kind: 'person' }] });
ok('a keyed repeat is a confirm — no model, a second source, no second fact', calls === 0 && res.confirmed === 1 && res.added === 0 && F.get(S, lunch).sources.length === 2 && F.current([S]).filter(f => /lunch/.test(f.text)).length === 1, { calls, res });

// ─── 4. the key: a changed detail replaces the fact ──────────────────────────
calls = 0;
const r5 = await rec('2026-09-27T10:00:00Z', 'Ola: Marek lunch on the 5th moved to 13:30 at Bistro Nord');
res = await F.remember(S, [{ title: 'Lunch with Marek at Bistro Nord', text: 'Ola has lunch with Marek Kowal on 5 October at 13:30 at Bistro Nord (moved from 12:00).', kind: 'status', about: 'meeting', when: '2026-10-05T13:30', expires: '2026-10-05', evidence: 'moved to 13:30 at Bistro Nord' }], { record: r5, ts: '2026-09-27T10:00:00Z', entities: [{ name: 'Marek Kowal', kind: 'person' }] });
const now = F.current([S]).filter(f => /lunch/.test(f.text));
ok('a keyed change replaces: one current fact, the old one history, no model', calls === 0 && res.added === 1 && now.length === 1 && /13:30/.test(now[0].text) && F.get(S, lunch).replacedBy === res.ids[0], { calls, now });
ok('the new fact stands on everything said before', now[0].sources.length === 3 && now[0].replaces === lunch, now[0]);
ok('the replace names the fact it replaced', res.replaced[0] === 'Lunch with Marek');
const lunch2 = res.ids[0];

// ─── 5. "replaced by" is a live relation ─────────────────────────────────────
await F.hide(S, lunch2, 'ola');
ok('hide the newer fact and the older is current again', F.current([S]).some(f => f.id === lunch) && !F.current([S]).some(f => f.id === lunch2));
await F.unhide(S, lunch2, 'ola');
ok('...restore it and the older is history again', !F.current([S]).some(f => f.id === lunch) && F.current([S]).some(f => f.id === lunch2));

// ─── 6. no key: the model decides — same, merge, unrelated ───────────────────
const r6 = await rec('2026-09-28T10:00:00Z', 'Ola: Harbor is in Porto now');
calls = 0; next = { decisions: [{ n: 1, verdict: 'same' }] };
res = await F.remember(S, [{ text: 'Harbor Works moved its office to Porto.', kind: 'fact', evidence: 'Harbor is in Porto now' }], { record: r6, ts: '2026-09-28T10:00:00Z' });
ok('"same" confirms the existing fact', calls === 1 && res.confirmed === 1 && F.get(S, `${r1}n0`).sources.includes(r6));
const r7 = await rec('2026-09-29T10:00:00Z', 'Ola: Harbor Porto office is at Rua Nova 12');
next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Harbor Works office in Porto', text: 'Harbor Works moved its office to Porto in May; it is at Rua Nova 12.' } }] };
res = await F.remember(S, [{ text: 'Harbor Works Porto office is at Rua Nova 12.', kind: 'fact', evidence: 'office is at Rua Nova 12' }], { record: r7, ts: '2026-09-29T10:00:00Z' });
const harbor = F.current([S]).filter(f => /Harbor/.test(f.text));
ok('"merge" is a replace whose text keeps both', harbor.length === 1 && /Rua Nova 12/.test(harbor[0].text) && /May/.test(harbor[0].text) && F.get(S, `${r1}n0`).replacedBy === harbor[0].id, harbor);
next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Harbor', text: 'Harbor Works is in Porto.' } }] };
const r8 = await rec('2026-09-30T10:00:00Z', 'Ola: Harbor hired Ana Lima as CFO in June 2026');
res = await F.remember(S, [{ text: 'Harbor Works hired Ana Lima as CFO in June 2026.', kind: 'fact', evidence: 'hired Ana Lima as CFO' }], { record: r8, ts: '2026-09-30T10:00:00Z' });
ok('a merge that drops a name or a number is refused — the fact is added as its own', res.added === 1 && res.replaced.length === 0 && F.current([S]).filter(f => /Harbor/.test(f.text)).length === 2);
next = new Error('model down');
const r9 = await rec('2026-10-01T10:00:00Z', 'Ola: Harbor Works raised 2M in September');
res = await F.remember(S, [{ text: 'Harbor Works raised 2M in September.', kind: 'fact', evidence: 'raised 2M in September' }], { record: r9, ts: '2026-10-01T10:00:00Z' });
ok('a model failure never loses a fact: it is added', res.added === 1);
const raiseId = res.ids[0];
next = { decisions: [] };

// ─── 6b. nothing close costs no model call; a batch keeps one copy; a merge keeps the status side ─
calls = 0; next = { decisions: [] };
const r6b = await rec('2026-10-01T11:00:00Z', 'Ola: the plants need water on Fridays');
res = await F.remember(S, [{ text: 'The office plants need water on Fridays.', kind: 'fact', evidence: 'the plants need water on Fridays' }], { record: r6b, ts: '2026-10-01T11:00:00Z' });
ok('nothing close: added without asking the model', res.added === 1 && calls === 0);
next = { decisions: [{ n: 1, verdict: 'same' }] };
const r6c = await rec('2026-10-01T12:00:00Z', 'Ola: yoga on Tuesdays at 7, yes Tuesdays 7am');
res = await F.remember(S, [{ text: 'Ola does yoga on Tuesdays at 7.', kind: 'fact', evidence: 'yoga on Tuesdays at 7' }, { text: 'Ola does yoga Tuesdays 7am.', kind: 'fact', evidence: 'yoga on Tuesdays at 7' }], { record: r6c, ts: '2026-10-01T12:00:00Z' });
ok('one batch: the second copy is not a second fact', res.added === 1 && F.current([S]).filter(f => /yoga/.test(f.text)).length === 1, res);
const r6d = await rec('2026-10-01T13:00:00Z', 'Ola: fair in Milan on the 12th', {});
next = { decisions: [] };
res = await F.remember(S, [{ title: 'Milan fair', text: 'Ola goes to the Milan fair on 12 October.', kind: 'status', about: 'travel', when: '2026-10-12', expires: '2026-10-13', evidence: 'fair in Milan on the 12th' }], { record: r6d, ts: '2026-10-01T13:00:00Z' });
const fair = res.ids[0];
const r6e = await rec('2026-10-02T13:00:00Z', 'Ola: Milan fair booth confirmed');
next = { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Milan fair, booth confirmed', text: 'Ola goes to the Milan fair on 12 October; the booth is confirmed.' } }] };
res = await F.remember(S, [{ text: 'Ola\'s Milan fair booth is confirmed.', kind: 'fact', evidence: 'Milan fair booth confirmed' }], { record: r6e, ts: '2026-10-02T13:00:00Z' });
const merged = F.get(S, res.ids[0]);
ok('a merge keeps the status side: kind, end, about and when', merged?.kind === 'status' && merged?.expires === '2026-10-13' && merged?.about === 'travel' && merged?.when === '2026-10-12' && F.get(S, fair).replacedBy === merged.id, merged);
next = { decisions: [] };

// ─── 7. hide, erase, and words that must not come back ───────────────────────
const raise = raiseId;
await F.hide(S, raise, 'ola');
ok('a hidden fact is off the screen and still in the file', !F.current([S]).some(f => f.id === raise) && F.get(S, raise)?.hidden === true);
await F.erase(S, [raise]);
ok('an erased fact leaves no line', !F.get(S, raise) && !readFileSync(F.factsPath(S), 'utf8').includes('raised 2M'));
res = await F.remember(S, [{ text: 'Harbor Works raised 2M in September.', kind: 'fact', evidence: 'raised 2M in September' }], { record: r9, ts: '2026-10-02T10:00:00Z' });
ok('...and the same words are not learned again', res.added === 0 && !F.current([S]).some(f => /raised 2M/.test(f.text)));

// ─── 8. a fact goes with its last conversation ───────────────────────────────
await L.hide(S, r8, 'ola');
ok('a fact whose only record is hidden is not shown', !F.current([S]).some(f => /Ana Lima/.test(f.text)));
await L.unhide(S, r8, 'ola');
ok('...and is back with it', F.current([S]).some(f => /Ana Lima/.test(f.text)));
L.redact(S, [r8], 'ola');
await new Promise(r => setTimeout(r, 20));
await F.sweepOrphans(S);
ok('erase the conversation and the fact is erased with it', !F.all(S).some(f => /Ana Lima/.test(f.text)));
L.redact(S, [r4], 'ola');
await new Promise(r => setTimeout(r, 20));
await F.sweepOrphans(S);
ok('a fact with other sources survives one of them going', F.current([S]).some(f => f.id === lunch2));

// ─── 9. the backlog: duplicates fold, keyed ones for free ────────────────────
const G = 'group:-100777';
const g1 = (await L.append({ scope: G, source: 'group', ts: '2026-09-20T10:00:00Z', text: 'Ola: Lisbon on the 7th', notes: [{ title: 'Lisbon trip', text: 'Ola flies to Lisbon on 7 October.', kind: 'status', about: 'travel', when: '2026-10-07' }], tags: { entities: [{ name: 'Lisbon', kind: 'topic' }] } })).id;
const g2 = (await L.append({ scope: G, source: 'group', ts: '2026-09-22T10:00:00Z', text: 'Ola: flying to Lisbon on 7 Oct', notes: [{ title: 'Flying to Lisbon', text: 'Ola is flying to Lisbon on 7 October.', kind: 'status', about: 'travel', when: '2026-10-07' }], tags: { entities: [{ name: 'Lisbon', kind: 'topic' }] } })).id;
calls = 0;
const b = await F.dedupeBacklog(G);
ok('two legacy notes with one key fold with no model call', calls === 0 && b.same + b.replaced === 1 && F.current([G]).length === 1, { b, cur: F.current([G]) });
ok('...and what is left stands on both conversations', F.current([G])[0].sources.includes(g1) && F.current([G])[0].sources.includes(g2), F.current([G])[0]);
const again = await F.dedupeBacklog(G);
ok('a second pass has nothing to do', again.same + again.replaced === 0);

// ─── 10. a title later, by amend ─────────────────────────────────────────────
const untitled = F.current([S]).find(f => !f.title);
await F.amend(S, untitled.id, { title: 'A heading' });
ok('amend adds a title, the id and text stay', F.get(S, untitled.id).title === 'A heading' && F.get(S, untitled.id).text === untitled.text);
await F.amend(S, untitled.id, { subject: 'Porto', whenFrom: 'on the 22nd' });
ok('amend sets the subject and the day\'s words too', F.get(S, untitled.id).subject === 'Porto' && F.get(S, untitled.id).whenFrom === 'on the 22nd');


// ─── 11. the names a fact is about ───────────────────────────────────────────
{
  const r11 = (await L.append({ scope: S, source: 'web', ts: '2026-10-01T10:00:00Z', text: 'Ola: Quillwork site is up; Tuesday I meet Marek.' })).id;
  const got = await F.remember(S, [
    { title: 'Quillwork website live', text: 'Quillwork launched its website.', kind: 'fact', evidence: 'Quillwork site is up', entities: [{ name: 'Quillwork', kind: 'project' }] },
    { title: 'Marek on Tuesday', text: 'Ola meets Marek on Tuesday 6 October about the kiosk.', kind: 'fact', evidence: 'Tuesday I meet Marek', entities: [{ name: 'Marek', kind: 'person' }] },
    { title: 'Kiosk project', text: 'Ola has a kiosk project.', kind: 'fact', evidence: 'about the kiosk' },
  ], { record: r11, ts: '2026-10-01T10:00:00Z', entities: [{ name: 'Quillwork', kind: 'project' }, { name: 'Marek', kind: 'person' }] });
  const by = (re) => F.forRecord(S, r11).find(f => re.test(f.text));
  ok('a fact carries the names its note was about, not the record\'s', got.added === 3 && by(/Quillwork/).entities?.map(e => e.name).join() === 'Quillwork' && by(/Marek/).entities?.map(e => e.name).join() === 'Marek', F.forRecord(S, r11));
  ok('a nameless note among several takes none — not every name of the conversation', !by(/kiosk project/).entities, by(/kiosk project/));
  const r11b = (await L.append({ scope: S, source: 'note', ts: '2026-10-01T11:00:00Z', text: 'Ola: the kiosk goes to Quillwork.' })).id;
  await F.remember(S, [{ title: 'Kiosk to Quillwork', text: 'The kiosk project goes to Quillwork.', kind: 'fact', evidence: 'the kiosk goes to Quillwork' }], { record: r11b, ts: '2026-10-01T11:00:00Z', entities: [{ name: 'Quillwork', kind: 'project' }] });
  ok('a record holding one note: that note takes the record\'s names (a saved note is about one thing)', F.forRecord(S, r11b)[0]?.entities?.map(e => e.name).join() === 'Quillwork', F.forRecord(S, r11b));
  ok('amend can take the names away', !F.get(S, by(/kiosk project/).id).entities);
}


// ─── 12. a long fact ends at a sentence ──────────────────────────────────────
{
  const para = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} says something that matters for later and goes on for a while to fill the line.`).join(' ');
  ok('a fact under the ceiling is kept whole', F.atSentence(para.slice(0, 500), 1200) === para.slice(0, 500));
  const cut = F.atSentence(para, 600);
  ok('a fact over the ceiling ends at its last whole sentence, never mid-word', cut.length <= 600 && /\.$/.test(cut) && para.startsWith(cut), cut.slice(-80));
  const words = F.atSentence('no punctuation at all '.repeat(60), 200);
  ok('with no sentence end in reach it ends at a word, with an ellipsis', words.length <= 201 && /…$/.test(words) && !/ …$/.test(words), words.slice(-30));
  const r12 = (await L.append({ scope: S, source: 'note', ts: '2026-10-02T10:00:00Z', text: para })).id;
  const got = await F.remember(S, [{ title: 'A long note', text: para, kind: 'fact', evidence: 'Sentence number 1' }], { record: r12, ts: '2026-10-02T10:00:00Z' });
  const stored = F.get(S, got.ids[0]);
  ok('the store cuts the same way', stored && stored.text.length <= 1200 && /\.$/.test(stored.text) && para.startsWith(stored.text), stored?.text.slice(-60));
}


// ─── 13. superseded: no longer true, struck through, kept in history ─────────
{
  const r13 = (await L.append({ scope: S, source: 'web', ts: '2026-10-03T10:00:00Z', text: 'Ola: I will probably get the Harbor job.' })).id;
  const first = await F.apply(S, [{ op: 'add', fact: { title: 'Harbor job likely', text: 'Ola will probably get the job at Harbor Works.', kind: 'fact', evidence: 'I will probably get the Harbor job' } }], { record: r13, ts: '2026-10-03T10:00:00Z' });
  const r13b = (await L.append({ scope: S, source: 'web', ts: '2026-10-05T10:00:00Z', text: 'Ola: I did not get the Harbor job.' })).id;
  const oldFact = F.get(S, first.ids[0]);
  const got = await F.apply(S, [{ op: 'add', fact: { title: 'Harbor job not obtained', text: 'Ola did not get the job at Harbor Works.', kind: 'fact', evidence: 'I did not get the Harbor job' }, supersedes: oldFact }], { record: r13b, ts: '2026-10-05T10:00:00Z' });
  const gone = F.get(S, oldFact.id), now = F.get(S, got.ids[0]);
  ok('the old fact is marked no longer true, by the new one', gone.replacedBy === now.id && gone.replacedWhy === 'superseded' && got.superseded[0] === 'Harbor job likely', { gone, got });
  ok('the new fact stands on its own record only', now.sources.length === 1 && now.sources[0] === r13b && !F.current([S]).some(f => f.id === gone.id), now);
  ok('history keeps the old one', F.visible([S], { history: true }).some(f => f.id === gone.id));
}


// ─── 14. a correction is a dated remark under the fact ───────────────────────
{
  const r14 = (await L.append({ scope: S, source: 'web', ts: '2026-10-01T10:00:00Z', text: 'Ola: defence work with Nils.' })).id;
  const first = await F.apply(S, [{ op: 'add', fact: { title: 'Defence work with Nils', text: 'Ola co-founded a defence startup with Nils Berglund; it no longer operates. Ola is connecting a founder to her contact at Borealis Defence.', kind: 'fact', evidence: 'defence work with Nils' } }], { record: r14, ts: '2026-10-01T10:00:00Z' });
  const r14b = (await L.append({ scope: S, source: 'note', ts: '2026-10-05T10:00:00Z', text: 'Ola: no contact at Borealis, only met them once.' })).id;
  const got = await F.apply(S, [{ op: 'update', target: F.get(S, first.ids[0]), fact: { text: 'Ola has no personal contact at Borealis Defence; she only crossed paths with them once at an event.', kind: 'fact' } }], { record: r14b, ts: '2026-10-05T10:00:00Z' });
  const f = F.get(S, first.ids[0]);
  ok('the fact keeps its words and carries the remark, dated, on the new record — which is not a source of the fact', got.updated[0] === 'Defence work with Nils' && f.text.startsWith('Ola co-founded') && f.updates?.length === 1 && f.updates[0].ts === '2026-10-05T10:00:00Z' && f.updates[0].record === r14b && !f.sources.includes(r14b), f);
  ok('a reader gets both as one text', /^Ola co-founded.*Update \(2026-10-05\): Ola has no personal contact/.test(F.fullText(f)), F.fullText(f));
  ok('nothing was replaced or added', !f.replacedBy && F.current([S]).filter(x => /Borealis/.test(x.text)).length === 1);
}


// ─── 15. a terse correction finds its fact by name ───────────────────────────
{
  const LLM = await import('./memory-llm.js');
  const r15 = (await L.append({ scope: S, source: 'web', ts: '2026-10-01T10:00:00Z', text: 'Ola: Harbor Works moved to Porto in May.' })).id;
  const first = await F.apply(S, [{ op: 'add', fact: { title: 'Harbor Works office move', text: 'Harbor Works moved its office to Porto in May; the Lisbon office closed.', kind: 'fact', evidence: 'Harbor Works moved to Porto in May', entities: [{ name: 'Harbor Works', kind: 'company' }] } }], { record: r15, ts: '2026-10-01T10:00:00Z' });
  let saw = null;
  LLM.configureRunner(async ({ user, schema }) => { if (schema?.properties?.decisions) { saw = user; return { decisions: [{ n: 1, verdict: 'corrects' }] }; } return {}; });
  const plan = await F.plan(S, [{ title: '', text: 'It was June, not May.', kind: 'fact', evidence: 'it was June, not May', entities: [{ name: 'Harbor Works', kind: 'company' }], ts: '2026-10-05T10:00:00Z' }]);
  ok('a correction with no words in common reaches the fact that shares its name', saw && /moved its office to Porto/.test(saw) && plan[0]?.op === 'update' && plan[0].target.id === first.ids[0], { saw: saw?.slice(0, 200), plan });
}


// ─── 16. an update goes with its conversation ────────────────────────────────
{
  const base = (await L.append({ scope: S, source: 'web', ts: '2026-10-02T10:00:00Z', text: 'Ola: the kiosk vendor is Vexa.' })).id;
  const made = await F.apply(S, [{ op: 'add', fact: { title: 'Kiosk vendor', text: 'The kiosk vendor is Vexa.', kind: 'fact' } }], { record: base, ts: '2026-10-02T10:00:00Z' });
  const corr = (await L.append({ scope: S, source: 'note', ts: '2026-10-06T10:00:00Z', text: 'Ola: Vexa was replaced by Norr.' })).id;
  await F.apply(S, [{ op: 'update', target: F.get(S, made.ids[0]), fact: { text: 'The kiosk vendor is now Norr, not Vexa.', kind: 'fact' } }], { record: corr, ts: '2026-10-06T10:00:00Z' });
  ok('the update is there while its conversation is', F.current([S]).find(f => f.id === made.ids[0])?.updates?.length === 1);
  await L.hide(S, corr, 'ola');
  const after = F.current([S]).find(f => f.id === made.ids[0]);
  ok('hide the conversation the update came from → the fact stays, the update goes', after && !(after.updates || []).length && after.text === 'The kiosk vendor is Vexa.', after);
}


// ─── 17. an update's conversation does not keep the fact alive ───────────────
{
  const orig = (await L.append({ scope: S, source: 'web', ts: '2026-10-03T10:00:00Z', text: 'Ola: the vendor is Alto.' })).id;
  const made = await F.apply(S, [{ op: 'add', fact: { title: 'The vendor', text: 'The vendor is Alto.', kind: 'fact' } }], { record: orig, ts: '2026-10-03T10:00:00Z' });
  const corr = (await L.append({ scope: S, source: 'note', ts: '2026-10-07T10:00:00Z', text: 'Ola: Alto was replaced by Brio.' })).id;
  await F.apply(S, [{ op: 'update', target: F.get(S, made.ids[0]), fact: { text: 'The vendor is now Brio, not Alto.', kind: 'fact', entities: [{ name: 'Brio', kind: 'company' }] } }], { record: corr, ts: '2026-10-07T10:00:00Z' });
  let f = F.get(S, made.ids[0]);
  ok('the update lends its names to the fact', (f.entities || []).some(e => e.name === 'Brio'), f.entities);
  ok('the update\'s record is not a source of the fact', f.sources.length === 1 && f.sources[0] === orig, f.sources);
  await L.hide(S, orig, 'ola');
  ok('hide the conversation the fact came from → the fact goes, remark or no remark', !F.current([S]).some(x => x.id === made.ids[0]));
  await L.unhide(S, orig);
  // Erase the correction's conversation: its words leave the facts file, not only the screen.
  await L.redact(S, [corr], 'ola');
  await F.sweepOrphans(S);
  const raw = readFileSync(F.factsPath(S), 'utf8');
  ok('erase the update\'s conversation → the update line is gone from disk', !raw.includes('now Brio, not Alto'), raw.split('\n').filter(l => /Brio/.test(l)));
  // Erasing the fact keeps its updates from coming back too.
  const corr2 = (await L.append({ scope: S, source: 'note', ts: '2026-10-08T10:00:00Z', text: 'Ola: and Brio moved to Porto.' })).id;
  await F.apply(S, [{ op: 'update', target: F.get(S, made.ids[0]), fact: { text: 'Brio moved to Porto.', kind: 'fact' } }], { record: corr2, ts: '2026-10-08T10:00:00Z' });
  await F.erase(S, [made.ids[0]]);
  const again = await F.plan(S, [{ title: 'Brio in Porto', text: 'Brio moved to Porto.', kind: 'fact', evidence: 'Brio moved to Porto' }]);
  ok('erase the fact → its updates\' words are not learned again either', again[0]?.op === 'skip', again);
}

// ─── 18. the keyed twin keeps its remarks ────────────────────────────────────
{
  const r18 = (await L.append({ scope: S, source: 'web', ts: '2026-10-02T10:00:00Z', text: 'Ola: call with Ida on 21 October at 10.' })).id;
  const first = await F.apply(S, [{ op: 'add', fact: { title: 'Call with Ida', text: 'Ola has a call with Ida on 21 October at 10:00.', kind: 'status', about: 'meeting', when: '2026-10-21T10:00', expires: '2026-10-21', subject: 'Ida', evidence: 'call with Ida on 21 October at 10' } }], { record: r18, ts: '2026-10-02T10:00:00Z' });
  const c18 = (await L.append({ scope: S, source: 'note', ts: '2026-10-05T10:00:00Z', text: 'Ola: the call is about the audit.' })).id;
  await F.apply(S, [{ op: 'update', target: F.get(S, first.ids[0]), fact: { text: 'The call with Ida is about the audit.', kind: 'fact' } }], { record: c18, ts: '2026-10-05T10:00:00Z' });
  const r18b = (await L.append({ scope: S, source: 'web', ts: '2026-10-06T10:00:00Z', text: 'Ola: the Ida call on the 21st moved to 11:30, at her office.' })).id;
  (await import('./memory-llm.js')).configureRunner(async ({ schema }) => (schema?.properties?.decisions ? { decisions: [{ n: 1, verdict: 'unrelated' }] } : {}));
  const got = await F.remember(S, [{ title: 'Call with Ida at 11:30', text: 'Ola has a call with Ida on 21 October at 11:30 at her office.', kind: 'status', about: 'meeting', when: '2026-10-21T11:30', expires: '2026-10-21', subject: 'Ida', evidence: 'moved to 11:30, at her office' }], { record: r18b, ts: '2026-10-06T10:00:00Z' });
  const now = F.get(S, got.ids[0]);
  ok('a moved time replaces by key and carries the remark over', got.replaced.length === 1 && now && now.updates?.length === 1 && /audit/.test(now.updates[0].text), now);
}


// ─── 19. the same meeting at another time is replaced, not remarked on ───────
{
  const LLM = await import('./memory-llm.js');
  LLM.configureRunner(async ({ schema }) => (schema?.properties?.decisions ? { decisions: [{ n: 1, verdict: 'corrects' }] } : {}));
  const r19 = (await L.append({ scope: S, source: 'web', ts: '2026-10-02T10:00:00Z', text: 'Ola: call with Ulla on 23 October at 10.' })).id;
  const a = await F.apply(S, [{ op: 'add', fact: { title: 'Call with Ulla', text: 'Ola has a call with Ulla on 23 October at 10:00 about the audit and the budget.', kind: 'status', about: 'meeting', when: '2026-10-23T10:00', expires: '2026-10-23', subject: 'Ulla' } }], { record: r19, ts: '2026-10-02T10:00:00Z' });
  const r19b = (await L.append({ scope: S, source: 'web', ts: '2026-10-06T10:00:00Z', text: 'Ola: the Ulla call moved to 11:30.' })).id;
  const got = await F.remember(S, [{ title: 'Call with Ulla at 11:30', text: 'The call with Ulla on 23 October moved to 11:30.', kind: 'status', about: 'meeting', when: '2026-10-23T11:30', expires: '2026-10-23', subject: 'Ulla', evidence: 'moved to 11:30' }], { record: r19b, ts: '2026-10-06T10:00:00Z' });
  const now = F.current([S]).find(f => /Ulla/.test(f.text) && !f.replacedBy);
  ok('a moved time replaces the status (Right now plans by when), even when the model would only remark', got.replaced.length === 1 && now?.when === '2026-10-23T11:30' && F.get(S, a.ids[0]).replacedBy === now.id, { got, now });
}


// ─── 12. a meeting read from a notetaker meets the chat that planned it ──────
{
  const LLM = await import('./memory-llm.js');
  // The judgment: nothing is related to the plan when it is filed; the import then merges into it.
  let importing = false;
  LLM.configureRunner(async ({ schema }) => (schema?.properties?.decisions ? (importing ? { decisions: [{ n: 1, verdict: 'merge', merged: { title: 'merged by the model', text: 'Ola met Marta Zielak, Vellmark\'s CTO, on 9 October at 13:00: the pilot starts 4 November.' } }] } : { decisions: [] }) : {}));
  const r12 = (await L.append({ scope: S, source: 'web', ts: '2026-10-03T10:00:00Z', text: 'Ola: Thursday 13:00 I meet Marta Zielak, Vellmark\'s CTO, about the pilot.' })).id;
  await F.remember(S, [{ title: 'Meeting with Marta Zielak', text: 'Ola meets Marta Zielak, Vellmark\'s CTO, on Thursday 9 October at 13:00 about the pilot.', kind: 'status', about: 'meeting', when: '2026-10-09T13:00', subject: 'Marta Zielak', evidence: 'Thursday 13:00 I meet Marta Zielak' }], { record: r12, ts: '2026-10-03T10:00:00Z' });
  const planned = F.current([S]).find(f => /Vellmark's CTO/.test(f.text));
  ok('the planned meeting is a timed status', planned?.when === '2026-10-09T13:00', planned);
  // The import: the same day, no time of its own, the summary as its text. The judgment merges, keeping both.
  importing = true;
  const rec = (await L.append({ scope: S, source: 'integration', ts: '2026-10-09T06:00:00Z', conv: 'import:granola:m-9', text: 'Meeting: Pilot\nWith: Marta Zielak\nNotes:\n- the pilot starts 4 November', tags: { import: { integration: 'granola', item: 'm-9' } } })).id;
  const got = await F.remember(S, [{ title: 'Call with Marta Zielak (9 Oct 2026)', text: 'Marta Zielak agreed the pilot starts 4 November.', kind: 'fact', about: 'meeting', when: '2026-10-09', subject: 'Marta Zielak', evidence: null }], { record: rec, ts: '2026-10-09T06:00:00Z', by: 'integration', standing: 'found', conv: 'import:granola:m-9' });
  const cur = F.current([S]).filter(f => /Marta Zielak/.test(f.text) && f.about === 'meeting');
  ok('a day-only meeting against the timed plan is not a moved meeting: one fact, merged, time kept, the convention\'s title', cur.length === 1 && cur[0].kind === 'fact' && cur[0].when === '2026-10-09T13:00' && /4 November/.test(cur[0].text) && /Vellmark's CTO/.test(cur[0].text) && cur[0].title === 'Call with Marta Zielak (9 Oct 2026)' && got.replaced.length === 1, cur.map(f => [f.title, f.kind, f.when, f.text]));
  LLM.configureRunner(null);
}

console.log(`memory-facts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
