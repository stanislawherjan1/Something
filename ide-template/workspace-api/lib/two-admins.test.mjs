/**
 * Two admins. The Telegram brain runs as the primary admin (their private
 * memory, own connections and skills), so only the primary admin's DMs go
 * to it; another admin's DM is a turn as that admin, like a member's. And
 * what the primary admin owns stays theirs: the other admin's turn gets
 * neither their own servers nor their private memory.
 * Run: node lib/two-admins.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'two-admins-'));
const STORE = mkdtempSync(join(tmpdir(), 'two-admins-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '78'.repeat(32));
process.env.MEMORY_V4 = 'on';
process.env.BOT_CLAUDE_CONFIG = join(STORE, 'bot-claude.json');
process.env.CLAUDE_CONFIG_PATH = process.env.BOT_CLAUDE_CONFIG;
process.env.TURN_RUN_DIR = join(STORE, 'turns');
mkdirSync(join(ROOT, '.team'), { recursive: true });
for (const s of ['stan', 'kat', 'ann']) mkdirSync(join(ROOT, 'memory', 'users', s), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z', slot: 1 },
  { email: 'kat@example.test', role: 'admin', slug: 'kat', displayName: 'Kat', telegramChatId: '3330003', addedAt: '2026-09-02T00:00:00Z', slot: 2 },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', telegramChatId: '2220002', addedAt: '2026-09-03T00:00:00Z', slot: 3 },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
writeFileSync(process.env.BOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const T = await import('./team.js');
ok('the primary admin is the first admin on the roster', T.primaryAdminSlug() === 'stan');
const { routeTelegramInbound } = await import('./integrations/telegram-sync.js');
let r = await routeTelegramInbound({ chat_id: '1110001', text: 'hi', message_id: 1 });
ok('the primary admin\'s DM goes to the brain', r.routed === false && /operator/.test(r.reason), r);
r = await routeTelegramInbound({ chat_id: '3330003', text: 'what do you know about Stan?', message_id: 2 });
ok('another admin\'s DM is a turn as them, never the brain', r.routed === true && r.reason === 'member turn', r);
r = await routeTelegramInbound({ chat_id: '2220002', text: 'hi', message_id: 3 });
ok('a member\'s DM is a turn as them', r.routed === true && r.reason === 'member turn', r);

// What the primary admin owns is theirs alone.
const crypto = await import('./integrations/crypto.js');
if (crypto.isReady()) {
  const store = await import('./integrations/store.js');
  const runtime = await import('./integrations/runtime.js');
  const C = await import('./claude.js');
  store.activate('granola@stan', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 's' }) } }, { owner: 'stan', reach: 'personal' });
  store.activate('granola@kat', { fields: { OAUTH_TOKENS: JSON.stringify({ access_token: 'k' }) } }, { owner: 'kat', reach: 'personal' });
  runtime.syncMcpServers();
  const katTurn = Object.keys(C.turnMcpServers({ actor: 'kat' }));
  ok('the other admin\'s turn has their own Granola, not the primary admin\'s', katTurn.includes('granola-mine') && (C.turnMcpServers({ actor: 'kat' })['granola-mine'].env.REMOTE_MCP_ID || C.turnMcpServers({ actor: 'kat' })['granola-mine'].env.BROKER_INTEGRATION_ID) === 'granola@kat', katTurn);
  const L = await import('./memory-ledger.js');
  ok('the other admin reads shared and their own memory, not the primary admin\'s', L.readableScopes({ actor: 'kat' }).join() === 'shared,user:kat');
}

console.log(`two-admins: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
