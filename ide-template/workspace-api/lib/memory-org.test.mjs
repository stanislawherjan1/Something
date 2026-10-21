/**
 * The organisation the sharing router reads: the company card's own bullets
 * and who is on the team — never its front matter, comments or anyone's
 * private memory; nothing at all alone (nobody to share with). The router
 * gets it as data, under the conversation's header, and the conservative
 * rules stay in its prompt. No model is called — the runner is a fake.
 *
 * Run: node lib/memory-org.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'memory-org-'));
process.env.PROJECT_DIR = ROOT;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };

mkdirSync(join(ROOT, 'memory', 'users', 'nora'), { recursive: true });
writeFileSync(join(ROOT, 'memory', 'MISSION.md'), `---
card: MISSION
purpose: The company — what it does
---

# MISSION

## About the company
<!-- one fact per bullet: what the company does, for whom, how -->
- Saltmarsh Ceramics: a two-person studio making stoneware tableware for restaurants. [Source: chat 2026-09-01]
- Nora runs the kiln and production; Mara leads suppliers, glaze sourcing and client orders.
- Clay comes from a supplier in Stoke; packaging from a local printer.
`);
writeFileSync(join(ROOT, 'memory', 'users', 'nora', 'USER_PROFILE.md'), '- Nora is pregnant and has not told the team yet.\n');
const roster = (n) => writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'nora@example.test', role: 'admin', slug: 'nora', displayName: 'Nora', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'mara@example.test', role: 'member', slug: 'mara', displayName: 'Mara', addedAt: '2026-09-01T00:00:00Z' },
].slice(0, n)));
roster(2);
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

const O = await import('./memory-org.js');
const R = await import('./memory-router.js');
const LLM = await import('./memory-llm.js');

const org = O.orgContext({ person: 'Nora' });
ok('the team is named, and whose conversation it is', /^TEAM: Nora, Mara \(this conversation is Nora's\)/.test(org), org);
ok('the company card\'s bullets are there', /Mara leads suppliers, glaze sourcing and client orders/.test(org) && /packaging from a local printer/.test(org), org);
ok('...without front matter, comments or source tails', !/card: MISSION|purpose:|one fact per bullet|\[Source:/.test(org), org);
ok('no one\'s private card ever enters it', !/pregnant/.test(org));

writeFileSync(join(ROOT, 'memory', 'MISSION.md'), '# MISSION\n\n## About the company\n' + Array.from({ length: 80 }, (_, i) => `- fact number ${i} ${'x'.repeat(60)}`).join('\n') + '\n');
ok('a long card is capped', O.orgContext().length < 3000 && /fact number 0/.test(O.orgContext()) && !/fact number 79/.test(O.orgContext()), O.orgContext().length);
writeFileSync(join(ROOT, 'memory', 'MISSION.md'), '');
ok('an empty card says so rather than inventing', /ABOUT THE COMPANY: nothing written down yet/.test(O.orgContext()));

roster(1);
ok('alone: no organisation block (nobody to share with)', O.orgContext() === '');
roster(2);
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));
ok('team mode off: none either', O.orgContext() === '');
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

// The router: the block under the conversation's header, the rules in its prompt.
let seen = null;
LLM.configureRunner(async ({ system, user }) => { seen = { system, user }; return { shared: '', private: '', ask: '', ask_question: '' }; });
await R.route({ name: 'Nora', channel: 'web', ts: '2026-10-21T10:00:00Z', text: 'Nora: I ordered the glaze samples from the Stoke supplier.', org: 'TEAM: Nora, Mara\nABOUT THE COMPANY (as the team wrote it):\n- Mara leads suppliers.' });
ok('the router reads the organisation as data, before the conversation', /ORGANISATION \(data/.test(seen.user) && seen.user.indexOf('Mara leads suppliers') < seen.user.indexOf('CONVERSATION:') && seen.user.indexOf('CONVERSATION:') < seen.user.indexOf('I ordered the glaze samples'), seen.user);
ok('...and its prompt keeps private the default', /private: THE DEFAULT/.test(seen.system) && /ORGANISATION never moves anything out of private/.test(seen.system) && /costs far less than a private one shared/.test(seen.system));
await R.route({ name: 'Nora', channel: 'web', ts: '2026-10-21T10:00:00Z', text: 'Nora: hello' });
ok('without an organisation the call is as it was', !/ORGANISATION \(data|CONVERSATION:/.test(seen.user), seen.user);
// What it shares is still held to the conversation's own words.
LLM.configureRunner(async () => ({ shared: 'Nora: I ordered the glaze samples from the Stoke supplier.\nMara leads suppliers.', private: '', ask: '', ask_question: '' }));
const r = await R.route({ name: 'Nora', channel: 'web', ts: '2026-10-21T10:00:00Z', text: 'Nora: I ordered the glaze samples from the Stoke supplier.', org: 'TEAM: Nora, Mara\n- Mara leads suppliers.' });
ok('a line copied from the organisation block is not a shared line', r.shared === 'Nora: I ordered the glaze samples from the Stoke supplier.' && r.dropped === 1, r);

// The notes pass: with the organisation, each note says whether a teammate
// depends on it — kept only on company or team work.
const raw = { notes: [
  { title: 'Celadon from Harbor Glaze', text: 'Harbor Glaze supplies the spring celadon.', kind: 'fact', concerns: 'a company or project', evidence: 'Harbor Glaze answered — 20 kg of the celadon', names: [], teamNeeds: true },
  { title: 'Physio on Friday', text: 'Nora has physio on Friday.', kind: 'fact', concerns: 'the person themselves', evidence: 'I have a physio appointment on Friday', names: [], teamNeeds: true },
], rules: [], entities: [] };
const src = 'Nora: Harbor Glaze answered — 20 kg of the celadon. Also I have a physio appointment on Friday.';
const cn = R.cleanNotes(raw, src, [], { max: 3, full: src });
ok('a company note keeps "a teammate depends on it"', cn.notes.find(n => /Harbor/.test(n.title))?.teamNeeds === true, cn.notes);
ok('...a note about the person never does, whatever the model said', !cn.notes.find(n => /Physio/.test(n.title))?.teamNeeds, cn.notes);
ok('the notes prompt asks for it only with an organisation', /teamNeeds/.test(R.notesSystem({ org: true })) && !/teamNeeds/.test(R.notesSystem({})));
LLM.configureRunner(async ({ user }) => { seen = { user }; return { notes: [], rules: [], entities: [], known_mentioned: [] }; });
await R.notes({ name: 'Nora', ts: '2026-10-21', text: src, org: 'TEAM: Nora, Mara' });
ok('the notes pass reads the organisation as data, before the conversation', /ORGANISATION \(data/.test(seen.user) && seen.user.indexOf('TEAM: Nora, Mara') < seen.user.indexOf('Harbor Glaze answered'), seen.user);

LLM.configureRunner(null);
console.log(`memory-org: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
