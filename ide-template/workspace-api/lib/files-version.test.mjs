/**
 * Versioned writes (the markdown editor's merge): a read carries the file's
 * version; a write with `baseVersion` lands only if the file is still that
 * version, otherwise it answers 409 with what is on disk now and writes
 * nothing; a write without one is unconditional, as before. A private tree
 * stays closed: the conflict answer never shows another person's file.
 * Run: node lib/files-version.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'files-version-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'files-version-store-'));
process.env.MEMORY_V4 = 'on';
mkdirSync(join(ROOT, '.team'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z', slot: 1 },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', slot: 2 },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));
const put = (p, text) => { mkdirSync(join(ROOT, p, '..'), { recursive: true }); writeFileSync(join(ROOT, p), text); };
put('Shared/plan.md', '# Plan\n\nOne.\n');
put('users/ann/notes.md', 'ANN-SECRET-8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/files.js')).default());
const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
const call = async (who, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-actor': who }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return {}; } })(), text };
};
const STAN = 'stan@example.test';
const disk = (p) => readFileSync(join(ROOT, p), 'utf8');

let r = await call(STAN, 'GET', '/files/read?path=Shared/plan.md');
const v1 = r.body.version;
ok('a read carries the version', r.status === 200 && /^[0-9a-f]{64}$/.test(v1 || ''), r.body);

r = await call(STAN, 'POST', '/files/write', { path: 'Shared/plan.md', content: '# Plan\n\nOne, edited.\n', baseVersion: v1 });
const v2 = r.body.version;
ok('a write on the current version lands and returns the new one', r.status === 200 && v2 && v2 !== v1 && disk('Shared/plan.md') === '# Plan\n\nOne, edited.\n', r.body);

// The bot changes the file meanwhile.
put('Shared/plan.md', '# Plan\n\nOne, edited.\n\nTwo, from the bot.\n');
r = await call(STAN, 'POST', '/files/write', { path: 'Shared/plan.md', content: '# Plan\n\nOne, edited again.\n', baseVersion: v2 });
ok('a write on an old version is refused with what is on disk', r.status === 409 && r.body.error === 'changed' && /from the bot/.test(r.body.content) && r.body.version !== v2, r.body);
ok('…and writes nothing', disk('Shared/plan.md') === '# Plan\n\nOne, edited.\n\nTwo, from the bot.\n');

r = await call(STAN, 'POST', '/files/write', { path: 'Shared/plan.md', content: 'plain write' });
ok('a write without a version is unconditional, as before', r.status === 200 && disk('Shared/plan.md') === 'plain write');

r = await call(STAN, 'POST', '/files/write', { path: 'users/ann/notes.md', content: 'x', baseVersion: 'stale' });
ok('another person\'s private file stays closed, with nothing of it in the answer', r.status !== 200 && r.status !== 409 && !/ANN-SECRET-8/.test(r.text) && disk('users/ann/notes.md') === 'ANN-SECRET-8', { status: r.status, text: r.text });

r = await call(STAN, 'POST', '/files/write', { path: 'Shared/gone.md', content: 'x', baseVersion: v1 });
ok('a versioned write to a file deleted meanwhile is refused', r.status === 409 && r.body.error === 'deleted', r.body);

server.close();
console.log(`files-version: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
