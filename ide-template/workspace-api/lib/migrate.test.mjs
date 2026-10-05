/**
 * Guards for the migration framework and the first v4 migrations.
 *
 * What it must never do: run a content migration by itself; apply a plan made on
 * data that has changed since; leave a half-applied tree behind; lose a line of
 * the RESPONSIBILITIES card; touch anything on a deployment where MEMORY_V4 is off.
 *
 * Run: node lib/migrate.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'migrate-'));
const STORE = mkdtempSync(join(tmpdir(), 'migrate-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return null; } };
const snapshot = (dir) => {
  const out = {};
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) walk(r); else out[r] = readFileSync(join(ROOT, r), 'utf8');
    }
  };
  walk(dir);
  return out;
};

// ─── a two-person team with legacy cards ─────────────────────────────────────
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-1004242': { title: 'Team' } } }));
mkdirSync(join(ROOT, 'memory', 'users', 'stan'), { recursive: true });
mkdirSync(join(ROOT, 'memory', 'users', 'kasia'), { recursive: true });
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
const STAN_CARD = [
  '---', 'card: RESPONSIBILITIES', 'write_how: one flat list', '---', '', '# Responsibilities', '',
  '<!-- example: - {mail} **Inbox** — never parsed -->',
  '## Responsibilities',
  '- {mail} **Morning inbox pass** — each morning, flag what matters. #email',
  'calendar **Weekly review** — Fridays 17:00, summarise the week #review #weekly',
  '- ~~{bell} **Supplements ping** — daily at 8~~',
  'check the invoices sometimes',
  '', '## Boundaries', '- never send mail without approval', '',
].join('\n');
writeFileSync(join(ROOT, 'memory', 'users', 'stan', 'RESPONSIBILITIES.md'), STAN_CARD);
writeFileSync(join(ROOT, 'memory', '_engine', '.migrated-v3'), '2026-09-02\n');

const migrate = await import('./migrate.js');
const { parseLegacyCard, readRoutines } = await import('./routines-store.js');

// ─── (a) the legacy card grammar ─────────────────────────────────────────────
const parsed = parseLegacyCard(STAN_CARD);
ok('(a) three duties parsed (with and without list marker / braces)', parsed.routines.length === 3, parsed);
ok('(a) icon, title, description, tags', parsed.routines[1].icon === 'calendar' && parsed.routines[1].title === 'Weekly review'
  && parsed.routines[1].tags.join(',') === 'review,weekly' && parsed.routines[1].description.startsWith('Fridays 17:00'), parsed.routines[1]);
ok('(a) a struck-through duty is kept as retired', parsed.routines[2].retired === true && parsed.routines[2].title === 'Supplements ping');
ok('(a) a line the grammar cannot read is returned, not dropped', parsed.unparsed.includes('check the invoices sometimes'));
const stray = parseLegacyCard('# Responsibilities\n\nWhat I do for you.\n\n- {mail} **Email** — daily\n- call mum\n\n## Notes\n- {bell} **Invoices** — on the 25th\n\n## Responsibilities\n- {clock} **Brief** — 8:00\n');
ok('(a) a duty outside the duty sections is still a duty', ['Email', 'Invoices', 'Brief'].every(t => stray.routines.some(r => r.title === t)), stray);
ok('(a) ...another list item there is kept as unparsed, the intro prose is not', stray.unparsed.includes('- call mum') && !stray.unparsed.some(u => /What I do/.test(u)), stray.unparsed);
ok('(a) comments and Boundaries are not duties', !parsed.routines.some(r => /Inbox$|approval/.test(r.title)));

// ─── (b) MEMORY_V4 off: nothing v4 happens, legacy stamp recorded ─────────────
process.env.MEMORY_V4 = 'off';
let rep = await migrate.autoApply();
ok('(b) the legacy v3 stamp is recorded as applied, nothing re-run', rep.recorded.includes('0001-engine-v3') && rep.applied.length === 0, rep);
ok('(b) flag off: no ledger directories', !existsSync(join(ROOT, 'memory', 'ledger')));
ok('(b) flag off: no routines.json', !existsSync(join(ROOT, '.team', 'users', 'stan', 'routines.json')));

// ─── (c) MEMORY_V4 on: structural migrations run once, by themselves ─────────
process.env.MEMORY_V4 = 'shadow';
const cardBefore = read('memory/users/stan/RESPONSIBILITIES.md');
rep = await migrate.autoApply();
ok('(c) layout and routines applied at boot', rep.applied.includes('0003-v4-layout') && rep.applied.includes('0004-routines-json'), rep);
for (const d of ['memory/ledger', 'memory/users/stan/ledger', 'memory/users/kasia/ledger', 'memory/groups/-1004242/ledger', '.bot-state']) {
  ok(`(c) ${d} exists`, existsSync(join(ROOT, d)));
}
const r = readRoutines('stan');
ok('(c) stan\'s routines.json holds every duty', r.routines.length === 3 && r.routines.every(x => x.source === 'card' && /^r_[0-9a-f]{12}$/.test(x.id)), r);
ok('(c) ...and the unparsed line', r.unparsed.includes('check the invoices sometimes'));
ok('(c) the card is byte-identical (legacy still reads it)', read('memory/users/stan/RESPONSIBILITIES.md') === cardBefore);
ok('(c) someone without a card gets no file', !existsSync(join(ROOT, '.team', 'users', 'kasia', 'routines.json')));
const stateAfter = JSON.stringify(migrate.readState());
rep = await migrate.autoApply();
ok('(c) a second boot is a no-op', rep.applied.length === 0 && JSON.stringify(migrate.readState()) === stateAfter, rep);
ok('(c) verify passes', (await migrate.verify('0004-routines-json')).ok);
writeFileSync(join(ROOT, '.team', 'users', 'stan', 'routines.json'), '{ broken');
ok('(c) verify catches a corrupted routines.json', !(await migrate.verify('0004-routines-json')).ok);

// ─── (d) content migrations: plan, stale-plan refusal, backup, rollback ───────
const MDIR = mkdtempSync(join(tmpdir(), 'migrate-mods-'));
writeFileSync(join(MDIR, '0100-test-content.mjs'), `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id: '0100-test-content', title: 'test', kind: 'content',
  paths: () => ['memory/concepts'],
  check: (ctx) => ({ needed: !existsSync(join(ctx.projectDir, 'memory/concepts/new.md')), summary: 'x' }),
  plan: () => ({ summary: 'rewrite a page and add one', actions: [{ op: 'write', path: 'memory/concepts/new.md' }] }),
  apply: (ctx) => {
    writeFileSync(join(ctx.projectDir, 'memory/concepts/old.md'), 'REWRITTEN');
    writeFileSync(join(ctx.projectDir, 'memory/concepts/new.md'), 'NEW');
    return { changed: 2 };
  },
  verify: (ctx) => ({ ok: existsSync(join(ctx.projectDir, 'memory/concepts/new.md')), problems: [] }),
};`);
mkdirSync(join(ROOT, 'memory', 'concepts'), { recursive: true });
writeFileSync(join(ROOT, 'memory', 'concepts', 'old.md'), 'ORIGINAL');
const before = snapshot('memory/concepts');
rep = await migrate.autoApply({ dir: MDIR });
ok('(d) a content migration never runs at boot — it is reported', rep.pendingContent.includes('0100-test-content') && read('memory/concepts/old.md') === 'ORIGINAL', rep);
let err = null;
try { await migrate.apply('0100-test-content', { dir: MDIR }); } catch (e) { err = e.message; }
ok('(d) apply without a plan is refused', /no plan/.test(err || ''), err);
await migrate.plan('0100-test-content', { dir: MDIR });
writeFileSync(join(ROOT, 'memory', 'concepts', 'old.md'), 'EDITED AFTER THE PLAN');
err = null;
try { await migrate.apply('0100-test-content', { dir: MDIR }); } catch (e) { err = e.message; }
ok('(d) a plan made on other data is refused', /changed since the plan/.test(err || ''), err);
writeFileSync(join(ROOT, 'memory', 'concepts', 'old.md'), 'ORIGINAL');
await migrate.plan('0100-test-content', { dir: MDIR });
const res = await migrate.apply('0100-test-content', { dir: MDIR });
ok('(d) apply after a fresh plan works', read('memory/concepts/new.md') === 'NEW' && read('memory/concepts/old.md') === 'REWRITTEN');
ok('(d) a backup was taken first', res.backup && existsSync(res.backup), res);
await migrate.rollback('0100-test-content');
ok('(d) rollback restores the tree byte-identical (created file gone, edited file restored)',
  JSON.stringify(snapshot('memory/concepts')) === JSON.stringify(before), snapshot('memory/concepts'));
rep = await migrate.autoApply({ dir: MDIR });
ok('(d) a rolled-back migration is not re-offered by boot', !rep.pendingContent.includes('0100-test-content') && !rep.applied.includes('0100-test-content'), rep);

// ─── (e) a failing verify rolls back by itself ────────────────────────────────
writeFileSync(join(MDIR, '0101-test-bad.mjs'), `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id: '0101-test-bad', title: 'bad', kind: 'structural',
  paths: () => ['memory/concepts'],
  check: () => ({ needed: true, summary: 'x' }),
  plan: () => ({ summary: 'x', actions: [] }),
  apply: (ctx) => { writeFileSync(join(ctx.projectDir, 'memory/concepts/old.md'), 'BROKEN'); return { changed: 1 }; },
  verify: () => ({ ok: false, problems: ['deliberately bad'] }),
};`);
rep = await migrate.autoApply({ dir: MDIR });
ok('(e) a failing structural migration is reported, not thrown', rep.failed.some(f => f.id === '0101-test-bad'), rep);
ok('(e) ...and its changes were rolled back', read('memory/concepts/old.md') === 'ORIGINAL');

// ─── (f) a failed apply keeps its cause even when the restore complains ──────
// On the canary, memory/'s directories belong to another user: tar put every
// file back but could not set the directories' mode/mtime, exited non-zero, and
// the framework threw THAT — inside the catch — so the apply's own error was
// never recorded and the screen showed only tar's complaints.
writeFileSync(join(MDIR, '0102-test-throws.mjs'), `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id: '0102-test-throws', title: 'throws', kind: 'structural',
  paths: () => ['memory/concepts'],
  check: () => ({ needed: true, summary: 'x' }),
  plan: () => ({ summary: 'x', actions: [] }),
  apply: (ctx) => { writeFileSync(join(ctx.projectDir, 'memory/concepts/old.md'), 'HALF-WRITTEN'); throw new Error('the sorter timed out'); },
  verify: () => ({ ok: true, problems: [] }),
};`);
let thrown = null;
try { await migrate.apply('0102-test-throws', { dir: MDIR }); } catch (e) { thrown = e; }
const st = migrate.readState().applied['0102-test-throws'];
ok('(f) the apply\'s own error is what is recorded and thrown', /the sorter timed out/.test(st.error) && /the sorter timed out/.test(thrown?.message), { st, thrown: thrown?.message });
ok('(f) ...with the restore\'s outcome beside it, not in place of it', st.restored === true && /memory restored/.test(thrown.message) && read('memory/concepts/old.md') === 'ORIGINAL', st);
// tar's metadata-only complaints are not a failed restore; anything else is.
const { restore } = migrate._internals;
let restoreThrew = null;
try { restore({ archive: join(STORE, 'migrations', 'does-not-exist.tar.gz'), manifest: [], paths: [] }); } catch (e) { restoreThrew = e.message; }
ok('(f) a genuinely failed restore (missing archive) still throws', /restore failed/.test(restoreThrew || ''), restoreThrew);

console.log(`migrate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
