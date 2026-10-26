/**
 * URL-based OAuth client ids (MCP SEP-991, client ID metadata documents), with a
 * stand-in authorization server that offers both dynamic registration and
 * metadata documents: an entry without `mcp.clientIdMetadata` still registers
 * dynamically, exactly as before; an entry with it sends the document's URL as
 * its client_id, through the authorize redirect and the token exchange — and the
 * document itself holds nothing but the client name and the redirect URI.
 * Run: node lib/oauth-client-metadata.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'oauth-cimd-'));
const STORE = mkdtempSync(join(tmpdir(), 'oauth-cimd-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ef'.repeat(32));
process.env.INTEGRATIONS_CATALOG_LOCAL = join(STORE, 'catalog.local.json');
process.env.MCP_OAUTH_PROXY_URL = '';   // the stand-in is on loopback; no egress proxy here
mkdirSync(join(ROOT, '.team'), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };

// ─── the stand-in authorization server ──────────────────────────────────────
const seen = { registrations: [], tokens: [] };
const body = (req) => new Promise((done) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => done(s)); });
const srv = createServer(async (req, res) => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const url = new URL(req.url, base);
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
  if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
  });
  if (url.pathname === '/register' && req.method === 'POST') {
    const meta = JSON.parse(await body(req));
    seen.registrations.push(meta);
    return send(201, { ...meta, client_id: `dcr-${seen.registrations.length}` });
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    seen.tokens.push(Object.fromEntries(new URLSearchParams(await body(req))));
    return send(200, { access_token: 'stand-in-access', refresh_token: 'stand-in-refresh', token_type: 'Bearer', expires_in: 3600 });
  }
  res.writeHead(404); res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const MCP_URL = `http://127.0.0.1:${srv.address().port}/mcp`;

const entry = (id, extra = {}) => ({
  id, label: id, description: 'stand-in', category: 'other',
  fields: [{ name: 'OAUTH_TOKENS', label: 'connection', type: 'remote-mcp-oauth' }],
  mcp: { type: 'http', url: MCP_URL, name: id, allowedHosts: ['127.0.0.1'], ...extra },
});
writeFileSync(process.env.INTEGRATIONS_CATALOG_LOCAL, JSON.stringify({ integrations: [
  entry('stub-dcr'),
  entry('stub-cimd', { clientIdMetadata: true }),
] }));

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('oauth-client-metadata: the crypto key is not readable in this environment — skipped'); srv.close(); process.exit(0); }
const oauth = await import('./integrations/oauth.js');
const store = await import('./integrations/store.js');

const BASE = 'https://workspace.example.test';
const DOC_URL = `${BASE}${oauth.CLIENT_METADATA_PATH}`;
const REDIRECT = `${BASE}/api/integrations/oauth/callback`;
const clientIdOf = (u) => new URL(u).searchParams.get('client_id');
const stateOf = (u) => new URL(u).searchParams.get('state');

// ─── without the flag: dynamic registration, as before ──────────────────────
{
  const at = await oauth.startAuth('stub-dcr', BASE);
  ok('no flag: the client registers dynamically', seen.registrations.length === 1, seen.registrations);
  ok('no flag: the authorize URL carries the registered client_id', clientIdOf(at) === 'dcr-1', at);
  ok('no flag: the registration names this deployment\'s redirect', seen.registrations[0]?.redirect_uris?.[0] === REDIRECT, seen.registrations[0]);
}

// ─── with the flag: the document's URL is the client_id ─────────────────────
{
  const at = await oauth.startAuth('stub-cimd', BASE);
  ok('flag: no dynamic registration', seen.registrations.length === 1, seen.registrations);
  ok('flag: the authorize URL carries the document URL as client_id', clientIdOf(at) === DOC_URL, at);
  ok('flag: the authorize URL carries the same redirect', new URL(at).searchParams.get('redirect_uri') === REDIRECT, at);

  const key = await oauth.handleCallback(stateOf(at), 'stand-in-code');
  const last = seen.tokens.at(-1) || {};
  ok('flag: the token exchange sends the same URL client_id', last.client_id === DOC_URL && last.code === 'stand-in-code', last);
  ok('flag: the tokens land in the store', key === 'stub-cimd' && JSON.parse(store.decryptFor(key).OAUTH_TOKENS).access_token === 'stand-in-access');

  // A second connect reuses the URL id; a move to another domain is a new one.
  const again = await oauth.startAuth('stub-cimd', BASE);
  ok('flag: a reconnect keeps the URL client_id, still no registration', clientIdOf(again) === DOC_URL && seen.registrations.length === 1, again);
  const moved = await oauth.startAuth('stub-cimd', 'https://moved.example.test');
  ok('flag: a moved domain sends its own document URL', clientIdOf(moved) === `https://moved.example.test${oauth.CLIENT_METADATA_PATH}` && seen.registrations.length === 1, moved);
}

// ─── the document: the name and the redirect, nothing else ──────────────────
{
  const doc = oauth.clientMetadataDocument(`${BASE}/`);
  ok('document: client_id is its own URL', doc.client_id === DOC_URL, doc);
  ok('document: the one redirect URI on this domain', JSON.stringify(doc.redirect_uris) === JSON.stringify([REDIRECT]), doc);
  ok('document: a public client (PKCE), no secret', doc.token_endpoint_auth_method === 'none' && !('client_secret' in doc), doc);
  const keys = Object.keys(doc).sort().join();
  ok('document: no field beyond the name, redirect and grant shape', keys === 'client_id,client_name,grant_types,redirect_uris,response_types,token_endpoint_auth_method', keys);
}

srv.close();
console.log(`oauth-client-metadata: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
