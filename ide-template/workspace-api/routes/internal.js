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
import { createSession, getSession, linkRelayPeer, listSessions } from '../lib/sessions.js';
import { appendToSession } from '../lib/chatHistory.js';
import { primaryAdminSlug, list as teamList, getTeamMode } from '../lib/team.js';
import { sendTelegramMessage, routeTelegramInbound } from '../lib/integrations/telegram-sync.js';
import { ensureBrowserForMcp } from './docs-comments-login.js';

// Resolve a recipient slug to a real team member, or null. B3: a relay must
// only ever land in a KNOWN teammate's view — never an arbitrary/invented slug.
function resolveMember(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) return null;
  return teamList().find(m => m.slug === slug) || null;
}

// Cross-surface relay threading: the recipient's existing session paired with
// the sender (relayPeers[senderSlug]), most-recently active. Lets a reply that
// arrives on ANOTHER surface (e.g. the sender answered on Telegram, which has no
// web session id to thread on) drop into the SAME conversation instead of
// spawning a new one. Null when there's no pair yet.
function findPairedSession(recipientSlug, senderSlug) {
  if (!recipientSlug || !senderSlug) return null;
  let sessions;
  try { sessions = listSessions(recipientSlug, { archived: false }); } catch { return null; }
  const paired = sessions.filter(s => s.relayPeers && s.relayPeers[senderSlug]);
  if (!paired.length) return null;
  paired.sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
  return paired[0].id;
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
        ? `📨 Message from ${sender.displayName || sender.slug}`
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
  router.post('/internal/chat-session', loopbackOnly, async (req, res) => {
    const { title, body, recipient, from, fromSession, channel } = req.body || {};
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
      // Who SENT this. A web turn passes `from`; a surface with no per-user
      // identity (Telegram, reminders) passes none — there the sender IS the
      // operator/admin. Attributing it lets a Telegram-originated reply thread
      // back into the right relay conversation instead of spawning a new one.
      const sender = resolveMember(from)
        || (!from && getTeamMode() ? resolveMember(primaryAdminSlug()) : null);
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
      // Cross-surface fallback — ONLY when we have no sender web session at all
      // (haveSender is false: the reply arrived over Telegram, which carries no
      // web session id). In that case reuse the recipient's existing thread
      // paired with the sender so it threads instead of opening a new one.
      // We must NOT do this when the sender DOES have a web session (haveSender):
      // a relay started from a DIFFERENT web chat is its own conversation and
      // gets its own pair — otherwise every chat with the same person collapses
      // into the first-paired one, and replies always go back to that first chat.
      if (!destId && isRelay && sender && !haveSender) {
        const paired = findPairedSession(actor, sender.slug);
        if (paired) destId = paired;
      }
      if (!destId) {
        destId = createSession(actor, { title: relayTitle }).id;
        if (haveSender) {
          // Pair both ways so the next reply (either direction) threads here.
          linkRelayPeer(actor, destId, sender.slug, fromSession);
          linkRelayPeer(sender.slug, fromSession, actor, destId);
        }
      }
      // Channel routing. Who actually receives this = `deliverTo`: the explicit
      // recipient for a relay, or the actor for a self / cross-surface "message
      // me on Telegram". Their preferredSurface is the DEFAULT channel; an
      // explicit `channel` from the sender OVERRIDES it. The web thread is always
      // the record + 2-way anchor; here we decide the Telegram ping and whether
      // to ALSO fire the web toast.
      const deliverTo   = target || resolveMember(actor);
      const explicitTg  = channel === 'telegram';
      const explicitWeb = channel === 'web';
      const prefersTg = !!(deliverTo?.telegramChatId &&
        (deliverTo.preferredSurface === 'telegram' || deliverTo.preferredSurface === 'both'));
      // Send to Telegram when the sender EXPLICITLY asked for it (works for a
      // relay AND a self "send me on Telegram"), or — for a cross-user relay —
      // when the recipient's preference is Telegram. Proactive/reminders (not
      // explicit, not a relay) don't auto-forward here; they have their own path.
      const wantTg = !!(deliverTo?.telegramChatId && !explicitWeb &&
        (explicitTg || (isRelay && prefersTg)));
      let tgSent = false;
      let tgMessageId = null;
      if (wantTg) {
        // Awaited (not fire-and-forget) so we know whether to suppress the web
        // toast AND can record the Telegram message id (for deterministic
        // reply-to threading of the teammate's eventual reply).
        const r = await sendTelegramMessage(deliverTo.telegramChatId, text);
        tgSent = !!(r && r.ok);
        tgMessageId = (r && r.messageId != null) ? String(r.messageId) : null;
      }
      // Suppress the web toast ONLY when the sender explicitly chose Telegram and
      // it actually landed there; otherwise the web toast still fires.
      const webToast = !(explicitTg && tgSent);

      // Record the relay/bot message into the web thread WITH delivery truth.
      // Moved AFTER the TG send so we know the channel + Telegram message id —
      // a teammate's Telegram reply is then threaded back deterministically
      // (reply_to_message_id → this tgMessageId). If the append throws after a
      // successful TG send, the recipient still saw it (non-fatal, logged); the
      // reply falls back to pair-based threading.
      try {
        appendToSession(actor, destId, {
          role: 'assistant', text, kind: 'bot',
          delivery: {
            channel: tgSent ? (webToast ? 'both' : 'telegram') : 'web',
            tgChatId: wantTg && deliverTo?.telegramChatId ? String(deliverTo.telegramChatId) : null,
            tgMessageId,
            at: new Date().toISOString(),
          },
        });
      } catch (err) {
        process.stderr.write(`[internal] relay append failed (delivered=${tgSent ? 'telegram' : 'web'}): ${err.message}\n`);
      }

      // Report WHERE it actually landed so web_send_message → the bot tells the
      // user the truth instead of promising a channel that didn't happen.
      return res.json({
        ok: true,
        id: destId,
        recipient: actor,
        relay: isRelay,
        delivery: {
          web: true,
          webToast,
          telegram: tgSent,
          telegramRequested: explicitTg,
          recipientLinkedTelegram: !!deliverTo?.telegramChatId,
        },
      });
    } catch (err) {
      process.stderr.write(`[internal] chat-session failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Inbound Telegram DM from a teammate → thread it back into the right web
  // relay conversation + push it onward to the peer. Called by the bot's grammy
  // middleware (loopback) for EVERY inbound DM; routeTelegramInbound decides
  // whether it belongs to a relay thread (and is a no-op otherwise, so a normal
  // Telegram DM is untouched). Loopback-only — same trust boundary as the rest.
  router.post('/internal/telegram-inbound', loopbackOnly, async (req, res) => {
    const { chat_id, text, message_id, reply_to_message_id } = req.body || {};
    try {
      const out = await routeTelegramInbound({ chat_id, text, message_id, reply_to_message_id });
      return res.json(out);
    } catch (err) {
      process.stderr.write(`[internal] telegram-inbound failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
