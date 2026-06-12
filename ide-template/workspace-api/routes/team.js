/**
 * /api/team/* — team whitelist management.
 *
 *   GET    /api/team           — list { entries: [{email, role, addedAt, addedBy}], me: {email, role, isAdmin} }
 *   POST   /api/team           — body: { email, role? } (admin only)
 *   PATCH  /api/team/:email    — body: { role } (admin only, lockout-protected)
 *   DELETE /api/team/:email    — admin only, refuses self-delete + last admin
 *
 * Auth: nginx auth_request /auth/verify gates every /api/* request and sets
 * the verified email in X-IDE-User. lib/auth.js cross-checks that against
 * the JWT in the session cookie before populating req.actor — header alone
 * isn't trusted in case anything inside the container ever talks to
 * workspace-api directly (port 3001, internal Docker network).
 *
 * Rate limit (5/min/IP) on writes — enough for legitimate team-edit bursts,
 * tight enough that a stolen session can't quietly invite a thousand emails.
 */

import { Router } from 'express';
import express from 'express';
import * as team from '../lib/team.js';

// Rate limiter — see routes/integrations.js for the rationale (actor-keyed,
// janitor sweeps stale buckets). Same shape, separate bucket count so a
// chatty integrations user doesn't lock themselves out of team edits.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS  = 5;
const hits = new Map();

function rateKey(req) {
  return req.actor || req.ip || req.socket?.remoteAddress || 'anonymous';
}

function rateLimit(req, res, next) {
  const key = rateKey(req);
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_HITS) {
    return res.status(429).json({ error: 'Too many team changes. Wait a minute and try again.' });
  }
  recent.push(now);
  hits.set(key, recent);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of hits) {
    if (ts.every(t => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  }
}, RATE_WINDOW_MS).unref();

function requireAdmin(req, res, next) {
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
  if (!team.isAdmin(req.actor)) {
    return res.status(403).json({ error: 'Only admins can change team membership.' });
  }
  next();
}

export default function teamRouter() {
  const router = Router();

  router.get('/team', (req, res) => {
    const entries = team.list();
    const me = req.actor ? team.find(req.actor) : null;
    res.json({
      entries,
      me: req.actor ? {
        email:   req.actor,
        role:    me?.role || null,
        isAdmin: me?.role === 'admin',
      } : null,
    });
  });

  router.post('/team', requireAdmin, rateLimit, express.json({ limit: '4kb' }), (req, res) => {
    const { email, role } = req.body || {};
    try {
      const entry = team.add({ email, role: role || 'member', addedBy: req.actor });
      res.status(201).json({ ok: true, entry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/team/:email', requireAdmin, rateLimit, express.json({ limit: '4kb' }), (req, res) => {
    const { role } = req.body || {};
    try {
      const entry = team.setRole({ email: req.params.email, role, actor: req.actor });
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/team/:email', requireAdmin, rateLimit, (req, res) => {
    try {
      const removed = team.remove({ email: req.params.email, actor: req.actor });
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
