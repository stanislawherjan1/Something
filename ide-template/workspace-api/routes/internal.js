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
import { primaryAdminSlug, list as teamList } from '../lib/team.js';
import { ensureBrowserForMcp } from './docs-comments-login.js';

// Resolve a recipient slug to a real team member, or null. B3: a relay must
// only ever land in a KNOWN teammate's view — never an arbitrary/invented slug.
function resolveMember(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) return null;
  return teamList().find(m => m.slug === slug) || null;
}

// A proactive bot message has no specific recipient yet (per-user targeting is
// a later team-mode phase), so it surfaces in the primary admin's chat history
// — the operator who'd act on it. Resolved per request so it tracks the current
// admin. (Matches the per-user actor keying in routes/chat.js.)

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

  // docs-comments auto-heal: relaunch the persistent browser (no viewer) from
  // the saved profile after the MCP hit a NOT_CONNECTED mid-session (chromium
  // crashed but the profile/session is intact). Loopback-only — same trust
  // boundary as the CDP port the MCP already attaches to. Idempotent; never
  // re-logins or clears the profile, so a truly-expired session still surfaces
  // SESSION_EXPIRED honestly. The boot hook covers the deploy case; this covers
  // a browser that died between deploys.
  router.post('/internal/docs-comments/ensure', loopbackOnly, async (_req, res) => {
    try {
      return res.json(await ensureBrowserForMcp());
    } catch (err) {
      process.stderr.write(`[internal] docs-comments ensure failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Server-pushed notification into the browser session. Loopback callers
  // are reminder-monitor.sh (via web-notify.sh) and future skill hooks /
  // telegram-inbound mirror. notify.publish() fans out to every connected
  // /api/notifications/stream subscriber.
  router.post('/internal/notify', loopbackOnly, (req, res) => {
    const { kind, title, body, meta, id, recipient, from } = req.body || {};
    if (typeof title !== 'string' && typeof body !== 'string') {
      return res.status(400).json({ ok: false, error: 'title or body required (strings)' });
    }
    try {
      // B3: a valid recipient slug scopes the toast to that teammate (+ admins);
      // absent/invalid → global, as before. For a cross-user relay, make the
      // toast recipient-facing — they should see who it's from, not the raw
      // headline the sender's bot wrote.
      const target = resolveMember(recipient)?.slug || null;
      const sender = resolveMember(from);
      const toastTitle = (target && sender && sender.slug !== target)
        ? `📨 Wiadomość od ${sender.displayName || sender.slug}`
        : title;
      const n = publishNotification({ kind, title: toastTitle, body, meta, id, recipient: target });
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
    const { title, body, recipient, from } = req.body || {};
    const cleanTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Bot message';
    let text = typeof body === 'string' && body.trim()
      ? (title ? `${title}\n\n${body}` : body)
      : (title || '');
    if (!text) {
      return res.status(400).json({ ok: false, error: 'title or body required' });
    }
    try {
      // B3 — recipient routing. Default (no/invalid recipient) = the primary
      // admin's chat, preserving the legacy proactive-bot + cross-surface tunnel
      // (within one user). A valid recipient slug → that teammate's chat.
      const target = resolveMember(recipient);
      const actor = target?.slug || primaryAdminSlug();
      // Cross-USER relay: the message originated from a DIFFERENT teammate.
      const sender = resolveMember(from);
      const isRelay = !!(sender && sender.slug !== actor);
      // For a relay the sender's bot already composed a natural, human message
      // FOR the recipient (greeting them, naming the sender inline, in their
      // language) — so deliver it verbatim. No robotic "X asked me to forward"
      // wrapper: that read as stilted and non-human. We only stamp the chat-list
      // TITLE with the sender so the recipient sees at a glance who it's from;
      // the message body stays exactly what the bot wrote.
      const relayTitle = isRelay ? `📨 ${sender.displayName || sender.slug}` : cleanTitle;
      if (isRelay) {
        text = (typeof body === 'string' && body.trim())
          ? body.trim()
          : (typeof title === 'string' ? title.trim() : '');
      }
      const session = createSession(actor, { title: relayTitle });
      appendToSession(actor, session.id, { role: 'assistant', text, kind: 'bot' });
      return res.json({ ok: true, id: session.id, recipient: actor, relay: isRelay });
    } catch (err) {
      process.stderr.write(`[internal] chat-session failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
