/**
 * Locks: an admin marks a shared file or folder read-only for members. The
 * rule (scope-rule.js pathWritable), the store (lib/locks.js) and the file
 * routes' answers. Run: node lib/locks.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'locks-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'locks-store-'));
mkdirSync(join(ROOT, 'plans'), { recursive: true });
mkdirSync(join(ROOT, 'users', 'ann'), { recursive: true });
mkdirSync(join(ROOT, '.team'), { recursive: true });
writeFileSync(join(ROOT, 'plans', 'q4.md'), '# Q4\n');
writeFileSync(join(ROOT, 'plans', 'notes.md'), 'notes\n');
writeFileSync(join(ROOT, 'brief.md'), 'brief\n');
writeFileSync(join(ROOT, 'users', 'ann', 'mine.md'), 'mine\n');
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const R = await import('./scope-rule.js');
const L = await import('./locks.js');

// ─── the rule ────────────────────────────────────────────────────────────────
const locks = { 'plans': { by: 'stan', at: 't' }, 'brief.md': { by: 'stan', at: 't' } };
ok('a locked file is read-only for a member', R.pathWritable('brief.md', { ownSlug: 'ann', locks }).why === 'locked');
ok('a folder lock covers everything under it', R.pathWritable('plans/q4.md', { ownSlug: 'ann', locks }).lock?.inherited === true);
ok('...and the folder itself', R.pathWritable('plans', { ownSlug: 'ann', locks }).lock?.inherited === false);
ok('an admin is read-only under a lock too', R.pathWritable('plans/q4.md', { ownSlug: 'stan', isAdmin: true, locks }).why === 'locked');
ok('an unlocked shared path is writable', R.pathWritable('other.md', { ownSlug: 'ann', locks }).ok);
ok('a private tree is still the scope rule\'s, not a lock\'s', R.pathWritable('users/bob/x.md', { ownSlug: 'ann', locks }).why === 'scope');
ok('the covering lock is found through dot and double segments', R.lockCovering('plans//./q4.md', locks)?.path === 'plans');
ok('a look-alike prefix is not covered', R.lockCovering('plans2/x.md', locks) === null);

// ─── the store ───────────────────────────────────────────────────────────────
let err = null;
try { L.lock('users/ann', 'stan'); } catch (e) { err = e.message; }
ok('a private path cannot be locked', /shared/.test(err), err);
err = null; try { L.lock('', 'stan'); } catch (e) { err = e.message; }
ok('nor the root', /root/.test(err), err);
err = null; try { L.lock('nowhere.md', 'stan'); } catch (e) { err = e.message; }
ok('nor a path that is not there', /exist/.test(err), err);
L.lock('plans', 'stan');
L.lock('brief.md', 'stan');
ok('locks are stored under .team, group-readable', existsSync(join(ROOT, '.team', 'locks.json')) && Object.keys(JSON.parse(readFileSync(join(ROOT, '.team', 'locks.json'), 'utf8'))).length === 2);
ok('the list says who and when, and whether the path is still there', L.list().every(l => l.by === 'stan' && l.at && l.exists === true));
ok('a covering lock is found from the store', L.covering('plans/notes.md')?.path === 'plans' && L.covering('other.md') === null);
writeFileSync(join(ROOT, '.team', 'locks.json'), JSON.stringify({ ...L.readLocks(), 'gone.md': { by: 'stan', at: 't' } }));
ok('a stale lock is listed as such and never covers anything', L.list().find(l => l.path === 'gone.md')?.exists === false && L.covering('gone.md') === null);
L.lock('plans/notes.md', 'stan'); L.unlock('plans/notes.md');
ok('...and is dropped on the next write', !L.list().some(l => l.path === 'gone.md'));

// ─── the routes ──────────────────────────────────────────────────────────────
const filesRouter = (await import('../routes/files.js')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', filesRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (who, method, path, body) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-actor': who }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let r = await call('ann@example.test', 'POST', '/files/write', { path: 'plans/q4.md', content: 'x' });
ok('a member cannot write under a locked folder', r.status === 403 && /Locked by Stan\. Read-only until an admin unlocks it\./.test(r.body.error), r);
r = await call('ann@example.test', 'POST', '/files/create', { path: 'plans/new.md', content: '' });
ok('...nor create there', r.status === 403);
r = await call('ann@example.test', 'POST', '/files/move', { from: 'plans/notes.md', to: 'notes.md' });
ok('...nor move out of it', r.status === 403);
r = await call('ann@example.test', 'POST', '/files/move', { from: 'users/ann/mine.md', to: 'plans/mine.md' });
ok('...nor into it', r.status === 403);
r = await call('ann@example.test', 'DELETE', '/files/delete?path=brief.md');
ok('...nor delete a locked file', r.status === 403 && existsSync(join(ROOT, 'brief.md')));
r = await call('ann@example.test', 'GET', '/files/read?path=brief.md');
ok('...but can read it', r.status === 200);
r = await call('ann@example.test', 'GET', '/files/tree?path=plans');
ok('the tree marks what a lock covers, with the admin\'s name', r.body.entries.every(e => e.locked?.path === 'plans' && e.locked.byName === 'Stan' && e.locked.inherited === true), r.body);
r = await call('ann@example.test', 'GET', '/files/tree');
ok('...the locked item itself as its own lock', r.body.entries.find(e => e.name === 'plans')?.locked?.inherited === false && !r.body.entries.find(e => e.name === 'users')?.locked);
r = await call('stan@example.test', 'POST', '/files/write', { path: 'plans/q4.md', content: '# Q4 v2\n' });
ok('an admin is refused under a lock as well', r.status === 403);
r = await call('stan@example.test', 'DELETE', '/files/delete?path=plans');
ok('...and cannot delete the locked folder', r.status === 403 && existsSync(join(ROOT, 'plans')));
mkdirSync(join(ROOT, 'wrap'), { recursive: true }); mkdirSync(join(ROOT, 'wrap', 'inner'), { recursive: true }); writeFileSync(join(ROOT, 'wrap', 'inner', 'a.md'), 'a');
L.lock('wrap/inner', 'stan');
r = await call('stan@example.test', 'DELETE', '/files/delete?path=wrap');
ok('a folder with a locked item inside cannot be deleted', r.status === 403 && /inside it is locked/.test(r.body.error), r);
r = await call('stan@example.test', 'POST', '/files/move', { from: 'wrap', to: 'wrapped' });
ok('...nor moved', r.status === 403);
L.unlock('wrap/inner');
r = await call('ann@example.test', 'POST', '/files/lock', { path: 'brief.md' });
ok('a member cannot lock', r.status === 403);
r = await call('ann@example.test', 'POST', '/files/unlock', { path: 'brief.md' });
ok('...nor unlock', r.status === 403 && L.covering('brief.md'));
r = await call('stan@example.test', 'POST', '/files/move', { from: 'plans', to: 'planning' });
ok('a locked folder cannot be renamed, by an admin either', r.status === 403 && L.covering('plans/q4.md')?.path === 'plans', L.list());
r = await call('stan@example.test', 'GET', '/files/locks');
ok('the admin\'s list shows every lock with names', r.body.canManage === true && r.body.locks.some(l => l.path === 'plans' && l.byName === 'Stan'), r.body);
r = await call('stan@example.test', 'POST', '/files/unlock', { path: 'plans' });
ok('an admin unlocks', r.body.removed === true && L.covering('plans/q4.md') === null);
r = await call('ann@example.test', 'POST', '/files/write', { path: 'plans/q4.md', content: 'now mine too' });
ok('...and a member can write there again', r.status === 200);
r = await call('stan@example.test', 'POST', '/files/move', { from: 'plans', to: 'planning' });
ok('...and an admin can rename it', r.status === 200);
r = await call('stan@example.test', 'DELETE', '/files/delete?path=brief.md');
ok('a locked file cannot be deleted until unlocked', r.status === 403 && existsSync(join(ROOT, 'brief.md')));
server.close();

console.log(`locks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
