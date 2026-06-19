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
import { createSession, getSession, linkRelayPeer } from '../lib/sessions.js';
import { appendToSession } from '../lib/chatHistory.js';
import { primaryAdminSlug, list as teamList, getTeamMode } from '../lib/team.js';
import { sendTelegramMessage } from '../lib/integrations/telegram-sync.js';
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
      // Who should see this toast. Priority:
      //   1. an explicit recipient slug (cross-user relay → that teammate);
      //   2. else the ORIGINATOR (`from`) when known — a user's own proactive /
      //      cross-surface message surfaces in THEIR view, not everyone's;
      //   3. else, in TEAM mode, the operator/admin — the Telegram surface and
      //      reminders run AS the operator and have no recipient/from, so a
      //      "send to the web UI" from Telegram must land with the operator, not
      //      fan out to every teammate (the leak this fixes);
      //   4. solo → null = global (there's only one user anyway).
      const target = resolveMember(recipient)?.slug
        || resolveMember(from)?.slug
        || (getTeamMode() ? primaryAdminSlug() : null);
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
    const { title, body, recipient, from, fromSession } = req.body || {};
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
      // Same precedence as /notify: explicit recipient → originator (own
      // proactive/cross-surface message) → operator/admin (Telegram + reminders
      // act as the operator). Keeps a Telegram "send to my web UI" in the
      // operator's own history rather than defaulting everyone to the admin.
      const actor = target?.slug || resolveMember(from)?.slug || primaryAdminSlug();
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

      // B3 v2 — thread continuity. A relay normally spawns a fresh session, so a
      // back-and-forth scattered into a new thread on every reply. Instead, pair
      // the sender's CURRENT session with the recipient's relay session
      // (relayPeers, both directions). On a later relay between the same two
      // people, reuse the paired thread so the reply "drops into" it. Falls back
      // to a new session when we can't resolve the sender's session (proactive
      // bot, cross-surface tunnel, missing IDE_SESSION_ID) — legacy behaviour.
      let destId = null;
      const haveSender = isRelay && typeof fromSession === 'string' && fromSession &&
                         getSession(sender.slug, fromSession);
      if (haveSender) {
        const pairedId = haveSender.relayPeers?.[actor];
        if (pairedId && getSession(actor, pairedId)) destId = pairedId; // reuse thread
      }
      if (!destId) {
        destId = createSession(actor, { title: relayTitle }).id;
        if (haveSender) {
          // Pair both ways so the next reply (either direction) threads here.
          linkRelayPeer(actor, destId, sender.slug, fromSession);
          linkRelayPeer(sender.slug, fromSession, actor, destId);
        }
      }
      appendToSession(actor, destId, { role: 'assistant', text, kind: 'bot' });

      // TG-2 cross-surface: the web thread is always the record, but if the
      // recipient prefers Telegram (and is linked) also ping them there so a
      // relay reaches them where they actually are. Fire-and-forget — the web
      // delivery already succeeded; a TG hiccup must not fail the request.
      const tgWanted = !!(isRelay && target?.telegramChatId &&
        (target.preferredSurface === 'telegram' || target.preferredSurface === 'both'));
      if (tgWanted) sendTelegramMessage(target.telegramChatId, text).catch(() => {});

      // Report WHERE it actually landed so the caller (web_send_message → the
      // bot) tells the user the truth instead of promising a channel that
      // didn't happen.
      return res.json({
        ok: true,
        id: destId,
        recipient: actor,
        relay: isRelay,
        delivery: {
          web: true,
          telegram: tgWanted,
          recipientLinkedTelegram: !!target?.telegramChatId,
        },
      });
    } catch (err) {
      process.stderr.write(`[internal] chat-session failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
