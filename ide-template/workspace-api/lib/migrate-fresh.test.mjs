/**
 * A fresh workspace starts on memory v4 by itself: the image seeds a few card
 * templates and two ABOUT pages; nobody wrote them, so the move (0005) has
 * nothing to review and boot applies it — stamp, templates gone, loaded cards
 * kept. The moment anything carries a person's words, the move waits for an
 * admin as before.
 *
 * Run: node lib/migrate-fresh.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'migrate-fresh-'));
const STORE = mkdtempSync(join(tmpdir(), 'migrate-fresh-store-'));
const TPL = mkdtempSync(join(tmpdir(), 'migrate-fresh-tpl-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_TEMPLATES_DIR = TPL;
process.env.MEMORY_V4 = 'shadow';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

// The shipped templates, and a solo workspace seeded from them byte for byte.
const put = (dir, rel, body) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), body); };
const templates = {
  'RULES.md': '---\ncard: RULES\n---\n\n# RULES\n\n<!-- hard rules -->\n',
  'USER_PROFILE.md': '---\ncard: USER_PROFILE\n---\n\n# USER_PROFILE\n',
  'USER_REFLECTIONS.md': '---\ncard: USER_REFLECTIONS\n---\n\n# USER_REFLECTIONS\n\n<!-- lessons -->\n',
  'USER_RELATIONSHIPS.md': '---\ncard: USER_RELATIONSHIPS\n---\n\n# USER_RELATIONSHIPS\n\n<!-- people -->\n',
  'RECENT_WEB.md': '# RECENT_WEB\n',
  'topics/ABOUT.md': '# About topics\n\nLong-form pages live here.\n',
  'patterns/ABOUT.md': '# About patterns\n\nRecurring mistakes live here.\n',
};
for (const [rel, body] of Object.entries(templates)) { put(TPL, rel, body); put(join(ROOT, 'memory'), rel, body); }
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([{ email: 'ola@example.test', role: 'admin', slug: 'ola', addedAt: '2026-10-01T00:00:00Z' }]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));

const migrate = await import('./migrate.js');
const M = (await import('../migrations/0005-legacy-memory-to-ledger.mjs')).default;
const ctx = await migrate.buildContext();

ok('untouched templates are views: nothing to move', M.trivial(ctx) === true && M.plan(ctx).actions.every(a => a.op === 'remove'), M.plan(ctx));
ok('check says so in words', /nothing to move/.test(M.check(ctx).summary), M.check(ctx));

const auto = await migrate.autoApply();
ok('boot applies the move by itself on a fresh workspace', auto.applied.includes('0005-legacy-memory-to-ledger') && !auto.pendingContent.includes('0005-legacy-memory-to-ledger'), auto);
ok('the deployment is on v4', existsSync(join(ROOT, 'memory', '_engine', '.v4-migrated')));
ok('the loaded cards stay byte for byte', readFileSync(join(ROOT, 'memory', 'RULES.md'), 'utf8') === templates['RULES.md'] && readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), 'utf8') === templates['USER_PROFILE.md']);
const ledgerFiles = (dir) => { try { return readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; } };
ok('the unedited templates and pages are gone, with no record made of them', !existsSync(join(ROOT, 'memory', 'USER_REFLECTIONS.md')) && !existsSync(join(ROOT, 'memory', 'topics', 'ABOUT.md')) && ledgerFiles(join(ROOT, 'memory', 'ledger')).length === 0 && ledgerFiles(join(ROOT, 'memory', 'users', 'ola', 'ledger')).length === 0, { auto, shared: ledgerFiles(join(ROOT, 'memory', 'ledger')) });
const state = migrate.readState().applied['0005-legacy-memory-to-ledger'];
ok('recorded like any apply, with its backup', state?.appliedAt && state.backup, state);
ok('a second boot has nothing to do', (await migrate.autoApply()).applied.length === 0);

// ─── one edited card, and the move waits for a person again ──────────────────
const ROOT2 = mkdtempSync(join(tmpdir(), 'migrate-fresh2-'));
const STORE2 = mkdtempSync(join(tmpdir(), 'migrate-fresh2-store-'));
process.env.PROJECT_DIR = ROOT2;
process.env.WSAPI_STORE_DIR = STORE2;
for (const [rel, body] of Object.entries(templates)) put(join(ROOT2, 'memory'), rel, body);
put(join(ROOT2, 'memory'), 'USER_RELATIONSHIPS.md', templates['USER_RELATIONSHIPS.md'] + '\n## Marek\n- Marek is the CTO at Quillwork.\n');
writeFileSync(join(ROOT2, '.allowed-emails.json'), JSON.stringify([{ email: 'ola@example.test', role: 'admin', slug: 'ola', addedAt: '2026-10-01T00:00:00Z' }]));
writeFileSync(join(ROOT2, '.team-config.json'), JSON.stringify({ teamMode: false }));
const ctx2 = await migrate.buildContext();
ok('a card someone wrote in is content: not trivial', M.trivial(ctx2) === false && M.plan(ctx2).actions.some(a => a.op === 'move' && a.path === 'memory/USER_RELATIONSHIPS.md'), M.plan(ctx2).actions);
const auto2 = await migrate.autoApply();
ok('boot leaves it for an admin', auto2.pendingContent.includes('0005-legacy-memory-to-ledger') && !auto2.applied.includes('0005-legacy-memory-to-ledger'), auto2);
ok('nothing moved, no stamp', existsSync(join(ROOT2, 'memory', 'USER_RELATIONSHIPS.md')) && !existsSync(join(ROOT2, 'memory', '_engine', '.v4-migrated')));
let refused = null;
try { await migrate.apply('0005-legacy-memory-to-ledger', { auto: true }); } catch (e) { refused = e.message; }
ok('and an automatic apply is refused outright', /never runs by itself/.test(refused || ''), refused);

// ─── the kill switch still wins ──────────────────────────────────────────────
process.env.MEMORY_V4 = 'off';
const ROOT3 = mkdtempSync(join(tmpdir(), 'migrate-fresh3-'));
process.env.PROJECT_DIR = ROOT3;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'migrate-fresh3-store-'));
for (const [rel, body] of Object.entries(templates)) put(join(ROOT3, 'memory'), rel, body);
writeFileSync(join(ROOT3, '.allowed-emails.json'), '[]');
writeFileSync(join(ROOT3, '.team-config.json'), JSON.stringify({ teamMode: false }));
const auto3 = await migrate.autoApply();
ok('MEMORY_V4=off: a fresh workspace is left alone', !auto3.applied.includes('0005-legacy-memory-to-ledger') && !existsSync(join(ROOT3, 'memory', '_engine', '.v4-migrated')), auto3);

for (const d of [ROOT, STORE, TPL, ROOT2, STORE2, ROOT3]) rmSync(d, { recursive: true, force: true });
console.log(`migrate-fresh: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
