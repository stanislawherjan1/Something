const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const whitelist = require('./whitelist');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// HSTS comes from Caddy at the edge; turn it off here so we don't double-set.
// CSP doesn't apply (responses are JSON / 302 redirects only).
app.use(helmet({ contentSecurityPolicy: false, hsts: false }));

const allowedOrigins = [
    ...(process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
        : []),
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
        return callback(new Error('CORS not allowed'), false);
    },
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// ── Config ──────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FRONTEND_DOMAIN = process.env.FRONTEND_DOMAIN;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'ide_session';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error('[auth] GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. Exiting.');
    process.exit(1);
}
if (!FRONTEND_DOMAIN) {
    console.error('[auth] FRONTEND_DOMAIN must be set. Exiting.');
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error('[auth] SESSION_SECRET must be set. Exiting.');
    process.exit(1);
}
if (Buffer.from(SESSION_SECRET).length < 32) {
    console.error('[auth] SESSION_SECRET must be at least 32 bytes. Generate with: openssl rand -hex 32');
    process.exit(1);
}

// Email whitelist is now resolved by ./whitelist.js — file-first
// (PROJECT_DIR/.allowed-emails.json), env fallback (IDE_ALLOWED_EMAILS).
if (whitelist.size() === 0) {
    console.warn('[auth] No allowed emails configured — no one will be able to log in.');
}

const APP_URL = `https://${FRONTEND_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
const CALLBACK_URL = `${APP_URL}/auth/callback`;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── State store for OAuth CSRF protection ───────────────────────────────────
// Map<state, { codeVerifier: string, expiresAt: number }>
const stateStore = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of stateStore) {
        if (val.expiresAt < now) stateStore.delete(key);
    }
}, 60_000);

// ── Session helpers ──────────────────────────────────────────────────────────
function createSessionToken({ email, name, picture }) {
    return jwt.sign({ email, name, picture }, SESSION_SECRET, { expiresIn: SESSION_TTL_SECONDS });
}

function verifySessionToken(token) {
    return jwt.verify(token, SESSION_SECRET);
}

// ── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later.' },
});

// Validate a `returnTo` value before storing it in the OAuth state. Must be a
// local path under /app/ to prevent open redirects (an attacker could otherwise
// craft /auth/google?returnTo=https://evil.com/ and phish the session cookie's
// origin). Defaults to /app/ when missing or invalid.
function safeReturnTo(raw) {
    if (typeof raw !== 'string' || !raw) return '/app/';
    // Reject absolute URLs and protocol-relative URLs
    if (/^[a-z]+:/i.test(raw) || raw.startsWith('//')) return '/app/';
    // Must start with /app/
    if (!raw.startsWith('/app/') && raw !== '/app') return '/app/';
    // Cap length defensively
    if (raw.length > 512) return '/app/';
    return raw;
}

// ── GET /auth/google ─────────────────────────────────────────────────────────
// Initiates Google OAuth flow with state (CSRF) + PKCE.
// Optional ?returnTo=<local-path> preserves the URL the user was on before
// hitting the login page (e.g. /app/?view=workspace).
app.get('/auth/google', authLimiter, (req, res) => {
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const returnTo = safeReturnTo(req.query.returnTo);

    stateStore.set(state, { codeVerifier, returnTo, expiresAt: Date.now() + STATE_TTL_MS });

    res.cookie('oauth_state', state, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: STATE_TTL_MS,
        path: '/',
    });

    const authUrl = googleClient.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    });

    res.redirect(authUrl);
});

// ── GET /auth/callback ───────────────────────────────────────────────────────
// Google redirects here after user consent.
app.get('/auth/callback', authLimiter, async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        console.warn('[auth] Google OAuth error:', error);
        return res.redirect('/app/?error=oauth_error');
    }

    if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
        return res.redirect('/app/?error=invalid_callback');
    }

    const stateCookie = req.cookies['oauth_state'];
    if (!stateCookie) {
        return res.redirect('/app/?error=missing_state');
    }

    // Timing-safe comparison (both must be same byte length for timingSafeEqual)
    let stateMatch = false;
    try {
        const a = Buffer.from(state);
        const b = Buffer.from(stateCookie);
        stateMatch = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
        return res.redirect('/app/?error=invalid_state');
    }

    if (!stateMatch) {
        return res.redirect('/app/?error=invalid_state');
    }

    const storeEntry = stateStore.get(state);
    if (!storeEntry || storeEntry.expiresAt < Date.now()) {
        stateStore.delete(state);
        res.clearCookie('oauth_state');
        return res.redirect('/app/?error=expired_state');
    }

    // Single-use: delete immediately before any async work
    stateStore.delete(state);
    res.clearCookie('oauth_state');

    const { codeVerifier, returnTo } = storeEntry;

    // Exchange authorization code for tokens
    let tokens;
    try {
        const response = await googleClient.getToken({ code, codeVerifier });
        tokens = response.tokens;
    } catch (err) {
        console.error('[auth] Token exchange failed:', err.message);
        return res.redirect('/app/?error=token_exchange_failed');
    }

    if (!tokens.id_token) {
        console.error('[auth] No id_token in Google response');
        return res.redirect('/app/?error=invalid_token');
    }

    // Verify ID token cryptographically (signature, aud, iss, exp)
    let googlePayload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID,
        });
        googlePayload = ticket.getPayload();
    } catch (err) {
        console.error('[auth] ID token verification failed:', err.message);
        return res.redirect('/app/?error=invalid_token');
    }

    if (!googlePayload.email_verified) {
        console.warn('[auth] Google email not verified:', googlePayload.email);
        return res.redirect('/app/?error=email_not_verified');
    }

    const email = googlePayload.email.toLowerCase();

    if (!whitelist.isAllowed(email)) {
        console.warn('[auth] Access denied:', email);
        return res.redirect(`/?error=access_denied&email=${encodeURIComponent(email)}`);
    }

    const name = googlePayload.name || '';
    const picture = googlePayload.picture || '';
    const sessionToken = createSessionToken({ email, name, picture });

    res.cookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: SESSION_TTL_MS,
        path: '/',
    });

    console.log(`[auth] Session created for ${email}`);
    // Re-validate returnTo defensively: storeEntry was set by us but harden anyway.
    return res.redirect(safeReturnTo(returnTo));
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
// Returns current user info from session cookie. Called by React SPA on mount.
app.get('/auth/me', (req, res) => {
    const sessionToken = req.cookies[SESSION_COOKIE];
    if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const payload = verifySessionToken(sessionToken);
        // Mirror the /auth/verify whitelist re-check so a removed user can't
        // keep reading their profile (and stay "logged in" in the UI) for
        // the JWT TTL after being kicked off the team. Cache TTL on the
        // whitelist resolver bounds propagation lag to ~30s.
        if (!whitelist.isAllowed(payload.email)) {
            res.clearCookie(SESSION_COOKIE);
            return res.status(401).json({ error: 'Access revoked' });
        }
        const role = whitelist.roleOf(payload.email);
        return res.json({
            email:    payload.email,
            name:     payload.name || '',
            picture:  payload.picture || '',
            role,
            isAdmin:  role === 'admin',
        });
    } catch {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }
});

// ── GET /auth/verify ─────────────────────────────────────────────────────────
// Called internally by nginx auth_request for every IDE request.
app.get('/auth/verify', (req, res) => {
    const sessionToken = req.cookies[SESSION_COOKIE];
    if (!sessionToken) return res.status(401).send('No session');

    try {
        const payload = verifySessionToken(sessionToken);
        // Belt-and-braces: a session can outlive a removal from the whitelist
        // (8 h JWT TTL). Re-check on every verify so a removed user is locked
        // out within the cache TTL (30 s) instead of waiting for cookie expiry.
        if (!whitelist.isAllowed(payload.email)) {
            res.clearCookie(SESSION_COOKIE);
            return res.status(401).send('Access revoked');
        }
        res.setHeader('X-IDE-User', payload.email);
        return res.status(200).send('OK');
    } catch {
        return res.status(401).send('Invalid or expired session');
    }
});

// ── DELETE /auth/session ──────────────────────────────────────────────────────
app.delete('/auth/session', (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    return res.json({ ok: true });
});

// ── GET /auth/health ──────────────────────────────────────────────────────────
app.get('/auth/health', (_req, res) => res.json({ ok: true }));

// ── Global error handler ─────────────────────────────────────────────────────
// Catches anything routes forgot to handle so we never return Express's
// default HTML stack-trace page (which leaks file paths + Node version).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[auth-service/unhandled]', err.stack || err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.AUTH_SERVICE_PORT || 3002;
app.listen(PORT, () => {
    console.log(`[auth-service] Running on port ${PORT}`);
    console.log(`[auth-service] Callback URL: ${CALLBACK_URL}`);
    console.log(`[auth-service] Whitelist: ${whitelist.size()} email(s) (source: ${whitelist.source()})`);
});
