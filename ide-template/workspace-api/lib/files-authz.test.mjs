/**
 * The authorization matrix of the file routes: tree, read, search, write,
 * create, mkdir, move, delete, raw, download, lock and unlock — as the admin,
 * the owner, another member, a stranger and nobody. A private tree is its
 * owner's only (no admin bypass); a lock is read-only for everyone, admins
 * too, until unlocked; locking is an admin's; a search never surfaces another
 * person's private text.
 * Run: node lib/files-authz.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'files-authz-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'files-authz-store-'));
process.env.MEMORY_V4 = 'on';
mkdirSync(join(ROOT, '.team'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', slot: 1 },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', slot: 2 },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z', slot: 3 },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
const put = (p, text) => { mkdirSync(join(ROOT, p, '..'), { recursive: true }); writeFileSync(join(ROOT, p), text); };
put('users/ann/notes.md', 'ANN-SECRET-7 the raise');
put('users/bob/notes.md', 'BOB-SECRET-7 the offer');
put('memory/users/ann/x.md', 'ANN-MEMORY-7');
put('.team/users/ann/routines.json', '{"routines":[{"title":"ANN-ROUTINE-7"}]}');
put('Shared/policy.md', 'the policy');
put('Shared/open.md', 'open text');
put('Shared/Locked/inside.md', 'inside a locked folder');
put('memory/RULES.md', 'rules');
put('.claude/skills/team-howto/SKILL.md', '---\nname: team-howto\ndescription: the team way\n---\nsteps');
put('users/ann/.skills/ann-howto/SKILL.md', '---\nname: ann-howto\ndescription: Ann\'s way\n---\nANN-SKILL-7');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/files.js')).default());
app.use('/api', (await import('../routes/skills.js')).default());
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const WHO = { admin: 'stan@example.test', owner: 'ann@example.test', other: 'bob@example.test', stranger: 'zed@example.test', nobody: null };
const call = async (who, method, path, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (WHO[who]) headers['x-test-actor'] = WHO[who];
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
};
const refused = (s) => s === 401 || s === 403 || s === 404;
const SECRETS = ['ANN-SECRET-7', 'ANN-MEMORY-7', 'ANN-ROUTINE-7', 'BOB-SECRET-7'];

// ─── another person's trees: closed to everyone else, admins included ────────
for (const who of ['admin', 'other', 'stranger', 'nobody']) {
  for (const [method, path, body] of [
    ['GET', '/files/read?path=users/ann/notes.md'], ['GET', '/files/raw?path=users/ann/notes.md'], ['GET', '/files/download?path=users/ann/notes.md'],
    ['GET', '/files/tree?path=users/ann'], ['GET', '/files/read?path=memory/users/ann/x.md'], ['GET', '/files/read?path=.team/users/ann/routines.json'],
    ['POST', '/files/write', { path: 'users/ann/notes.md', content: 'x' }], ['POST', '/files/create', { path: 'users/ann/new.md' }], ['POST', '/files/mkdir', { path: 'users/ann/dir' }],
    ['POST', '/files/move', { from: 'users/ann/notes.md', to: 'Shared/stolen.md' }], ['DELETE', '/files/delete?path=users/ann/notes.md'],
  ]) {
    const r = await call(who, method, path, body);
    ok(`${who}: ${method} ${path.split('?')[0]} on Ann's tree is refused`, refused(r.status) && !SECRETS.some(s => r.text.includes(s)), { status: r.status, text: r.text.slice(0, 120) });
  }
}
ok('Ann\'s note is untouched', (await call('owner', 'GET', '/files/read?path=users/ann/notes.md')).body.content === 'ANN-SECRET-7 the raise');
// ─── the owner, and the shared space for members ─────────────────────────────
let r = await call('owner', 'GET', '/files/read?path=users/ann/notes.md'); ok('the owner reads their own', r.status === 200 && /ANN-SECRET-7/.test(r.text));
r = await call('owner', 'GET', '/files/tree?path=users/ann'); ok('...and lists it', r.status === 200);
r = await call('owner', 'POST', '/files/write', { path: 'users/ann/notes.md', content: 'ANN-SECRET-7 the raise, updated' }); ok('...and writes it', r.status === 200, r.body);
r = await call('other', 'GET', '/files/read?path=Shared/open.md'); ok('a member reads the shared space', r.status === 200);
r = await call('other', 'POST', '/files/write', { path: 'Shared/open.md', content: 'open text, edited' }); ok('...and writes an unlocked shared file', r.status === 200, r.body);
// ─── search: never another person's text ─────────────────────────────────────
for (const who of ['admin', 'other']) {
  for (const q of ['ANN-SECRET', 'raise', 'ANN-ROUTINE', 'ANN-MEMORY']) {
    const s = await call(who, 'GET', `/files/search?q=${q}`);
    ok(`${who}: a search for "${q}" surfaces nothing of Ann's`, s.status === 200 && !s.text.includes('users/ann') && !SECRETS.filter(x => x.startsWith('ANN')).some(x => s.text.includes(x)), s.text.slice(0, 200));
  }
}
const s = await call('owner', 'GET', '/files/search?q=ANN-SECRET'); ok('the owner\'s search finds their own', s.status === 200 && s.text.includes('users/ann'), s.text.slice(0, 200));
// ─── locks: an admin's to set; read-only for everyone until unlocked ─────────
for (const who of ['owner', 'other', 'stranger', 'nobody']) {
  const l = await call(who, 'POST', '/files/lock', { path: 'Shared/policy.md' });
  ok(`${who}: cannot lock`, refused(l.status), l.status);
}
r = await call('admin', 'POST', '/files/lock', { path: 'Shared/policy.md' }); ok('the admin locks a shared file', r.status === 200, r.body);
r = await call('admin', 'POST', '/files/lock', { path: 'Shared/Locked' }); ok('...and a folder', r.status === 200, r.body);
r = await call('admin', 'POST', '/files/lock', { path: 'users/ann/notes.md' }); ok('a lock on a private path is refused', refused(r.status) || r.status === 400, r.status);
for (const who of ['admin', 'owner', 'other']) {
  for (const [method, path, body] of [
    ['POST', '/files/write', { path: 'Shared/policy.md', content: 'changed' }], ['DELETE', '/files/delete?path=Shared/policy.md'], ['POST', '/files/move', { from: 'Shared/policy.md', to: 'Shared/p2.md' }],
    ['POST', '/files/write', { path: 'Shared/Locked/inside.md', content: 'changed' }], ['POST', '/files/create', { path: 'Shared/Locked/new.md' }], ['POST', '/files/move', { from: 'Shared/Locked', to: 'Shared/Moved' }], ['DELETE', '/files/delete?path=Shared/Locked'],
    ['POST', '/files/move', { from: 'Shared', to: 'Elsewhere' }],
  ]) {
    const x = await call(who, method, path, body);
    ok(`${who}: ${method} ${path.split('?')[0]} ${body?.path || body?.from || path.split('=').pop()} under a lock is refused`, x.status === 403 && /[Ll]ocked/.test(x.text), { status: x.status, text: x.text.slice(0, 120) });
  }
  const rd = await call(who, 'GET', '/files/read?path=Shared/policy.md'); ok(`${who}: still reads the locked file`, rd.status === 200 && rd.body.content === 'the policy');
}
for (const who of ['owner', 'other']) { const u = await call(who, 'POST', '/files/unlock', { path: 'Shared/policy.md' }); ok(`${who}: cannot unlock`, refused(u.status), u.status); }
r = await call('admin', 'POST', '/files/unlock', { path: 'Shared/policy.md' }); ok('the admin unlocks', r.status === 200, r.body);
r = await call('other', 'POST', '/files/write', { path: 'Shared/policy.md', content: 'the policy, revised' }); ok('...and the file is writable again, by a member too', r.status === 200, r.body);
r = await call('other', 'GET', '/files/locks'); ok('a member sees the locks but may not manage them', r.status === 200 && r.body.canManage === false && (r.body.locks || []).some(l => l.path === 'Shared/Locked'), r.body);
// ─── nobody and a stranger: nothing at all ───────────────────────────────────
for (const who of ['stranger', 'nobody']) for (const path of ['/files/tree', '/files/read?path=Shared/open.md', '/files/search?q=open', '/files/locks']) {
  const x = await call(who, 'GET', path); ok(`${who}: ${path.split('?')[0]} is refused`, refused(x.status), x.status);
}

// ─── skills: the team's are an admin's; a person's own are theirs alone ──────
r = await call('owner', 'POST', '/files/write', { path: '.claude/skills/team-howto/SKILL.md', content: 'changed' });
ok('a member cannot change a team skill', r.status === 403, r.status);
r = await call('owner', 'POST', '/files/create', { path: '.claude/skills/new/SKILL.md' });
ok('...nor add one', r.status === 403, r.status);
r = await call('owner', 'POST', '/files/write', { path: '.claude/CLAUDE.md', content: 'x' });
ok('...nor change the team\'s instructions', r.status === 403, r.status);
r = await call('owner', 'POST', '/files/write', { path: 'users/ann/.skills/ann-howto/SKILL.md', content: '---\nname: ann-howto\ndescription: Ann\'s way\n---\nANN-SKILL-7 v2' });
ok('a member changes a skill of their own', r.status === 200, r.body);
r = await call('admin', 'POST', '/files/write', { path: '.claude/skills/team-howto/SKILL.md', content: '---\nname: team-howto\ndescription: the team way\n---\nsteps v2' });
ok('an admin changes a team skill', r.status === 200, r.body);
let sk = await call('owner', 'GET', '/skills');
ok('Ann\'s list: the team\'s skill read-only, her own editable', (sk.body.skills || []).some(x => x.name === 'team-howto' && x.scope === 'team' && x.editable === false) && (sk.body.skills || []).some(x => x.name === 'ann-howto' && x.scope === 'personal' && x.editable === true), sk.body.skills);
sk = await call('other', 'GET', '/skills');
ok('Bob\'s list has none of Ann\'s', !(sk.body.skills || []).some(x => x.name === 'ann-howto'), sk.body.skills?.map(x => x.name));
sk = await call('admin', 'GET', '/skills');
ok('the admin\'s list has none of Ann\'s either, and the team\'s skill is editable', !(sk.body.skills || []).some(x => x.name === 'ann-howto') && (sk.body.skills || []).some(x => x.name === 'team-howto' && x.editable === true), sk.body.skills?.map(x => [x.name, x.editable]));
r = await call('owner', 'GET', '/skills/raw?name=ann-howto&origin=personal');
ok('Ann opens her own skill', r.status === 200 && /ANN-SKILL-7/.test(r.text));
r = await call('other', 'GET', '/skills/raw?name=ann-howto&origin=personal');
ok('Bob asking for "ann-howto" among his own finds nothing of Ann\'s', r.status === 404 && !/ANN-SKILL/.test(r.text), r.status);

server.close();
console.log(`files-authz: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
