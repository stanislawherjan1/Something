/**
 * The facts gate, case by case: what may ground a fact (said / found / recital),
 * dates that stand on words, names that stand on words, and "Right now" with
 * open-ended statuses and the same thing seen from two scopes. Pure functions
 * plus a temp ledger; no model.
 * Run: node lib/memory-gate.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-gate-'));
process.env.PROJECT_DIR = ROOT;
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ola@example.test', role: 'admin', slug: 'ola', displayName: 'Ola', telegramChatId: '1', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false, groups: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}` : ''}`); }
};

const C = await import('./memory-consolidator.js');
const R = await import('./memory-router.js');
const V = await import('./memory-views.js');
const L = await import('./memory-ledger.js');

// ─── 1. the gate: which tools make a turn a finding ──────────────────────────
const t = (name, okFlag = true) => ({ name, at: 0, ok: okFlag });
ok('web search and fetch are findings; reading files is not (memory files read back are a recital)', C.isFinding([t('WebSearch')]) && C.isFinding([t('WebFetch')]) && !C.isFinding([t('Read')]) && !C.isFinding([t('Grep')]) && !C.isFinding([t('Bash')]));
ok('an integration read is a finding (catalog name, hyphenated too)', C.isFinding([t('mcp__notion__search')]) && C.isFinding([t('mcp__google-workspace__gmail_search')]) && C.isFinding([t('mcp__email__list_messages')]) && C.isFinding([t('mcp__stripe__list_customers')]));
ok('the browser tab and a delegate turn are findings', C.isFinding([t('mcp__workspace-api__tab_snapshot')]) && C.isFinding([t('tab_screenshot')]) && C.isFinding([t('mcp__workspace-api__use_integrations')]));
ok('memory tools, whatever their name, are not', !C.isFinding([t('mcp__workspace-api__memory_search')]) && !C.isFinding([t('mcp__workspace-api__memory_now')]) && !C.isFinding([t('mcp__workspace-api__memory_timeline')]) && !C.isFinding([t('mcp__workspace-api__memory_grep')]) && !C.isFinding([t('mcp__workspace-api__memory_note')]));
ok('another model, image generation, translation and delivery are not', !C.isFinding([t('mcp__openai__ask_gpt')]) && !C.isFinding([t('mcp__gemini-chat__ask')]) && !C.isFinding([t('mcp__grok__ask')]) && !C.isFinding([t('mcp__seedream__generate')]) && !C.isFinding([t('mcp__deepl__translate')]) && !C.isFinding([t('mcp__telegram__send')]));
ok('a skill load, a schema fetch, a setting or routine saved are not', !C.isFinding([t('Skill')]) && !C.isFinding([t('ToolSearch')]) && !C.isFinding([t('mcp__workspace-api__set_my_settings')]) && !C.isFinding([t('mcp__workspace-api__add_routine')]) && !C.isFinding([t('mcp__reminders__set')]) && !C.isFinding([t('mcp__pdf__render')]));
ok('a failed read reads nothing; one good read among recitals is enough', !C.isFinding([t('WebFetch', false)]) && C.isFinding([t('mcp__workspace-api__memory_search'), t('WebFetch')]));
ok('no tools, odd shapes: not a finding, no crash', !C.isFinding(undefined) && !C.isFinding([]) && !C.isFinding([null, {}, { name: 7 }]));

// ─── 2. evidence and dates ───────────────────────────────────────────────────
// Whether words name a day is the model's call (dayStated / endStated); the code
// keeps a day only when the model says one was stated AND its quote is really there.
const said = 'Ola: Lunch with Marek on Monday at 12, then I fly to Lisbon for a few days, back on 11 October. The offer deadline is 9.10.\nBot: Sure.';
const notes = (raw, max = 6) => R.cleanNotes({ notes: raw, rules: [] }, said, [], { max });
let r = notes([
  { text: 'Ola meets Marek on Monday at 12.', kind: 'status', about: 'meeting', when: '2026-10-05T12:00', whenFrom: 'on Monday at 12', dayStated: true, expires: null, endStated: false, subject: 'Marek', evidence: 'Lunch with Marek on Monday at 12' },
  { text: 'Ola flies to Lisbon for a few days.', kind: 'status', about: 'travel', when: '2026-10-07', whenFrom: 'then I fly to Lisbon', dayStated: true, expires: '2026-10-11', expiresFrom: 'back on 11 October', endStated: true, subject: 'Lisbon', evidence: 'I fly to Lisbon for a few days' },
  { text: 'Ola is away until the 14th.', kind: 'status', about: 'travel', when: '2026-10-07', whenFrom: 'then I fly to Lisbon', dayStated: true, expires: '2026-10-14', expiresFrom: 'for a few days', endStated: false, evidence: 'I fly to Lisbon for a few days' },
  { text: 'The offer is due on 9 October.', kind: 'status', about: 'deadline', when: '2026-10-09', whenFrom: 'is 9.10', dayStated: true, expires: null, evidence: 'The offer deadline is 9.10' },
  { text: 'Ola got a raise.', kind: 'fact', evidence: 'I got a raise' },
]);
ok('a stated day with its words in the source is kept; a meeting ends on its day; the subject and the words travel', r.notes[0]?.when === '2026-10-05T12:00' && r.notes[0]?.expires === '2026-10-05' && r.notes[0]?.subject === 'Marek' && r.notes[0]?.whenFrom === 'on Monday at 12', r.notes[0]);
ok('a stated end is kept', r.notes[1]?.expires === '2026-10-11', r.notes[1]);
ok('an end the model says was not stated ("for a few days") is no end — the status is open', r.notes[2]?.expires === null && r.notes[2]?.when === '2026-10-07', r.notes[2]);
ok('...and the loss is reported, not silent', r.rejected.some(x => x.kept && /expires 2026-10-14/.test(x.why)), r.rejected);
ok('a deadline on a stated day ends that day', r.notes[3]?.when === '2026-10-09' && r.notes[3]?.expires === '2026-10-09', r.notes[3]);
ok('a note whose quote nobody said is dropped, with the reason', r.notes.length === 4 && r.rejected.some(x => !x.kept && /got a raise/.test(x.text) && x.why === 'quote not in what was said'), r.rejected);
r = notes([{ text: 'Ola may go to Lisbon in a few weeks.', kind: 'status', about: 'travel', when: '2026-10-18', whenFrom: 'I fly to Lisbon for a few days', dayStated: false, evidence: 'I fly to Lisbon for a few days' }]);
ok('a day the model says was not stated is no day, whatever date it guessed', r.notes[0] && !r.notes[0].when, r.notes[0]);
r = notes([{ text: 'Ola meets Marek.', kind: 'status', about: 'meeting', when: '2026-10-05', whenFrom: 'on Tuesday', dayStated: true, evidence: 'Lunch with Marek on Monday at 12' }]);
ok('a stated day whose words are not in the source is dropped (the note stays, as a fact)', r.notes[0] && !r.notes[0].when && r.notes[0].expires === null && r.notes[0].kind === 'fact' && r.rejected.some(x => x.kept), r);
r = notes([{ text: 'Ola is waiting for the bank.', kind: 'status', about: 'waiting', when: null, evidence: 'Lunch with Marek on Monday at 12' }, { text: 'Ola is building a kiosk.', kind: 'status', about: 'other', when: null, evidence: 'Lunch with Marek on Monday at 12' }]);
ok('a wait with no day stays a status; a dayless "status" about anything else is a fact', r.notes[0]?.kind === 'status' && r.notes[1]?.kind === 'fact', r.notes);
r = notes([{ text: 'Ola flies to Lisbon on the 7th.', kind: 'fact', about: 'travel', when: '2026-10-07', whenFrom: 'then I fly to Lisbon', dayStated: true, evidence: 'I fly to Lisbon for a few days' }]);
ok('a trip with a day is a status whatever the model called it', r.notes[0]?.kind === 'status' && r.notes[0]?.when === '2026-10-07' && r.notes[0]?.about === 'travel', r.notes[0]);
r = R.cleanNotes({ notes: [{ text: 'Ola is in talks with Harbor.', kind: 'fact', evidence: 'you are in talks with Harbor about a role' }], rules: [] }, said, [], { max: 4, full: `${said}\nBot: As far as I know you are in talks with Harbor about a role.` });
ok('a quote found only in the assistant\'s turn is a recital', r.notes.length === 0 && r.rejected[0]?.why === 'quoted from the assistant', r.rejected);

// ─── 3. names: what a note adds is the model's call, the code enforces it ────
{
  const LLM = await import('./memory-llm.js');
  let seen = null;
  LLM.configureRunner(async ({ system, user }) => { seen = { system, user }; return { unsupported: /Krzysztof/.test(user.split('WORDS:')[0]) ? ['Krzysztof'] : [] }; });
  let u = await R.unsupportedDetails({ text: 'Monday meeting with Krzysztof Lewis.', said: 'the meeting with tlewis on monday', known: ['Orion'] });
  ok('the model is asked with the note, the person\'s words and the known names', /NOTE: Monday meeting/.test(seen?.user) && /WORDS: the meeting with tlewis/.test(seen?.user) && /NAMES: Orion/.test(seen?.user), seen?.user);
  ok('what it finds unsupported comes back', JSON.stringify(u) === '["Krzysztof"]', u);
  LLM.configureRunner(async () => { throw new Error('down'); });
  u = await R.unsupportedDetails({ text: 'x', said: 'y' });
  ok('a model failure blocks nothing (a lost fact is worse than a skipped check)', Array.isArray(u) && u.length === 0);
  LLM.configureRunner(null);
}

// ─── 4. right now: open-ended statuses, two scopes, two different things ─────
const put = (scope, ts, speaker, text, note) => L.append({ scope, source: 'telegram', ts, speaker, text, notes: [note] });
const AT = Date.parse('2026-10-01T10:00:00Z');
await put('user:ola', '2026-09-29T09:00:00Z', 'Ola', 'Ola: Lisbon on the 7th for a few days', { title: 'Lisbon trip from 7 October', text: 'Ola flies to Lisbon on 7 October for a few days.', kind: 'status', about: 'travel', when: '2026-10-07', expires: null, subject: 'Lisbon' });
await put('group:-100777', '2026-09-29T11:00:00Z', 'Ola', 'Ola: Lisbon on the 7th', { title: 'Flying to Lisbon', text: 'Ola is flying to Lisbon on 7 October.', kind: 'status', about: 'travel', when: '2026-10-07', expires: null, subject: 'Lisbon' });
await put('user:ola', '2026-09-30T09:00:00Z', 'Ola', 'Ola: Marek Monday 12', { title: 'Meeting with Marek on Monday', text: 'Ola meets Marek Kowal on 5 October at 12:00.', kind: 'status', about: 'meeting', when: '2026-10-05T12:00', expires: '2026-10-05', subject: 'Marek Kowal' });
await put('user:ola', '2026-09-30T10:00:00Z', 'Ola', 'Ola: Jan Monday 15', { title: 'Meeting with Jan on Monday', text: 'Ola meets Jan Nowak on 5 October at 15:00.', kind: 'status', about: 'meeting', when: '2026-10-05T15:00', expires: '2026-10-05', subject: 'Jan Nowak' });
await put('user:ola', '2026-09-10T10:00:00Z', 'Ola', 'Ola: waiting on the bank', { title: 'Waiting on the bank', text: 'Ola is waiting for the bank to answer.', kind: 'status', about: 'waiting', when: null, expires: null });
let now = V.now(['user:ola', 'shared', 'group:-100777'], { at: AT });
const lisbon = now.filter(x => /Lisbon/.test(x.text));
ok('the same trip from two scopes shows once, private first, marked', lisbon.length === 1 && lisbon[0].scope === 'user:ola' && JSON.stringify(lisbon[0].alsoIn) === '["group:-100777"]', lisbon);
ok('two different meetings on the same day stay two (different subjects)', now.filter(x => /meets/.test(x.text)).length === 2, now);
ok('an open-ended status last mentioned three weeks ago is gone', !now.some(x => /bank/.test(x.text)), now);
await put('user:ola', '2026-09-30T11:00:00Z', 'Ola', 'Ola: building a kiosk app', { title: 'Kiosk app', text: 'Ola is building a kiosk app.', kind: 'status', about: 'other', when: null, expires: null });
await put('user:ola', '2026-09-30T12:00:00Z', 'Ola', 'Ola: waiting on the notary', { title: 'Waiting on the notary', text: 'Ola is waiting for the notary.', kind: 'status', about: 'waiting', when: null, expires: null });
now = V.now(['user:ola', 'shared', 'group:-100777'], { at: AT });
for (let i = 0; i < 9; i++) await put('user:ola', `2026-09-30T13:0${i}:00Z`, 'Ola', `Ola: waiting on thing ${i}`, { title: `Waiting on thing ${i}`, text: `Ola is waiting on thing ${i}.`, kind: 'status', about: 'waiting', when: null, expires: null });
const crowded = V.now(['user:ola', 'shared', 'group:-100777'], { at: AT });
ok('dated items come before ongoing waits, so the limit never cuts what has a day', crowded.some(x => /Lisbon/.test(x.text)) && crowded.findIndex(x => /Lisbon/.test(x.text)) < crowded.findIndex(x => /thing/.test(x.text)), crowded.map(x => x.title));
ok('a "status" with no day that is not a wait is not on Right now (a thread, not a now)', !now.some(x => /kiosk/.test(x.text)) && now.some(x => /notary/.test(x.text)), now.map(x => x.title));
ok('an open-ended status with a day ahead shows with no end', lisbon[0]?.expires === null && lisbon[0]?.when === '2026-10-07');
ok('soonest first: the meetings before the trip', now.findIndex(x => /meets/.test(x.text)) < now.findIndex(x => /Lisbon/.test(x.text)), now.map(x => x.title));
now = V.now(['user:ola'], { at: Date.parse('2026-10-12T10:00:00Z') });
ok('five days after its day the open trip still shows', now.some(x => /Lisbon/.test(x.text)), now);
now = V.now(['user:ola'], { at: Date.parse('2026-10-16T10:00:00Z') });
ok('nine days after its day, the open trip is gone (a week past its start)', !now.some(x => /Lisbon/.test(x.text)), now);


// ─── per-note names ──────────────────────────────────────────────────────────
// A conversation about two things: each note carries only the names it is
// about (the model's "names"), never every name of the conversation.
{
  const two = 'Ola: Quillwork has its website up now. Also, Tuesday I meet Marek about the kiosk.\nBot: Great.';
  const r = R.cleanNotes({ notes: [
    { text: 'Quillwork launched its website.', kind: 'fact', evidence: 'Quillwork has its website up now', names: ['Quillwork'] },
    { text: 'Ola meets Marek about the kiosk on Tuesday.', kind: 'status', about: 'meeting', when: '2026-10-06', whenFrom: 'Tuesday', dayStated: true, subject: 'Marek', evidence: 'Tuesday I meet Marek about the kiosk', names: ['Marek'] },
    { text: 'Ola has a kiosk project.', kind: 'fact', evidence: 'I meet Marek about the kiosk', names: [] },
  ], rules: [], entities: [{ name: 'Quillwork', kind: 'project' }, { name: 'Marek', kind: 'person' }] }, two, [], { max: 4 });
  ok('a note is about the names it lists, not every name of the conversation', r.notes[0]?.entities?.map(e => e.name).join() === 'Quillwork' && r.notes[1]?.entities?.map(e => e.name).join() === 'Marek', r.notes);
  ok('a note that names none, with two names in the conversation, is about neither', !r.notes[2]?.entities, r.notes[2]);
  const one = R.cleanNotes({ notes: [{ text: 'Quillwork launched its website.', kind: 'fact', evidence: 'Quillwork has its website up now', names: [] }], rules: [], entities: [{ name: 'Quillwork', kind: 'project' }] }, two, [], { max: 2 });
  ok('...but a conversation about one thing gives it to the note', one.notes[0]?.entities?.[0]?.name === 'Quillwork', one.notes[0]);
  const bySubject = R.cleanNotes({ notes: [{ text: 'Ola meets Marek on Tuesday.', kind: 'status', about: 'meeting', when: '2026-10-06', whenFrom: 'Tuesday', dayStated: true, subject: 'Marek', evidence: 'Tuesday I meet Marek about the kiosk', names: [] }], rules: [], entities: [{ name: 'Quillwork', kind: 'project' }, { name: 'Marek', kind: 'person' }] }, two, [], { max: 2 });
  ok('a status that names none is about its subject when that is one of the names', bySubject.notes[0]?.entities?.map(e => e.name).join() === 'Marek', bySubject.notes[0]);
  const invented = R.cleanNotes({ notes: [{ text: 'Quillwork launched its website.', kind: 'fact', evidence: 'Quillwork has its website up now', names: ['Acme'] }], rules: [], entities: [{ name: 'Quillwork', kind: 'project' }, { name: 'Marek', kind: 'person' }] }, two, [], { max: 2 });
  ok('a name not attested for the conversation is ignored', !invented.notes[0]?.entities, invented.notes[0]);
}


// ─── a note grounded in the assistant's restatement is asked for the person's words ──
{
  const LLM = await import('./memory-llm.js');
  const human = 'Ola: Nils will das eher auf Arztpraxen zuschneiden, wie du ja schon weisst';
  const full = `${human}\nBot: Ok, notiert — Arztpraxen, nicht Gastro.`;
  let asks = 0;
  LLM.configureRunner(async ({ schema }) => {
    if (schema?.properties?.notes) return { notes: [{ title: 'Nils targets medical practices', text: 'Nils now targets medical practices rather than gastro.', kind: 'fact', importance: 2, evidence: 'Arztpraxen, nicht Gastro', names: [] }], rules: [], entities: [{ name: 'Nils', kind: 'person' }] };
    if (schema?.properties?.quote) { asks++; return { quote: 'Nils will das eher auf Arztpraxen zuschneiden' }; }
    return {};
  });
  const r = await R.notes({ name: 'Ola', ts: '2026-10-05', text: full, attest: human, known: [], max: 2 });
  ok('the quote from the assistant is refused, the person is re-asked once, and the note stands on their words', asks === 1 && r.notes.length === 1 && r.notes[0].evidence === 'Nils will das eher auf Arztpraxen zuschneiden' && !r.rejected.some(x => !x.kept), r);
  LLM.configureRunner(async ({ schema }) => {
    if (schema?.properties?.notes) return { notes: [{ title: 'Right now recital', text: 'Ola is in Lisbon until Friday.', kind: 'fact', importance: 1, evidence: 'you are in Lisbon until Friday', names: [] }], rules: [], entities: [] };
    if (schema?.properties?.quote) return { quote: '' };
    return {};
  });
  const r2 = await R.notes({ name: 'Ola', ts: '2026-10-05', text: 'Ola: what do you have in Right now?\nBot: As far as I know you are in Lisbon until Friday.', attest: 'Ola: what do you have in Right now?', known: [], max: 2 });
  ok('a recital with nothing of the person behind it stays out', r2.notes.length === 0 && r2.rejected.some(x => x.why === 'quoted from the assistant'), r2);
}


// ─── a known name the model says is mentioned counts, in any form ────────────
{
  const said = 'Ola: Vellmarks Angebot ist raus, ich warte bis Freitag auf Antwort.';
  const r = R.cleanNotes({ notes: [{ text: 'Ola sent the offer and waits for an answer by Friday.', kind: 'status', about: 'waiting', evidence: 'ich warte bis Freitag auf Antwort', names: [] }], rules: [], entities: [], known_mentioned: ['Vellmark Logistics'] }, said, ['Vellmark Logistics', 'Marta Zielak'], { max: 2, kinds: { vellmarklogistics: 'company' } });
  ok('a known name the model reports as mentioned counts, with its kind, with no word test', r.entities.length === 1 && r.entities[0].name === 'Vellmark Logistics' && r.entities[0].kind === 'company', r.entities);
  ok('...and a note that named none is about it, being the only name', r.notes[0]?.entities?.[0]?.name === 'Vellmark Logistics', r.notes[0]);
  const r2 = R.cleanNotes({ notes: [], rules: [], entities: [], known_mentioned: ['Acme Corp'] }, 'Ola: nothing much.', ['Marek Nowak'], { max: 2 });
  ok('a name not on the known list is not taken on the model\'s say-so', r2.entities.length === 0, r2.entities);
}

console.log(`memory-gate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
