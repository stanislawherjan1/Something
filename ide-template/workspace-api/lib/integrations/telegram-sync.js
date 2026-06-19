/**
 * telegram-sync — bridges the TEAM store to the Telegram integration so that:
 *
 *   1. The chat ids allowed to DM the bot track the team roster. Previously
 *      TELEGRAM_ALLOWED_IDS was only set during activation, so adding a member
 *      later left them locked out. syncTelegramAllowedIds() recomputes the list
 *      from team.telegramAllowedIds(), writes it into the integration field,
 *      flushes integrations.env, and restarts the bot to pick it up.
 *
 *   2. A relay can reach a teammate on Telegram (not just the web thread).
 *      sendTelegramMessage() sends to an arbitrary chat id straight from wsapi
 *      via the Bot API — api.telegram.org is on the egress base allowlist, and
 *      the bot token is read from the (encrypted) integration store.
 *
 * Both no-op cleanly when Telegram isn't active, so solo / Telegram-less
 * workspaces are unaffected.
 */

import { appendFileSync } from 'node:fs';
import * as store from './store.js';
import * as runtime from './runtime.js';
import { telegramAllowedIds, list as teamList } from '../team.js';
import { listSessions } from '../sessions.js';
import { appendToSession, readUndelivered } from '../chatHistory.js';

// The bot's Telegram conversation log (source for RECENT_TELEGRAM + the live
// recent_messages tool). It's mode 0660 group=botshare; wsapi is in botshare so
// it can append. A relay we send from wsapi via the raw Bot API bypasses the
// bot's own outbound transformer, so without this the bot's brain has NO record
// of what it relayed to a teammate's Telegram and is confused when asked.
const TELEGRAM_LOG_PATH = process.env.TELEGRAM_LOG_PATH || '/home/bot/.telegram/conversation.jsonl';

// Append an outbound relay to the Telegram conversation log so the bot's brain
// (recent_messages / next snapshot) knows what it relayed there. Best-effort —
// missing file / perms are non-fatal (the web thread is still the record).
function logTelegramOutbound(chatId, text, messageId) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      direction: 'outbound',
      method: 'sendMessage',
      chat_id: String(chatId),
      message_id: messageId != null ? String(messageId) : null,
      text: String(text == null ? '' : text),
    };
    appendFileSync(TELEGRAM_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

function telegramActive() {
  try { return store.isActive('telegram'); } catch { return false; }
}

/**
 * Push the team-derived allow-list into the Telegram integration + restart the
 * bot. Fire-and-forget from team routes (the caller shouldn't block its HTTP
 * response on a bot restart). Returns a small status object.
 *
 * Revoke correctness: store.update() silently skips empty-string values, so when
 * the LAST linked member is removed the field can't be blanked directly — and a
 * removed teammate would keep bot DM access. We avoid that by writing a sentinel
 * "0" (no real Telegram user id) when the list is empty: it OVERWRITES the old
 * ids (revoking them) and matches nobody. The admin keeps access via the
 * separate TELEGRAM_ADMIN_CHAT_ID that bot.sh unions in.
 */
const NO_IDS_SENTINEL = '0';

export async function syncTelegramAllowedIds() {
  if (!telegramActive()) return { skipped: 'telegram not active' };
  try {
    const ids = telegramAllowedIds();
    const joined = ids.join(',') || NO_IDS_SENTINEL;
    store.update('telegram', { fields: { TELEGRAM_ALLOWED_IDS: joined } });
    runtime.applyFiles('telegram');           // → {home}/.{bot}/integrations.env
    const restartOk = await runtime.restartBot();
    return { ok: true, count: ids.length, restartOk };
  } catch (err) {
    process.stderr.write(`[telegram-sync] allowed-ids sync failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Send a plain-text message to a specific Telegram chat id from wsapi. Used by
 * the cross-surface relay to ping a teammate where they prefer to be reached.
 * Returns { ok, messageId } or { ok:false, error }. Never throws.
 */
export async function sendTelegramMessage(chatId, text) {
  if (!telegramActive()) return { ok: false, error: 'telegram not active' };
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d{4,20}$/.test(id)) return { ok: false, error: 'invalid chat id' };
  const body = String(text == null ? '' : text).trim();
  if (!body) return { ok: false, error: 'empty text' };

  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return { ok: false, error: 'no bot token' };

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text: body, disable_web_page_preview: true }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) {
      return { ok: false, error: `telegram ${resp.status}: ${JSON.stringify(json).slice(0, 180)}` };
    }
    const messageId = json.result?.message_id;
    // Record it in the bot's Telegram conversation log so its brain knows what
    // it relayed there (this send bypasses the bot's own outbound transformer).
    logTelegramOutbound(id, body, messageId);
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Dedup recently-processed inbound Telegram message ids (the bot middleware may
// retry). Small bounded set — replay protection, not durable state.
const _recentInbound = new Set();
function _seenInbound(messageId) {
  if (messageId == null) return false;
  const key = String(messageId);
  if (_recentInbound.has(key)) return true;
  _recentInbound.add(key);
  if (_recentInbound.size > 1000) _recentInbound.delete(_recentInbound.values().next().value);
  return false;
}

/**
 * Route an INBOUND Telegram DM from a teammate back into the right web relay
 * thread, then actively push it onward to the peer(s). This is what makes a
 * teammate's Telegram reply land in the conversation it answers (instead of
 * confusing the identity-blind bot) and reach the other person even when that
 * teammate never opens the web.
 *
 * Safety: strictly scoped to the SENDER's OWN relay sessions (resolved from
 * THEIR chat id), so a reply can never land in a thread they don't own.
 * Threading is DETERMINISTIC — match the Telegram reply-to against a stored
 * delivery.tgMessageId. When there's no reply-to and the sender has more than
 * one outstanding relay thread, we REFUSE to guess (returning ambiguous) rather
 * than cross-deliver one teammate's answer to the wrong peer.
 *
 * Returns { ok, routed, reason?, session_id?, peers? }. Never throws.
 */
export async function routeTelegramInbound({ chat_id, text, message_id, reply_to_message_id } = {}) {
  const cid = String(chat_id == null ? '' : chat_id).trim();
  const body = String(text == null ? '' : text).trim();
  if (!cid || !body) return { ok: true, routed: false, reason: 'empty' };
  if (_seenInbound(message_id)) return { ok: true, routed: false, reason: 'duplicate' };

  // Resolve the sender from their linked chat id — ANY teammate, not just admin.
  let sender = null;
  try { sender = teamList().find(m => String(m.telegramChatId || '') === cid) || null; }
  catch { sender = null; }
  if (!sender) return { ok: true, routed: false, reason: 'not a teammate' };
  // The operator/admin is handled by their OWN brain (the single tmux claude IS
  // the operator's assistant). Auto-routing the admin's Telegram replies was too
  // aggressive — a tap-reply asking the bot ABOUT a relay ("what's this about?")
  // got mis-relayed to the teammate. So the admin always falls through to their
  // brain, which relays only on an explicit instruction ("tell Jan …"). Non-admin
  // teammates (whose DMs the identity-blind brain would misattribute) still route.
  if (sender.role === 'admin') return { ok: true, routed: false, reason: 'admin (brain handles)' };

  // Only the sender's OWN relay sessions (leak-safe).
  let sessions;
  try {
    sessions = listSessions(sender.slug, { archived: false })
      .filter(s => s.relayPeers && Object.keys(s.relayPeers).length);
  } catch { sessions = []; }
  if (!sessions.length) return { ok: true, routed: false, reason: 'no relay thread' };

  // Deterministic threading: match the Telegram reply-to against a stored
  // tgMessageId on one of the sender's relay messages.
  let dest = null;
  if (reply_to_message_id != null) {
    const rid = String(reply_to_message_id);
    for (const s of sessions) {
      let msgs = [];
      try { msgs = readUndelivered(sender.slug, s.id, 0).messages; } catch { msgs = []; }
      if (msgs.some(m => m.delivery && String(m.delivery.tgMessageId || '') === rid)) { dest = s; break; }
    }
  }
  if (!dest) {
    // No deterministic reply-to. Route a non-admin teammate to their single
    // outstanding relay thread; refuse to guess across multiple.
    if (sessions.length === 1) dest = sessions[0];
    else return { ok: true, routed: false, reason: 'ambiguous' };   // never guess across peers
  }

  // Thread the reply into the sender's own web relay thread (out-of-band → the
  // never-blind watermark surfaces it on their next web turn).
  try { appendToSession(sender.slug, dest.id, { role: 'user', text: body, kind: 'telegram-reply' }); }
  catch (err) { process.stderr.write(`[telegram-inbound] append failed: ${err.message}\n`); }

  // Active relay-back: a Telegram-native teammate never takes a web turn, so the
  // reply would otherwise be recorded write-only and the peer never hears it.
  // Push it onward NOW via the existing relay machinery (loopback /chat-session),
  // which threads into the peer's paired session + delivers on the peer's surface.
  // Fire the relay-back ASYNC (not awaited) so the routing DECISION returns fast
  // — the bot.sh middleware awaits this (capped) to decide whether to suppress
  // the brain, and must not block on the slow downstream Telegram send.
  const peers = Object.keys(dest.relayPeers || {});
  const port = process.env.WORKSPACE_API_PORT || '3001';
  for (const peerSlug of peers) {
    fetch(`http://127.0.0.1:${port}/api/internal/chat-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: peerSlug, from: sender.slug, fromSession: dest.id, body }),
    }).catch((err) => {
      process.stderr.write(`[telegram-inbound] relay-back to ${peerSlug} failed: ${err.message}\n`);
    });
  }
  return { ok: true, routed: true, session_id: dest.id, peers };
}
