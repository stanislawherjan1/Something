/**
 * POST /mcp — the MCP endpoint for coding agents (Claude Code, Codex, Cursor).
 *
 * Mounted outside /api: nginx sends it here only after auth-service verified
 * the agent's bearer token (`/auth/verify-agent`) and hands the person's
 * identity on in signed headers (lib/mcp/identity.js). A request without that
 * signature — a session cookie, a forged X-IDE-User from inside the container,
 * a direct call to port 3001 — is nobody and gets 401 with the OAuth challenge.
 *
 * Streamable HTTP as the 2025-11-25 spec: POST only; GET and DELETE (the old
 * stream and session endpoints) answer 405, Origin is checked against this
 * workspace, and nothing is kept between requests.
 */
import { Router } from 'express';
import { agentFrom } from '../lib/mcp/identity.js';
import { viewerFor } from '../lib/viewer.js';
import { handleMcp } from '../lib/mcp/server.js';

const FRONTEND_DOMAIN = String(process.env.FRONTEND_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

const REQUESTS_PER_MIN = Number(process.env.MCP_REQUESTS_PER_MIN) || 120;

export default function mcpRouter() {
  const router = Router();
  const perGrant = new Map();   // grant → request times in the last minute

  const challenge = (req) => `Bearer resource_metadata="https://${FRONTEND_DOMAIN || req.get('host') || 'localhost'}/.well-known/oauth-protected-resource/mcp", scope="read"`;

  router.all('/mcp', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'POST only' });
    // DNS-rebinding guard: a browser page on another origin must not drive the endpoint.
    const origin = req.get('Origin');
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { host = ''; }
      if (!host || (FRONTEND_DOMAIN && host !== FRONTEND_DOMAIN)) return res.status(403).json({ error: 'origin not allowed' });
    }
    const agent = agentFrom(req);
    if (!agent) { res.set('WWW-Authenticate', challenge(req)); return res.status(401).json({ error: 'unauthorized' }); }
    // A loop on someone's laptop must not flood the workspace: requests per grant per minute.
    const now = Date.now();
    const seen = (perGrant.get(agent.grant) || []).filter(t => t > now - 60_000);
    if (seen.length >= REQUESTS_PER_MIN) { res.set('Retry-After', '30'); return res.status(429).json({ error: 'too many requests from this agent; slow down' }); }
    seen.push(now); perGrant.set(agent.grant, seen);
    if (perGrant.size > 5000) perGrant.delete(perGrant.keys().next().value);
    const v = viewerFor(agent.email);
    if (!v) { res.set('WWW-Authenticate', `${challenge(req)}, error="invalid_token", error_description="not on this workspace's team"`); return res.status(401).json({ error: 'not on this workspace\'s team' }); }
    if (!agent.scopes.includes('read')) {
      res.set('WWW-Authenticate', `${challenge(req)}, error="insufficient_scope", scope="read"`);
      return res.status(403).json({ error: 'insufficient_scope' });
    }
    try {
      await handleMcp(req, res, agent, v);
    } catch (err) {
      process.stderr.write(`[mcp] ${agent.email} via ${agent.client}: ${err.stack || err}\n`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  return router;
}
