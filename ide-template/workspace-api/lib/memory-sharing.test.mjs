/**
 * What from a private conversation may reach the team, and how: the gate
 * corpus. Each case is a fact as the notes pass files it, the router's
 * verdict on the conversation, the person's mode, rules and earlier
 * answers — and the one outcome it must get. The model's judgement is in
 * the case (concerns, subject); the code's decision is what is tested.
 * Run: node lib/memory-sharing.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'sharing-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'sharing-store-'));
process.env.MEMORY_V4 = 'on';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'alex@example.test', role: 'admin', slug: 'alex', displayName: 'Alex', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', sharing: 'auto' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z', sharing: 'never' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const S = await import('./memory-sharing.js');
const L = await import('./memory-ledger.js');
const F = await import('./memory-facts.js');
const A = await import('./memory-asks.js');
// No suite calls a model: the reconcile step (one fact per thing) finds nothing to merge.
(await import('./memory-llm.js')).configureRunner(async ({ schema }) => (schema?.properties?.decisions ? { decisions: [] } : {}));

ok('the mode is the person\'s choice, "ask" when unset', S.modeOf('alex') === 'ask' && S.modeOf('ann') === 'auto' && S.modeOf('bob') === 'never');

// ─── the corpus ──────────────────────────────────────────────────────────────
const P = (overrides) => ({ title: 'x', text: 'x', kind: 'fact', evidence: 'the quarry launch moves to october 3', concerns: "the team's work", ...overrides });
const routed = {
  shared: 'Alex: The Quarry launch moves to October 3.\nAlex: Vellmark starts the warehouse pilot on 4 November.\nAlex: Payment from Vellmark is late, Marta said they pay next week.\nAlex: I got verbal approval for the Chief of Staff role at Northwind.\nAlex: Jarek is pushing for more office presence.',
  ask: 'Alex: Budget for the Harbor campaign might be cut.',
  askQuestion: 'Should I save the Harbor budget news for the whole team?',
};
const cases = [
  // [name, fact, mode, expected]
  ['a project date, automatic mode → team', P({ title: 'Quarry launch date', text: 'The Quarry launch moved to 3 October.', subject: 'Quarry', entities: [{ name: 'Quarry', kind: 'project' }] }), 'auto', 'team'],
  ['the same in ask-first mode → a question', P({ title: 'Quarry launch date', text: 'The Quarry launch moved to 3 October.', subject: 'Quarry', entities: [{ name: 'Quarry', kind: 'project' }] }), 'ask', 'ask'],
  ['the same in never mode → stays private', P({ title: 'Quarry launch date', text: 'The Quarry launch moved to 3 October.', subject: 'Quarry', entities: [{ name: 'Quarry', kind: 'project' }] }), 'never', 'private'],
  ['a client\'s pilot, automatic → team', P({ title: 'Vellmark pilot start', text: 'Vellmark starts the warehouse pilot on 4 November.', evidence: 'Vellmark starts the warehouse pilot on 4 November', subject: 'Vellmark', concerns: 'a company or project', entities: [{ name: 'Vellmark', kind: 'company' }] }), 'auto', 'team'],
  ['a late payment "per Marta" is about the company → team', P({ title: 'Vellmark payment late', text: 'Vellmark pays late; Marta said next week.', evidence: 'Payment from Vellmark is late, Marta said they pay next week', subject: 'Vellmark', concerns: 'a company or project', entities: [{ name: 'Vellmark', kind: 'company' }, { name: 'Marta', kind: 'person' }] }), 'auto', 'team'],
  ['a job offer to the person, automatic → still a question', P({ title: 'Chief of Staff offer at Northwind', text: 'Alex has verbal approval for the Chief of Staff role at Northwind.', evidence: 'I got verbal approval for the Chief of Staff role at Northwind', subject: 'Northwind', concerns: 'the person themselves', entities: [{ name: 'Northwind', kind: 'company' }] }), 'auto', 'ask'],
  ['what a named person pushes for, automatic → a question', P({ title: 'Jarek wants more office presence', text: 'Jarek is pushing for more office presence.', evidence: 'Jarek is pushing for more office presence', subject: 'Jarek', concerns: 'another person', entities: [{ name: 'Jarek', kind: 'person' }] }), 'auto', 'ask'],
  ['a fact whose subject is a person, even if the model said "work" → a question', P({ title: 'Marta owns the WMS integration', text: 'Marta owns the WMS integration.', evidence: 'Payment from Vellmark is late, Marta said they pay next week', subject: 'Marta', concerns: "the team's work", entities: [{ name: 'Marta', kind: 'person' }] }), 'auto', 'ask'],
  ['a preference is personal → a question', P({ title: 'Remote work preference', text: 'Alex prefers remote work.', kind: 'preference', subject: null, concerns: "the team's work" }), 'auto', 'ask'],
  ['a note the model did not label → treated as about the person', P({ title: 'Quarry launch date', text: 'x', subject: 'Quarry', concerns: undefined, entities: [{ name: 'Quarry', kind: 'project' }] }), 'auto', 'ask'],
  ['a borderline line (router: ask) → a question in automatic mode too', P({ title: 'Harbor budget', text: 'The Harbor budget might be cut.', evidence: 'Budget for the Harbor campaign might be cut', subject: 'Harbor', concerns: 'a company or project' }), 'auto', 'ask'],
  ['a line the router kept private → private in every mode', P({ title: 'My raise', text: 'Alex negotiates a raise.', evidence: 'I am negotiating my own raise', subject: null, concerns: 'the person themselves' }), 'auto', 'private'],
  ['no evidence → private', P({ title: 'Quarry', text: 'x', evidence: '', subject: 'Quarry', entities: [{ name: 'Quarry', kind: 'project' }] }), 'auto', 'private'],
];
// Lifestyle: health, money and relationships are the person's whatever the mode.
const lifestyle = {
  shared: 'Alex: My therapist moved our sessions to Thursdays.\nAlex: We are paying off the flat loan early.\nAlex: Mia and I are thinking about moving to Gdansk.\nAlex: The flat-share rota: Tomek cooks on Mondays.',
  ask: '', askQuestion: '',
};
const lifeCases = [
  ['a health fact is about the person — a question even in automatic mode', P({ title: 'Therapy on Thursdays', text: 'Alex sees their therapist on Thursdays.', evidence: 'My therapist moved our sessions to Thursdays', subject: null, concerns: 'the person themselves' }), 'auto', 'ask'],
  ['money at home is about the person', P({ title: 'Flat loan paid early', text: 'Alex is paying off the flat loan early.', evidence: 'We are paying off the flat loan early', subject: null, concerns: 'the person themselves' }), 'auto', 'ask'],
  ['a plan with a partner names another person', P({ title: 'Moving to Gdansk', text: 'Alex and Mia consider moving to Gdansk.', evidence: 'Mia and I are thinking about moving to Gdansk', subject: 'Mia', concerns: 'another person', entities: [{ name: 'Mia', kind: 'person' }] }), 'auto', 'ask'],
  ['a flat-share rota is the household\'s work — may cross in automatic mode', P({ title: 'Cooking rota', text: 'Tomek cooks on Mondays.', evidence: 'The flat-share rota: Tomek cooks on Mondays', subject: 'rota', concerns: "the team's work", entities: [{ name: 'Tomek', kind: 'person' }] }), 'auto', 'team'],
  ['...and never in never mode', P({ title: 'Cooking rota', text: 'Tomek cooks on Mondays.', evidence: 'The flat-share rota: Tomek cooks on Mondays', subject: 'rota', concerns: "the team's work" }), 'never', 'private'],
];
for (const [name, fact, mode, want] of lifeCases) {
  const d = S.decide({ mode, fact, routed: lifestyle });
  ok(name, d.outcome === want, { got: d, want });
}

for (const [name, fact, mode, want] of cases) {
  const d = S.decide({ mode, fact, routed });
  ok(name, d.outcome === want, { got: d, want });
}

// ─── rules and earlier answers ───────────────────────────────────────────────
const vell = P({ title: 'Vellmark pilot start', text: 'Vellmark starts the warehouse pilot on 4 November.', evidence: 'Vellmark starts the warehouse pilot on 4 November', subject: 'Vellmark', concerns: 'a company or project', entities: [{ name: 'Vellmark', kind: 'company' }] });
ok('a "share" rule for the subject shares even in ask-first mode', S.decide({ mode: 'ask', fact: vell, routed, rules: [{ subject: 'vellmark', decision: 'share' }] }).outcome === 'team');
ok('a "keep" rule keeps even in automatic mode', S.decide({ mode: 'auto', fact: vell, routed, rules: [{ subject: 'Vellmark', decision: 'keep' }] }).outcome === 'private');
ok('a rule never overrides "never"', S.decide({ mode: 'never', fact: vell, routed, rules: [{ subject: 'Vellmark', decision: 'share' }] }).outcome === 'private');
const decided = new Map([[S.factKey(vell), 'keep']]);
ok('a fact kept private before is not asked again', S.decide({ mode: 'ask', fact: vell, routed, decided }).outcome === 'private');
ok('a fact shared before is shared again (a confirm)', S.decide({ mode: 'ask', fact: vell, routed, decided: new Map([[S.factKey(vell), 'share']]) }).outcome === 'team');
ok('the person gate holds even for a fact shared before? no — an explicit earlier answer stands', S.decide({ mode: 'auto', fact: P({ ...vell, concerns: 'another person', subject: 'Marta', entities: [{ name: 'Marta', kind: 'person' }] }), routed, decided: new Map([[S.factKey(vell), 'share']]) }).outcome === 'team');

// ─── what reaches the team is the fact ───────────────────────────────────────
const out = await S.fileTeamFact('alex', vell, { ts: '2026-10-05T10:00:00Z', conv: 'web:alex:s1', source: 'web', name: 'Alex' });
const rec = L.read({ scopes: ['shared'] }).find(r => r.id === out.recordId);
ok('a shared record carries the fact, in the person\'s name', !!rec && rec.origin === 'user:alex' && rec.tags?.sharedFact === true && /Vellmark starts the warehouse pilot/.test(rec.text) && rec.speaker === 'Alex', rec);
const teamFacts = F.all('shared');
ok('...and the team has the fact, with its subject and whom it concerns', teamFacts.length === 1 && teamFacts[0].subject === 'Vellmark' && teamFacts[0].concerns === 'a company or project' && teamFacts[0].record === out.recordId, teamFacts);

// ─── a question answered "share" files the fact; "remember" makes a rule ──────
const scope = { ...vell, title: 'Vellmark pilot scope', text: 'The Vellmark pilot covers two warehouses and the WMS integration.', evidence: 'the pilot covers two warehouses and the WMS integration' };
const id = A.addAsk('alex', { text: scope.text, question: 'Share with the team?', ts: '2026-10-06T10:00:00Z', source: 'web', fact: scope, reason: 'about Vellmark', key: S.factKey(scope) });
const r1 = await A.resolveAsk('alex', id, 'share', 'alex', { rememberSubject: true, name: 'Alex' });
ok('answering "share" files the fact for the team', r1.ok && F.all('shared').some(f => f.title === 'Vellmark pilot scope'), { r1, facts: F.all('shared').map(f => [f.title, f.text, f.updates?.length]) });
ok('...and "remember" sets a rule for the subject', A.listRules('alex').some(r => r.subject === 'Vellmark' && r.decision === 'share'), A.listRules('alex'));
ok('...and the answer is remembered by the fact\'s key', A.decisions('alex').get(S.factKey(scope)) === 'share');
const id2 = A.addAsk('alex', { text: 'x', question: 'q', ts: '2026-10-06T11:00:00Z', source: 'web', fact: P({ title: 'Jarek wants office', text: 'Jarek pushes for office.', subject: 'Jarek', concerns: 'another person' }), reason: 'about Jarek', key: 'jarek wants office' });
const r2 = await A.resolveAsk('alex', id2, 'keep', 'alex', { rememberSubject: false });
ok('answering "keep" files nothing', r2.ok && !F.all('shared').some(f => f.title === 'Jarek wants office'));
ok('a pending question carries the fact, the reason and the key', A.listAsks('alex').every(a => a.fact && a.reason && a.key));

console.log(`memory-sharing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
