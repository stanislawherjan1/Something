/**
 * A new organisation is born on v4: the entrypoint stamps memory "fresh"
 * before seeding, and the first boot records every migration as done without
 * running one — so nobody is asked to "tidy" or "upgrade" cards they never
 * had, and the seeded templates stay as shipped. An older workspace (no fresh
 * stamp) keeps its migrations.
 *
 * Run: node lib/migrate-born-fresh.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'born-fresh-'));
const STORE = mkdtempSync(join(tmpdir(), 'born-fresh-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'on';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };

// What the entrypoint does on a new organisation: the stamp, then the seeds.
const TPL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bootstrap', 'memory-cards-templates');
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), JSON.stringify({ at: '2026-10-15T00:00:00Z', fresh: true }));
for (const f of readdirSync(TPL).filter((f) => f.endsWith('.md'))) writeFileSync(join(ROOT, 'memory', f), readFileSync(join(TPL, f)));
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([{ email: 'ola@example.test', role: 'admin', slug: 'ola', addedAt: '2026-10-01T00:00:00Z' }]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));
const rules = readFileSync(join(ROOT, 'memory', 'RULES.md'), 'utf8');

const migrate = await import('./migrate.js');
const all = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')).filter((f) => /^\d{4}-.*\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, ''));
const report = await migrate.autoApply();
ok('the first boot runs no migration', report.applied.length === 0 && report.pendingContent.length === 0, report);
const applied = migrate.readState().applied;
ok('...and records every one as done, so nothing asks for a review', all.every((id) => applied[id]?.appliedAt && applied[id].recordedFresh), { all, applied });
ok('the seeded cards stay as shipped', readFileSync(join(ROOT, 'memory', 'RULES.md'), 'utf8') === rules);
ok('a second boot has nothing to do', (await migrate.autoApply()).applied.length === 0);

console.log(`migrate-born-fresh: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
