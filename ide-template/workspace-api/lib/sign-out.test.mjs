/**
 * Signing out ends the session everywhere it is checked: a token issued
 * before the sign-out is no longer the person's, one issued after is.
 * Run: node lib/sign-out.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jwt from 'jsonwebtoken';

const ROOT = mkdtempSync(join(tmpdir(), 'sign-out-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'sign-out-store-'));
process.env.SESSION_SECRET = 'test-secret-for-sign-out';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); } };

const team = await import('./team.js');
const { attachActor } = await import('./auth.js');
const actorOf = (token) => {
  const req = { cookies: { ide_session: token }, get: () => '', headers: {} };
  attachActor(req, {}, () => {});
  return req.actor;
};
const mint = (iat) => jwt.sign({ email: 'ann@example.test', iat }, process.env.SESSION_SECRET, { expiresIn: '8h' });

const now = Math.floor(Date.now() / 1000);
const before = mint(now - 60);
ok('a token is the person before they sign out', actorOf(before) === 'ann@example.test', actorOf(before));
ok('sign-out is recorded', team.markSignedOut('ann@example.test') === true);
ok('...and the earlier token is nobody', actorOf(before) === null, actorOf(before));
const after = mint(now + 5);
ok('a token issued after the sign-out is the person again', actorOf(after) === 'ann@example.test', actorOf(after));
ok('signing out someone not on the roster changes nothing', team.markSignedOut('who@example.test') === false);

console.log(`sign-out: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
