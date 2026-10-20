/**
 * A proactive message to a person goes to the surfaces they are linked on —
 * and prefer, unless one was named — never to a surface that is off, and the
 * caller is told what landed. The senders are injected.
 * Run: node lib/deliver.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'deliver-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'deliver-store-'));
process.env.INTEGRATIONS_KEY_PATH = join(process.env.WSAPI_STORE_DIR, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '12'.repeat(32));
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const D = await import('./integrations/deliver.js');
const store = await import('./integrations/store.js');
const { isReady } = await import('./integrations/crypto.js');
if (!isReady()) { console.log('  (store not ready in this rig — deliver checks skipped)'); console.log(`deliver: ${pass} passed, ${fail} failed`); process.exit(0); }

const sent = [];
D.__setSenders({
  telegram: async (m, text) => { sent.push({ s: 'telegram', to: m.telegramChatId, text }); return { ok: true, messageId: 77 }; },
  slack: async (m, text) => { sent.push({ s: 'slack', to: m.slackUserId, text }); return { ok: true, messageId: '1.1', channel: 'D1' }; },
});
const both = { slug: 'ann', telegramChatId: '2220002', slackUserId: 'U0ANN0001', preferredSurface: ['web', 'slack'] };

ok('nothing is linked while no integration is connected', D.linkedSurfaces(both).length === 0 && JSON.stringify(D.surfacesFor(both, 'slack')) === '[]');
let r = await D.sendToPerson(both, 'hi', 'slack');
ok('...and a send there is refused, not attempted', !r.ok && /not linked/.test(r.error) && sent.length === 0);

store.activate('slack', { fields: { SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x' } }, { owner: 'stan', reach: 'workspace' });
ok('Slack connected + an id = linked on Slack', JSON.stringify(D.linkedSurfaces(both)) === '["slack"]');
ok("'all' follows the person's preference", JSON.stringify(D.surfacesFor(both, 'all')) === '["slack"]');
ok("a named surface the person is linked on is honoured even if not preferred", JSON.stringify(D.surfacesFor({ ...both, preferredSurface: 'web' }, 'slack')) === '["slack"]');
ok("'web' means no other surface", JSON.stringify(D.surfacesFor(both, 'web')) === '[]');
ok("'telegram' while Telegram is not connected = nothing", JSON.stringify(D.surfacesFor(both, 'telegram')) === '[]');

store.activate('telegram', { fields: { TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_ADMIN_CHAT_ID: '1110001' } }, { owner: 'stan', reach: 'workspace' });
ok('both connected = both linked', JSON.stringify(D.linkedSurfaces(both)) === '["telegram","slack"]');
ok("'both' (web + Telegram) prefers Telegram only", JSON.stringify(D.surfacesFor({ ...both, preferredSurface: 'both' }, 'all')) === '["telegram"]');
ok('a set may name every surface', JSON.stringify(D.surfacesFor({ ...both, preferredSurface: ['telegram', 'slack'] }, 'all')) === '["telegram","slack"]');
ok('no preference stated = no proactive leg beyond the web', JSON.stringify(D.surfacesFor({ ...both, preferredSurface: null }, 'all')) === '[]');

sent.length = 0;
r = await D.deliver({ ...both, preferredSurface: ['telegram', 'slack'] }, 'ping', 'all');
ok('deliver sends on each surface and reports what landed', r.telegram && r.slack && r.tgMessageId === '77' && r.slackChannel === 'D1' && sent.length === 2 && JSON.stringify(r.sent) === '["telegram","slack"]', r);
D.__setSenders({ slack: async () => ({ ok: false, error: 'channel_not_found' }) });
r = await D.deliver(both, 'ping', 'slack');
ok('a failed leg is reported false, never thrown', r.slack === false && r.sent.length === 0);
D.__setSenders({ slack: async () => { throw new Error('boom'); } });
r = await D.sendToPerson(both, 'ping', 'slack');
ok('a sender that throws becomes an error result', !r.ok && r.error === 'boom');
r = await D.sendToPerson(both, 'ping', 'fax');
ok('an unknown surface is refused', !r.ok);

console.log(`deliver: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
