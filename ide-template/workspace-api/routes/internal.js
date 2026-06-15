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
import { publish as publishNotification } from '../lib/notify.js';
import { createSession } from '../lib/sessions.js';
import { appendToSession } from '../lib/chatHistory.js';

// Single-user actor — matches routes/chat.js until multi-user team mode
// lands. The internal endpoint creates the session as if the workspace
// owner authored it; that surfaces it in their chat-history dropdown.
const ACTOR = 'default';

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

  // Server-pushed notification into the browser session. Loopback callers
  // are reminder-monitor.sh (via web-notify.sh) and future skill hooks /
  // telegram-inbound mirror. notify.publish() fans out to every connected
  // /api/notifications/stream subscriber.
  router.post('/internal/notify', loopbackOnly, (req, res) => {
    const { kind, title, body, meta, id } = req.body || {};
    if (typeof title !== 'string' && typeof body !== 'string') {
      return res.status(400).json({ ok: false, error: 'title or body required (strings)' });
    }
    try {
      const n = publishNotification({ kind, title, body, meta, id });
      return res.json({ ok: true, id: n.id });
    } catch (err) {
      process.stderr.write(`[internal] notify failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Bot-originated chat session — creates a fresh session in the
  // workspace owner's chat history, pre-populated with an assistant
  // message. Returns the new session id. web-channel-mcp's
  // web_send_message tool calls this so every spontaneous bot reply
  // becomes a clickable, named entry in the Assistant chat dropdown
  // alongside the user's normal conversations. The companion
  // /internal/notify call (also fired by the MCP) gets the session_id
  // back via its meta so the UI can wire click → switch session.
  router.post('/internal/chat-session', loopbackOnly, (req, res) => {
    const { title, body } = req.body || {};
    const cleanTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Bot message';
    const text = typeof body === 'string' && body.trim()
      ? (title ? `${title}\n\n${body}` : body)
      : (title || '');
    if (!text) {
      return res.status(400).json({ ok: false, error: 'title or body required' });
    }
    try {
      const session = createSession(ACTOR, { title: cleanTitle });
      appendToSession(ACTOR, session.id, {
        role: 'assistant',
        text,
        kind: 'bot',
      });
      return res.json({ ok: true, id: session.id });
    } catch (err) {
      process.stderr.write(`[internal] chat-session failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
