/**
 * Files shared by link, through the real routes: who can share which file,
 * what anyone with the link sees (name and current text, never the path),
 * who can end a link, and the admin's switch for the whole workspace.
 * A private tree stays its owner's: nobody else, admin included, can share it,
 * list its link or end it.
 *
 * Run: node lib/shares.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'shares-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'shares-store-'));
process.env.SHARE_PUBLIC_PER_MIN = '1000';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
const put = (p, text) => { mkdirSync(join(ROOT, p, '..'), { recursive: true }); writeFileSync(join(ROOT, p), text); };
put('Shared/plan.md', '# Plan\n\nLaunch on Friday.');
put('Shared/data.csv', 'a,b');
put('users/ann/notes.md', 'ANN-PRIVATE-9 the raise');
put('memory/RULES.md', 'rules');
put('.claude/CLAUDE.md', 'instructions');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/shares.js')).default());
app.use('/api', (await import('../routes/internal.js')).default());
const ti = await import('./turn-identity.js');
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const WHO = { admin: 'stan@example.test', ann: 'ann@example.test', bob: 'bob@example.test', stranger: 'zed@example.test', nobody: null };
const call = async (who, method, path, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (WHO[who]) headers['x-test-actor'] = WHO[who];
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
};

// ── sharing a team file ──────────────────────────────────────────────────────
let r = await call('bob', 'POST', '/shares', { path: 'Shared/plan.md' });
ok('a member shares a team file', r.status === 200 && /^[A-Za-z0-9_-]{20,}$/.test(r.body.token), r.body);
const planToken = r.body.token;
r = await call('ann', 'POST', '/shares', { path: '/Shared/plan.md' });
ok('sharing it again gives the same link', r.status === 200 && r.body.token === planToken, r.body);

let pub = await call('nobody', 'GET', `/public/share/${planToken}`);
ok('anyone with the link reads the name and text', pub.status === 200 && pub.body.name === 'plan.md' && pub.body.content.includes('Launch on Friday.'), pub.body);
ok('...never the path', !pub.text.includes('Shared/'), pub.text);
ok('...not to be indexed or cached', /noindex/.test(pub.headers.get('x-robots-tag') || '') && pub.headers.get('cache-control') === 'no-store');
put('Shared/plan.md', '# Plan\n\nLaunch moved to Monday.');
pub = await call('nobody', 'GET', `/public/share/${planToken}`);
ok('the link shows the file as it is now', pub.body.content.includes('Monday') && !pub.body.content.includes('Friday'), pub.body);

// ── what can't be shared ─────────────────────────────────────────────────────
for (const [who, path, why] of [
  ['bob', 'users/ann/notes.md', "another person's private file"],
  ['admin', 'users/ann/notes.md', "another person's private file, by an admin"],
  ['admin', 'memory/RULES.md', 'a memory file'],
  ['admin', '.claude/CLAUDE.md', 'a hidden folder'],
  ['admin', 'Shared/data.csv', 'a file that is not Markdown'],
  ['admin', 'Shared/missing.md', 'a file that does not exist'],
  ['admin', '../outside.md', 'a path outside the workspace'],
  ['stranger', 'Shared/plan.md', 'someone not on the team'],
  ['nobody', 'Shared/plan.md', 'someone not signed in'],
]) {
  r = await call(who, 'POST', '/shares', { path });
  ok(`refused: ${why}`, r.status === 401 || r.status === 403, r.body);
}

// ── a private file: its owner's to share, nobody else's to see or end ────────
r = await call('ann', 'POST', '/shares', { path: 'users/ann/notes.md' });
ok('the owner shares her private file', r.status === 200 && r.body.token, r.body);
const annToken = r.body.token;
pub = await call('nobody', 'GET', `/public/share/${annToken}`);
ok('...anyone with the link reads it, without whose it is', pub.body.content?.includes('ANN-PRIVATE-9') && !pub.text.includes('users/ann'), pub.text);
r = await call('admin', 'GET', '/shares');
ok("an admin's list has the team file's link, not her private one", r.body.links.some((l) => l.token === planToken) && !r.body.links.some((l) => l.token === annToken), r.body);
r = await call('bob', 'GET', '/shares');
ok("a member's list has the links he made", r.body.links.length === 1 && r.body.links[0].token === planToken, r.body);
r = await call('admin', 'DELETE', `/shares/${annToken}`);
ok("an admin can't end a link to someone's private file", r.status === 403);
r = await call('admin', 'GET', `/shares/${annToken}/open`);
ok("...nor learn which file it is", r.status === 403 && !r.text.includes('users/ann'), r.text);
r = await call('ann', 'GET', `/shares/${annToken}/open`);
ok('the owner, signed in, is sent to the file', r.status === 200 && r.body.path === 'users/ann/notes.md', r.body);
r = await call('bob', 'GET', '/shares?path=users/ann/notes.md');
ok("another member asking about her file learns nothing about a link", r.body.link === null && r.body.canShare === false, r.body);

// ── ending a link ────────────────────────────────────────────────────────────
r = await call('ann', 'DELETE', `/shares/${planToken}`);
ok("a member can't end a link someone else made", r.status === 403);
r = await call('admin', 'DELETE', `/shares/${planToken}`);
ok('an admin ends a link to a team file', r.status === 200);
pub = await call('nobody', 'GET', `/public/share/${planToken}`);
ok('an ended link shows nothing', pub.status === 404 && !pub.text.includes('Monday'), pub.text);
r = await call('ann', 'DELETE', `/shares/${annToken}`);
ok('the owner ends her own link', r.status === 200);

// ── moved, or into a hidden place ────────────────────────────────────────────
r = await call('bob', 'POST', '/shares', { path: 'Shared/plan.md' });
const t2 = r.body.token;
mkdirSync(join(ROOT, 'Shared', '.archive'), { recursive: true });
renameSync(join(ROOT, 'Shared/plan.md'), join(ROOT, 'Shared/.archive/plan.md'));
pub = await call('nobody', 'GET', `/public/share/${t2}`);
ok('a moved file is no longer shown', pub.status === 404, pub.body);
renameSync(join(ROOT, 'Shared/.archive/plan.md'), join(ROOT, 'Shared/plan.md'));
pub = await call('nobody', 'GET', `/public/share/${t2}`);
ok('...and is again once it is back', pub.status === 200, pub.body);

// ── the workspace switch ─────────────────────────────────────────────────────
r = await call('bob', 'PUT', '/shares/settings', { enabled: false });
ok("a member can't switch sharing off", r.status === 403);
r = await call('admin', 'PUT', '/shares/settings', { enabled: false });
ok('an admin switches sharing off', r.status === 200 && r.body.enabled === false);
pub = await call('nobody', 'GET', `/public/share/${t2}`);
ok('...every link stops at once', pub.status === 404);
r = await call('bob', 'POST', '/shares', { path: 'Shared/plan.md' });
ok('...and nothing new can be shared', r.status === 403 && /switched off/.test(r.body.error), r.body);
r = await call('admin', 'PUT', '/shares/settings', { enabled: true });
pub = await call('nobody', 'GET', `/public/share/${t2}`);
ok('switched back on, the link works again', r.body.enabled === true && pub.status === 200);

// ── tokens ───────────────────────────────────────────────────────────────────
for (const t of ['nope', 'x'.repeat(80), '../../etc/passwd', `${t2}x`]) {
  pub = await call('nobody', 'GET', `/public/share/${encodeURIComponent(t)}`);
  ok(`a made-up token shows nothing (${t.slice(0, 12)})`, pub.status === 404);
}

// ── a link ends by itself ────────────────────────────────────────────────────
const STORE = join(process.env.WSAPI_STORE_DIR, 'shares.json');
const days = (iso) => Math.round((Date.parse(iso) - Date.now()) / 86400_000);
put('Shared/notes.md', 'Team notes.');
r = await call('bob', 'POST', '/shares', { path: 'Shared/notes.md' });
ok('a new link works for 30 days unless told otherwise', r.status === 200 && days(r.body.expiresAt) === 30, r.body);
const tNotes = r.body.token;
r = await call('bob', 'PATCH', `/shares/${tNotes}`, { days: 7 });
ok('its maker shortens it to 7 days', r.status === 200 && days(r.body.expiresAt) === 7, r.body);
r = await call('bob', 'PATCH', `/shares/${tNotes}`, { days: 0 });
ok('...or lets it work with no end', r.status === 200 && r.body.expiresAt === null, r.body);
r = await call('ann', 'PATCH', `/shares/${tNotes}`, { days: 365 });
ok("someone else can't change it", r.status === 403);
r = await call('bob', 'PATCH', `/shares/${tNotes}`, { days: 9999 });
ok('an out-of-range span falls back to 30 days', r.status === 200 && days(r.body.expiresAt) === 30, r.body);
const st = JSON.parse(readFileSync(STORE, 'utf8')); st.links[tNotes].expiresAt = new Date(Date.now() - 1000).toISOString(); writeFileSync(STORE, JSON.stringify(st));
pub = await call('nobody', 'GET', `/public/share/${tNotes}`);
ok('an ended link shows nothing', pub.status === 404 && !pub.text.includes('Team notes'), pub.text);
r = await call('bob', 'GET', `/shares/${tNotes}/open`);
ok('...and opens nothing, even for its maker', r.status === 403);
r = await call('bob', 'GET', '/shares?path=Shared/notes.md');
ok('the file reads as not shared', r.body.link === null && r.body.canShare === true, r.body);
r = await call('bob', 'GET', '/shares');
ok('the list shows it as ended', r.body.links.some((l) => l.token === tNotes && l.expired === true), r.body);
r = await call('bob', 'POST', '/shares', { path: 'Shared/notes.md', days: 7 });
ok('sharing it again makes a new link', r.status === 200 && r.body.token !== tNotes && days(r.body.expiresAt) === 7, r.body);
const tNew = r.body.token;
pub = await call('nobody', 'GET', `/public/share/${tNew}`);
ok('...which works', pub.status === 200);

// ── the assistant is told when it changed a shared file ──────────────────────
const HOOK = fileURLToPath(new URL('../../hooks/shared-file-note.mjs', import.meta.url));
// Run as a separate process, asynchronously: this process also serves the API the hook calls.
const runHook = (file, token, port = String(server.address().port)) => new Promise((done) => {
  const p = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, PROJECT_DIR: ROOT, WORKSPACE_API_PORT: port, IDE_TURN_ID: token || '' } });
  let stdout = '', stderr = '';
  p.stdout.on('data', (b) => { stdout += b; }); p.stderr.on('data', (b) => { stderr += b; });
  p.on('close', (status) => done({ status, stdout, stderr }));
  p.stdin.end(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } }));
});
const bobTurn = ti.issueTurnToken({ actor: 'bob' });
let h = await runHook(join(ROOT, 'Shared/notes.md'), bobTurn);
let note = (() => { try { return JSON.parse(h.stdout).hookSpecificOutput; } catch { return null; } })();
ok('editing a shared file: the assistant is told it is public', h.status === 0 && note?.hookEventName === 'PostToolUse' && /shared by link/.test(note.additionalContext) && /Shared\/notes\.md/.test(note.additionalContext), h.stdout + h.stderr);
put('Shared/never-shared.md', 'Draft.');
h = await runHook(join(ROOT, 'Shared/never-shared.md'), bobTurn);
ok('...a file that is not shared: nothing', h.status === 0 && h.stdout === '', h.stdout);
r = await call('ann', 'POST', '/shares', { path: 'users/ann/notes.md' });
h = await runHook(join(ROOT, 'users/ann/notes.md'), bobTurn);
ok("...someone else's private file: nothing, not even that it is shared", h.status === 0 && h.stdout === '', h.stdout);
h = await runHook(join(ROOT, 'users/ann/notes.md'), ti.issueTurnToken({ actor: 'ann' }));
ok('...her own shared private file: she is told', h.status === 0 && /shared by link/.test(h.stdout), h.stdout);
h = await runHook(join(ROOT, 'Shared/notes.md'), 'made-up');
ok('...no turn identity: nothing, and the edit is never blocked', h.status === 0 && h.stdout === '', h.stdout);
h = await runHook(join(ROOT, 'Shared/data.csv'), bobTurn);
ok('...a file that is not Markdown: nothing', h.status === 0 && h.stdout === '');
const dead = await runHook(join(ROOT, 'Shared/notes.md'), bobTurn, '1');
ok('...workspace-api down: the hook stays silent and succeeds', dead.status === 0 && dead.stdout === '');

// ── the per-visitor cap counts each visitor, not the proxy in front ──────────
process.env.SHARE_PUBLIC_PER_MIN = '3';
const hit = (ip) => fetch(`http://127.0.0.1:${server.address().port}/api/public/share/${tNew}`, { headers: { 'X-Forwarded-For': `${ip}, 172.18.0.5`, 'X-Real-IP': '172.18.0.5' } }).then((x) => x.status);
const a = [await hit('203.0.113.7'), await hit('203.0.113.7'), await hit('203.0.113.7'), await hit('203.0.113.7')];
ok('one visitor over the cap is slowed down', JSON.stringify(a) === '[200,200,200,429]', a);
ok('...another visitor behind the same proxy is not', (await hit('198.51.100.9')) === 200);
process.env.SHARE_PUBLIC_PER_MIN = '1000';

server.close();
console.log(`shares: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
