// A turn's MCP config carries broker grants this process holds and that are
// good for a while: the bot's config file is brought up to date BEFORE the
// turn's own file is copied from it. (The first turn after the 24 h mark once
// got the previous day's nonces and lost every brokered server.) And a
// headless turn runs without the CLI's "the user hasn't heard from you"
// reminder, which turned a silent run into a message.
// Run: node lib/turn-mcp-grants.test.mjs
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'turn-grants-'));
const STORE = mkdtempSync(join(tmpdir(), 'turn-grants-store-'));
const CFG = join(ROOT, 'bot-claude.json');
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.CLAUDE_CONFIG_PATH = CFG;
process.env.BOT_CLAUDE_CONFIG = CFG;
process.env.TURN_RUN_DIR = join(ROOT, 'run');
process.env.MEMORY_V4 = 'off';
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ab'.repeat(32));
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'tom@example.test', role: 'admin', slug: 'tom', displayName: 'Tom', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));
// A stand-in CLI: it answers with the grok nonce from the config it was given
// and with the reminder settings it sees in its environment.
const FAKE = join(ROOT, 'fake-claude.mjs');
writeFileSync(FAKE, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const i = process.argv.indexOf('--mcp-config');
const cfg = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
const seen = { nonce: cfg.mcpServers?.grok?.env?.BROKER_NONCE || null, reminder: process.env.CLAUDE_CODE_SILENT_TURN_REMINDER, text: process.env.CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT };
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'stream_event', session_id: 'S1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(seen) } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S1', result: '' }) + '\\n');
});
`);
chmodSync(FAKE, 0o755);
process.env.CLAUDE_BIN = FAKE;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const store = await import('./integrations/store.js');
const broker = await import('./integrations/broker.js');
store.activate('grok', { fields: { XAI_API_KEY: 'test-key' } });
// The bot's config as a previous workspace-api process left it: a nonce this
// process has never issued.
writeFileSync(CFG, JSON.stringify({ mcpServers: { grok: { command: '/opt/ide/bin/mcp-runner', args: ['grok'], env: { BROKER_NONCE: 'minted-by-the-previous-process' }, __ide_managed: true } } }));

const { runClaudeTurn } = await import('./claude.js');
const turn = (o) => new Promise((resolve) => {
  let text = '';
  runClaudeTurn({ onText: (t) => { text += t; }, onToolStart() {}, onToolEnd() {}, onImage() {}, onError: (e) => resolve({ error: String(e), text }), onDone: (r) => resolve({ ...r, text }), ...o });
});

const r = await turn({ actor: 'tom', message: 'hello' });
let seen = null;
try { seen = JSON.parse(r.text); } catch { /* reported below */ }
ok('the turn ran', !r.error && seen, r);
ok('the turn\'s config carries a grant this process holds', seen?.nonce && seen.nonce !== 'minted-by-the-previous-process' && broker.grantIntegration(seen.nonce) === 'grok', seen);
ok('...and so does the bot\'s config now', JSON.parse(readFileSync(CFG, 'utf8')).mcpServers.grok.env.BROKER_NONCE === seen?.nonce);
ok('the CLI\'s silent-turn reminder is off for the turn', seen?.reminder === '' && typeof seen?.text === 'string' && /not a person/.test(seen.text), seen);

console.log(`turn-mcp-grants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
