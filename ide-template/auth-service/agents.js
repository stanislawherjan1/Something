/**
 * The authorization server for coding agents (Claude Code, Codex, Cursor):
 * a person connects their agent to this workspace's MCP endpoint once, in the
 * browser, and the agent then reads the company context as that person.
 *
 * OAuth 2.1 as the MCP authorization spec (2025-11-25) asks for it:
 *   - protected-resource metadata (RFC 9728) naming this server;
 *   - authorization-server metadata (RFC 8414) with PKCE S256 only;
 *   - client registration by Client ID Metadata Document (the client_id is an
 *     HTTPS URL to the client's own metadata) or, for older clients, dynamic
 *     registration (RFC 7591); a public client, never a secret;
 *   - the authorization code flow with the `resource` indicator (RFC 8707),
 *     tokens minted for this MCP endpoint only;
 *   - opaque access tokens (one hour) and rotating refresh tokens (thirty days,
 *     sliding), stored hashed; revocation (RFC 7009).
 *
 * It lives here, not in workspace-api, on purpose: this is the one process
 * that already talks to Google, holds the session secret, has the roster and
 * direct internet (the client metadata fetch), and holds no integration keys.
 * workspace-api never sees a bearer token — nginx asks /auth/verify-agent and
 * passes the verified identity on, signed, the way it passes X-IDE-User.
 *
 * A grant is a person's: every use re-checks the roster, and a sign-out
 * everywhere or a removal from the team ends it like a session.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const express = require('express');

// read:private — the person's private things (their folder, their private
// memory, their own task list); off unless they tick it.
const SCOPES = ['read', 'read:private', 'write:tasks', 'write:memory', 'write:files', 'ask'];
const READ_SCOPE = 'read';
const ACCESS_TTL_MS = 60 * 60 * 1000;                 // one hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // thirty days, sliding
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const PENDING_CLIENT_TTL_MS = 60 * 60 * 1000;
const CIMD_CACHE_MS = 60 * 60 * 1000;
const CIMD_MAX_BYTES = 16 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const VERIFY_SIG_TTL_MS = 60 * 1000;
const NAME_MAX = 80;

const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const clean = (s, max = NAME_MAX) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const timingEqual = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ── Grants on disk ───────────────────────────────────────────────────────────
// { version, clients: { id → { id, name, redirectUris, kind, createdAt } },
//   grants: { id → { id, email, clientId, clientName, redirectHost, scopes,
//                    createdAt, lastUsedAt, refresh: { hash, exp }, access: [{ hash, exp }] } } }
class GrantStore {
    constructor(dir) {
        this.file = path.join(dir, 'agent-grants.json');
        this.data = { version: 1, clients: {}, grants: {} };
        try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (raw && raw.version === 1) this.data = { version: 1, clients: raw.clients || {}, grants: raw.grants || {} };
        } catch { /* first run */ }
    }
    save() {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }
    client(id) { return this.data.clients[id] || null; }
    putClient(c) { this.data.clients[c.id] = c; this.save(); }
    grant(id) { return this.data.grants[id] || null; }
    putGrant(g) { this.data.grants[g.id] = g; this.save(); }
    dropGrant(id) { delete this.data.grants[id]; this.save(); }
    grants() { return Object.values(this.data.grants); }
    byAccessHash(hash) {
        for (const g of this.grants()) if ((g.access || []).some(a => a.hash === hash)) return g;
        return null;
    }
    byRefreshHash(hash) {
        for (const g of this.grants()) if (g.refresh && g.refresh.hash === hash) return g;
        // A refresh token used twice: the first use rotated it. OAuth 2.1 says
        // the grant is compromised; the caller revokes it.
        for (const g of this.grants()) if ((g.spentRefresh || []).includes(hash)) return { reused: true, grant: g };
        return null;
    }
}

// ── Redirect URIs ────────────────────────────────────────────────────────────
// Loopback only (http, any port). The agents this is for (Claude Code, Codex)
// run on the person's computer and listen there; a redirect to a website would
// let anyone register a client named "Claude Code" that sends the code to their
// own server, and phish a teammate into clicking Allow. A web client can be
// allowed later by name, not by registration.
function validRedirectUri(u) {
    let url;
    try { url = new URL(String(u)); } catch { return false; }
    if (url.hash || url.username || url.password) return false;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}
function isLoopback(u) { try { return new URL(u).protocol === 'http:'; } catch { return false; } }
// Does a client's registered redirect URI cover the one it is using? Exact,
// except that a loopback URI covers any port (RFC 8252 §7.3): a native client
// opens a listener on whatever port is free and cannot register them all.
function redirectCovered(registered, used) {
    if (registered === used) return true;
    let r, u;
    try { r = new URL(registered); u = new URL(used); } catch { return false; }
    if (!isLoopback(registered) || !isLoopback(used)) return false;
    return r.hostname === u.hostname && r.pathname === u.pathname && r.search === u.search;
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

// ── Private address ranges (the client metadata fetch must never reach them) ─
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (net.isIPv6(ip)) {
        const low = ip.toLowerCase();
        if (low === '::1' || low === '::') return true;
        if (low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80')) return true;
        const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
        if (m) return isPrivateIp(m[1]);
        return false;
    }
    return true;   // not an address at all
}
function isPrivateHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (net.isIP(h)) return isPrivateIp(h);
    return false;
}

// ── Client ID Metadata Documents ─────────────────────────────────────────────
// The client's id is the HTTPS URL of a JSON document it hosts; we fetch it,
// check that the document claims that very URL, and take the name and the
// redirect URIs from it. Fetched by a server on behalf of an unknown caller,
// so: https only, public addresses only (checked after DNS, and the fetch
// does not follow redirects), small, short, cached.
const cimdCache = new Map();
async function fetchClientMetadata(clientId) {
    let url;
    try { url = new URL(clientId); } catch { throw new Error('client_id is not a URL'); }
    if (url.protocol !== 'https:' || !url.pathname || url.pathname === '/' || url.hash || url.username || url.password) throw new Error('client_id must be an https URL with a path');
    if (isPrivateHost(url.hostname)) throw new Error('client_id host is not public');
    const cached = cimdCache.get(clientId);
    if (cached && cached.at > Date.now() - CIMD_CACHE_MS) return cached.doc;
    let addrs = [];
    try { addrs = await dns.lookup(url.hostname, { all: true }); } catch { throw new Error('client_id host does not resolve'); }
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('client_id host is not public');
    // The connection goes to the address just checked, not to a second lookup
    // (a DNS answer that changes in between would point it inside).
    const text = await getPinned(url, addrs[0]);
    let doc;
    try { doc = JSON.parse(text); } catch { throw new Error('client metadata is not JSON'); }
    if (!doc || typeof doc !== 'object' || doc.client_id !== clientId) throw new Error('client metadata does not claim this client_id');
    // Only its loopback redirects count (see validRedirectUri); a document with none is refused.
    const loopback = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String).filter(validRedirectUri) : [];
    if (!loopback.length) throw new Error('client metadata has no loopback redirect_uris');
    if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') throw new Error('only public clients (token_endpoint_auth_method none) are accepted');
    const out = { id: clientId, name: clean(doc.client_name) || url.hostname, redirectUris: loopback, kind: 'cimd', uri: clean(doc.client_uri, 200) || null };
    cimdCache.set(clientId, { at: Date.now(), doc: out });
    return out;
}

/** GET over https to one already-checked address; no redirects, small, short; errors say nothing of the network. */
function getPinned(url, addr) {
    return new Promise((resolve, reject) => {
        const fail = (why) => reject(new Error(why));
        const lookup = (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family));
        const req = https.request(url, { method: 'GET', headers: { accept: 'application/json' }, lookup, timeout: CIMD_TIMEOUT_MS }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return fail(`client metadata answered ${res.statusCode}`); }
            const chunks = []; let size = 0;
            res.on('data', (c) => { size += c.length; if (size > CIMD_MAX_BYTES) { req.destroy(); fail('client metadata too large'); } else chunks.push(c); });
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', () => fail('client metadata could not be fetched'));
        });
        req.on('timeout', () => { req.destroy(); fail('client metadata could not be fetched: timeout'); });
        req.on('error', () => fail('client metadata could not be fetched'));
        req.end();
    });
}

/**
 * The key the gate signs an agent's identity with: derived from the session
 * secret, so the secret that signs sign-in sessions signs nothing else.
 * workspace-api derives the same (lib/mcp/identity.js).
 */
function agentGateKey(secret) {
    return crypto.createHmac('sha256', String(secret)).update('something/agent-gate/v1').digest();
}

// ── Mount ────────────────────────────────────────────────────────────────────
/**
 * @param app express app
 * @param opts { appUrl, sessionCookie, sessionSecret, verifySessionToken, whitelist, limiter, storeDir }
 */
function mountAgents(app, opts) {
    const { appUrl, sessionCookie, sessionSecret, verifySessionToken, whitelist, limiter } = opts;
    const store = new GrantStore(opts.storeDir || process.env.AUTH_STORE_DIR || '/var/auth-store');
    const RESOURCE = `${appUrl}/mcp`;
    const GATE_KEY = agentGateKey(sessionSecret);
    const ISSUER = appUrl;

    const pendingClients = new Map();   // DCR clients before their first consent: id → client
    const authRequests = new Map();     // req id → the authorize parameters, for the consent page
    const codes = new Map();            // code hash → { clientId, redirectUri, challenge, email, scopes, exp }
    setInterval(() => {
        const t = Date.now();
        for (const [k, v] of pendingClients) if (v.exp < t) pendingClients.delete(k);
        for (const [k, v] of authRequests) if (v.exp < t) authRequests.delete(k);
        for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
    }, 60_000).unref();

    // The signed-in person behind a request (cookie or the extension's bearer
    // session), re-checked against the roster the way /auth/verify does.
    function personOf(req) {
        const token = req.cookies?.[sessionCookie] || null;
        if (!token) return null;
        try {
            const p = verifySessionToken(token);
            if (!whitelist.isAllowed(p.email) || whitelist.signedOutSince(p.email, p.iat)) return null;
            return { email: String(p.email).toLowerCase(), name: p.name || '', role: whitelist.roleOf(p.email) };
        } catch { return null; }
    }
    const requirePerson = (req, res, next) => {
        const who = personOf(req);
        if (!who) return res.status(401).json({ error: 'sign in first' });
        req.person = who;
        next();
    };

    async function resolveClient(clientId) {
        if (!clientId) return null;
        const known = store.client(clientId) || pendingClients.get(clientId)?.client || null;
        if (known) return known;
        if (/^https:\/\//i.test(clientId)) return fetchClientMetadata(clientId);
        return null;
    }

    const oauthError = (res, status, error, description) => {
        res.set('Cache-Control', 'no-store');
        return res.status(status).json({ error, error_description: description });
    };
    const redirectWithError = (res, redirectUri, state, error, description) => {
        const u = new URL(redirectUri);
        u.searchParams.set('error', error);
        if (description) u.searchParams.set('error_description', description);
        if (state) u.searchParams.set('state', state);
        u.searchParams.set('iss', ISSUER);
        return res.redirect(u.toString());
    };

    // ── Discovery ──
    const prm = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            resource: RESOURCE,
            authorization_servers: [ISSUER],
            scopes_supported: SCOPES,
            bearer_methods_supported: ['header'],
            resource_name: 'Something',
        });
    };
    app.get('/.well-known/oauth-protected-resource', prm);
    app.get('/.well-known/oauth-protected-resource/mcp', prm);
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            issuer: ISSUER,
            authorization_endpoint: `${appUrl}/oauth/authorize`,
            token_endpoint: `${appUrl}/oauth/token`,
            registration_endpoint: `${appUrl}/oauth/register`,
            revocation_endpoint: `${appUrl}/oauth/revoke`,
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
            scopes_supported: SCOPES,
            client_id_metadata_document_supported: true,
            authorization_response_iss_parameter_supported: true,
        });
    });

    // ── Dynamic registration (older clients) ──
    // Nothing is written to disk until the client's first consent: an anonymous
    // caller cannot grow the store.
    app.post('/oauth/register', limiter, express.json({ limit: '8kb' }), (req, res) => {
        const b = req.body || {};
        const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
        if (!uris.length || !uris.every(validRedirectUri)) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be loopback http URLs (an agent on the person\'s computer)');
        if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') return oauthError(res, 400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method none) are accepted');
        const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code'];
        if (!grants.includes('authorization_code')) return oauthError(res, 400, 'invalid_client_metadata', 'authorization_code is required');
        const id = `dcr_${rand(18)}`;
        const client = { id, name: clean(b.client_name) || 'An MCP client', redirectUris: uris, kind: 'dcr', uri: clean(b.client_uri, 200) || null, createdAt: nowIso() };
        pendingClients.set(id, { client, exp: Date.now() + PENDING_CLIENT_TTL_MS });
        res.set('Cache-Control', 'no-store');
        return res.status(201).json({
            client_id: id,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: client.name,
            redirect_uris: uris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        });
    });

    // ── Authorize ──
    // Validates the request, parks it under a short id, and sends the person
    // to the consent page (through Google sign-in first when there is no
    // session). The page asks the server for the parked request and answers
    // with the person's choice; the code is minted there.
    app.get('/oauth/authorize', limiter, async (req, res) => {
        const q = req.query;
        const clientId = String(q.client_id || '');
        const redirectUri = String(q.redirect_uri || '');
        let client;
        try { client = await resolveClient(clientId); } catch (e) { console.warn(`[auth/agents] authorize refused: ${e.message} (${clientId.slice(0, 200)})`); return oauthError(res, 400, 'invalid_client', e.message); }
        if (!client) { console.warn(`[auth/agents] authorize refused: unknown client_id ${clientId.slice(0, 200)}`); return oauthError(res, 400, 'invalid_client', 'unknown client_id'); }
        if (!client.redirectUris.some(r => redirectCovered(r, redirectUri))) {
            console.warn(`[auth/agents] authorize refused: redirect_uri ${redirectUri} not registered for ${client.kind} client ${clientId} (${client.redirectUris.join(', ')})`);
            return oauthError(res, 400, 'invalid_request', 'redirect_uri is not registered for this client');
        }
        // From here on errors go back to the client, as OAuth asks.
        const state = typeof q.state === 'string' ? q.state.slice(0, 512) : '';
        if (q.response_type !== 'code') return redirectWithError(res, redirectUri, state, 'unsupported_response_type', 'response_type must be code');
        if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(q.code_challenge || ''))) return redirectWithError(res, redirectUri, state, 'invalid_request', 'PKCE S256 is required');
        if (q.resource !== undefined && String(q.resource).replace(/\/$/, '') !== RESOURCE) return redirectWithError(res, redirectUri, state, 'invalid_target', `resource must be ${RESOURCE}`);
        const asked = String(q.scope || '').split(/\s+/).filter(Boolean);
        if (asked.some(s => !SCOPES.includes(s))) return redirectWithError(res, redirectUri, state, 'invalid_scope', `scopes: ${SCOPES.join(' ')}`);
        // The person chooses, not the client: the consent page always offers
        // every scope, with its own defaults. Clients ask for different things
        // (Claude Code for nothing in particular, Codex for what the 401
        // challenge names, i.e. read) and that must not decide what can be ticked.
        const scopes = SCOPES;
        const id = rand(24);
        authRequests.set(id, { clientId, client, redirectUri, state, challenge: String(q.code_challenge), scopes, exp: Date.now() + REQUEST_TTL_MS });
        const consent = `/app/connect?req=${id}`;
        if (personOf(req)) return res.redirect(consent);
        return res.redirect(`/auth/google?returnTo=${encodeURIComponent(consent)}`);
    });

    // The consent page reads the parked request…
    app.get('/auth/agents/request/:id', requirePerson, (req, res) => {
        const r = authRequests.get(String(req.params.id));
        if (!r || r.exp < Date.now()) return res.status(404).json({ error: 'This connection request has expired. Start again from your coding agent.' });
        res.set('Cache-Control', 'no-store');
        return res.json({
            id: req.params.id,
            client: { name: r.client.name, uri: r.client.uri || null, kind: r.client.kind },
            redirectHost: hostOf(r.redirectUri),
            loopback: isLoopback(r.redirectUri),
            scopes: r.scopes,
            person: { email: req.person.email, name: req.person.name },
        });
    });
    // …and answers with the person's choice.
    app.post('/auth/agents/consent', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
        const b = req.body || {};
        const r = authRequests.get(String(b.req || ''));
        if (!r || r.exp < Date.now()) return res.status(404).json({ error: 'This connection request has expired. Start again from your coding agent.' });
        authRequests.delete(String(b.req));   // single use, allow or deny
        const u = new URL(r.redirectUri);
        if (b.allow !== true) {
            u.searchParams.set('error', 'access_denied');
            if (r.state) u.searchParams.set('state', r.state);
            u.searchParams.set('iss', ISSUER);
            return res.json({ ok: true, redirect: u.toString() });
        }
        // The person may grant less than the client asked, never more; read is always in.
        const chosen = Array.isArray(b.scopes) ? b.scopes.map(String).filter(s => r.scopes.includes(s)) : r.scopes;
        const scopes = [...new Set([READ_SCOPE, ...chosen])];
        if (r.client.kind === 'dcr' && !store.client(r.clientId)) { store.putClient(r.client); pendingClients.delete(r.clientId); }
        const code = `sc_${rand(32)}`;
        codes.set(sha256(code), { clientId: r.clientId, clientName: r.client.name, redirectUri: r.redirectUri, challenge: r.challenge, email: req.person.email, scopes, exp: Date.now() + CODE_TTL_MS });
        u.searchParams.set('code', code);
        if (r.state) u.searchParams.set('state', r.state);
        u.searchParams.set('iss', ISSUER);
        return res.json({ ok: true, redirect: u.toString() });
    });

    // ── Token ──
    const mintAccess = (g) => {
        const token = `sa_${rand(32)}`;
        const exp = Date.now() + ACCESS_TTL_MS;
        g.access = (g.access || []).filter(a => a.exp > Date.now()).slice(-4);
        g.access.push({ hash: sha256(token), exp });
        return { token, exp };
    };
    const mintRefresh = (g) => {
        const token = `sr_${rand(32)}`;
        if (g.refresh) g.spentRefresh = [...(g.spentRefresh || []).slice(-4), g.refresh.hash];
        g.refresh = { hash: sha256(token), exp: Date.now() + REFRESH_TTL_MS };
        return token;
    };
    const tokenResponse = (res, g, access, refresh) => {
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        return res.json({ access_token: access.token, token_type: 'Bearer', expires_in: Math.floor((access.exp - Date.now()) / 1000), refresh_token: refresh, scope: g.scopes.join(' ') });
    };

    app.post('/oauth/token', limiter, express.urlencoded({ extended: false, limit: '8kb' }), express.json({ limit: '8kb' }), (req, res) => {
        const b = req.body || {};
        const clientId = String(b.client_id || '');
        if (b.grant_type === 'authorization_code') {
            const entry = codes.get(sha256(String(b.code || '')));
            codes.delete(sha256(String(b.code || '')));   // one try, success or not
            if (!entry || entry.exp < Date.now()) return oauthError(res, 400, 'invalid_grant', 'code is unknown or expired');
            if (entry.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'code was issued to another client');
            if (String(b.redirect_uri || '') !== entry.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri differs from the authorization request');
            if (b.resource !== undefined && String(b.resource).replace(/\/$/, '') !== RESOURCE) return oauthError(res, 400, 'invalid_target', `resource must be ${RESOURCE}`);
            const verifier = String(b.code_verifier || '');
            if (!/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier) || !timingEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), entry.challenge)) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
            if (!whitelist.isAllowed(entry.email)) return oauthError(res, 400, 'invalid_grant', 'the person is no longer on this workspace\'s team');
            const g = {
                id: `g_${rand(12)}`, email: entry.email, clientId, clientName: entry.clientName, redirectHost: hostOf(entry.redirectUri),
                scopes: entry.scopes, createdAt: nowIso(), lastUsedAt: null, refresh: null, access: [],
            };
            const access = mintAccess(g);
            const refresh = mintRefresh(g);
            store.putGrant(g);
            console.log(`[auth/agents] ${entry.email} connected ${entry.clientName} (${g.scopes.join(' ')})`);
            return tokenResponse(res, g, access, refresh);
        }
        if (b.grant_type === 'refresh_token') {
            const found = store.byRefreshHash(sha256(String(b.refresh_token || '')));
            if (!found) return oauthError(res, 400, 'invalid_grant', 'refresh token is unknown');
            if (found.reused) {
                // A spent refresh token presented again: someone else has it. End the grant.
                store.dropGrant(found.grant.id);
                console.warn(`[auth/agents] refresh token reuse for ${found.grant.email} / ${found.grant.clientName}: grant revoked`);
                return oauthError(res, 400, 'invalid_grant', 'refresh token was already used; the connection has been revoked, connect again');
            }
            const g = found;
            if (g.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'refresh token belongs to another client');
            if (g.refresh.exp < Date.now()) { store.dropGrant(g.id); return oauthError(res, 400, 'invalid_grant', 'refresh token expired; connect again'); }
            const alive = liveGrant(g);
            if (!alive.ok) { store.dropGrant(g.id); return oauthError(res, 400, 'invalid_grant', alive.why); }
            const access = mintAccess(g);
            const refresh = mintRefresh(g);
            store.putGrant(g);
            return tokenResponse(res, g, access, refresh);
        }
        return oauthError(res, 400, 'unsupported_grant_type', 'authorization_code or refresh_token');
    });

    // A grant ends with the person: taken off the roster, or signed out
    // everywhere after the grant was made.
    function liveGrant(g) {
        if (!whitelist.isAllowed(g.email)) return { ok: false, why: 'the person is no longer on this workspace\'s team' };
        if (whitelist.signedOutSince(g.email, Math.floor(Date.parse(g.createdAt) / 1000))) return { ok: false, why: 'the person signed out everywhere; connect again' };
        return { ok: true };
    }

    // ── Revoke (RFC 7009): what `claude mcp logout` calls ──
    app.post('/oauth/revoke', limiter, express.urlencoded({ extended: false, limit: '8kb' }), express.json({ limit: '8kb' }), (req, res) => {
        const token = String((req.body || {}).token || '');
        const h = sha256(token);
        const g = store.byAccessHash(h) || (() => { const f = store.byRefreshHash(h); return f && !f.reused ? f : null; })();
        if (g) { store.dropGrant(g.id); console.log(`[auth/agents] ${g.email} revoked ${g.clientName} from the client`); }
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true });   // always 200: a revoked or unknown token is the same to the caller
    });

    // ── The gate for /mcp: nginx asks, we answer with the verified identity ──
    // The identity travels on to workspace-api with a short-lived signature
    // under the shared session secret, so nothing inside the container can
    // forge an agent's headers to it.
    app.get('/auth/verify-agent', (req, res) => {
        const m = (req.get('Authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
        const challenge = `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource/mcp", scope="${READ_SCOPE}"`;
        const refuse = (why) => { res.set('WWW-Authenticate', `${challenge}, error="invalid_token", error_description="${why}"`); return res.status(401).send(why); };
        if (!m) { res.set('WWW-Authenticate', challenge); return res.status(401).send('No token'); }
        const h = sha256(m[1]);
        const g = store.byAccessHash(h);
        if (!g) return refuse('unknown token');
        const a = g.access.find(x => x.hash === h);
        if (!a || a.exp < Date.now()) return refuse('token expired');
        const alive = liveGrant(g);
        if (!alive.ok) { store.dropGrant(g.id); return refuse(alive.why); }
        // Last use, written at most once a minute per grant.
        if (!g.lastUsedAt || Date.parse(g.lastUsedAt) < Date.now() - 60_000) { g.lastUsedAt = nowIso(); store.putGrant(g); }
        const exp = Date.now() + VERIFY_SIG_TTL_MS;
        const scopes = g.scopes.join(' ');
        const sig = crypto.createHmac('sha256', GATE_KEY).update([g.email, g.id, scopes, g.clientName, exp].join('\n')).digest('base64url');
        res.set('X-IDE-User', g.email);
        res.set('X-IDE-Agent-Grant', g.id);
        res.set('X-IDE-Agent-Scopes', scopes);
        res.set('X-IDE-Agent-Client', encodeURIComponent(g.clientName));
        res.set('X-IDE-Agent-Sig', `${exp}.${sig}`);
        return res.status(200).send('OK');
    });

    // ── The Coding agents page ──
    const shown = (g) => ({ id: g.id, client: g.clientName, kind: store.client(g.clientId)?.kind || (g.clientId.startsWith('https://') ? 'cimd' : 'dcr'), redirectHost: g.redirectHost, scopes: g.scopes, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, expiresAt: g.refresh ? new Date(g.refresh.exp).toISOString() : null });
    app.get('/auth/agents', requirePerson, (req, res) => {
        res.set('Cache-Control', 'no-store');
        const mine = store.grants().filter(g => g.email === req.person.email).map(shown);
        // An admin sees who connected what — the inventory, never what was read.
        const team = req.query.team === '1' && req.person.role === 'admin'
            ? store.grants().filter(g => g.email !== req.person.email).map(g => ({ ...shown(g), email: g.email, scopes: undefined }))
            : undefined;
        return res.json({ ok: true, resource: RESOURCE, scopes: SCOPES, grants: mine, ...(team ? { team } : {}) });
    });
    app.delete('/auth/agents/:id', requirePerson, (req, res) => {
        const g = store.grant(String(req.params.id));
        if (!g) return res.status(404).json({ error: 'no such connection' });
        if (g.email !== req.person.email && req.person.role !== 'admin') return res.status(404).json({ error: 'no such connection' });
        store.dropGrant(g.id);
        console.log(`[auth/agents] ${req.person.email} revoked ${g.clientName} of ${g.email}`);
        return res.json({ ok: true });
    });

    return { store, SCOPES, RESOURCE };
}

module.exports = { mountAgents, SCOPES, agentGateKey, validRedirectUri, redirectCovered, isPrivateIp, isPrivateHost, fetchClientMetadata, GrantStore, _test: { ACCESS_TTL_MS, REFRESH_TTL_MS } };
