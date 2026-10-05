/**
 * Guards for the memory routes' privacy in team mode — each one a leak that was
 * live before it was closed:
 *
 *   (a) a GROUP turn's supersede / retire / revert searched the sender's private
 *       tree and returned private lines into a session the whole group shares;
 *   (b) GET /internal/memory-log returned every user's private writes to any
 *       caller on loopback — and every turn's Bash is on loopback;
 *   (c) GET /memory/prefix?raw=1 handed the primary admin's private cards to any
 *       loopback caller, i.e. to a teammate's turn;
 *   (d) recent_messages had no identity from inside a turn, so in team mode it
 *       answered nothing to anyone;
 *   (e) the sweep treated the whole Telegram log as the operator's DM, filing
 *       teammates' DMs into the operator's private memory, and fed every user's
 *       private writes into its prompt as "already saved";
 *   (f) the operator's RECENT_TELEGRAM card — loaded into the operator's prompt —
 *       carried every teammate's Telegram DM with the same bot.
 *
 * Real routers on 127.0.0.1, real turn tokens, a temp PROJECT_DIR.
 * Run: node lib/memory-privacy.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-privacy-'));
process.env.PROJECT_DIR = ROOT;
process.env.TELEGRAM_LOG_PATH = join(ROOT, 'telegram.jsonl');
process.env.BOT_TURN_ID_HASH_FILE = join(ROOT, 'bot-turn-id.sha256');
process.env.MEMORY_SWEEP = '0';
const BOT_TOKEN = 'bot-token-for-tests-0123456789';
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};

// ─── a two-person team: stan (operator, admin) and kasia (member) ────────────
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', telegramChatId: '2220002', addedAt: '2026-09-01T00:00:00Z' },
]));
const setTeamMode = (on) => writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({
  teamMode: on, groups: { '-100777': { title: 'Team', addedAt: '2026-09-01T00:00:00Z' } },
}));
setTeamMode(true);

const mem = join(ROOT, 'memory');
for (const d of ['users/stan', 'users/kasia', 'concepts', '_engine']) mkdirSync(join(mem, d), { recursive: true });
writeFileSync(join(mem, 'RULES.md'), '---\ncard: RULES\n---\n\n# RULES\n\n## Never\n- deploy on Fridays\n');
writeFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'),
  '---\ncard: USER_PROFILE\n---\n\n# USER_PROFILE\n\n## Identity\n- Stan has therapy on Thursday evenings\n');
writeFileSync(join(mem, 'users', 'kasia', 'USER_PROFILE.md'),
  '---\ncard: USER_PROFILE\n---\n\n# USER_PROFILE\n\n## Identity\n- Kasia is interviewing at another company\n');

const engine = await import('./memory-engine.js');
const ti = await import('./turn-identity.js');
const shared = engine.remember({ actor: 'stan', scope: 'shared', page: 'office', text: 'The office moves to the second floor in June' });
const stanPriv = engine.remember({ actor: 'stan', scope: 'private', owner: 'stan', card: 'USER_PREFERENCES', text: 'Stan takes no calls before eleven' });
const kasiaPriv = engine.remember({ actor: 'kasia', scope: 'private', owner: 'kasia', card: 'USER_PREFERENCES', text: 'Kasia wants summaries in English' });
ok('fixtures: three writes logged', shared.ok && stanPriv.ok && kasiaPriv.ok, { shared, stanPriv, kasiaPriv });

// ─── real routers on loopback ────────────────────────────────────────────────
const express = (await import('express')).default;
const internalRouter = (await import('../routes/internal.js')).default;
const memoryRouter = (await import('../routes/memory.js')).default;
const app = express();
app.use(express.json());
app.use('/api', internalRouter());
app.use('/api', memoryRouter());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, path, { token, actor, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-IDE-Turn'] = token;
  if (actor) headers['X-IDE-Actor'] = actor;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text body */ }
  return { status: r.status, json, text };
};

const stanDm = ti.issueTurnToken({ actor: 'stan', group: false });
const kasiaDm = ti.issueTurnToken({ actor: 'kasia', group: false });
const stanInGroup = ti.issueTurnToken({ actor: 'stan', group: true });

try {
  // ─── (a) group turns never reach the sender's private tree ──────────────────
  let r = await call('POST', '/internal/memory-write', { token: stanInGroup, body: { op: 'retire', match: 'therapy on Thursday evenings', reason: 'test' } });
  ok('(a) group retire cannot find the sender\'s private claim', r.status !== 200 && !r.text.includes('therapy'), r.json);
  ok('(a) ...and the private claim is untouched',
    readFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'), 'utf8').includes('therapy on Thursday evenings'));
  r = await call('POST', '/internal/memory-write', { token: stanInGroup, body: { op: 'supersede', match: 'therapy', text: 'x' } });
  ok('(a) group supersede returns no private text', !r.text.includes('therapy'), r.json);
  r = await call('POST', '/internal/memory-write', { token: stanInGroup, body: { op: 'revert', event_id: stanPriv.eventId || stanPriv.event_id || stanPriv.id } });
  ok('(a) group revert of a private event is refused', !(r.json && r.json.ok), r.json);
  r = await call('POST', '/internal/memory-write', { token: stanInGroup, body: { op: 'remember', page: 'office', text: 'The kitchen gets a new coffee machine' } });
  ok('(a) group remember into SHARED memory still works', r.status === 200 && r.json?.ok, r.json);
  // control: the same person in a DM reaches their own tree
  engine.remember({ actor: 'stan', scope: 'private', owner: 'stan', card: 'USER_PROFILE', section: 'Identity', text: 'Stan collects vinyl records' });
  r = await call('POST', '/internal/memory-write', { token: stanDm, body: { op: 'retire', match: 'collects vinyl records', reason: 'test' } });
  ok('(a) control: in a DM the owner can retire their own private claim', r.status === 200 && r.json?.ok, r.json);

  // ─── (b) memory_log is scoped like reads ────────────────────────────────────
  const logText = async (opts) => JSON.stringify((await call('GET', '/internal/memory-log?days=7', opts)).json || {});
  let t = await logText({ token: kasiaDm });
  ok('(b) a member sees shared writes', t.includes('second floor'));
  ok('(b) a member sees their own private writes', t.includes('summaries in English'));
  ok('(b) a member never sees the operator\'s private writes', !t.includes('no calls before eleven'), t.slice(0, 300));
  t = await logText({ token: stanInGroup });
  ok('(b) a group turn sees shared only', t.includes('second floor') && !t.includes('no calls before eleven') && !t.includes('summaries in English'));
  t = await logText({});
  ok('(b) no token in team mode → shared only', t.includes('second floor') && !t.includes('no calls before eleven') && !t.includes('summaries in English'));
  t = await logText({ token: BOT_TOKEN, actor: 'stan' });
  ok('(b) the operator\'s brain sees the operator\'s private writes', t.includes('no calls before eleven') && !t.includes('summaries in English'));

  // ─── (c) the raw prefix is the operator brain's only ───────────────────────
  r = await call('GET', '/memory/prefix?raw=1', {});
  ok('(c) team mode, no token → raw prefix refused', r.status === 403, r.status);
  r = await call('GET', '/memory/prefix?raw=1', { token: kasiaDm });
  ok('(c) a teammate\'s turn token → refused', r.status === 403, r.status);
  r = await call('GET', '/memory/prefix?raw=1', { token: BOT_TOKEN });
  ok('(c) the bot token → served, with the operator\'s private card', r.status === 200 && r.text.includes('therapy on Thursday evenings'), r.status);
  r = await call('GET', '/memory/prefix', {});
  ok('(c) the JSON diagnostics (no content) stay open', r.status === 200 && r.json && !r.text.includes('therapy'));
  setTeamMode(false);
  r = await call('GET', '/memory/prefix?raw=1', {});
  ok('(c) solo mode keeps working without a token', r.status === 200, r.status);
  setTeamMode(true);

  // One Telegram log with the operator's DM, a teammate's DM, a stranger and a group line.
  const QUIET = new Date(Date.now() - 30 * 60_000);
  const ts = (m) => new Date(QUIET.getTime() - m * 60_000).toISOString();
  writeFileSync(process.env.TELEGRAM_LOG_PATH, [
    { ts: ts(9), direction: 'inbound', chat_id: '1110001', text: 'stan: move my dentist to Friday' },
    { ts: ts(8), direction: 'outbound', chat_id: '1110001', text: 'done, Friday 10:00' },
    { ts: ts(7), direction: 'inbound', chat_id: '1110001', text: 'thanks' },
    { ts: ts(6), direction: 'inbound', chat_id: '2220002', text: 'kasia: I am interviewing elsewhere, keep it quiet' },
    { ts: ts(5), direction: 'outbound', chat_id: '2220002', text: 'understood' },
    { ts: ts(4), direction: 'inbound', chat_id: '2220002', text: 'ok' },
    { ts: ts(3), direction: 'inbound', chat_id: '3330003', text: 'a stranger writes' },
    { ts: ts(2), direction: 'inbound', chat_id: '-100777', text: 'a group line' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  utimesSync(process.env.TELEGRAM_LOG_PATH, QUIET, QUIET);
  // ─── (d) recent_messages knows who is asking ────────────────────────────────
  writeFileSync(join(mem, 'users', 'kasia', 'RECENT_WEB.md'), '---\ncard: RECENT_WEB\n---\n\n## user\nkasia web tail line\n');
  writeFileSync(join(mem, 'users', 'stan', 'RECENT_WEB.md'), '---\ncard: RECENT_WEB\n---\n\n## user\nstan web tail line\n');
  r = await call('GET', '/memory/recent/web', { token: kasiaDm });
  ok('(d) a member gets their own web tail', r.json?.content?.includes('kasia web tail line'), r.json);
  ok('(d) ...and never the operator\'s', !r.text.includes('stan web tail line'));
  r = await call('GET', '/memory/recent/telegram', { token: kasiaDm });
  ok('(d) a member gets no Telegram tail (the operator\'s channel)', !r.text.includes('dentist') && !r.json?.content);
  r = await call('GET', '/memory/recent/web', { token: stanInGroup });
  ok('(d) a group turn gets no private tail', !r.text.includes('stan web tail line') && !r.text.includes('kasia web tail line'));
  r = await call('GET', '/memory/recent/telegram', { token: BOT_TOKEN, actor: 'stan' });
  ok('(d) the operator\'s brain gets the Telegram tail', r.json?.content?.includes('dentist'), r.json?.content?.slice(0, 300));
  // ─── (f) ...and that tail carries no teammate's DM and no group line ────────
  ok('(f) the operator\'s Telegram card holds no teammate DM', !r.json?.content?.includes('interviewing elsewhere'), r.json?.content);
  ok('(f) ...and no group line', !r.json?.content?.includes('a group line'));
  ok('(f) ...but keeps chats nobody claims (the operator\'s unlinked history)', r.json?.content?.includes('a stranger writes'));

  // ─── (e) the sweep: one source per DM chat, owned by that chat's person ─────
  const sweep = await import('./memory-sweep.js');
  const dms = sweep.idleSources().filter((s) => s.kind === 'dm');
  const byChat = Object.fromEntries(dms.map((s) => [s.chatId, s]));
  ok('(e) the operator\'s chat is a source owned by the operator', byChat['1110001']?.owner === 'stan', dms);
  ok('(e) a teammate\'s chat is a source owned by the teammate', byChat['2220002']?.owner === 'kasia', dms);
  ok('(e) a chat no roster member owns is never swept', !byChat['3330003']);
  ok('(e) group lines in the DM log are not a DM source', !dms.some((s) => String(s.chatId).startsWith('-')));
  const kasiaTail = sweep._renderTailForTests(byChat['2220002']);
  ok('(e) a teammate\'s transcript holds only their chat', kasiaTail.includes('interviewing elsewhere') && !kasiaTail.includes('dentist'), kasiaTail);
  const stanTail = sweep._renderTailForTests(byChat['1110001']);
  ok('(e) the operator\'s transcript holds no teammate lines', stanTail.includes('dentist') && !stanTail.includes('interviewing'), stanTail);
  const savedForKasia = sweep._alreadySavedForTests(byChat['2220002'], 0).join('\n');
  ok('(e) "already saved" for a member excludes the operator\'s private writes',
    !savedForKasia.includes('no calls before eleven') && savedForKasia.includes('second floor'), savedForKasia);
  const savedForGroup = sweep._alreadySavedForTests({ kind: 'group', owner: null }, 0).join('\n');
  ok('(e) "already saved" for a group holds shared writes only',
    !savedForGroup.includes('no calls before eleven') && !savedForGroup.includes('summaries in English'));
} finally {
  server.close();
}

// ─── (g) the file rule the tools' scope guard applies ─────────────────────────
const { pathInScope, pathInGroupScope } = await import('./scope-rule.js');
ok('(g) a teammate\'s routines and chats are not readable by path', !pathInScope('.team/users/kasia/routines.json', { ownSlug: 'stan', isAdmin: true }) && !pathInScope('.team/users/kasia/chats/s1.jsonl', { ownSlug: 'stan', isAdmin: true }));
ok('(g) ...one\'s own are', pathInScope('.team/users/stan/routines.json', { ownSlug: 'stan' }));
ok('(g) no raw path reaches a group\'s memory — admins included', !pathInScope('memory/groups/-100777/ledger/2026-09.jsonl', { ownSlug: 'stan', isAdmin: true }) && !pathInScope('memory/groups/-100777/ledger/2026-09.jsonl', { ownSlug: 'kasia' }));
ok('(g) nor from a group turn (another group\'s, or its own)', !pathInGroupScope('memory/groups/-100999/ledger/2026-09.jsonl') && !pathInGroupScope('memory/groups/-100777/ledger/2026-09.jsonl'));
ok('(g) a group turn cannot read anyone\'s routines', !pathInGroupScope('.team/users/stan/routines.json'));
ok('(g) a person\'s own ledger stays readable to them only', pathInScope('memory/users/stan/ledger/2026-09.jsonl', { ownSlug: 'stan' }) && !pathInScope('memory/users/stan/ledger/2026-09.jsonl', { ownSlug: 'kasia', isAdmin: true }));

console.log(`memory-privacy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
