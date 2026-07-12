/**
 * MCP-spec OAuth broker for remote (`mcp.type: "http"`) integrations.
 *
 * workspace-api — not Claude Code — is the OAuth client here. Claude Code's
 * built-in MCP OAuth needs a loopback redirect on the machine running the
 * CLI, which a headless container can never satisfy. Instead the browser
 * flow terminates on this server (the client's own domain, routed by Caddy
 * through the existing /api prefix), tokens land in the encrypted store,
 * and the bot only ever sees short-lived access tokens through
 * /api/internal/mcp-token/:id (see routes/internal.js + mcp-auth-helper.sh).
 *
 * The protocol legwork (RFC 9728/8414 discovery, RFC 7591 dynamic client
 * registration, PKCE, refresh) is the official MCP SDK's auth module — the
 * same code path Claude Code itself uses — so per-provider quirks stay the
 * provider's problem, not ours.
 *
 * State layout:
 *   - OAuth tokens        → encrypted store field OAUTH_TOKENS (JSON string:
 *                           { access_token, refresh_token?, expires_at?, scope? })
 *   - DCR client identity → ${WSAPI_STORE_DIR}/mcp-oauth-clients.json, 0600.
 *                           client_id is not a secret (it rides in every
 *                           authorize URL) but lives next to the store anyway.
 *   - In-flight flows     → in-memory Map keyed by the OAuth `state` param,
 *                           10-minute TTL. A wsapi restart aborts pending
 *                           popups; the user just clicks Connect again.
 */

import { auth, refreshAuthorization, discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import { ProxyAgent } from 'undici';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from '../config.js';
import * as catalog from './catalog.js';
import * as store from './store.js';

// workspace-api has no direct egress; its outbound must go through the egress
// proxy. The OAuth broker talks to provider hosts (discovery, DCR, token,
// refresh) BEFORE the integration is active — so the provider host is NOT yet
// on the strict per-integration allowlist (that's written on activation). We
// route these fetches through the proxy's OPEN listener (the same path
// Playwright browsing uses), which permits any public host without per-host
// allowlisting, and blocks RFC1918/loopback. Scoped to the OAuth SDK calls via
// fetchFn so the rest of wsapi (incl. its loopback fetches) is untouched.
//
// Set MCP_OAUTH_PROXY_URL='' to disable (local dev with direct internet).
const OAUTH_PROXY_URL = process.env.MCP_OAUTH_PROXY_URL ?? 'http://egress-proxy:3130';
const oauthDispatcher = OAUTH_PROXY_URL ? new ProxyAgent(OAUTH_PROXY_URL) : undefined;
// Use the GLOBAL fetch (not undici's exported fetch) so the SDK's
// `input instanceof Response` checks pass — undici's Response is a different
// class, which made the SDK's error parser stringify it to "[object Response]"
// on any non-2xx. Node's global fetch still honours undici's `dispatcher`.
const proxyFetch = oauthDispatcher
  ? (url, init) => fetch(url, { ...init, dispatcher: oauthDispatcher })
  : undefined;   // undefined → SDK falls back to its default global fetch

const DIR          = process.env.WSAPI_STORE_DIR || join(PROJECT_DIR, '.integrations');
const CLIENTS_FILE = join(DIR, 'mcp-oauth-clients.json');
const CLIENTS_TMP  = join(DIR, '.mcp-oauth-clients.json.tmp');

const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 120 * 1000;   // refresh when <2 min of life left

/** OAuth `state` → { id, serverUrl, redirectUrl, verifier, createdAt } */
const pending = new Map();

/** integration id → in-flight refresh promise (stampede guard) */
const refreshing = new Map();

/** serverUrl → { asUrl, metadata, fetchedAt } — discovery cache (1 h) */
const discovery = new Map();

// ─── DCR client persistence ─────────────────────────────────────────────────

function readClients() {
  if (!existsSync(CLIENTS_FILE)) return {};
  try { return JSON.parse(readFileSync(CLIENTS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeClients(all) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CLIENTS_TMP, JSON.stringify(all, null, 2), { mode: 0o600 });
  try { chmodSync(CLIENTS_TMP, 0o600); } catch {}
  renameSync(CLIENTS_TMP, CLIENTS_FILE);
  try { chmodSync(CLIENTS_FILE, 0o600); } catch {}
}

// ─── helpers ────────────────────────────────────────────────────────────────

function catFor(id) {
  const cat = catalog.get(id);
  if (!cat?.mcp || cat.mcp.type !== 'http' || !cat.mcp.url) {
    throw new Error(`${id} is not a remote-MCP integration`);
  }
  return cat;
}

function sweepPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

/** Resolve (and cache) the authorization server for a remote MCP endpoint. */
async function authServerFor(serverUrl) {
  const hit = discovery.get(serverUrl);
  if (hit && Date.now() - hit.fetchedAt < 3600_000) return hit;
  let asUrl = serverUrl;
  try {
    const prm = await discoverOAuthProtectedResourceMetadata(serverUrl, undefined, proxyFetch);
    if (prm?.authorization_servers?.length) asUrl = prm.authorization_servers[0];
  } catch { /* some servers skip RFC 9728; AS then defaults to the MCP origin */ }
  const metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn: proxyFetch });
  const entry = { asUrl, metadata, fetchedAt: Date.now() };
  discovery.set(serverUrl, entry);
  return entry;
}

/**
 * Build an OAuthClientProvider bound to one integration + one redirect URL.
 * `flow` collects side effects (authorize URL, issued state) during auth().
 */
function makeProvider(id, redirectUrl, flow) {
  return {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() {
      return {
        client_name: 'Something Integrations',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',   // public client — PKCE carries the proof
      };
    },
    state: () => flow.state,
    clientInformation: () => readClients()[id],
    saveClientInformation: (info) => {
      const all = readClients();
      all[id] = info;
      writeClients(all);
    },
    // startAuth must never see stale tokens (auth() would try to refresh
    // them instead of starting a new code flow); the callback exchange
    // doesn't read tokens at all. Writes go through saveTokens below.
    tokens: () => undefined,
    saveTokens: (t) => {
      flow.tokens = {
        access_token:  t.access_token,
        refresh_token: t.refresh_token,
        token_type:    t.token_type,
        scope:         t.scope,
        expires_at:    t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      };
    },
    redirectToAuthorization: (url) => { flow.authorizeUrl = url.toString(); },
    saveCodeVerifier: (v) => { flow.verifier = v; },
    codeVerifier: () => flow.verifier,
  };
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Begin the OAuth flow for a remote-MCP integration. Performs discovery and,
 * on first contact, dynamic client registration. Returns the provider
 * authorize URL the browser (popup) should navigate to.
 *
 * `baseUrl` is this deployment's public origin (https://<client-domain>),
 * derived by the route from FRONTEND_DOMAIN or the forwarded Host header.
 */
export async function startAuth(id, baseUrl) {
  const cat = catFor(id);
  sweepPending();

  const redirectUrl = `${baseUrl.replace(/\/$/, '')}/api/integrations/oauth/callback`;
  const flow = { state: randomBytes(24).toString('base64url') };
  const provider = makeProvider(id, redirectUrl, flow);

  const result = await auth(provider, { serverUrl: cat.mcp.url, fetchFn: proxyFetch });
  if (result !== 'REDIRECT' || !flow.authorizeUrl) {
    throw new Error(`unexpected auth result for ${id}: ${result}`);
  }

  pending.set(flow.state, {
    id,
    serverUrl:  cat.mcp.url,
    redirectUrl,
    verifier:   flow.verifier,
    createdAt:  Date.now(),
  });
  return flow.authorizeUrl;
}

/**
 * Complete the flow from the provider's redirect. Validates `state` against
 * the pending map (this is the only thing that authenticates the callback —
 * the browser session is deliberately not required), exchanges the code,
 * and persists tokens into the encrypted store. Returns the integration id.
 */
export async function handleCallback(state, code) {
  sweepPending();
  const flow0 = pending.get(state);
  if (!flow0) throw new Error('unknown or expired OAuth state');
  pending.delete(state);

  const flow = { state, verifier: flow0.verifier };
  const provider = makeProvider(flow0.id, flow0.redirectUrl, flow);
  const result = await auth(provider, { serverUrl: flow0.serverUrl, authorizationCode: code, fetchFn: proxyFetch });
  if (result !== 'AUTHORIZED' || !flow.tokens) {
    throw new Error(`token exchange failed for ${flow0.id}: ${result}`);
  }

  const fields = { OAUTH_TOKENS: JSON.stringify(flow.tokens) };
  if (store.isActive(flow0.id)) store.updateInternal(flow0.id, fields);
  else store.activate(flow0.id, { fields });
  return flow0.id;
}

/**
 * Return a currently-valid access token for an active remote-MCP
 * integration, refreshing through the provider when <2 min of life remain.
 * Refreshes are deduplicated per id. Throws { code: 'reauth_required' }
 * when there is no usable token — the dashboard then shows Reconnect.
 */
export async function getFreshToken(id) {
  catFor(id);
  if (!store.isActive(id)) {
    throw Object.assign(new Error(`${id} is not connected`), { code: 'reauth_required' });
  }
  const plain = store.decryptFor(id);
  let tokens;
  try { tokens = JSON.parse(plain.OAUTH_TOKENS || 'null'); } catch { tokens = null; }
  if (!tokens?.access_token) {
    throw Object.assign(new Error(`${id} has no stored OAuth tokens`), { code: 'reauth_required' });
  }

  const fresh = !tokens.expires_at || tokens.expires_at - Date.now() > REFRESH_SKEW_MS;
  if (fresh) return tokens.access_token;

  if (!tokens.refresh_token) {
    throw Object.assign(new Error(`${id} token expired and no refresh_token`), { code: 'reauth_required' });
  }

  if (refreshing.has(id)) return refreshing.get(id);
  const job = (async () => {
    try {
      const cat = catFor(id);
      const { asUrl, metadata } = await authServerFor(cat.mcp.url);
      const clientInformation = readClients()[id];
      if (!clientInformation) {
        throw Object.assign(new Error(`${id} has no registered OAuth client`), { code: 'reauth_required' });
      }
      const t = await refreshAuthorization(asUrl, {
        metadata,
        clientInformation,
        refreshToken: tokens.refresh_token,
        resource: new URL(cat.mcp.url),
        fetchFn: proxyFetch,
      });
      const next = {
        access_token:  t.access_token,
        // some providers rotate the refresh token on every use
        refresh_token: t.refresh_token || tokens.refresh_token,
        token_type:    t.token_type,
        scope:         t.scope ?? tokens.scope,
        expires_at:    t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      };
      store.updateInternal(id, { OAUTH_TOKENS: JSON.stringify(next) });
      return next.access_token;
    } catch (err) {
      // A rejected refresh (revoked grant, rotated-and-lost token) is not
      // transient — surface as reauth so the UI can prompt Reconnect.
      if (!err.code) err.code = 'reauth_required';
      throw err;
    } finally {
      refreshing.delete(id);
    }
  })();
  refreshing.set(id, job);
  return job;
}

/** Drop the DCR client registration for an integration (on DELETE). */
export function forgetClient(id) {
  const all = readClients();
  if (all[id]) { delete all[id]; writeClients(all); }
}
