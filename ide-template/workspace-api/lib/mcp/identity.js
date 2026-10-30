/**
 * The person behind a coding agent's request to /mcp.
 *
 * workspace-api never sees the agent's bearer token. nginx asks auth-service
 * (/auth/verify-agent) and forwards what it answered: the person's email, the
 * grant, its scopes, the client's name — and a signature over all of it under
 * the session secret both services hold, good for a minute. The signature is
 * what makes the headers trustworthy: anything inside the container can reach
 * port 3001 and set X-IDE-User, but not sign it.
 */
import crypto from 'node:crypto';
import { SESSION_SECRET, onTeam } from '../auth.js';

export const SCOPES = ['read', 'read:private', 'write:tasks', 'write:memory', 'write:files', 'ask'];

function timingEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The gate's key: derived from the session secret, as auth-service derives it (agentGateKey). */
const gateKey = (secret) => crypto.createHmac('sha256', String(secret)).update('something/agent-gate/v1').digest();

/** What auth-service signs — the same line, the same order, on both sides. */
export function signatureFor({ email, grant, scopes, client, exp }, secret = SESSION_SECRET) {
  return crypto.createHmac('sha256', gateKey(secret)).update([email, grant, scopes.join(' '), client, exp].join('\n')).digest('base64url');
}

/**
 * `{ email, grant, scopes, client }` for a request that carries a valid,
 * fresh signature from the gate and names someone on the roster; null for
 * anything else. A session cookie is not an agent: it is never looked at here.
 */
export function agentFrom(req) {
  if (!SESSION_SECRET) return null;
  const email = String(req.get('X-IDE-User') || '').trim().toLowerCase();
  const grant = String(req.get('X-IDE-Agent-Grant') || '').trim();
  const scopes = String(req.get('X-IDE-Agent-Scopes') || '').split(' ').filter(s => SCOPES.includes(s));
  let client = '';
  try { client = decodeURIComponent(String(req.get('X-IDE-Agent-Client') || '')); } catch { client = ''; }
  const sig = String(req.get('X-IDE-Agent-Sig') || '');
  if (!email || !grant || !sig) return null;
  const [expRaw, mac] = sig.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now() || !mac) return null;
  if (!timingEqual(mac, signatureFor({ email, grant, scopes, client, exp: expRaw }))) return null;
  if (!onTeam(email)) return null;
  return { email, grant, scopes, client: client || 'an MCP client' };
}
