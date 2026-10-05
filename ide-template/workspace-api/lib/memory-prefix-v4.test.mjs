/**
 * Guards for the memory v4 prefix (MEMORY_V4=read|on): the product rules stay,
 * the v3 memory mechanics go, a person's private cards load only for that
 * person, a group turn loads nothing private, and the rules card is the rules
 * channel of the right scope.
 *
 * Run: node lib/memory-prefix-v4.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'prefix-v4-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'off';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team' } } }));
const mem = join(ROOT, 'memory');
for (const d of ['users/stan', 'users/kasia']) mkdirSync(join(mem, d), { recursive: true });
writeFileSync(join(mem, 'AGENT_IDENTITY.md'), '# AGENT_IDENTITY\n\nName: Ada.\n');
writeFileSync(join(mem, 'RULES.md'), '# RULES\n\n- Never deploy on Fridays.\n');
writeFileSync(join(mem, 'INDEX.md'), '# INDEX\n\n- topics/pinecrest.md\n');
writeFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'), '# USER_PROFILE\n\n- Stan runs operations.\n');
writeFileSync(join(mem, 'users', 'stan', 'RECENT_TELEGRAM.md'), '# RECENT\n\nStan: yesterday we talked about the boat.\n');
writeFileSync(join(mem, 'users', 'kasia', 'USER_PROFILE.md'), '# USER_PROFILE\n\n- Kasia is interviewing elsewhere.\n');

const L = await import('./memory-ledger.js');
const RS = await import('./routines-store.js');
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-20T10:00:00Z', text: 'Stan: short answers.', tags: { rules: ['Keep answers short.'] } });
await L.append({ scope: 'user:kasia', source: 'web', ts: '2026-09-20T10:00:00Z', text: 'Kasia: cc me.', tags: { rules: ['Always cc Kasia.'] } });
await L.append({ scope: 'group:-100777', source: 'group', ts: '2026-09-20T10:00:00Z', text: 'Marek: answer in English here.', tags: { rules: ['Answer in English in this group.'] } });
RS.writeRoutines('stan', { routines: [{ title: 'Morning brief', description: 'Summarise email at 8:00.', source: 'ui' }, { title: 'Old duty', retired: true, source: 'ui' }] });
// The Short-term memory the screen shows: a live status and the nightly digest.
mkdirSync(join(mem, 'users', 'stan', 'views'), { recursive: true });
writeFileSync(join(mem, 'users', 'stan', 'views', 'digest.json'), JSON.stringify({ at: '2026-09-21T04:00:00Z', items: [{ name: 'Pinecrest', state: 'active', line: 'Kickoff scheduled for October.' }, { name: 'Old venture', state: 'closed', line: 'Wound down in August.' }] }));
const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-21T10:00:00Z', text: 'Stan: in Lisbon this week.', notes: [{ text: 'Stan is in Lisbon this week.', kind: 'status', expires: soon }] });

const { buildTurnPrefix } = await import('./claude.js');
const legacy = buildTurnPrefix({ actor: 'stan', memoryDir: mem, isTgOperator: true }).block;
ok('(a) with the flag off the prefix is unchanged (v3)', /## INDEX/.test(legacy) && /memory_grep/.test(legacy));

process.env.MEMORY_V4 = 'read';
const stan = buildTurnPrefix({ actor: 'stan', memoryDir: mem, isTgOperator: true }).block;
ok('(b) the product rules stay', /## How you talk/.test(stan) && /## Reply channels/.test(stan) && /## Security — untrusted content/.test(stan));
ok('(b) the v4 memory section replaces the v3 mechanics', /## Your memory/.test(stan) && !/## Card grammar/.test(stan) && !/## When to write, when to correct/.test(stan));
ok('(b) no INDEX, no RECENT tails', !/## INDEX/.test(stan) && !/## RECENT_/.test(stan) && !/boat/.test(stan));
ok('(b) identity and the team\'s rules load', /Name: Ada/.test(stan) && /Never deploy on Fridays/.test(stan));
ok('(b) the person\'s own profile loads', /Stan runs operations/.test(stan));
ok('(b) ...never a teammate\'s', !/interviewing/.test(stan) && !/cc Kasia/.test(stan));
ok('(b) routines come from routines.json, retired ones left out', /## ROUTINES/.test(stan) && /Morning brief — Summarise email at 8:00\./.test(stan) && !/Old duty/.test(stan));
ok('(b) the standing rules card is the person\'s rules channel', /## STANDING_RULES/.test(stan) && /\(2026-09-20\) Keep answers short\./.test(stan));
ok('(b) what is going on: live statuses and the digest, last of the extra cards', /## WHAT_IS_GOING_ON/.test(stan) && /Right now:\n- Stan is in Lisbon this week\. \(until /.test(stan) && /- Pinecrest \(active\): Kickoff scheduled for October\./.test(stan) && /- Old venture \(closed\)/.test(stan) && stan.indexOf('## STANDING_RULES') < stan.indexOf('## WHAT_IS_GOING_ON'), stan.slice(stan.indexOf('## WHAT_IS_GOING_ON'), stan.indexOf('## WHAT_IS_GOING_ON') + 300));
ok('(b) it is much smaller than today\'s', stan.length < legacy.length, { v4: stan.length, v3: legacy.length });

// The group's own digest (rendered from shared + the group) and a shared status.
mkdirSync(join(mem, 'groups', '-100777', 'views'), { recursive: true });
writeFileSync(join(mem, 'groups', '-100777', 'views', 'digest.json'), JSON.stringify({ at: '2026-09-21T04:00:00Z', items: [{ name: 'Northgate', state: 'closed', line: 'Ceased to exist on 2026-09-19.' }] }));
await L.append({ scope: 'shared', source: 'web', ts: '2026-09-21T11:00:00Z', text: 'Stan: office closed this week.', notes: [{ text: 'The office is closed this week.', kind: 'status', expires: soon }] });
const group = buildTurnPrefix({ actor: 'kasia', groupContext: true, groupId: '-100777', memoryDir: mem }).block;
ok('(c) a group turn loads no private card, not even the sender\'s', !/## USER_PROFILE/.test(group) && !/interviewing/.test(group) && !/## ROUTINES/.test(group) && !/Lisbon/.test(group) && !/Pinecrest/.test(group));
ok('(c) ...but what is going on for the group: its digest and the shared statuses', /## WHAT_IS_GOING_ON/.test(group) && /Northgate \(closed\): Ceased to exist on 2026-09-19\./.test(group) && /The office is closed this week\./.test(group), group.slice(group.indexOf('## WHAT_IS_GOING_ON'), group.indexOf('## WHAT_IS_GOING_ON') + 300));
ok('(c) ...and the group\'s own rules, no one\'s personal ones', /Answer in English in this group/.test(group) && !/cc Kasia/.test(group) && !/Keep answers short/.test(group));
const noGid = buildTurnPrefix({ actor: 'kasia', groupContext: true, memoryDir: mem }).block;
ok('(c) a group turn without a group id gets no rules card at all', !/## STANDING_RULES/.test(noGid));

const solo = buildTurnPrefix({ actor: 'default', memoryDir: mem }).block;
ok('(d) no actor in team mode is the primary admin', /Stan runs operations/.test(solo) && /Keep answers short/.test(solo));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));
writeFileSync(join(mem, 'USER_PROFILE.md'), '# USER_PROFILE\n\n- The solo owner runs everything.\n');
const soloFlat = buildTurnPrefix({ actor: 'default', memoryDir: mem }).block;
ok('(d) solo mode loads the owner\'s flat cards', /solo owner runs everything/.test(soloFlat) && /Keep answers short/.test(soloFlat), soloFlat.slice(-800));

console.log(`memory-prefix-v4: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
