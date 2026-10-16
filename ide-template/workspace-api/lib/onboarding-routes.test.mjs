/**
 * Onboarding end to end over HTTP, with the website and the model scripted:
 * the admin sets up the company and themselves, research runs in stages, only
 * drafted lines can be confirmed, the company card and the admin's own card are
 * written through the memory engine, and a member joining later answers only
 * about themselves and gets a plan without the team's tools.
 * Run: node lib/onboarding-routes.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'onb-routes-'));
const STORE = mkdtempSync(join(tmpdir(), 'onb-routes-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'on';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'mara@example.test', role: 'admin', slug: 'mara', displayName: 'Mara', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'jonas@example.test', role: 'member', slug: 'jonas', displayName: 'Jonas', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), '{}');
// The shared cards exist from the first boot (bootstrap seeds them).
writeFileSync(join(ROOT, 'memory', 'MISSION.md'), readFileSync(new URL('../../bootstrap/memory-cards-templates/MISSION.md', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const LLM = await import('./memory-llm.js');
const state = await import('./onboarding/state.js');
const { default: onboardingRouter } = await import('../routes/onboarding.js');
const { default: memoryV4Router } = await import('../routes/memory-v4.js');

// The model: the plan call answers with ids; nothing else is asked of it here.
LLM.configureRunner(async ({ system }) => {
  if (/starter plan/.test(system)) return { integrations: [{ id: 'notion', why: 'Your notes.' }], routines: [{ id: 'morning-brief', why: 'Your day at 8.' }] };
  throw new Error('unexpected model call');
});
let lookups = 0;
const hooks = {
  readSite: async (site) => ({ site, pages: [{ url: `${site}about`, text: 'Six people.' }], tools: [{ id: 'mailchimp', seen: 'Newsletter form' }], favicon: { type: 'image/png', data: 'iVBORw0=' } }),
  draftCompany: async () => [{ text: 'Six people, founded by Mara and Jonas', source: 'https://fieldcraft.co/about' }],
  lookupCompany: async () => ({ website: null, facts: [{ text: 'Featured in a 2025 outdoor retail roundup', source: 'https://news.example/roundup', sure: true }] }),
  lookupPerson: async () => { lookups++; return [{ text: 'Ran an outdoor shop in Berlin', source: 'https://www.linkedin.com/in/mara' }]; },
};
state.configureHooks(hooks);
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', onboardingRouter());
app.use('/api', memoryV4Router());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-test-actor': who }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const MARA = 'mara@example.test', JONAS = 'jonas@example.test';
const waitDone = async (who) => { for (let i = 0; i < 100; i++) { const r = await call(who, 'GET', '/onboarding/research'); if (r.body.done) return r.body; await new Promise((s) => setTimeout(s, 20)); } return null; };

// ─── who sees which steps ────────────────────────────────────────────────────
let r = await call(MARA, 'GET', '/onboarding');
ok('a fresh install shows onboarding to its admin', r.body.show === true, r.body);
ok('the first admin has the company step and their own', r.body.steps.company === true && r.body.steps.person === true, r.body);
r = await call(JONAS, 'GET', '/onboarding');
ok('a member only has their own', r.body.steps.company === false && r.body.steps.person === true, r.body);
ok('a stranger is turned away', (await call('nobody@example.test', 'GET', '/onboarding')).status !== 200);

// ─── the company ─────────────────────────────────────────────────────────────
ok('a member cannot set up the company', (await call(JONAS, 'POST', '/onboarding/company', { name: 'X', sentence: 'Y' })).status === 403);
ok('the name and the sentence are needed', (await call(MARA, 'POST', '/onboarding/company', { name: 'Fieldcraft' })).status === 400);
ok('a website must be a public one', (await call(MARA, 'POST', '/onboarding/company', { name: 'Fieldcraft', sentence: 'We sell outdoor gear', site: 'http://10.0.0.1' })).status === 400);
r = await call(MARA, 'POST', '/onboarding/company', { name: 'Fieldcraft', sentence: 'We sell outdoor gear online', site: 'Fieldcraft.co' });
ok('the company is saved, website normalised', r.status === 200 && state.readCompany().site === 'https://fieldcraft.co/', state.readCompany());
const storeFile = join(STORE, 'onboarding', 'company.json');
ok('onboarding lives in workspace-api\'s store, private to it', existsSync(storeFile) && (statSync(storeFile).mode & 0o077) === 0 && !existsSync(join(ROOT, 'onboarding')));

// ─── the person and the research ─────────────────────────────────────────────
ok('research needs the person first', (await call(MARA, 'POST', '/onboarding/research')).status === 400);
ok('name, role and help are needed', (await call(MARA, 'POST', '/onboarding/me', { fullName: 'Mara Lindqvist', role: 'Founder' })).status === 400);
await call(MARA, 'POST', '/onboarding/me', { fullName: 'Mara Lindqvist', role: 'Founder', help: 'Customer emails about orders', lookup: true });
ok('the name given becomes the name the workspace shows', (await import('./team.js')).getUser('mara@example.test')?.displayName === 'Mara Lindqvist', (await import('./team.js')).getUser('mara@example.test'));
let claude = false;
state.configureHooks({ ...hooks, claudeReady: () => claude });
r = await call(MARA, 'POST', '/onboarding/research');
let done = await waitDone(MARA);
ok('without a Claude token the setup says so, and stops', !!done.error && done.stages[0].state === 'failed' && lookups === 0, done);

// As after the token step.
claude = true;
r = await call(MARA, 'POST', '/onboarding/research');
ok('the admin\'s stages: Claude, the company on the web, the website, the look-up, ready', r.body.stages.map((s) => s.id).join() === 'claude,web,site,lookup,ready', r.body.stages);
ok('the stages name the company and the site', r.body.stages[1].label === 'Looking up Fieldcraft' && r.body.stages[2].label === 'Reading fieldcraft.co', r.body.stages);
done = await waitDone(MARA);
ok('the research finishes, every stage done', done && !done.error && done.stages.every((s) => s.state === 'done'), done);
ok('findings: the site\'s and the web\'s company lines, the tools, the favicon, and the person', done.findings.company?.facts.length === 2 && done.findings.company.facts[1].source === 'https://news.example/roundup' && done.findings.company.tools[0].id === 'mailchimp' && done.findings.company.favicon.startsWith('data:image/png;base64,') && done.findings.person?.facts.length === 1, done.findings);
ok('the look-up ran because it was asked for', lookups === 1);

// ─── confirming ──────────────────────────────────────────────────────────────
r = await call(MARA, 'POST', '/onboarding/confirm', {
  company: [
    { text: 'Six people; founded by Mara and Jonas', source: 'https://fieldcraft.co/about' },
    { text: 'We are a bank now', source: 'https://evil.example/' },
  ],
  person: [{ text: 'Ran an outdoor shop in Berlin', source: 'https://www.linkedin.com/in/mara' }],
});
ok('confirming writes through the memory engine', r.status === 200 && r.body.written.company === 4 && r.body.written.person === 4, r.body);
const mission = readFileSync(join(ROOT, 'memory', 'MISSION.md'), 'utf8');
ok('the company card holds its name, the sentence, the website and the kept, edited line', mission.includes('Name: Fieldcraft') && mission.includes('What it does: We sell outdoor gear online') && mission.includes('Website: fieldcraft.co') && mission.includes('Six people; founded by Mara and Jonas'), mission);
ok('a line with a source the research never found is not kept', !mission.includes('bank'), mission);
const maraCard = join(ROOT, 'memory', 'users', 'mara', 'USER_PROFILE.md');
ok('the admin\'s own lines go to their private card', existsSync(maraCard) && readFileSync(maraCard, 'utf8').includes('Roles: Founder') && readFileSync(maraCard, 'utf8').includes('Ran an outdoor shop in Berlin'));
ok('...and not to the company card', !mission.includes('Roles: Founder') && !mission.includes('Berlin'));
r = await call(MARA, 'GET', '/onboarding');
ok('afterwards the company step is done for everyone', r.body.steps.company === false && r.body.steps.person === false, r.body);

// ─── once it's confirmed, onboarding is closed ───────────────────────────────
ok('after confirming, the answers can\'t be rewritten here', (await call(MARA, 'POST', '/onboarding/me', { fullName: 'Someone Else', role: 'CEO', help: 'x', lookup: true })).status === 409);
ok('...nor research run again', (await call(MARA, 'POST', '/onboarding/research')).status === 409);
ok('...nor lines confirmed again', (await call(MARA, 'POST', '/onboarding/confirm', { person: [] })).status === 409);

// ─── the plan ────────────────────────────────────────────────────────────────
r = await call(MARA, 'GET', '/onboarding/plan');
const ids = r.body.plan.integrations.map((i) => i.id);
ok('the plan: the tool from the site first, then the model\'s pick', ids.join() === 'mailchimp,notion', r.body.plan);
ok('a routine came with it', r.body.plan.routines[0]?.id === 'morning-brief', r.body.plan.routines);
await call(MARA, 'POST', '/onboarding/plan/dismiss', { id: 'notion' });
r = await call(MARA, 'GET', '/onboarding/plan');
ok('a dismissed item leaves the plan', !r.body.plan.integrations.some((i) => i.id === 'notion'), r.body.plan);
r = await call(MARA, 'GET', '/onboarding/plan?fresh=1');
ok('...and never comes back, even rebuilt', !r.body.plan.integrations.some((i) => i.id === 'notion'), r.body.plan);
await call(MARA, 'POST', '/onboarding/done');
r = await call(MARA, 'GET', '/onboarding');
ok('done is remembered, and onboarding is not shown again', r.body.steps.done === true && r.body.show === false, r.body);

// ─── a member joining later ──────────────────────────────────────────────────
await call(JONAS, 'POST', '/onboarding/me', { fullName: 'Jonas Weber', role: 'Wholesale', help: 'Following up after calls', lookup: false });
r = await call(JONAS, 'POST', '/onboarding/research');
ok('a member\'s stages: about them only', r.body.stages.map((s) => s.id).join() === 'you,ready', r.body.stages);
done = await waitDone(JONAS);
ok('no look-up asked, none run; no company findings for a member', lookups === 1 && !done.findings.company && !done.findings.person, done.findings);
r = await call(JONAS, 'POST', '/onboarding/confirm', { company: [{ text: 'Sneaky', source: 'https://fieldcraft.co/about' }] });
const mission2 = readFileSync(join(ROOT, 'memory', 'MISSION.md'), 'utf8');
ok('a member\'s confirm never touches the company card', r.status === 200 && r.body.written.company === 0 && !mission2.includes('Sneaky'));
ok('the member\'s lines go to their own card', readFileSync(join(ROOT, 'memory', 'users', 'jonas', 'USER_PROFILE.md'), 'utf8').includes('Roles: Wholesale'));
ok('...never to the admin\'s', !readFileSync(maraCard, 'utf8').includes('Wholesale'));

// ─── a member trying to use the look-up on other people ─────────────────────
const KASIA = 'kasia@example.test';
const roster = JSON.parse(readFileSync(join(ROOT, '.allowed-emails.json'), 'utf8'));
roster.push({ email: KASIA, role: 'member', slug: 'kasia', displayName: 'Kasia', addedAt: '2026-10-15T12:00:00Z' });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify(roster));
const searched = [];
state.configureHooks({ ...hooks, claudeReady: () => true, lookupPerson: async ({ fullName }) => { searched.push(fullName); return []; } });
await call(KASIA, 'POST', '/onboarding/me', { fullName: 'Kasia Nowak', role: 'Sales', help: 'Follow-ups', lookup: true });
await call(KASIA, 'POST', '/onboarding/research'); await waitDone(KASIA);
await call(KASIA, 'POST', '/onboarding/me', { fullName: 'Victim Person', role: 'Sales', help: 'Follow-ups', lookup: true });
await call(KASIA, 'POST', '/onboarding/research'); await waitDone(KASIA);
ok('the look-up runs once per person: a second name is never searched', searched.join() === 'Kasia Nowak', searched);
r = await call(KASIA, 'POST', '/onboarding/research'); await waitDone(KASIA);
r = await call(KASIA, 'POST', '/onboarding/research');
ok('three research runs a day, then a plain refusal', r.status === 429 && /enough tries for today/.test(r.body.error), r);

// ─── a workspace that was already in use when it got this version ────────────
const { mkdtempSync: mk } = await import('node:fs');
process.env.WSAPI_STORE_DIR = mk(join(tmpdir(), 'onb-upgraded-'));
const setupMod = await import('./setup.js');
r = await call(JONAS, 'GET', '/onboarding');
// The fresh store above has no "since" yet; this one is created now, with setup
// complete or not depending on this machine — either way an old member who never
// started is shown onboarding only on a fresh install.
const fresh = !setupMod.status().complete;
ok('someone already using an updated workspace is not sent back to the start', r.body.show === fresh, { show: r.body.show, fresh });

// ─── the team's rules: an admin keeps them, a member reads them ─────────────
{
  writeFileSync(join(ROOT, 'memory', 'RULES.md'), readFileSync(new URL('../../bootstrap/memory-cards-templates/RULES.md', import.meta.url), 'utf8'));
  let r = await call(MARA, 'POST', '/memory/v4/prefs', { card: 'RULES', op: 'add', text: 'Never share a client price outside the team' });
  ok('an admin adds a team rule', r.status === 200 && readFileSync(join(ROOT, 'memory', 'RULES.md'), 'utf8').includes('Never share a client price outside the team'), r);
  r = await call(JONAS, 'POST', '/memory/v4/prefs', { card: 'RULES', op: 'add', text: 'Members may skip reviews' });
  ok('a member cannot', r.status === 403 && !readFileSync(join(ROOT, 'memory', 'RULES.md'), 'utf8').includes('skip reviews'), r);
  r = await call(JONAS, 'GET', '/memory/v4/prefs');
  ok('a member sees the team rule', (r.body.team?.lines || []).some((l) => l.includes('client price')), r.body.team);
  r = await call(MARA, 'POST', '/memory/v4/prefs', { card: 'RULES', op: 'remove', text: 'Never share a client price outside the team' });
  ok('an admin removes it', r.status === 200 && !readFileSync(join(ROOT, 'memory', 'RULES.md'), 'utf8').includes('client price'), r);
}

server.close();
console.log(`onboarding-routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
