/**
 * Who may do what through the web API, in team mode, checked through the
 * mounted routers the way a request arrives (no SESSION_SECRET in tests, so
 * the actor comes from the X-IDE-User header nginx would set):
 *   - a session that is not on the roster gets no chat turn;
 *   - restarting the bot and the docs-comments login are the admin's;
 *   - a raw SVG is served inert;
 *   - a private memory note is written for the turn's own person only.
 * Run: node lib/access-rules.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'access-rules-'));
const STORE = mkdtempSync(join(tmpdir(), 'access-rules-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.BOT_TURN_ID_HASH_FILE = join(STORE, 'bot-turn-id.sha256');
delete process.env.SESSION_SECRET;
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update('bot-token').digest('hex'));
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
mkdirSync(join(ROOT, 'pics'), { recursive: true });
writeFileSync(join(ROOT, 'pics/x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
writeFileSync(join(ROOT, 'pics/x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};

const ti = await import('./turn-identity.js');
const { attachActor } = await import('./auth.js');
const express = (await import('express')).default;
const app = express();
app.use(express.json());
app.use(attachActor);
for (const name of ['bot', 'files', 'chat', 'internal']) {
  app.use('/api', (await import(`../routes/${name}.js`)).default());
}
app.use('/api/integrations/docs-comments', (await import('../routes/docs-comments-login.js')).default());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, path, { user, token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['X-IDE-User'] = user;
  if (token) headers['X-IDE-Turn'] = token;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, text: await r.text() };
};
const ADMIN = 'stan@example.test', MEMBER = 'ann@example.test', STRANGER = 'who@example.test';

// a session that is not on the roster
let r = await call('GET', '/chat/sessions', { user: STRANGER });
ok('team mode: a session off the roster gets no chat', r.status === 401 || r.status === 403, r.status);
r = await call('GET', '/chat/sessions', { user: MEMBER });
ok('...a member does', r.status !== 403 && r.status !== 401, r.status);

// the bot's lifecycle
r = await call('POST', '/bot/restart', { user: MEMBER });
ok('a member cannot restart the bot', r.status === 403, r.status);
r = await call('POST', '/bot/send', { user: ADMIN, body: { text: 'hi' } });
ok('there is no relay into the bot from the web', r.status === 404, r.status);

// the docs-comments login
r = await call('POST', '/integrations/docs-comments/connect-start', { user: MEMBER });
ok('a member cannot start the docs-comments login', r.status === 403, r.status);
r = await call('GET', '/integrations/docs-comments/vnc/', { user: MEMBER });
ok('...nor open its viewer', r.status === 403, r.status);
r = await call('GET', '/integrations/docs-comments/status', { user: MEMBER });
ok('...but sees its status', r.status === 200, r.status);

// raw files
r = await call('GET', '/files/raw?path=pics/x.svg', { user: MEMBER });
ok('an SVG is served with a script-free, sandboxed policy', r.status === 200 && /sandbox/.test(r.headers.get('content-security-policy') || '') && /'none'/.test(r.headers.get('content-security-policy') || ''), r.headers.get('content-security-policy'));
ok('...and is not sniffed into something else', r.headers.get('x-content-type-options') === 'nosniff');
r = await call('GET', '/files/raw?path=pics/x.png', { user: MEMBER });
ok('a PNG carries no such policy', r.status === 200 && !r.headers.get('content-security-policy'));

// a private memory note names no one else
const annTurn = ti.issueTurnToken({ actor: 'ann' });
r = await call('POST', '/internal/memory-write', { token: annTurn, body: { op: 'remember', scope: 'private', owner: 'stan', card: 'RESPONSIBILITIES', text: '**Daily** — check' } });
ok('a private write for another person is refused', r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
r = await call('POST', '/internal/memory-write', { token: annTurn, body: { op: 'remember', scope: 'private', owner: 'ann', card: 'NOPE', text: 'x' } });
ok('...naming oneself is fine', r.status !== 403, r.status);

// a message's sender is the turn, not a claim
const { listSessions } = await import('./sessions.js');
r = await call('POST', '/internal/chat-session', { token: annTurn, body: { recipient: 'stan', from: 'stan', body: 'hello there' } });
ok('a relay is filed under the sender the token proves', r.status === 200 && listSessions('stan').some((s) => /Ann/.test(s.title)) && !listSessions('stan').some((s) => /Stan/.test(s.title)), listSessions('stan').map((s) => s.title));
r = await call('POST', '/internal/notify', { body: { title: 'x', body: 'y', from: 'stan' } });
ok('a notify without a turn is accepted as anonymous', r.status === 200, r.status);
r = await call('GET', '/internal/mcp-token/grok');
ok('an OAuth token is not handed to a caller without a turn', r.status === 403, r.status);
r = await call('GET', '/internal/mcp-token/grok', { token: annTurn });
ok('...a turn gets past the gate', r.status !== 403, r.status);

// the integrations list
for (const name of ['integrations']) app.use('/api', (await import(`../routes/${name}.js`)).default());
r = await call('GET', '/integrations');
ok('the integrations list needs a signed-in person', r.status === 401, r.status);
r = await call('GET', '/integrations', { user: MEMBER });
ok('...a member sees it without the credential summaries', r.status === 200 && !JSON.parse(r.text).integrations.some((i) => i.credentialSummary), r.status);

// the setup wizard, once an admin exists
app.use('/api', (await import('../routes/setup.js')).default());
r = await call('POST', '/setup/branding', { user: MEMBER, body: { botName: 'X' } });
ok('a member cannot change setup while an admin exists', r.status === 403, r.status);

server.close();
console.log(`access-rules: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
