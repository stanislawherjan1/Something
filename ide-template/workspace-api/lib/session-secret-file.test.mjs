/**
 * In the container the session secret is a file for workspace-api's uid, not
 * an environment variable: a cookie signed with the file's secret is a
 * session. Run: node lib/session-secret-file.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jwt from 'jsonwebtoken';

const ROOT = mkdtempSync(join(tmpdir(), 'secret-file-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'secret-file-store-'));
delete process.env.SESSION_SECRET;
process.env.SESSION_SECRET_FILE = join(ROOT, 'session-secret');
writeFileSync(process.env.SESSION_SECRET_FILE, 'the-secret-from-the-file\n');
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([{ email: 'ann@example.test', role: 'member', slug: 'ann', addedAt: '2026-09-01T00:00:00Z' }]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); } };
const { attachActor, SESSION_SECRET } = await import('./auth.js');
const actorOf = (token) => { const req = { cookies: { ide_session: token }, get: () => '', headers: {} }; attachActor(req, {}, () => {}); return req.actor; };
ok('the secret is read from the file', SESSION_SECRET === 'the-secret-from-the-file');
ok('a cookie signed with it is a session', actorOf(jwt.sign({ email: 'ann@example.test' }, 'the-secret-from-the-file')) === 'ann@example.test');
ok('one signed with something else is not', actorOf(jwt.sign({ email: 'ann@example.test' }, 'guess')) === null);
console.log(`session-secret-file: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
