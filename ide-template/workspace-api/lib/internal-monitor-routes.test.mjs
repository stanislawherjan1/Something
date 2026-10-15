/**
 * The routes the reminder monitor drives — invoke-turn (run a turn as a
 * teammate), reminder-deliver and group-say — answer only a caller holding the
 * bot user's token. A turn's own token, a made-up one or none is refused before
 * the route does anything. Run: node lib/internal-monitor-routes.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'internal-monitor-'));
const STORE = mkdtempSync(join(tmpdir(), 'internal-monitor-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.BOT_TURN_ID_HASH_FILE = join(STORE, 'bot-turn-id.sha256');
const BOT_TOKEN = 'bot-token-for-tests';
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};

const ti = await import('./turn-identity.js');
const express = (await import('express')).default;
const router = (await import('../routes/internal.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/internal`;
const post = async (path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-IDE-Turn'] = token;
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return r.status;
};

const turnToken = ti.issueTurnToken({ actor: 'ann' });
const routes = [
  ['/invoke-turn', { actor: 'bob', message: 'hello' }],
  ['/reminder-deliver', { recipients: ['bob'], title: 'x' }],
  ['/group-say', { chat_id: '-1001', text: 'x' }],
];
for (const [path, body] of routes) {
  ok(`${path}: no token is refused`, (await post(path, body)) === 403);
  ok(`${path}: a turn's own token is refused`, (await post(path, body, turnToken)) === 403);
  ok(`${path}: a made-up token is refused`, (await post(path, body, 'not-the-token')) === 403);
  ok(`${path}: the bot's token gets past the gate`, (await post(path, body, BOT_TOKEN)) !== 403);
}

server.close();
console.log(`internal-monitor-routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
