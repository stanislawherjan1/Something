/**
 * Self-validating session middleware for workspace-api.
 *
 * Defense-in-depth complement to nginx auth_request: nginx forwards a
 * verified `X-IDE-User` header on every /api/* request, but if anything
 * inside the code-server container ever talks to workspace-api directly
 * (port 3001, internal Docker network), it could forge that header. So we
 * cross-check the session cookie itself on every admin write.
 *
 * The session cookie (`ide_session`) is a JWT signed by auth-service with
 * SESSION_SECRET. We share the same secret via docker-compose env so we can
 * verify locally — no extra round-trip to auth-service needed.
 *
 * Resolution order for the actor email:
 *   1. JWT-verified `email` claim from the session cookie (preferred).
 *   2. Validated `X-IDE-User` header from nginx — only trusted when the
 *      cookie also resolves to the same email (double-check).
 *
 * Routes use `req.actor` (set by attachActor middleware). For admin-gated
 * writes, requireAdmin checks team.isAdmin(req.actor) on the verified email.
 */

import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'ide_session';

if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // Refuse to boot in production without a session secret. Without it the
    // module would silently degrade to header-only trust, and any in-container
    // process (e.g. a code-server terminal user, a malicious MCP) could pose
    // as anyone by sending X-IDE-User to localhost:3001.
    process.stderr.write(
      '[workspace-api/auth] FATAL: SESSION_SECRET is not set in production.\n' +
      '[workspace-api/auth] Refusing to start with header-only trust. Configure\n' +
      '[workspace-api/auth] SESSION_SECRET in the deployment .env and restart.\n'
    );
    process.exit(1);
  }
  process.stderr.write(
    '[workspace-api/auth] SESSION_SECRET not set — falling back to header-only\n' +
    '[workspace-api/auth] trust. Allowed only outside production (NODE_ENV != production).\n'
  );
}

export const cookieMiddleware = cookieParser();

function fromHeader(req) {
  const raw = req.get('X-IDE-User');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  // Loose email shape; the actual whitelist lives in lib/team.js — we just
  // refuse obvious garbage so a bogus header can't poison req.actor.
  if (!trimmed || trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

function fromCookie(req) {
  if (!SESSION_SECRET) return null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    const email = String(payload?.email || '').trim().toLowerCase();
    if (!email) return null;
    return email;
  } catch {
    return null;
  }
}

/**
 * Sets req.actor and req.actorSource. Doesn't reject — leaves auth decisions
 * to downstream middleware (requireAdmin, requireSetupOrAdmin) so endpoints
 * like GET /api/branding can still run pre-session.
 */
export function attachActor(req, _res, next) {
  const fromCk  = fromCookie(req);
  const fromHd  = fromHeader(req);

  if (fromCk && fromHd) {
    if (fromCk === fromHd) {
      req.actor = fromCk;
      req.actorSource = 'cookie+header';
    } else {
      // Header disagrees with cookie — refuse both. Could be nginx
      // misconfig, could be an in-container forgery attempt. Fail closed.
      process.stderr.write(`[workspace-api/auth] cookie/header mismatch (cookie=${fromCk} header=${fromHd}) — dropping actor\n`);
      req.actor = null;
      req.actorSource = 'mismatch';
    }
  } else if (fromCk) {
    req.actor = fromCk;
    req.actorSource = 'cookie';
  } else if (fromHd && !SESSION_SECRET) {
    // Legacy fallback: SESSION_SECRET wasn't deployed yet (older clients
    // mid-migration). Trust the header alone since nginx still gates it.
    req.actor = fromHd;
    req.actorSource = 'header-legacy';
  } else {
    req.actor = null;
    req.actorSource = 'none';
  }

  next();
}

export function requireActor(req, res, next) {
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}
