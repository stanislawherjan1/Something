/**
 * syncMcpServers writes the bot's CLI config (/home/bot/.claude.json):
 *   - a pass that changes nothing leaves the file alone and says so;
 *   - a broker grant this process still holds is kept, one it does not know
 *     (a restart, expiry) is replaced;
 *   - a manual entry survives every pass;
 *   - a file that does not parse is left as it is (with a copy beside it)
 *     and the pass fails instead of writing our block over it.
 * Run: node lib/mcp-config-sync.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'mcp-sync-'));
const STORE = mkdtempSync(join(tmpdir(), 'mcp-sync-store-'));
const CFG = join(ROOT, 'claude.json');
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.CLAUDE_CONFIG_PATH = CFG;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ab'.repeat(32));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};
const read = () => JSON.parse(readFileSync(CFG, 'utf8'));

const store = await import('./integrations/store.js');
const runtime = await import('./integrations/runtime.js');
const broker = await import('./integrations/broker.js');

// The bot's config as entrypoint leaves it: an always-on server, a CLI setting.
writeFileSync(CFG, JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { reminders: { command: 'node', args: ['/opt/ide/apps/reminder-mcp/index.js'] } } }, null, 2));
store.activate('grok', { fields: { XAI_API_KEY: 'test-key' } });

let r = runtime.syncMcpServers();
let cfg = read();
ok('activating an integration adds its server', r.changed === true && cfg.mcpServers.grok?.args?.[0] === 'grok', cfg);
ok('...the always-on server and the CLI setting stay', cfg.mcpServers.reminders && cfg.hasCompletedOnboarding === true);
const nonce = cfg.mcpServers.grok.env.BROKER_NONCE;
ok('...with a grant the broker knows', broker.grantIntegration(nonce) === 'grok');

const mtime = statSync(CFG).mtimeMs;
await new Promise((res) => setTimeout(res, 20));
r = runtime.syncMcpServers();
ok('a pass that changes nothing reports no change', r.changed === false);
ok('...keeps the grant', read().mcpServers.grok.env.BROKER_NONCE === nonce);
ok('...and does not touch the file', statSync(CFG).mtimeMs === mtime);

cfg = read(); cfg.mcpServers.grok.env.BROKER_NONCE = 'from-a-previous-process'; writeFileSync(CFG, JSON.stringify(cfg));
r = runtime.syncMcpServers();
const fresh = read().mcpServers.grok.env.BROKER_NONCE;
ok('a grant this process does not know is replaced', r.changed === true && fresh !== 'from-a-previous-process' && broker.grantIntegration(fresh) === 'grok');

store.activate('granola', { fields: { OAUTH_TOKENS: '{"access_token":"a","refresh_token":"r","expires_at":1}' } });
r = runtime.syncMcpServers();
const g = read().mcpServers.granola;
ok('a hosted server that needs the person\'s token goes through the local bridge', g?.command?.endsWith('mcp-runner') && g.args?.[0] === 'remote' && g.env?.REMOTE_MCP_ID === 'granola' && /^https:\/\//.test(g.env?.REMOTE_MCP_URL || ''), g);
ok('...with no token in the config itself', !JSON.stringify(g).includes('Bearer') && !('headersHelper' in g));

writeFileSync(CFG, '{ "mcpServers": { "reminders": { "command": "node" }, ');
let threw = null;
try { runtime.syncMcpServers(); } catch (err) { threw = err; }
ok('a file that does not parse makes the pass fail', !!threw, threw);
ok('...and is left as it was', readFileSync(CFG, 'utf8').startsWith('{ "mcpServers": { "reminders"'));
ok('...with a copy beside it', readdirSync(ROOT).some((f) => f.startsWith('claude.json.unreadable-')));
ok('...and no temporary file left behind', !readdirSync(ROOT).some((f) => f.endsWith('.tmp')));

console.log(`mcp-config-sync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
