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
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve as resolvePath, relative as relativePath } from 'node:path';
import { PROJECT_DIR } from '../config.js';
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
    // updateInternal, not update(): TELEGRAM_ALLOWED_IDS is no longer a catalog
    // field (the roster owns the list since the settings panel), and update()
    // silently drops non-catalog names → "no recognised fields" → sync dead.
    store.updateInternal('telegram', { TELEGRAM_ALLOWED_IDS: joined });
    runtime.applyFiles('telegram');           // → {home}/.{bot}/integrations.env
    const restartOk = await runtime.restartBot();
    return { ok: true, count: ids.length, restartOk };
  } catch (err) {
    process.stderr.write(`[telegram-sync] allowed-ids sync failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Boot-time self-heal of the Telegram allow-list. Recomputes TELEGRAM_ALLOWED_IDS
 * from the team roster and flushes it into the store + integrations.env WITHOUT a
 * bot restart — bot.sh reads the fresh integrations.env on its own startup (it
 * waits for wsapi-ready first), so no signal is needed.
 *
 * Why (2026-07-16): syncTelegramAllowedIds only runs on a roster edit. A member
 * whose Telegram link predates that code path (or a sync whose bot-restart leg
 * failed and was never retried) stays ON the roster but OFF the allow-list — the
 * bot silently ignores their DMs and group messages. Seen live: a prod teammate
 * was in the roster with the right chat id, yet TELEGRAM_ALLOWED_IDS was empty
 * and allowFrom held only the admin. Reconciling from the roster on every boot
 * makes "on the roster ⇒ allowed" always true, no matter how they were added.
 */
export function reconcileTelegramAllowedIdsAtBoot() {
  if (!telegramActive()) return { skipped: 'telegram not active' };
  try {
    const ids = telegramAllowedIds();
    const joined = ids.join(',') || NO_IDS_SENTINEL;
    store.updateInternal('telegram', { TELEGRAM_ALLOWED_IDS: joined });
    runtime.applyFiles('telegram');           // → {home}/.{bot}/integrations.env
    return { ok: true, count: ids.length };
  } catch (err) {
    process.stderr.write(`[telegram-sync] boot allowed-ids reconcile failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Apply a change to the GROUP registry to the live bot. bot.sh seeds access.json's
 * `groups{}` from the .team-config.json registry at startup, and the plugin gates
 * outbound replies on `access.groups`, so restarting the bot makes a newly
 * registered group reply-able from the operator's DM. The registry itself is
 * already written by team.addGroup/removeGroup; this just re-seeds + reloads.
 * Fire-and-forget from the group routes. No-op when Telegram isn't active.
 */
export async function syncTelegramGroups() {
  if (!telegramActive()) return { skipped: 'telegram not active' };
  try {
    const restartOk = await runtime.restartBot();
    return { ok: true, restartOk };
  } catch (err) {
    process.stderr.write(`[telegram-sync] groups sync failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch a group's admin list straight from the Bot API (the bot must be in the
 * group). Used by the watcher's retroactive registration to find the group's
 * creator when the my_chat_member join event was never processed (deferred bot,
 * poll gap). Returns the raw admins array, or null on any failure. Never throws.
 */
export async function getChatAdministrators(chatId) {
  if (!telegramActive()) return null;
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d{4,20}$/.test(id)) return null;

  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return null;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChatAdministrators`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok || !Array.isArray(json.result)) return null;
    return json.result;
  } catch (err) {
    process.stderr.write(`[telegram-sync] getChatAdministrators failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Send a plain-text message to a specific Telegram chat id from wsapi. Used by
 * the cross-surface relay to ping a teammate where they prefer to be reached.
 * Returns { ok, messageId } or { ok:false, error }. Never throws.
 */
export async function sendTelegramMessage(chatId, text, { logKind } = {}) {
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
    // EXCEPTION — a group-mode send (logKind:'group') must NEVER touch the
    // operator's DM conversation log: recent-snapshot.js renders that log into
    // the admin's PRIVATE RECENT_TELEGRAM with no chat_id filter, so a group
    // answer (and the untrusted group text it echoes) would laundry into the
    // operator brain's high-trust prefix = cross-surface prompt-injection. The
    // group's own audit sink (.group-watcher/<gid>.jsonl) is its record instead.
    if (logKind !== 'group') logTelegramOutbound(id, body, messageId);
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Telegram Bot API hard limit for bot uploads is 50 MB.
const TELEGRAM_DOC_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Upload a file from disk to a Telegram chat as a document (sendDocument). This
 * is how the group brain DELIVERS a real file (a rendered PDF, a CSV, …) — the
 * text stream alone can't carry an attachment, which is why claiming "sent" a
 * file over text was always a lie.
 *
 * Security: the path is confined to PROJECT_DIR. A group message is untrusted
 * input, and the marker that triggers this comes from the brain's output; the
 * confinement stops "[[SEND_FILE /etc/…]]" / secret-file exfiltration even if a
 * member tries to steer it. Must be a regular file, ≤ 50 MB.
 *
 * Uses Node's native fetch + FormData + Blob (undici multipart) — this is wsapi
 * (Node), NOT the bun/grammy path that hangs on multipart, so no bypass needed.
 * api.telegram.org is on the egress base allowlist. Returns { ok, messageId } or
 * { ok:false, error }. Never throws.
 */
export async function sendGroupDocument(chatId, filePath, { caption, logKind } = {}) {
  if (!telegramActive()) return { ok: false, error: 'telegram not active' };
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d{4,20}$/.test(id)) return { ok: false, error: 'invalid chat id' };

  const raw = String(filePath == null ? '' : filePath).trim();
  if (!raw) return { ok: false, error: 'no file path' };
  // Confine to PROJECT_DIR: resolve, then require it stays inside (no ../ escape,
  // no absolute path to a secret elsewhere on the box).
  const abs = resolvePath(PROJECT_DIR, raw);
  const rel = relativePath(PROJECT_DIR, abs);
  if (rel === '' || rel.startsWith('..')) return { ok: false, error: 'file is outside the project directory' };

  let data, info;
  try {
    info = await stat(abs);
    if (!info.isFile()) return { ok: false, error: 'not a regular file' };
    if (info.size === 0) return { ok: false, error: 'file is empty' };
    if (info.size > TELEGRAM_DOC_MAX_BYTES) return { ok: false, error: 'file exceeds the 50 MB Telegram limit' };
    data = await readFile(abs);
  } catch (err) {
    return { ok: false, error: `file unreadable: ${err.message}` };
  }

  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return { ok: false, error: 'no bot token' };

  try {
    const form = new FormData();
    form.set('chat_id', id);
    if (caption && String(caption).trim()) form.set('caption', String(caption).trim().slice(0, 1024));
    form.set('document', new Blob([data]), basename(abs));
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) {
      return { ok: false, error: `telegram ${resp.status}: ${JSON.stringify(json).slice(0, 180)}` };
    }
    return { ok: true, messageId: json.result?.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a chat action (e.g. 'typing') so Telegram shows "<bot> is typing…" while a
 * long turn runs — the natural, non-repetitive "working on it" signal (vs spamming
 * a fixed "checking…" message). Expires after ~5s, so callers re-send to keep it
 * alive. Best-effort; never throws.
 */
export async function sendChatAction(chatId, action = 'typing') {
  if (!telegramActive()) return { ok: false };
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d{4,20}$/.test(id)) return { ok: false };
  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return { ok: false };
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, action }),
    });
    return { ok: true };
  } catch { return { ok: false }; }
}

// The bot's own Telegram user id (via getMe), cached. Group mode needs it to
// drop the bot's OWN group sends before they re-enter the relevance watcher and
// trigger a self-reply loop (dedup on message_id can't catch a new outbound id).
let _botUserId = null;
export async function getBotUserId() {
  if (_botUserId) return _botUserId;
  if (!telegramActive()) return null;
  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = await resp.json().catch(() => ({}));
    if (json.ok && json.result?.id != null) { _botUserId = String(json.result.id); return _botUserId; }
  } catch { /* network — caller retries later */ }
  return null;
}

// ─── File download (group-mode images) ─────────────────────────────────────────
// Download a Telegram file (e.g. a group photo) by file_id, via the Bot API. Two
// hops: getFile → file_path, then GET https://api.telegram.org/file/bot<token>/<path>.
// api.telegram.org is on the egress base allowlist (same host as sendMessage), so
// both hops reach out. Capped so a malicious/huge file can't OOM the small VPS.
// Returns { ok, buffer, ext } or { ok:false, error }. Never throws.
const MAX_TG_FILE_BYTES = 20 * 1024 * 1024;   // 20 MB — Telegram photo sizes are well under this
export async function downloadTelegramFile(fileId) {
  if (!telegramActive()) return { ok: false, error: 'telegram not active' };
  const fid = String(fileId == null ? '' : fileId).trim();
  if (!fid) return { ok: false, error: 'no file id' };
  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return { ok: false, error: 'no bot token' };
  try {
    const metaResp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fid)}`);
    const meta = await metaResp.json().catch(() => ({}));
    if (!metaResp.ok || !meta.ok || !meta.result?.file_path) {
      return { ok: false, error: `getFile ${metaResp.status}: ${JSON.stringify(meta).slice(0, 160)}` };
    }
    const filePath = meta.result.file_path;                       // e.g. "photos/file_12.jpg"
    const ext = (String(filePath).match(/\.([A-Za-z0-9]{1,5})$/)?.[1] || 'jpg').toLowerCase();
    const fileResp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!fileResp.ok) return { ok: false, error: `file download ${fileResp.status}` };
    const buf = Buffer.from(await fileResp.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'empty file' };
    if (buf.length > MAX_TG_FILE_BYTES) return { ok: false, error: `file too large (${buf.length} bytes)` };
    return { ok: true, buffer: buf, ext };
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
  // tgMessageId on one of the sender's relay messages. Capture the relay depth
  // recorded on the matched message so we can bound a Telegram ping-pong (C1).
  let dest = null;
  let matchedDepth = 0;
  if (reply_to_message_id != null) {
    const rid = String(reply_to_message_id);
    for (const s of sessions) {
      let msgs = [];
      try { msgs = readUndelivered(sender.slug, s.id, 0).messages; } catch { msgs = []; }
      const hit = msgs.find(m => m.delivery && String(m.delivery.tgMessageId || '') === rid);
      if (hit) { dest = s; matchedDepth = Number(hit.delivery.relayDepth) || 0; break; }
    }
  }
  if (!dest) {
    // No deterministic reply-to. Route a non-admin teammate to their single
    // outstanding relay thread; refuse to guess across multiple.
    if (sessions.length === 1) dest = sessions[0];
    else return { ok: true, routed: false, reason: 'ambiguous' };   // never guess across peers
  }

  // Durable dedup (H6/RC-2): the in-memory _seenInbound set is wiped on a wsapi
  // restart, so a bot retry after a restart would double-route. Each inbound is
  // stamped with its Telegram message id (inside delivery — the only persisted
  // free-form slot appendToSession keeps), so re-check the dest thread on disk.
  if (message_id != null) {
    let prior = [];
    try { prior = readUndelivered(sender.slug, dest.id, 0).messages; } catch { prior = []; }
    if (prior.some(m => m.delivery && String(m.delivery.tgInboundId || '') === String(message_id))) {
      return { ok: true, routed: false, reason: 'duplicate (durable)' };
    }
  }

  // Thread the reply into the sender's own web relay thread (out-of-band → the
  // never-blind watermark surfaces it on their next web turn). Stamp the inbound
  // message id (durable dedup above) into delivery.
  try {
    appendToSession(sender.slug, dest.id, {
      role: 'user', text: body, kind: 'telegram-reply',
      delivery: { tgInboundId: message_id != null ? String(message_id) : null, at: new Date().toISOString() },
    });
  } catch (err) { process.stderr.write(`[telegram-inbound] append failed: ${err.message}\n`); }

  // C1 — bound the Telegram ping-pong. Two teammates who BOTH prefer Telegram
  // would otherwise relay-back forever (each reply auto-pings the other's TG,
  // whose reply routes back …). The depth rides on the delivery the peer replied
  // to; once it passes the cap we still thread the reply for the record but stop
  // auto-forwarding it onward.
  const peers = Object.keys(dest.relayPeers || {});
  const MAX_RELAY_DEPTH = 2;
  if (matchedDepth >= MAX_RELAY_DEPTH) {
    process.stderr.write(`[telegram-inbound] relay depth ${matchedDepth} ≥ ${MAX_RELAY_DEPTH}; threaded but not forwarded (loop guard)\n`);
    return { ok: true, routed: true, session_id: dest.id, peers, delivered: false, reason: 'depth-capped' };
  }

  // Active relay-back, AWAITED (RC-1). A Telegram-native teammate never takes a
  // web turn, so the reply would otherwise be recorded write-only and the peer
  // never hears it. Push it onward via the relay machinery (loopback
  // /chat-session) and AWAIT the result (bounded) — a silent fire-and-forget
  // failure used to drop the message with no trace. bot.sh awaits this turn
  // (1.5s cap) to decide suppression, so each call is capped below that.
  const port = process.env.WORKSPACE_API_PORT || '3001';
  const postRelay = (peerSlug) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1200);
    return fetch(`http://127.0.0.1:${port}/api/internal/chat-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: peerSlug, from: sender.slug, fromSession: dest.id, body, relayDepth: matchedDepth + 1 }),
      signal: ctl.signal,
    }).then(r => r.ok).catch((err) => {
      process.stderr.write(`[telegram-inbound] relay-back to ${peerSlug} failed: ${err.message}\n`);
      return false;
    }).finally(() => clearTimeout(timer));
  };
  const results = await Promise.allSettled(peers.map(postRelay));
  const delivered = results.some(r => r.status === 'fulfilled' && r.value === true);
  if (peers.length && !delivered) {
    process.stderr.write(`[telegram-inbound] relay-back to all peers failed (session ${dest.id})\n`);
  }
  return { ok: true, routed: true, session_id: dest.id, peers, delivered };
}
