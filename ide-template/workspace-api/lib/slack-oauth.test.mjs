/**
 * Installing the Slack app from here: the manifest names this workspace's
 * callback, the install link goes to Slack's consent page for the app's own
 * client id with the surface's scopes and a one-shot state, the callback
 * trades the code for the bot token and stores it, a stale state is refused,
 * and a connection with neither a bot token nor a client id + secret is
 * refused at save time. Slack is a fake transport; the routes are real.
 * Run: node lib/slack-oauth.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'slack-oauth-'));
const STORE = mkdtempSync(join(tmpdir(), 'slack-oauth-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, '12'.repeat(32));
process.env.SLACK_PROXY_URL = '';
process.env.INTEGRATIONS_RATE_MAX = '100';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400)}` : ''}`); } };

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('slack-oauth: the crypto key is not readable here — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
const api = await import('./integrations/slack-api.js');
const calls = [];
let script = [];
api.configure({ fetch: async (url, init) => { calls.push({ url: String(url), init }); const next = script.shift(); return next || { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ ok: true }) }; } });

const express = (await import('express')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = req.get('x-test-actor') || null; next(); });
app.use('/api', (await import('../routes/integrations.js')).default());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = async (method, path, { body, who = 'stan@example.test', follow = false } = {}) => {
  const r = await fetch(base + path, { method, redirect: follow ? 'follow' : 'manual', headers: { 'Content-Type': 'application/json', ...(who ? { 'x-test-actor': who } : {}), 'x-forwarded-host': 'bot.example.test', 'x-forwarded-proto': 'https' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, location: r.headers.get('location') };
};

// save: neither a bot token nor an install pair
let r = await req('PUT', '/api/integrations/slack', { body: { fields: { SLACK_APP_TOKEN: 'xapp-1' } } });
ok('a Slack connection needs the bot token or the client id + secret', r.status === 400 && /Bot token/.test(r.json?.error || ''), r.json);
r = await req('PUT', '/api/integrations/slack', { body: { fields: { SLACK_APP_TOKEN: 'xapp-1', SLACK_CLIENT_ID: '111.222', SLACK_CLIENT_SECRET: 'shh' } } });
ok('the install pair alone is accepted', r.status === 200 && r.json?.ok === true, r.json);

// the list says: installed? can be from here?
r = await req('GET', '/api/integrations');
const sl = r.json.integrations.find(i => i.id === 'slack');
ok('the list says the app still needs installing and can be from here', sl?.install?.needed === true && sl.install.possible === true, sl?.install);
r = await req('GET', '/api/integrations', { who: 'ann@example.test' });
ok('...but only to an admin', !r.json.integrations.find(i => i.id === 'slack')?.install);

// manifest carries this workspace's callback
r = await req('GET', '/api/integrations/slack/manifest');
ok('the manifest names this workspace as the redirect', r.json?.oauth_config?.redirect_urls?.[0] === 'https://bot.example.test/api/integrations/slack/oauth/callback' && r.json.settings.socket_mode_enabled === true, r.json?.oauth_config);

// install → Slack's consent page
r = await req('GET', '/api/integrations/slack/install');
ok('the install link goes to Slack for the app\'s own client id', r.status === 302 && r.location?.startsWith('https://slack.com/oauth/v2/authorize?'), r.location);
const u = new URL(r.location);
ok('...with the surface\'s bot scopes, the callback and a state', u.searchParams.get('client_id') === '111.222' && u.searchParams.get('scope').split(',').includes('im:history') && u.searchParams.get('redirect_uri') === 'https://bot.example.test/api/integrations/slack/oauth/callback' && (u.searchParams.get('state') || '').length > 10);
const state = u.searchParams.get('state');
r = await req('GET', '/api/integrations/slack/install', { who: 'ann@example.test' });
ok('a member cannot start the install', r.status === 403 || r.status === 401);

// callback: the code becomes the bot token
script = [{ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ ok: true, access_token: 'xoxb-installed', team: { id: 'T1', name: 'Example' }, bot_user_id: 'U0BOT' }) }];
r = await req('GET', `/api/integrations/slack/oauth/callback?code=the-code&state=${encodeURIComponent(state)}`, { who: null });
const ex = calls.find(c => c.url.endsWith('oauth.v2.access'));
ok('the callback trades the code for the token at oauth.v2.access', r.status === 200 && /<title>Connected/.test(r.text) && !!ex && /client_secret=shh/.test(ex.init.body) && /code=the-code/.test(ex.init.body) && /redirect_uri=https%3A%2F%2Fbot.example.test/.test(ex.init.body), ex ? ex.init.body : r.text.slice(0, 200));
ok('...and the bot token is in the store', store.decryptFor('slack').SLACK_BOT_TOKEN === 'xoxb-installed');
r = await req('GET', '/api/integrations');
ok('the list no longer says the app needs installing', r.json.integrations.find(i => i.id === 'slack').install.needed === false);
r = await req('GET', `/api/integrations/slack/oauth/callback?code=again&state=${encodeURIComponent(state)}`, { who: null });
ok('a state is good once', r.status === 400 && /stale/.test(r.text));
r = await req('GET', '/api/integrations/slack/oauth/callback?code=x&state=made-up', { who: null });
ok('a made-up state is refused', r.status === 400);
r = await req('GET', '/api/integrations/slack/oauth/callback?error=access_denied', { who: null });
ok('a refusal at Slack is shown, not stored', r.status === 400 && /access_denied/.test(r.text));

server.close();
console.log(`slack-oauth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
