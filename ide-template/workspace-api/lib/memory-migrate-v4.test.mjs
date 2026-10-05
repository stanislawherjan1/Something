/**
 * Guards for moving the old memory into v4 (migration 0005) and for the upgrade
 * banner's API and backups.
 *
 * What must hold: every claim lands in the scope it was in, dated; generated
 * files go, loaded cards stay byte-identical; duties leave only once they live in
 * routines.json; the move never runs by itself; only an admin starts it; after
 * it the deployment is on v4 and the old sweep stops; a backup download holds
 * only what its downloader may read (admins included), before and after the move;
 * rollback restores the old memory byte for byte; old archives are pruned.
 *
 * Run: node lib/memory-migrate-v4.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = mkdtempSync(join(tmpdir(), 'migrate-v4-'));
const STORE = mkdtempSync(join(tmpdir(), 'migrate-v4-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'shadow';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

// ─── a legacy tree ───────────────────────────────────────────────────────────
const mem = join(ROOT, 'memory');
const put = (rel, body) => { mkdirSync(join(mem, rel, '..'), { recursive: true }); writeFileSync(join(mem, rel), body); };
put('AGENT_IDENTITY.md', '# AGENT_IDENTITY\n\nName: Ada.\n');
put('RULES.md', '# RULES\n\n- Never deploy on Fridays.\n');
put('CHANNELS.md', '# CHANNELS\n');
put('TEAM.md', '# TEAM\n');
put('INDEX.md', '# INDEX\n\n- concepts/pinecrest.md\n');
put('RECENT_WEB.md', '# RECENT\n\nsomething\n');
put('concepts/pinecrest.md', [
  '---', 'title: Pinecrest', 'kind: concept', '---', '', 'Accreting claims about **Pinecrest**.', '', '## Claims',
  '- Pinecrest is our biggest client.  [Source: conversation, 2026-08-01]',
  '- Pinecrest renews in March.  [Source: conversation, 2026-08-15]',
  '- Pinecrest wants SSO.  [Source: conversation, 2026-09-02]',
  '- Pinecrest contact is Юрий.  [Source: conversation, 2026-09-03]',
  '- Pinecrest pays net 30.  [Source: conversation, 2026-09-04]',
  '- Pinecrest kickoff moved to Oct 3.  [Source: conversation, 2026-09-20]',
  '- Pinecrest demo went well.  [Source: conversation, 2026-09-10]',
  '', '## ## Contacts', '- Pinecrest CFO is Maria.', '',
  '<!-- example:', '- this commented example is not a claim', '-->', '',
].join('\n'));
put('topics/old-project.md', '# Old project\n\n- The old project was paused in May.\n');
put('patterns/weekly.md', '# Weekly\n\n- Status reports go out on Fridays.\n');
put('users/stan/USER_PROFILE.md', '# USER_PROFILE\n\n- Stan runs operations.\n');
put('users/stan/USER_PREFERENCES.md', '# USER_PREFERENCES\n\n- Short answers.\n');
put('users/stan/INDEX.md', '# USER_INDEX\n');
put('users/stan/RECENT_TELEGRAM.md', '# RECENT\n');
put('users/stan/USER_RELATIONSHIPS.md', '# USER_RELATIONSHIPS\n\n- Stan\'s sister is Ola.  [Source: conversation, 2026-07-01]\n');
put('users/stan/RESPONSIBILITIES.md', '# RESPONSIBILITIES\n\n- **Morning brief** — email at 8:00\n');
put('users/stan/concepts/private-thing.md', '---\ntitle: Private Thing\n---\n\n## Claims\n- Stan is considering a sabbatical.\n');
put('users/kasia/RESPONSIBILITIES.md', '# RESPONSIBILITIES\n\n- **Invoices** — on the 25th\n');
put('users/kasia/concepts/kasia-secret.md', '---\ntitle: Kasia Secret\n---\n\n## Claims\n- Kasia is interviewing elsewhere.\n');
put('_engine/log.jsonl', JSON.stringify({ op: 'remember', target: 'memory/users/kasia/concepts/kasia-secret.md', added: [{ line: 'Kasia is interviewing elsewhere.' }] }) + '\n');
const old = Date.parse('2026-06-01T00:00:00Z') / 1000;
utimesSync(join(mem, 'topics/old-project.md'), old, old);
mkdirSync(join(ROOT, '.team', 'users', 'stan'), { recursive: true });
writeFileSync(join(ROOT, '.team', 'users', 'stan', 'routines.json'), JSON.stringify({ version: 1, routines: [{ id: 'r_1', title: 'Morning brief', source: 'ui' }], unparsed: [] }));

const L = await import('./memory-ledger.js');
await L.append({ scope: 'user:stan', source: 'telegram', ts: '2026-09-25T10:00:00Z', text: 'Stan: filed during shadow mode.' });
const before = Object.fromEntries(['AGENT_IDENTITY.md', 'RULES.md', 'concepts/pinecrest.md', 'users/stan/USER_PROFILE.md', 'users/stan/RESPONSIBILITIES.md', 'users/kasia/concepts/kasia-secret.md']
  .map(f => [f, readFileSync(join(mem, f), 'utf8')]));

const migrate = await import('./migrate.js');
const mig = (await import('../migrations/0005-legacy-memory-to-ledger.mjs')).default;
const { pageRecords } = await import('../migrations/0005-legacy-memory-to-ledger.mjs');
const E = await import('./embedder-client.js');
E.configureEmbedder(async () => { throw new Error('none'); });

// ─── (a) pages → records ─────────────────────────────────────────────────────
const pr = pageRecords(readFileSync(join(mem, 'concepts/pinecrest.md'), 'utf8'), { title: 'pinecrest', mtime: Date.now() });
ok('(a) the page title comes from its frontmatter', pr.name === 'Pinecrest');
ok('(a) five claims per record, sections kept apart', pr.records.length === 3 && pr.records[0].notes.length === 5 && pr.records[1].notes.length === 2 && /Contacts/.test(pr.records[2].text), pr.records.map(r => r.text.slice(0, 60)));
ok('(a) a record is dated by its newest stamp', pr.records[0].ts.startsWith('2026-09-04') && pr.records[1].ts.startsWith('2026-09-20'), pr.records.map(r => r.ts));
ok('(a) stamps are dropped from the text, Cyrillic kept', !/\[Source/.test(pr.records[0].text) && /Юрий/.test(pr.records[0].text));
ok('(a) a commented-out example is not a claim', !pr.records.some(r => /commented example/.test(r.text)));

// ─── (b) never by itself ─────────────────────────────────────────────────────
const auto = await migrate.autoApply();
ok('(b) boot only reports the move', auto.pendingContent.includes('0005-legacy-memory-to-ledger') && !auto.failed.length && existsSync(join(mem, 'concepts/pinecrest.md')), auto);
ok('(b) mode stays shadow until the move', L.v4Mode() === 'shadow');

// ─── (c) the API ─────────────────────────────────────────────────────────────
const express = (await import('express')).default;
const router = (await import('../routes/migrations.js')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (email, method, path) => {
  const r = await fetch(base + path, { method, headers: email ? { 'x-test-actor': email } : {} });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const listTar = (buf) => {
  const f = join(STORE, `dl-${Math.random().toString(36).slice(2)}.tar.gz`);
  writeFileSync(f, buf);
  return spawnSync('tar', ['tzf', f], { encoding: 'utf8' }).stdout.split('\n').map(l => l.replace(/^\.\//, '')).filter(l => l && !l.endsWith('/'));
};

let r = await call('stan@example.test', 'GET', '/migrations/status');
ok('(c) the admin sees the move available and pending', r.body.memory.available === true && r.body.pending.some(p => p.id === '0005-legacy-memory-to-ledger'), r.body);
r = await call('kasia@example.test', 'GET', '/migrations/status');
ok('(c) a member sees it is coming, without the admin list', r.body.memory.available === true && r.body.pending === undefined);
r = await call('kasia@example.test', 'POST', '/migrations/0005-legacy-memory-to-ledger/start');
ok('(c) a member cannot start it', r.status === 403 && existsSync(join(mem, 'concepts/pinecrest.md')));

r = await call('kasia@example.test', 'GET', '/memory/backup');
let files = listTar(r.body);
ok('(c) a backup holds the shared tree and the person\'s own', files.includes('memory/concepts/pinecrest.md') && files.includes('memory/users/kasia/concepts/kasia-secret.md'), files);
ok('(c) ...never another person\'s tree, nor the engine log', !files.some(f => f.startsWith('memory/users/stan/')) && !files.some(f => f.startsWith('memory/_engine/')), files);
r = await call('stan@example.test', 'GET', '/memory/backup');
files = listTar(r.body);
ok('(c) an admin\'s backup is theirs, not the whole workspace', files.includes('memory/users/stan/USER_RELATIONSHIPS.md') && !files.some(f => f.startsWith('memory/users/kasia/')), files);

r = await call('stan@example.test', 'POST', '/migrations/0005-legacy-memory-to-ledger/start');
ok('(c) the admin starts it', r.status === 202);
let job;
for (let i = 0; i < 100; i++) {
  job = (await call('stan@example.test', 'GET', '/migrations/0005-legacy-memory-to-ledger/job')).body.job;
  if (job.state !== 'running') break;
  await new Promise(res => setTimeout(res, 50));
}
ok('(c) it finishes', job.state === 'done', job);

// ─── (d) after the move ──────────────────────────────────────────────────────
const shared = L.read({ scopes: ['shared'] });
const stanRecs = L.read({ scopes: ['user:stan'] });
const kasiaRecs = L.read({ scopes: ['user:kasia'] });
ok('(d) shared pages land in shared memory, as migration records', shared.filter(x => x.source === 'migration' && /Pinecrest/.test(x.text)).length === 3 && shared.some(x => /old project was paused/.test(x.text)) && shared.some(x => /Status reports go out on Fridays/.test(x.text)));
ok('(d) claims become the records\' notes', shared.flatMap(x => x.notes).some(n => n.text === 'Pinecrest renews in March.'));
ok('(d) an undated page is dated by its file', shared.find(x => /old project/.test(x.text)).ts.startsWith('2026-06-01'));
ok('(d) a person\'s pages and relationships land in their own scope', stanRecs.some(x => /sabbatical/.test(x.text)) && stanRecs.some(x => /sister is Ola/.test(x.text)) && kasiaRecs.some(x => /interviewing elsewhere/.test(x.text)));
ok('(d) nothing private crossed scopes', !shared.some(x => /sabbatical|interviewing|sister/.test(x.text)) && !stanRecs.some(x => /interviewing/.test(x.text)) && !kasiaRecs.some(x => /sabbatical/.test(x.text)));
ok('(d) what shadow mode filed is still there', stanRecs.some(x => /filed during shadow mode/.test(x.text)));
ok('(d) pages and generated files leave memory/', !existsSync(join(mem, 'concepts/pinecrest.md')) && !existsSync(join(mem, 'INDEX.md')) && !existsSync(join(mem, 'RECENT_WEB.md')) && !existsSync(join(mem, 'users/stan/INDEX.md')) && !existsSync(join(mem, 'users/stan/USER_RELATIONSHIPS.md')) && !existsSync(join(mem, 'patterns/weekly.md')));
ok('(d) loaded cards stay byte-identical', readFileSync(join(mem, 'AGENT_IDENTITY.md'), 'utf8') === before['AGENT_IDENTITY.md'] && readFileSync(join(mem, 'users/stan/USER_PROFILE.md'), 'utf8') === before['users/stan/USER_PROFILE.md'] && existsSync(join(mem, 'TEAM.md')));
const RS = await import('./routines-store.js');
ok('(d) duty cards leave once their duties live in routines.json', !existsSync(join(mem, 'users/stan/RESPONSIBILITIES.md')) && !existsSync(join(mem, 'users/kasia/RESPONSIBILITIES.md')));
ok('(d) ...including a duty written outside the card\'s sections', RS.readRoutines('kasia').routines.some(x => x.title === 'Invoices'), RS.readRoutines('kasia'));
ok('(d) the engine log is untouched', existsSync(join(mem, '_engine/log.jsonl')));
ok('(d) the deployment is on v4 now', L.v4Mode() === 'on');
process.env.MEMORY_V4 = 'off';
ok('(d) ...unless the operator\'s flag says off', L.v4Mode() === 'off');
process.env.MEMORY_V4 = 'shadow';
const { sweepIdle } = await import('./memory-sweep.js');
ok('(d) the old sweep stands down', (await sweepIdle({ force: true })).skipped === 'memory v4');
ok('(d) a second run has nothing to do', (await mig.check(await migrate.buildContext())).needed === false);
r = await call('kasia@example.test', 'GET', '/migrations/status');
ok('(d) the banner goes away', r.body.memory.migrated === true && r.body.memory.available === false);

r = await call('kasia@example.test', 'GET', '/memory/backup');
files = listTar(r.body);
ok('(d) the backup after the move is the OLD memory, still only the person\'s', files.includes('memory/users/kasia/concepts/kasia-secret.md') && files.includes('memory/concepts/pinecrest.md') && !files.some(f => f.startsWith('memory/users/stan/')) && !files.some(f => f.startsWith('memory/_engine/')), files);

// ─── (e) the operator's rollback, and the 30-day window ──────────────────────
await migrate.rollback('0005-legacy-memory-to-ledger');
ok('(e) rollback restores the old memory byte for byte', Object.entries(before).every(([f, body]) => existsSync(join(mem, f)) && readFileSync(join(mem, f), 'utf8') === body));
ok('(e) ...and the deployment is back in shadow', L.v4Mode() === 'shadow' && !L.read({ scopes: ['shared'] }).some(x => x.source === 'migration'));
await migrate.plan('0005-legacy-memory-to-ledger');
await migrate.apply('0005-legacy-memory-to-ledger');
const pruned = migrate.pruneBackups({ now: Date.now() + 31 * 86400_000 });
ok('(e) archives older than 30 days are pruned', pruned.length >= 1 && migrate.readState().applied['0005-legacy-memory-to-ledger'].backupPrunedAt);
r = await call('kasia@example.test', 'GET', '/memory/backup');
ok('(e) ...after which the old-memory download says so', r.status === 410);

server.close();
console.log(`memory-migrate-v4: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
