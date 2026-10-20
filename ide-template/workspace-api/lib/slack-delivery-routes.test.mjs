/**
 * Slack as a place a proactive message lands. A reminder fan-out with
 * channel=slack reaches a linked person's Slack DM (the operator included,
 * solo mode included — the tmux brain has no Slack); a relay goes to Slack
 * when the sender names it or the recipient prefers it; an unlinked person
 * gets the web only; a run outcome follows the same rule. Senders are fakes;
 * the routes are the real ones.
 * Run: node lib/slack-delivery-routes.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'slack-delivery-'));
const STORE = mkdtempSync(join(tmpdir(), 'slack-delivery-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '12'.repeat(32));
process.env.BOT_TURN_ID_HASH_FILE = join(STORE, 'bot-turn-id.sha256');
const BOT_TOKEN = 'bot-token-for-the-test';
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));
process.env.SLACK_PROXY_URL = '';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', slackUserId: 'U0STAN001', preferredSurface: ['web', 'slack'], addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', slackUserId: 'U0ANN0001', telegramChatId: '2220002', preferredSurface: ['web', 'telegram'], addedAt: '2026-09-01T00:00:00Z' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('slack-delivery-routes: the crypto key is not readable here — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
store.activate('slack', { fields: { SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x' } }, { owner: 'stan', reach: 'workspace' });
store.activate('telegram', { fields: { TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_ADMIN_CHAT_ID: '1110001' } }, { owner: 'stan', reach: 'workspace' });

const D = await import('./integrations/deliver.js');
const sent = [];
D.__setSenders({
  telegram: async (m, text) => { sent.push({ s: 'telegram', slug: m.slug, text }); return { ok: true, messageId: 5 }; },
  slack: async (m, text) => { sent.push({ s: 'slack', slug: m.slug, text }); return { ok: true, messageId: '1.0', channel: `D${m.slackUserId}` }; },
});

const express = (await import('express')).default;
const router = (await import('../routes/internal.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/internal`;
const post = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const asBot = { 'X-IDE-Turn': BOT_TOKEN };

// reminder fan-out
let r = await post('/reminder-deliver', { recipients: ['stan', 'ann', 'bob'], channel: 'slack', title: 'Standup', body: 'in 5' }, asBot);
ok('channel=slack reaches the people linked on Slack — the operator included', r.status === 200 && r.body.delivered.find(d => d.slug === 'stan')?.slack === true && r.body.delivered.find(d => d.slug === 'ann')?.slack === true, r.body);
ok('...and not someone with no Slack', r.body.delivered.find(d => d.slug === 'bob')?.slack === false);
ok('...with the reminder as the text, no web toast leg for a named surface', sent.filter(x => x.s === 'slack').length === 2 && /Standup: in 5/.test(sent[0].text) && r.body.delivered.every(d => d.web === false));
sent.length = 0;
r = await post('/reminder-deliver', { recipients: ['stan', 'ann'], channel: 'all', title: 'Lunch' }, asBot);
ok("channel=all follows each person's preference: Stan on Slack, Ann on Telegram, both on the web", r.body.delivered.find(d => d.slug === 'ann')?.telegram === true && r.body.delivered.find(d => d.slug === 'ann')?.slack === false && r.body.delivered.find(d => d.slug === 'ann')?.web === true && !r.body.delivered.find(d => d.slug === 'stan'), r.body);
ok('...the operator is not served here on other channels (the brain does that)', !sent.some(x => x.slug === 'stan'));

// solo mode: Slack still goes through here
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));
sent.length = 0;
r = await post('/reminder-deliver', { recipients: ['stan'], channel: 'slack', title: 'Solo ping' }, asBot);
ok('in solo mode a Slack reminder is delivered here, not skipped', r.body.delivered?.[0]?.slack === true && sent[0]?.slug === 'stan', r.body);
r = await post('/reminder-deliver', { recipients: ['stan'], channel: 'telegram', title: 'Solo tg' }, asBot);
ok('...while any other channel still skips in solo (the brain has it)', r.body.skipped === 'solo');
r = await post('/invoke-turn', { actor: 'stan', message: '[REMINDER channel=slack | x]' }, asBot);
ok('a Slack-bound frame may run headlessly in solo mode', r.status === 202 || (r.status === 200 && !r.body.skipped), r);
r = await post('/invoke-turn', { actor: 'stan', message: '[REMINDER channel=web | x]' }, asBot);
ok('...other frames are still the brain\'s in solo', r.body.skipped === 'solo');
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

// relay
const ti = await import('./turn-identity.js');
const annTurn = ti.issueTurnToken({ actor: 'ann' });
sent.length = 0;
r = await post('/chat-session', { recipient: 'stan', body: 'can you look at the deck?', channel: 'slack' }, { 'X-IDE-Turn': annTurn });
ok('a relay with channel=slack lands in the recipient\'s Slack DM', r.status === 200 && r.body.delivery?.slack === true && r.body.delivery.slackRequested === true && sent[0]?.s === 'slack' && sent[0].slug === 'stan', r.body);
ok('...and the web toast is not doubled when the named surface landed', r.body.delivery.webToast === false);
sent.length = 0;
r = await post('/chat-session', { recipient: 'stan', body: 'and the budget?' }, { 'X-IDE-Turn': annTurn });
ok('a relay with no channel follows the recipient\'s preference (Stan prefers Slack)', r.body.delivery?.slack === true && r.body.delivery.slackRequested === false && r.body.delivery.webToast === true, r.body);
sent.length = 0;
r = await post('/chat-session', { recipient: 'bob', body: 'hi bob', channel: 'slack' }, { 'X-IDE-Turn': annTurn });
ok('a relay to someone with no Slack says so and goes to the web', r.body.delivery?.slack === false && r.body.delivery.recipientLinkedSlack === false && r.body.delivery.web === true && sent.length === 0, r.body);
sent.length = 0;
const stanTurn = ti.issueTurnToken({ actor: 'stan' });
r = await post('/chat-session', { recipient: 'ann', body: 'ping', channel: 'slack' }, { 'X-IDE-Turn': stanTurn });
ok('naming Slack for someone linked on both goes to Slack only (no Telegram)', r.body.delivery?.slack === true && r.body.delivery.telegram === false && sent.every(x => x.s === 'slack'), r.body);

server.close();
console.log(`slack-delivery-routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
