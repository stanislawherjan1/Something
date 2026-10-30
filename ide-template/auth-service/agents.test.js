// The coding agents' authorization server, end to end against a real express
// app on a loopback port: discovery, registration, authorize → consent → code,
// PKCE, the token exchange, the gate's headers and signature, refresh rotation
// with reuse detection, revocation, and the page's list. No Google: a fake
// session cookie signed with the test secret stands in for the sign-in.
//   node agents.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { mountAgents, SCOPES, agentGateKey, validRedirectUri, redirectCovered, isPrivateIp, isPrivateHost } = require('./agents');

const SECRET = 'test-secret-test-secret-test-secret-0123';
const APP_URL = 'https://ws.example.test';
const RESOURCE = `${APP_URL}/mcp`;
const roster = new Map([['ann@example.test', { role: 'admin', sessionsBefore: 0 }], ['bob@example.test', { role: 'member', sessionsBefore: 0 }]]);
const whitelist = {
    isAllowed: (e) => roster.has(String(e).toLowerCase()),
    roleOf: (e) => roster.get(String(e).toLowerCase())?.role || null,
    signedOutSince: (e, iat) => { const c = roster.get(String(e).toLowerCase())?.sessionsBefore || 0; return !!c && Number(iat || 0) < Math.floor(c / 1000); },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
const app = express();
app.use(cookieParser());
mountAgents(app, { appUrl: APP_URL, sessionCookie: 'ide_session', sessionSecret: SECRET, verifySessionToken: (t) => jwt.verify(t, SECRET), whitelist, limiter: (_q, _s, n) => n(), storeDir: dir });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); } };
const session = (email) => `ide_session=${jwt.sign({ email, name: 'Test' }, SECRET, { expiresIn: 3600 })}`;
const pkce = () => { const v = crypto.randomBytes(32).toString('base64url'); return { v, c: crypto.createHash('sha256').update(v).digest('base64url') }; };

(async () => {
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p, h = {}) => fetch(base + p, { headers: h, redirect: 'manual' });
    const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body), redirect: 'manual' });
    const form = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

    console.log('== discovery');
    const prm = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
    ok('protected resource metadata names this server and its authorization server', prm.resource === RESOURCE && prm.authorization_servers[0] === APP_URL && prm.scopes_supported.includes('read'));
    const asm = await (await get('/.well-known/oauth-authorization-server')).json();
    ok('authorization server metadata: PKCE S256 only, public clients, CIMD advertised, registration kept', asm.code_challenge_methods_supported.join() === 'S256' && asm.token_endpoint_auth_methods_supported.join() === 'none' && asm.client_id_metadata_document_supported === true && asm.registration_endpoint.endsWith('/oauth/register'));

    console.log('== redirect URIs and private addresses');
    ok('only loopback http is valid: no website, however public', validRedirectUri('http://localhost:3000/callback') && validRedirectUri('http://127.0.0.1:8080/cb') && !validRedirectUri('https://app.example.com/cb') && !validRedirectUri('http://evil.example.com/cb') && !validRedirectUri('https://192.168.1.1/cb') && !validRedirectUri('javascript:alert(1)') && !validRedirectUri('https://a.b/c#frag'));
    ok('private ranges are private', isPrivateIp('10.1.2.3') && isPrivateIp('172.16.0.1') && isPrivateIp('192.168.0.1') && isPrivateIp('169.254.169.254') && isPrivateIp('127.0.0.1') && isPrivateIp('::1') && isPrivateIp('fd00::1') && isPrivateIp('::ffff:10.0.0.1') && !isPrivateIp('8.8.8.8') && !isPrivateIp('2606:4700::1111'));
    ok('a loopback redirect covers any port, nothing else does', redirectCovered('http://localhost/callback', 'http://localhost:51234/callback') && redirectCovered('http://127.0.0.1:3000/cb', 'http://127.0.0.1:9999/cb') && !redirectCovered('http://localhost/callback', 'http://localhost:51234/other') && !redirectCovered('https://app.example.com/cb', 'https://app.example.com:8443/cb') && !redirectCovered('http://localhost/callback', 'http://127.0.0.1/callback'));
    ok('private hosts are private', isPrivateHost('localhost') && isPrivateHost('foo.local') && isPrivateHost('10.0.0.5') && !isPrivateHost('claude.ai'));

    console.log('== dynamic registration');
    let r = await post('/oauth/register', { client_name: 'Test <b>Agent</b>', redirect_uris: ['http://localhost:51234/callback'] });
    const reg = await r.json();
    ok('a public loopback client registers', r.status === 201 && /^dcr_/.test(reg.client_id) && reg.token_endpoint_auth_method === 'none');
    ok('the client name is cleaned of markup', reg.client_name === 'Test bAgent/b');
    r = await post('/oauth/register', { client_name: 'x', redirect_uris: ['http://evil.example.com/cb'] });
    ok('a non-loopback http redirect is refused', r.status === 400);
    r = await post('/oauth/register', { client_name: 'Claude Code', redirect_uris: ['https://evil.example.com/cb'] });
    ok('a client sending the code to a website is refused, whatever it calls itself', r.status === 400 && (await r.json()).error === 'invalid_redirect_uri');
    r = await post('/oauth/register', { client_name: 'x', redirect_uris: ['http://localhost:1234/cb'], token_endpoint_auth_method: 'client_secret_post' });
    ok('a confidential client is refused', r.status === 400);
    ok('nothing is on disk before a consent', !fs.existsSync(path.join(dir, 'agent-grants.json')) || !Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'agent-grants.json'), 'utf8')).clients).length);

    console.log('== authorize');
    const { v, c } = pkce();
    const authz = (extra = {}) => '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:51234/callback', code_challenge: c, code_challenge_method: 'S256', state: 'st-1', scope: 'read write:tasks write:memory', resource: RESOURCE, ...extra });
    r = await get(authz());
    const loc = r.headers.get('location') || '';
    ok('without a session the person is sent to sign in, and back to the consent page', r.status === 302 && loc.startsWith('/auth/google?returnTo=%2Fapp%2Fconnect%3Freq%3D'));
    r = await get(authz(), { cookie: session('ann@example.test') });
    const consentUrl = r.headers.get('location') || '';
    ok('with a session the person is sent to the consent page', r.status === 302 && consentUrl.startsWith('/app/connect?req='));
    const reqId = new URL(consentUrl, APP_URL).searchParams.get('req');
    r = await get(authz({ redirect_uri: 'http://localhost:9999/other' }), { cookie: session('ann@example.test') });
    ok('an unregistered redirect_uri is refused before anything else', r.status === 400 && (await r.json()).error === 'invalid_request');
    r = await get(authz({ code_challenge_method: 'plain' }), { cookie: session('ann@example.test') });
    ok('PKCE plain is refused, back to the client', r.status === 302 && /error=invalid_request/.test(r.headers.get('location')));
    r = await get(authz({ resource: 'https://other.example.test/mcp' }), { cookie: session('ann@example.test') });
    ok('a token for another resource is refused (invalid_target)', r.status === 302 && /error=invalid_target/.test(r.headers.get('location')));
    r = await get(authz({ scope: 'read admin' }), { cookie: session('ann@example.test') });
    ok('an unknown scope is refused', r.status === 302 && /error=invalid_scope/.test(r.headers.get('location')));

    console.log('== consent');
    r = await get(`/auth/agents/request/${reqId}`);
    ok('the parked request needs a session', r.status === 401);
    r = await get(`/auth/agents/request/${reqId}`, { cookie: session('ann@example.test') });
    const shown = await r.json();
    ok('the consent page sees the client, the redirect host and every scope, whatever the client asked', r.status === 200 && shown.client.name === 'Test bAgent/b' && shown.redirectHost === 'localhost' && shown.loopback === true && shown.scopes.join() === SCOPES.join());
    r = await post('/auth/agents/consent', { req: reqId, allow: true, scopes: ['read', 'write:tasks', 'admin:everything'] }, { cookie: session('ann@example.test') });
    const consent = await r.json();
    const redirect = new URL(consent.redirect);
    ok('allow answers with the client\'s redirect carrying code, state and iss', r.status === 200 && redirect.origin === 'http://localhost:51234' && /^sc_/.test(redirect.searchParams.get('code')) && redirect.searchParams.get('state') === 'st-1' && redirect.searchParams.get('iss') === APP_URL);
    r = await post('/auth/agents/consent', { req: reqId, allow: true }, { cookie: session('ann@example.test') });
    ok('a consent is single use', r.status === 404);
    const code = redirect.searchParams.get('code');

    console.log('== token');
    r = await form('/oauth/token', { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: 'http://localhost:51234/callback', code_verifier: crypto.randomBytes(32).toString('base64url'), resource: RESOURCE });
    ok('a wrong PKCE verifier fails and burns the code', r.status === 400 && (await r.json()).error === 'invalid_grant');
    // A fresh code for the real exchange.
    r = await get(authz(), { cookie: session('ann@example.test') });
    const req2 = new URL(r.headers.get('location'), APP_URL).searchParams.get('req');
    r = await post('/auth/agents/consent', { req: req2, allow: true, scopes: ['write:tasks', 'admin:everything'] }, { cookie: session('ann@example.test') });
    const code2 = new URL((await r.json()).redirect).searchParams.get('code');
    r = await form('/oauth/token', { grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: 'http://localhost:51234/callback', code_verifier: v, resource: RESOURCE });
    const tok = await r.json();
    ok('the exchange yields a bearer access token, a refresh token and the granted scopes', r.status === 200 && /^sa_/.test(tok.access_token) && /^sr_/.test(tok.refresh_token) && tok.token_type === 'Bearer' && tok.expires_in > 3500);
    ok('read is always granted, a scope that does not exist never is', tok.scope === 'read write:tasks');
    ok('the DCR client is on disk now, after its first consent', Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'agent-grants.json'), 'utf8')).clients).includes(reg.client_id));
    r = await form('/oauth/token', { grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: 'http://localhost:51234/callback', code_verifier: v });
    ok('a code is single use', r.status === 400);

    console.log('== the gate');
    r = await get('/auth/verify-agent');
    ok('no token → 401 with the resource metadata challenge', r.status === 401 && /resource_metadata="https:\/\/ws\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/.test(r.headers.get('www-authenticate')) && /scope="read"/.test(r.headers.get('www-authenticate')));
    r = await get('/auth/verify-agent', { authorization: 'Bearer sa_nope_nope_nope_nope_nope' });
    ok('an unknown token → 401 invalid_token', r.status === 401 && /invalid_token/.test(r.headers.get('www-authenticate')));
    r = await get('/auth/verify-agent', { authorization: `Bearer ${tok.access_token}` });
    const sig = r.headers.get('x-ide-agent-sig') || '';
    ok('a live token → the person, the grant, the scopes, the client', r.status === 200 && r.headers.get('x-ide-user') === 'ann@example.test' && r.headers.get('x-ide-agent-scopes') === 'read write:tasks' && decodeURIComponent(r.headers.get('x-ide-agent-client')) === 'Test bAgent/b' && /^g_/.test(r.headers.get('x-ide-agent-grant')));
    const [exp, mac] = sig.split('.');
    const expect = crypto.createHmac('sha256', agentGateKey(SECRET)).update(['ann@example.test', r.headers.get('x-ide-agent-grant'), 'read write:tasks', 'Test bAgent/b', exp].join('\n')).digest('base64url');
    ok('…signed with a key derived from the session secret, not the secret itself, with a short expiry', mac === expect && mac !== crypto.createHmac('sha256', SECRET).update(['ann@example.test', r.headers.get('x-ide-agent-grant'), 'read write:tasks', 'Test bAgent/b', exp].join('\n')).digest('base64url') && Number(exp) > Date.now() && Number(exp) < Date.now() + 120_000);
    r = await get('/auth/verify-agent', { cookie: session('ann@example.test') });
    ok('a session cookie is not an agent token', r.status === 401);

    console.log('== refresh');
    r = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id });
    const tok2 = await r.json();
    ok('a refresh rotates both tokens', r.status === 200 && tok2.access_token !== tok.access_token && tok2.refresh_token !== tok.refresh_token);
    r = await get('/auth/verify-agent', { authorization: `Bearer ${tok.access_token}` });
    ok('the earlier access token still works until it expires', r.status === 200);
    r = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id });
    ok('the spent refresh token presented again revokes the whole grant', r.status === 400 && /already used/.test((await r.json()).error_description));
    r = await get('/auth/verify-agent', { authorization: `Bearer ${tok2.access_token}` });
    ok('…so its access tokens are dead too', r.status === 401);

    console.log('== the roster ends a grant');
    const grantFor = async (email) => {
        const p = pkce();
        let x = await get('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:51234/callback', code_challenge: p.c, code_challenge_method: 'S256', state: 's', resource: RESOURCE }), { cookie: session(email) });
        const id = new URL(x.headers.get('location'), APP_URL).searchParams.get('req');
        x = await post('/auth/agents/consent', { req: id, allow: true }, { cookie: session(email) });
        const cd = new URL((await x.json()).redirect).searchParams.get('code');
        x = await form('/oauth/token', { grant_type: 'authorization_code', code: cd, client_id: reg.client_id, redirect_uri: 'http://localhost:51234/callback', code_verifier: p.v, resource: RESOURCE });
        return x.json();
    };
    const bob = await grantFor('bob@example.test');
    ok('a member connects with every scope the client asked for when they allow all', bob.scope === 'read read:private write:tasks write:memory write:files ask');
    roster.get('bob@example.test').sessionsBefore = Date.now() + 1000;
    r = await get('/auth/verify-agent', { authorization: `Bearer ${bob.access_token}` });
    ok('"sign out everywhere" ends the grant at the next call', r.status === 401);
    roster.get('bob@example.test').sessionsBefore = 0;
    const bob2 = await grantFor('bob@example.test');
    roster.delete('bob@example.test');
    r = await get('/auth/verify-agent', { authorization: `Bearer ${bob2.access_token}` });
    ok('removal from the roster ends the grant at the next call', r.status === 401);
    roster.set('bob@example.test', { role: 'member', sessionsBefore: 0 });

    console.log('== the page');
    const ann = await grantFor('ann@example.test');
    const bob3 = await grantFor('bob@example.test');
    r = await get('/auth/agents', { cookie: session('bob@example.test') });
    let page = await r.json();
    ok('a person lists their own connections only', r.status === 200 && page.grants.length === 1 && page.grants[0].client === 'Test bAgent/b' && page.grants[0].redirectHost === 'localhost' && page.team === undefined);
    r = await get('/auth/agents?team=1', { cookie: session('bob@example.test') });
    ok('a member asking for the team inventory gets none', (await r.json()).team === undefined);
    r = await get('/auth/agents?team=1', { cookie: session('ann@example.test') });
    page = await r.json();
    ok('an admin sees the inventory: who connected what, no scopes', page.team.length === 1 && page.team[0].email === 'bob@example.test' && page.team[0].scopes === undefined);
    r = await fetch(base + `/auth/agents/${page.team[0].id}`, { method: 'DELETE', headers: { cookie: session('ann@example.test') } });
    ok('an admin may revoke a teammate\'s connection (a security act)', r.status === 200);
    r = await get('/auth/verify-agent', { authorization: `Bearer ${bob3.access_token}` });
    ok('…and it is dead', r.status === 401);
    r = await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: ann.refresh_token }) });
    ok('RFC 7009 revoke answers 200', r.status === 200);
    r = await get('/auth/verify-agent', { authorization: `Bearer ${ann.access_token}` });
    ok('…and the grant is gone', r.status === 401);

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nagents: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
