// A remote MCP whose provider has no dynamic client registration (HubSpot):
// the admin saves a client registered in the provider's console, and the OAuth
// broker uses it instead of registering one.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'oauth-own-client-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = join(ROOT, 'store');
process.env.INTEGRATIONS_KEY_PATH = join(ROOT, 'integrations.key');
process.env.MCP_OAUTH_PROXY_URL = '';
process.env.CLAUDE_CONFIG_PATH = join(ROOT, 'claude.json');
writeFileSync(process.env.CLAUDE_CONFIG_PATH, '{}');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, randomBytes(32).toString('hex'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL', name, extra ?? ''); } };

// The provider, as HubSpot advertises it: discovery without a
// registration_endpoint, a token endpoint that wants client_secret_post.
const MCP = 'https://mcp.hubspot.com';
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init.body ? String(init.body) : '';
  calls.push({ url, body });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/.well-known/oauth-protected-resource')) {
    return json({ resource: MCP, authorization_servers: [MCP] });
  }
  if (url.includes('/.well-known/oauth-authorization-server')) {
    return json({
      issuer: MCP,
      authorization_endpoint: `${MCP}/oauth/authorize/user`,
      token_endpoint: `${MCP}/oauth/v3/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (url === `${MCP}/oauth/v3/token`) {
    return json({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 1800 });
  }
  return json({ error: 'not_found' }, 404);
};

const store = await import('./integrations/store.js');
const oauth = await import('./integrations/oauth.js');
const runtime = await import('./integrations/runtime.js');
const BASE = 'https://workspace.example.com';
const REDIRECT = `${BASE}/api/integrations/oauth/callback`;

// ── nothing saved yet: no sign-in, no registration attempt ──────────────────
let err = null;
try { await oauth.startAuth('hubspot', BASE); } catch (e) { err = e; }
ok('sign-in refused before the client is saved', err && /client ID and secret/.test(err.message), err?.message);
ok('no provider call before the client is saved', calls.length === 0, calls);

// ── client saved through the normal activation ──────────────────────────────
store.activate('hubspot', { fields: { HUBSPOT_CLIENT_ID: 'cid-123', HUBSPOT_CLIENT_SECRET: 'sec-456' } });
ok('saved client counts as active', store.isActive('hubspot'));
ok('no tokens yet', !store.hasField('hubspot', 'OAUTH_TOKENS'));
const wired = () => JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_PATH, 'utf8')).mcpServers?.hubspot;
runtime.syncMcpServers();
ok('server not wired before sign-in', !wired());

const authorizeUrl = new URL(await oauth.startAuth('hubspot', BASE));
ok('authorize goes to the provider', authorizeUrl.href.startsWith(`${MCP}/oauth/authorize/user`), authorizeUrl.href);
ok('authorize carries the saved client ID', authorizeUrl.searchParams.get('client_id') === 'cid-123');
ok('authorize carries this workspace callback', authorizeUrl.searchParams.get('redirect_uri') === REDIRECT);
ok('authorize uses PKCE', authorizeUrl.searchParams.get('code_challenge_method') === 'S256');
ok('the secret never reaches the browser', !authorizeUrl.href.includes('sec-456'));
ok('no dynamic registration attempted', !calls.some(c => /register/i.test(c.url)), calls.map(c => c.url));
ok('no DCR client file written', !existsSync(join(process.env.WSAPI_STORE_DIR, 'mcp-oauth-clients.json')));

// ── callback: code exchanged with the saved client, tokens stored ──────────
await oauth.handleCallback(authorizeUrl.searchParams.get('state'), 'code-789');
const tokenCall = calls.find(c => c.url === `${MCP}/oauth/v3/token`);
const form = new URLSearchParams(tokenCall?.body || '');
ok('token exchange sends the client ID', form.get('client_id') === 'cid-123', tokenCall?.body);
ok('token exchange sends the secret (client_secret_post)', form.get('client_secret') === 'sec-456', tokenCall?.body);
ok('token exchange sends the code', form.get('code') === 'code-789');
ok('tokens stored', store.hasField('hubspot', 'OAUTH_TOKENS'));
const plain = store.decryptFor('hubspot');
ok('client kept beside the tokens', plain.HUBSPOT_CLIENT_ID === 'cid-123' && plain.HUBSPOT_CLIENT_SECRET === 'sec-456');
ok('access token served to the bot', await oauth.getFreshToken('hubspot') === 'at-1');

runtime.syncMcpServers();
ok('server wired after sign-in, token via the helper', wired()?.url === MCP && / hubspot$/.test(wired()?.headersHelper || ''), wired());

console.log(`oauth-own-client: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
