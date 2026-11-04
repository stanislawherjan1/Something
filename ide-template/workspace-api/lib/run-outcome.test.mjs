// A reminder run's outcome (/internal/invoke-turn with `deliver`): the closing
// text after the last tool call is what the person gets; `[[SILENT]]` anywhere
// on a line of its own means nothing is sent — the model puts it last, after
// its reasoning, and that reasoning once went out as a message; no marker
// survives into what is sent.
// Run: node lib/run-outcome.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'run-outcome-'));
const STORE = mkdtempSync(join(tmpdir(), 'run-outcome-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.MEMORY_V4 = 'off';
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'integrations.key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '12'.repeat(32));
process.env.BOT_TURN_ID_HASH_FILE = join(STORE, 'bot-turn-id.sha256');
const BOT_TOKEN = 'bot-token-for-the-test';
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));
mkdirSync(join(ROOT, 'memory'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'admin', slug: 'ann', displayName: 'Ann', telegramChatId: '2220002', preferredSurface: ['web', 'telegram'], addedAt: '2026-09-01T00:00:00Z' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
// The stand-in CLI: narration, a tool call, then the closing text the message asks for.
const FAKE = join(ROOT, 'fake-claude.mjs');
writeFileSync(FAKE, `#!/usr/bin/env node
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const out = (event) => process.stdout.write(JSON.stringify({ type: 'stream_event', session_id: 'fake', event }) + '\\n');
  // The route appends a note on what becomes of the reply; the closing text ends before it.
  const closing = (buf.match(/CLOSING:(.*?)(?: \\[This run is headless|$)/ms) || [, 'Done.'])[1].trim().replace(/\\\\n/g, '\\n');
  out({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  out({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking the calendar and the inbox first.' } });
  out({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'mcp__workspace-api__memory_search', input: {} } });
  out({ type: 'content_block_stop', index: 1 });
  out({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
  out({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: closing } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fake', result: '' }) + '\\n');
});
`);
chmodSync(FAKE, 0o755);
process.env.CLAUDE_BIN = FAKE;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('run-outcome: the crypto key is not readable here — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
store.activate('telegram', { fields: { TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_ADMIN_CHAT_ID: '2220002' } }, { owner: 'ann', reach: 'workspace' });
const D = await import('./integrations/deliver.js');
const sent = [];
D.__setSenders({
  telegram: async (m, text) => { sent.push({ slug: m.slug, text }); return { ok: true, messageId: 5 }; },
  slack: async () => ({ ok: false }),
});

const express = (await import('express')).default;
const router = (await import('../routes/internal.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/internal`;
const run = async (closing) => {
  const before = sent.length;
  const r = await fetch(base + '/invoke-turn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IDE-Turn': BOT_TOKEN }, body: JSON.stringify({ actor: 'ann', message: `[REMINDER channel=telegram | check things] CLOSING:${closing}`, deliver: { channel: 'telegram', title: 'Reminder' } }) });
  if (r.status !== 202) return { status: r.status, body: await r.json().catch(() => ({})) };
  const until = Date.now() + 15_000;
  while (Date.now() < until) { await new Promise(res => setTimeout(res, 100)); if (sent.length > before) break; }
  await new Promise(res => setTimeout(res, 400));
  return { status: 202, sent: sent.slice(before) };
};

let r = await run('The brief already went out this morning, nothing changed since.\\n[[SILENT]]');
ok('a run that ends with [[SILENT]] after its reasoning sends nothing', r.status === 202 && r.sent.length === 0, r);
r = await run('[[SILENT]]');
ok('a bare [[SILENT]] sends nothing', r.status === 202 && r.sent.length === 0, r);
r = await run('Two emails need you: the invoice from Orbis and the venue contract.');
ok('the closing text goes out, without the narration before the tool call', r.sent.length === 1 && r.sent[0].text === 'Two emails need you: the invoice from Orbis and the venue contract.' && r.sent[0].slug === 'ann', r);
r = await run('Done.\\n[[SEND]]\\nAll set for the call.');
ok('a stray marker never reaches the person', r.sent.length === 1 && !/\[\[/.test(r.sent[0].text) && /Done\.\n\nAll set|Done\.\nAll set/.test(r.sent[0].text), r);

server.close();
console.log(`run-outcome: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
