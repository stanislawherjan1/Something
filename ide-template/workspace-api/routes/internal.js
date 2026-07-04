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
import { primaryAdminSlug, list as teamList, getTeamMode, addGroup, isAllowedGroup, userByChatId } from '../lib/team.js';
import { sendTelegramMessage, routeTelegramInbound } from '../lib/integrations/telegram-sync.js';
import { routeGroupMessage } from '../lib/integrations/group-watcher.js';
import { summarizeThread, sweepIdleThreads } from '../lib/reflect-summary.js';
import { distillVerdicts } from '../lib/reflect-distill.js';
import { curatePages } from '../lib/reflect-curate.js';
import { lintMemory } from '../lib/memory-lint.js';
import { injectBotFrame } from '../lib/bot-inject.js';
import { ensureBrowserForMcp, recordSessionState } from './docs-comments-login.js';

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

  // Operator identity for the Telegram bot. bot.sh curls this at startup to
  // export IDE_ACTOR_SLUG (+ IDE_ACTOR_IS_ADMIN=1) into the brain's env so the
  // operator's web_send_message relays carry from=<operator> — that's what gives
  // the recipient an attributed chat title AND toast ("📨 Message from <op>")
  // instead of an anonymous bubble (F3). The slug is fetched (not derived in
  // bash) so it can't drift from team.js's slugify/uniqueSlug. IS_ADMIN=1 makes
  // scope-guard.mjs short-circuit (line 109) → the slug never fences the brain
  // out of shared/other files. Solo / non-team → teamMode:false and bot.sh
  // leaves the env unset (legacy full-access behaviour, unchanged).
  router.get('/internal/operator-identity', loopbackOnly, (_req, res) => {
    try {
      const teamMode = getTeamMode();
      const slug = teamMode ? primaryAdminSlug() : null;
      return res.json({ ok: true, teamMode, slug, isAdmin: !!slug });
    } catch (err) {
      process.stderr.write(`[internal] operator-identity failed: ${err.message}\n`);
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

  // docs-comments session-probe sink: the keep-alive process (PM2
  // <bot>-docs-keepalive) reports each refresh verdict here so /status can show
  // honest session validity (vs the old process-alive=connected lie). loopback only.
  router.post('/internal/docs-comments/session-probe', loopbackOnly, (req, res) => {
    try {
      const { valid, host } = req.body || {};
      recordSessionState({ valid: !!valid, host: typeof host === 'string' ? host : '' });
      return res.json({ ok: true });
    } catch (err) {
      process.stderr.write(`[internal] docs-comments session-probe failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Server-pushed notification into the browser session. Loopback callers
  // are reminder-monitor.sh (via web-notify.sh) and future skill hooks /
  // telegram-inbound mirror. notify.publish() fans out to every connected
  // /api/notifications/stream subscriber.
  // Team roster for the reminder MCP's set-time name→slug resolution +
  // validation (the MCP is a separate process with no in-process team.js). Same
  // loopback trust boundary as /internal/operator-identity.
  router.get('/internal/roster', loopbackOnly, (_req, res) => {
    try {
      const op = getTeamMode() ? primaryAdminSlug() : null;
      const members = teamList().map(m => ({
        slug: m.slug,
        displayName: m.displayName || m.slug,
        role: m.role,
        telegramChatId: m.telegramChatId || null,
        preferredSurface: m.preferredSurface || null,
        preferredLanguage: m.preferredLanguage || null,
        isOperator: !!op && m.slug === op,
      }));
      return res.json({ ok: true, teamMode: getTeamMode(), members });
    } catch (err) {
      process.stderr.write(`[internal] roster failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Per-recipient reminder fan-out (team mode). reminder-monitor.sh POSTs here
  // when a due reminder has recipients. The OPERATOR is delivered separately by
  // the monitor (brain frame in bash) and EXCLUDED here, so no teammate-leg ever
  // double-fires them. Each remaining teammate gets a recipient-scoped web toast
  // (notify.visibleTo) + their Telegram if linked & preferred. '*everyone*' is
  // expanded late (live roster). Best-effort per leg; never throws.
  router.post('/internal/reminder-deliver', loopbackOnly, async (req, res) => {
    const { recipients, channel, title, body } = req.body || {};
    try {
      if (!getTeamMode()) return res.json({ ok: true, skipped: 'solo' });
      const ch = ['telegram', 'web', 'all'].includes(channel) ? channel : 'all';
      const opSlug = primaryAdminSlug();
      let slugs = Array.isArray(recipients) ? recipients.slice() : [];
      if (slugs.length === 1 && slugs[0] === '*everyone*') slugs = teamList().map(m => m.slug);
      slugs = [...new Set(slugs.filter(s => /^[a-z0-9-]+$/.test(s) && s !== opSlug))];
      const t = String(title == null ? '' : title).trim();
      const b = String(body == null ? '' : body).trim();
      if (!t && !b) return res.status(400).json({ ok: false, error: 'title or body required' });
      const delivered = [];
      for (const slug of slugs) {
        const m = resolveMember(slug);
        if (!m) continue;                                 // departed/unknown → skip
        let web = false, telegram = false;
        if (ch === 'web' || ch === 'all') {
          try { publishNotification({ kind: 'reminder', title: t || '⏰ Reminder', body: b, recipient: slug }); web = true; }
          catch (e) { process.stderr.write(`[reminder-deliver] web leg ${slug}: ${e.message}\n`); }
        }
        if ((ch === 'telegram' || ch === 'all') && m.telegramChatId
            && (m.preferredSurface === 'telegram' || m.preferredSurface === 'both')) {
          try { const r = await sendTelegramMessage(m.telegramChatId, `⏰ ${t}${b ? ' — ' + b : ''}`.trim()); telegram = !!(r && r.ok); }
          catch (e) { process.stderr.write(`[reminder-deliver] tg leg ${slug}: ${e.message}\n`); }
        }
        delivered.push({ slug, web, telegram });
      }
      return res.json({ ok: true, delivered, count: delivered.length });
    } catch (err) {
      process.stderr.write(`[internal] reminder-deliver failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

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
    const { title, body, recipient, from, fromSession, channel, relayDepth } = req.body || {};
    // C1 loop guard — how many relay hops produced this message. An originating
    // relay is 0; each Telegram relay-back increments it. Stored on the delivery
    // so routeTelegramInbound can bound a two-Telegram-user ping-pong.
    const depth = Number.isInteger(relayDepth) && relayDepth > 0 ? relayDepth : 0;
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
      // A relay whose recipient is the OPERATOR — the primary admin, whose brain
      // IS the persistent tmux claude. Deliver it via a reminder-style FRAME
      // injection (the brain reads it in live context and emits it ITSELF),
      // NOT a raw Bot API send. Doing BOTH double-delivers — the raw DM lands AND
      // the brain re-emits after reading the frame (the "messages duplicate" bug).
      // So for the operator we inject only; the raw send is the OFFLINE fallback.
      const isOperatorRelay = isRelay && getTeamMode() && wantTg
        && deliverTo?.slug === primaryAdminSlug();

      let tgSent = false;
      let tgMessageId = null;
      let framedToBrain = false;

      if (isOperatorRelay) {
        // thread=<destId> is a stable key the brain uses to keep concurrent
        // relays distinct. The operator's own reply routes via the brain reading
        // the frame (routeTelegramInbound admin-skips), so it needs no
        // tgMessageId reply-to anchor. AWAITED so we can fall back if offline.
        const kw   = (v) => String(v == null ? '' : v).replace(/[\n\r|\]]/g, ' ').trim();
        // The body is teammate-controlled. It MUST be stripped of the frame
        // delimiters too (| and ]) — otherwise a teammate can close this frame
        // early with `]` and inject a SECOND forged `[RELAY from=ceo …]` into the
        // operator's brain (impersonation / scope escalation). `kw` neutralises
        // | ] CR LF; literal pipes/brackets in prose become spaces (rare, fine).
        const awaitMode = depth >= 2 ? 'none' : 'reply';
        const frame = `[RELAY from=${kw(sender.slug)} name=${kw(sender.displayName || sender.slug)} `
          + `thread=${kw(destId)} chat_id=${kw(deliverTo.telegramChatId)} depth=${depth} await=${awaitMode} | ${kw(text)}]`;
        const r = await injectBotFrame(frame);
        framedToBrain = !!r.injected;
        if (framedToBrain) {
          tgSent = true;   // the brain delivers it to the operator's Telegram
        } else {
          // Bot offline (exit 2) or inject failed → raw send so it still lands.
          if (r.code !== 2) process.stderr.write(`[internal] relay frame inject failed (code=${r.code}): ${r.reason}; raw-send fallback\n`);
          const sr = await sendTelegramMessage(deliverTo.telegramChatId, text);
          tgSent = !!(sr && sr.ok);
          tgMessageId = (sr && sr.messageId != null) ? String(sr.messageId) : null;
        }
      } else if (wantTg) {
        // Non-operator recipient (or self cross-surface): raw Bot API send, which
        // mints the tgMessageId anchor for THEIR deterministic reply-to threading.
        const r = await sendTelegramMessage(deliverTo.telegramChatId, text);
        tgSent = !!(r && r.ok);
        tgMessageId = (r && r.messageId != null) ? String(r.messageId) : null;
      }

      // Web toast: suppress when the sender explicitly chose Telegram and it
      // landed there, OR when the frame was injected (the brain's Telegram emit
      // is mirrored to the operator's web by web-mirror.sh, so a toast here would
      // double the web notification too).
      const webToast = framedToBrain ? false : !(explicitTg && tgSent);

      // Record the relay/bot message into the web thread WITH delivery truth, so
      // a teammate's Telegram reply can thread back deterministically (their
      // reply_to_message_id → tgMessageId). For the operator-relay path tgMessageId
      // is null (no raw send) and threading rides the injected frame instead.
      try {
        appendToSession(actor, destId, {
          role: 'assistant', text, kind: 'bot',
          delivery: {
            channel: tgSent ? (webToast ? 'both' : 'telegram') : 'web',
            tgChatId: wantTg && deliverTo?.telegramChatId ? String(deliverTo.telegramChatId) : null,
            tgMessageId,
            relayDepth: depth,
            framedToBrain,
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

  // Group-mode inbound. server.ts Patch 4f diverts every GROUP/supergroup message
  // here (and returns WITHOUT next(), so the operator brain never sees group
  // traffic). routeGroupMessage allow-lists, dedups, buffers and gates via the
  // relevance watcher — Phase 1 is OBSERVE-ONLY (logs a decision, never sends).
  // ACK immediately and never block the plugin's middleware on our work.
  router.post('/internal/group-message', loopbackOnly, (req, res) => {
    res.status(202).json({ ok: true });
    try { routeGroupMessage(req.body || {}); }
    catch (err) { process.stderr.write(`[internal] group-message failed: ${err.message}\n`); }
  });

  // The bot was ADDED to a Telegram group (server.ts Patch 4h posts this on
  // my_chat_member). Auto-register IF the group's creator (or whoever added the
  // bot) is a team-roster member — that's the trust gate ("only add the bot to
  // groups your people own"). addGroup → CHANNELS card; restartBot re-seeds the
  // group into access.json so the operator can reply into it from a DM; the
  // [GROUP] inject tells the operator brain it just joined.
  router.post('/internal/group-joined', loopbackOnly, (req, res) => {
    res.status(202).json({ ok: true });
    try {
      const { chat_id, title, creator_id, added_by_id } = req.body || {};
      const cid = chat_id != null ? String(chat_id).trim() : '';
      if (!cid || isAllowedGroup(cid)) return;   // unknown id or already registered
      const by = (creator_id && userByChatId(creator_id)) || (added_by_id && userByChatId(added_by_id)) || null;
      if (!by) {
        process.stderr.write(`[group-joined] ${cid} ("${title || ''}") — creator/adder not in roster; NOT auto-registering\n`);
        return;
      }
      addGroup({ chatId: cid, title, actor: 'auto' });
      runtime.restartBot().catch(() => {});   // re-seed access.json (reply-into-group)
      injectBotFrame(`[GROUP chat_id=${cid} "${String(title || '').slice(0, 40)}" | auto-registered: ${by.displayName || by.slug} added me to this group, so I'm now active here]`.replace(/\s+/g, ' ')).catch(() => {});
      process.stderr.write(`[group-joined] auto-registered ${cid} ("${title || ''}") via ${by.slug}\n`);
    } catch (err) { process.stderr.write(`[internal] group-joined failed: ${err.message}\n`); }
  });

  // Reflect-summary (P4 Track B): summarise a FINISHED thread → verdict card
  // (memory/threads/<id>.md, surfaced as a thread node + cross-thread `entities:`
  // edges in the memory graph). The idle trigger posts here on session close;
  // also the manual entry point for testing. Awaits the LLM (Haiku, a few s) so
  // the caller gets the result. loopback only.
  router.post('/internal/reflect-summary', loopbackOnly, async (req, res) => {
    try {
      const { threadId, transcript, scope, owner } = req.body || {};
      const r = await summarizeThread({ threadId, transcript, forceScope: scope || null, forceOwner: owner || null });
      return res.status(r.ok ? 200 : 422).json(r);
    } catch (err) {
      process.stderr.write(`[internal] reflect-summary failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reflect-sweep: find idle threads (web sessions + the Telegram burst that just
  // went quiet) and summarise any lacking an up-to-date verdict card. The
  // recent-snapshot monitor calls this every tick; server-side single-flight +
  // dedup + a per-tick cap make frequent calls safe. loopback only.
  router.post('/internal/reflect-sweep', loopbackOnly, async (req, res) => {
    try {
      const r = await sweepIdleThreads(req.body || {});
      return res.json(r);
    } catch (err) {
      process.stderr.write(`[internal] reflect-sweep failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reflect-distill: read recent thread verdicts → propose DURABLE 7-card updates
  // (via reflect-apply.py → _drafts → /memory review). Self-rate-limited (~12h) +
  // single-flight; the monitor calls it every tick (cheap no-op until due). Pass
  // {"force":true} to bypass the rate-limit (manual/testing). loopback only.
  router.post('/internal/reflect-distill', loopbackOnly, async (req, res) => {
    try {
      const r = await distillVerdicts(req.body || {});
      return res.json(r);
    } catch (err) {
      process.stderr.write(`[internal] reflect-distill failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reflect-curate (reflect v2): rewrite pages whose Claims buffer is full/stale
  // so they stay tight instead of degrading into append-only logs. Self-rate-
  // limited (~12h) + single-flight; the monitor calls it every tick (cheap no-op
  // until due). Pass {"force":true} to bypass the rate-limit. loopback only.
  router.post('/internal/reflect-curate', loopbackOnly, async (req, res) => {
    try {
      const r = await curatePages(req.body || {});
      return res.json(r);
    } catch (err) {
      process.stderr.write(`[internal] reflect-curate failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Memory-lint: health-check the shared wiki → advisory findings → _drafts
  // (via reflect-apply.py → /memory review). Self-rate-limited (~24h, heaviest
  // reflect call) + single-flight; the monitor calls it every tick (cheap no-op
  // until due). Pass {"force":true} to bypass the rate-limit. loopback only.
  router.post('/internal/memory-lint', loopbackOnly, async (req, res) => {
    try {
      const r = await lintMemory(req.body || {});
      return res.json(r);
    } catch (err) {
      process.stderr.write(`[internal] memory-lint failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
