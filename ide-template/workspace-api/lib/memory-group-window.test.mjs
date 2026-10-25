/**
 * A chat that never ends is filed in windows, and a later window is a new
 * conversation: what it adds to a fact an earlier window made is an update
 * with history, a new source and today's date — never folded into the old
 * fact in place. Seen on a production client: a group decided on a supplier
 * on one day; days later "ok, sent" was merged into that fact
 * silently — the Facts list showed nothing new, Changes said "0 facts", and
 * the owner looked for it under today and found nothing. Chunks of ONE window
 * still fold into each other (a long conversation filed in parts is one
 * conversation). No model is called — the runner is a fake.
 *
 * Run: node lib/memory-group-window.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'group-window-'));
process.env.PROJECT_DIR = ROOT;
process.env.TELEGRAM_LOG_PATH = join(ROOT, 'telegram.jsonl');
process.env.MEMORY_V4 = 'shadow';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'marek@example.test', role: 'admin', slug: 'marek', displayName: 'Marek', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team', addedAt: '2026-09-01T00:00:00Z' } } }));

const L = await import('./memory-ledger.js');
const C = await import('./memory-consolidator.js');
const F = await import('./memory-facts.js');
const LLM = await import('./memory-llm.js');
const { configureEmbedder } = await import('./embedder-client.js');
configureEmbedder(async () => { throw new Error('none'); });   // word overlap stands in

// ─── the fake model: notes per window, one merge verdict ─────────────────────
const calls = [];
let notesAnswer = () => ({ notes: [], rules: [], entities: [], known_mentioned: [] });
let decideAnswer = () => ({ decisions: [] });
LLM.configureRunner(async ({ schema, user }) => {
  const kind = schema.properties.decisions ? 'decide' : schema.properties.shared ? 'route' : 'notes';
  calls.push({ kind, user });
  if (kind === 'decide') return decideAnswer(user);
  if (kind === 'route') throw new Error('a group is never routed');
  return notesAnswer(user);
});

const NOW = Date.now();
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const LATER = NOW + 20 * 60_000;
const tick = () => C.consolidateIdle({ now: LATER });
const G = 'group:-100777';
mkdirSync(join(ROOT, '.group-watcher'), { recursive: true });
const history = join(ROOT, '.group-watcher', '-100777-history.jsonl');
const say = (ts, text, who = 'Marek') => appendFileSync(history, JSON.stringify({ ts, role: who ? 'user' : 'assistant', who: who || '', text }) + '\n');
const current = () => F.all(G).filter(f => !f.hidden && !f.replacedBy && !f.retired);
const lastFiling = () => L.readEvents().filter(e => e.op === 'file' && e.scope === G).pop();

// ─── window 1: the decision ──────────────────────────────────────────────────
say(at(60), 'For Riverstone we will try other printers than the current one, 900 eur per run is too high.');
say(at(59), 'Noted — I will look for local printers.', '');
notesAnswer = () => ({
  notes: [{ title: 'Riverstone printers', text: 'The team decided to move the Riverstone print run from the current printer (900 eur per run) to a local one.', importance: 2, kind: 'fact', evidence: 'we will try other printers than the current one', concerns: "the team's work", names: ['Riverstone'] }],
  rules: [], entities: [{ name: 'Riverstone', kind: 'company' }], known_mentioned: [],
});
let s = await tick();
const first = current();
const rec1 = L.read({ scopes: [G] })[0];
ok('window 1 files one fact in the group', s.sources === 1 && first.length === 1 && /current printer/.test(first[0].text) && first[0].record === rec1.id, { s, first });
ok('...counted in Changes', lastFiling()?.notes === 1, lastFiling());
ok('...with no decide call: nothing to compare with yet', !calls.some(c => c.kind === 'decide'));
const oldId = first[0].id, oldAt = first[0].at;

// ─── window 2, days later in the story: "ok, sent" ───────────────────────────
// (Minutes here; what matters is that window 1 was filed and this one is new.)
say(at(20), 'ok, sent the Riverstone quote requests to the two local printers, purchasing on cc');
notesAnswer = () => ({
  notes: [{ title: 'Riverstone quote requests sent', text: 'Marek sent the Riverstone quote requests to the two local printers, with purchasing on cc; waiting for their answers.', importance: 2, kind: 'status', about: 'waiting', when: null, dayStated: false, expires: null, endStated: false, subject: null, evidence: 'sent the Riverstone quote requests to the two local printers', concerns: "the team's work", names: ['Riverstone'] }],
  rules: [], entities: [{ name: 'Riverstone', kind: 'company' }], known_mentioned: [],
});
decideAnswer = () => ({ decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Riverstone printers', text: 'The team moved the Riverstone print run from the current printer (900 eur per run) to a local one; Marek sent quote requests to the two printers, purchasing on cc, and is waiting for their answers.' } }] });
calls.length = 0;
const before = new Date().toISOString();
s = await tick();
const rec2 = L.read({ scopes: [G] }).find(r => r.id !== rec1.id);
const now = current();
ok('window 2 is a new record of the same chat', rec2 && rec2.conv === rec1.conv && rec2.ts > rec1.ts, { rec1: rec1?.ts, rec2: rec2?.ts });
ok('the model was asked how the new note relates to the old fact', calls.some(c => c.kind === 'decide' && /current printer/.test(c.user)));
ok('one current fact, with the merged wording', now.length === 1 && /quote requests/.test(now[0].text) && /current printer/.test(now[0].text), now.map(f => f.text));
ok('it is a NEW fact that replaced the old one — not the old one reworded in place', now[0].id !== oldId && F.all(G).find(f => f.id === oldId)?.replacedBy === now[0].id, { oldId, now: now[0].id, old: F.all(G).find(f => f.id === oldId) });
ok('it is dated by when memory learned it (today), so the Facts list shows it on top', now[0].at >= before && now[0].at !== oldAt, { at: now[0].at, oldAt, before });
ok('it stands on both conversations: the new record, and the old one as a source', now[0].record === rec2.id && now[0].sources.includes(rec1.id), { record: now[0].record, sources: now[0].sources, rec1: rec1.id, rec2: rec2.id });
ok('Changes counts the fact', lastFiling()?.notes === 1, lastFiling());

// ─── the same window in parts: still one piece ───────────────────────────────
// Two chunks of one filing (a long conversation) share conv AND window: the
// second's fuller wording goes into the first's fact in place — no history,
// no second source. Tested at the facts store, where the rule lives.
const S = 'group:-100555';
const w = at(10);
const ra = await L.append({ scope: S, source: 'group', ts: w, conv: 'group:-100555', speaker: 'Ola', text: 'Ola: the Harbor pitch is on the 12th' });
const rb = await L.append({ scope: S, source: 'group', ts: at(9), conv: 'group:-100555', speaker: 'Ola', text: 'Ola: the Harbor pitch on the 12th is at 10, at their office' });
decideAnswer = () => ({ decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Harbor pitch', text: 'The Harbor pitch is on the 12th at 10, at their office.' } }] });
await F.remember(S, [{ title: 'Harbor pitch', text: 'The Harbor pitch is on the 12th.', kind: 'fact', evidence: 'the Harbor pitch is on the 12th', entities: [{ name: 'Harbor', kind: 'company' }] }], { record: ra.id, ts: w, by: 'group', standing: 'said', conv: 'group:-100555', convSince: w, entities: [{ name: 'Harbor', kind: 'company' }] });
const a1 = F.all(S)[0];
await F.remember(S, [{ title: 'Harbor pitch', text: 'The Harbor pitch on the 12th is at 10, at their office.', kind: 'fact', evidence: 'the Harbor pitch on the 12th is at 10', entities: [{ name: 'Harbor', kind: 'company' }] }], { record: rb.id, ts: at(9), by: 'group', standing: 'said', conv: 'group:-100555', convSince: w, entities: [{ name: 'Harbor', kind: 'company' }] });
const same = F.all(S).filter(f => !f.replacedBy);
ok('a later chunk of the SAME window rewords the fact in place', same.length === 1 && same[0].id === a1.id && /at their office/.test(same[0].text) && F.all(S).length === 1, F.all(S));

// ...and the next window, even seconds later, is another conversation.
const rc = await L.append({ scope: S, source: 'group', ts: at(5), conv: 'group:-100555', speaker: 'Ola', text: 'Ola: Harbor pitch moved to the 14th' });
decideAnswer = () => ({ decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Harbor pitch', text: 'The Harbor pitch is on the 14th at 10, at their office.' } }] });
await F.remember(S, [{ title: 'Harbor pitch', text: 'The Harbor pitch moved to the 14th.', kind: 'fact', evidence: 'Harbor pitch moved to the 14th', entities: [{ name: 'Harbor', kind: 'company' }] }], { record: rc.id, ts: at(5), by: 'group', standing: 'said', conv: 'group:-100555', convSince: at(5), entities: [{ name: 'Harbor', kind: 'company' }] });
const next = F.all(S).filter(f => !f.replacedBy);
ok('a note from the NEXT window replaces it, with the old wording kept as history', next.length === 1 && next[0].id !== a1.id && /14th/.test(next[0].text) && F.all(S).find(f => f.id === a1.id)?.replacedBy === next[0].id && next[0].sources.includes(ra.id), F.all(S));

// Without `convSince` the old rule holds (an import's parts, a caller that has no window).
const S2 = 'group:-100444';
const rd = await L.append({ scope: S2, source: 'group', ts: at(30), conv: 'group:-100444', speaker: 'Ola', text: 'Ola: Nord demo Friday' });
const re = await L.append({ scope: S2, source: 'group', ts: at(3), conv: 'group:-100444', speaker: 'Ola', text: 'Ola: Nord demo Friday at 9' });
decideAnswer = () => ({ decisions: [{ n: 1, verdict: 'merge', merged: { title: 'Nord demo', text: 'The Nord demo is on Friday at 9.' } }] });
await F.remember(S2, [{ title: 'Nord demo', text: 'The Nord demo is on Friday.', kind: 'fact', evidence: 'Nord demo Friday', entities: [{ name: 'Nord', kind: 'company' }] }], { record: rd.id, ts: at(30), by: 'group', standing: 'said', conv: 'group:-100444', entities: [{ name: 'Nord', kind: 'company' }] });
await F.remember(S2, [{ title: 'Nord demo', text: 'The Nord demo is on Friday at 9.', kind: 'fact', evidence: 'Nord demo Friday at 9', entities: [{ name: 'Nord', kind: 'company' }] }], { record: re.id, ts: at(3), by: 'group', standing: 'said', conv: 'group:-100444', entities: [{ name: 'Nord', kind: 'company' }] });
ok('with no window given, the same conv is still one piece (as before)', F.all(S2).length === 1 && /at 9/.test(F.all(S2)[0].text), F.all(S2));

console.log(`memory-group-window: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
