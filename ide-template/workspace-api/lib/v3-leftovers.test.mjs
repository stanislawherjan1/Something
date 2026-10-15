/**
 * The older memory's leftovers: a workspace still on it keeps them all (its
 * memory reads them), and once it moves to v4 they are archived and removed
 * (0008) and the processes that wrote them stop bringing them back.
 * Run: node lib/v3-leftovers.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'v3-left-'));
const STORE = mkdtempSync(join(tmpdir(), 'v3-left-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'shadow';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};
const abs = (p) => join(ROOT, p);
const put = (p, text = '# x\n') => { mkdirSync(join(abs(p), '..'), { recursive: true }); writeFileSync(abs(p), text); };

writeFileSync(abs('.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(abs('.team-config.json'), JSON.stringify({ teamMode: true }));
mkdirSync(abs('memory/_engine'), { recursive: true });
const LEFT = ['memory/RECENT_WEB.md', 'memory/TEAM.md', 'memory/INDEX.md', 'memory/USER_RELATIONSHIPS.md', 'memory/USER_REFLECTIONS.md',
  'memory/.dedupe-report.json', 'memory/_engine/.swept.json', 'memory/patterns/p.md',
  'memory/users/stan/RECENT_TELEGRAM.md', 'memory/users/stan/RECENT_WEB.md', 'memory/users/stan/USER_REFLECTIONS.md', 'memory/users/stan/RESPONSIBILITIES.md',
  'memory/users/ann/USER_RELATIONSHIPS.md'];
for (const p of LEFT) put(p);
put('memory/users/ann/RESPONSIBILITIES.md', '# RESPONSIBILITIES\n- **Inbox** — check mail daily #mail\n');   // no routines.json yet
put('.team/users/stan/routines.json', JSON.stringify({ routines: [] }));
// Dee had a routine from the screen before the move AND a real duty only on the card: 0004 skipped her (routines.json existed).
put('memory/users/dee/RESPONSIBILITIES.md', '# RESPONSIBILITIES\n\n## Responsibilities\n- {mail} **Weekly invoices** — every Monday, chase unpaid invoices #finance\n');
put('.team/users/dee/routines.json', JSON.stringify({ routines: [{ id: 'r1', title: 'Morning brief', description: 'x' }] }));
// A member seeded the bare template at join and never had a duty: nothing to carry over.
put('memory/users/bo/RESPONSIBILITIES.md', readFileSync(new URL('../../bootstrap/memory-cards-templates/RESPONSIBILITIES.md', import.meta.url), 'utf8'));
const KEEP = ['memory/RULES.md', 'memory/MISSION.md', 'memory/AGENT_IDENTITY.md', 'memory/users/stan/USER_PROFILE.md', 'memory/users/stan/USER_PREFERENCES.md', 'memory/users/stan/facts.jsonl', 'memory/ledger/2026-10.jsonl'];
for (const p of KEEP) put(p);

const migrate = await import('./migrate.js');
const snap = await import('./recent-snapshot.js');
const team = await import('./team.js');

// ─── (a) still on the older memory: nothing goes, the writers still write ───
let rep = await migrate.autoApply();
ok('(a) 0008 does not run before the move', !rep.applied.includes('0008-retire-v3-leftovers'), rep);
ok('(a) ...every file is still there', [...LEFT, ...KEEP].every(p => existsSync(abs(p))), [...LEFT, ...KEEP].filter(p => !existsSync(abs(p))));
team.writeTeamRoster();
ok('(a) the roster card is still written', existsSync(abs('memory/TEAM.md')));
const w = snap.writeRecentSnapshot({ channel: 'web' });
ok('(a) the recent tails are still written', !w.skipped, w);

// ─── (b) the move: archived and gone, once ──────────────────────────────────
writeFileSync(abs('memory/_engine/.v4-migrated'), '{}');
rep = await migrate.autoApply();
ok('(b) 0008 runs once the stamp is there', rep.applied.includes('0008-retire-v3-leftovers'), rep);
for (const p of LEFT) ok(`(b) ${p} is gone`, !existsSync(abs(p)));
ok('(b) what v4 reads is untouched', KEEP.every(p => existsSync(abs(p))), KEEP.filter(p => !existsSync(abs(p))));
ok('(b) a bare duties template goes too', !existsSync(abs('memory/users/bo/RESPONSIBILITIES.md')));
ok('(b) a card with a duty the routines do not hold stays (nothing is lost)', existsSync(abs('memory/users/dee/RESPONSIBILITIES.md')));
ok('(b) a duties card goes only after 0004 carried it into routines', !existsSync(abs('memory/users/ann/RESPONSIBILITIES.md')) && /Inbox/.test(readFileSync(abs('.team/users/ann/routines.json'), 'utf8')));
const archives = readdirSync(join(STORE, 'migrations')).filter(f => f.startsWith('0008-v3-leftovers-') && f.endsWith('.tar.gz'));
ok('(b) the leftovers are in one archive in the store', archives.length === 1, readdirSync(join(STORE, 'migrations')));
ok('(b) verify passes', (await migrate.verify('0008-retire-v3-leftovers')).ok);
rep = await migrate.autoApply();
ok('(b) a second boot is a no-op', !rep.applied.includes('0008-retire-v3-leftovers'), rep);

// ─── (c) the writers stop bringing them back ────────────────────────────────
team.writeTeamRoster();
ok('(c) no roster card after the move', !existsSync(abs('memory/TEAM.md')));
put('memory/users/stan/RECENT_WEB.md');
const s = snap.writeRecentSnapshot({ channel: 'web' });
ok('(c) no recent tail is written', s.skipped === 'memory v4' && !existsSync(abs('memory/RECENT_WEB.md')), s);
ok('(c) ...and one left over is removed', !existsSync(abs('memory/users/stan/RECENT_WEB.md')));
ok('(c) the tail is rendered on demand instead (empty without messages)', snap.renderRecent({ channel: 'web', slug: 'stan' }) === '');
team.add({ email: 'cy@example.test', role: 'member', actor: 'stan@example.test' });
ok('(c) a new teammate gets no duties card', !existsSync(abs('memory/users/cy/RESPONSIBILITIES.md')));

console.log(`v3-leftovers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
