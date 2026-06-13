/**
 * /api/internal/* — loopback-only controls for in-container helpers.
 *
 * No session auth: these are called by processes inside the same container
 * (bot.sh) over 127.0.0.1, never by a browser. Two layers keep them private:
 *   1. nginx only proxies authed /api/* from outside — an external caller is
 *      gated before it ever reaches here.
 *   2. loopbackOnly below rejects anything whose peer isn't 127.0.0.1/::1, so
 *      even another container on the internal network can't call it (nginx
 *      would arrive with the nginx container's IP, not loopback).
 */

import { Router } from 'express';
import * as runtime from '../lib/integrations/runtime.js';

function loopbackOnly(req, res, next) {
  const ip = req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'loopback only' });
}

export default function internalRouter() {
  const router = Router();

  // Re-mint broker grants: syncMcpServers() issues fresh single-use nonces
  // into the live broker grants Map and rewrites the bot's .claude.json.
  // bot.sh calls this on every startup, so a bot-only restart (Telegram
  // /restart, PM2 cycle) picks up VALID grants instead of reusing stale or
  // expired (24h TTL) nonces from a prior session — which the broker would
  // reject, breaking every brokered MCP (Trello, GitHub, …). Idempotent.
  router.post('/internal/sync-mcp', loopbackOnly, (_req, res) => {
    try {
      const { changed } = runtime.syncMcpServers();
      return res.json({ ok: true, changed: !!changed });
    } catch (err) {
      process.stderr.write(`[internal] sync-mcp failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
