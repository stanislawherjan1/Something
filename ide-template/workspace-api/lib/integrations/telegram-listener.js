/**
 * Telegram, as a surface: one long poll held open from inside workspace-api,
 * and what each update it brings turns into. The counterpart of
 * slack-listener.js for the Bot API; on when TELEGRAM_TRANSPORT=wsapi
 * (lib/integrations/telegram-transport.js), otherwise the channel plugin in
 * the bot's tmux session reads Telegram and this file does nothing.
 *
 * Why here: workspace-api already decrypts the store, already runs the member
 * DMs and the group watcher, and already does every Telegram send
 * (telegram-sync.js). The plugin needed a pinned CLI, sixteen patches at
 * every boot and a tmux session to type into; this needs a loop.
 *
 * What an update becomes:
 *   a DM from a roster person        → a turn AS that person (member-dm),
 *                                      the operator included; a relay answer
 *                                      goes to its thread (routeTelegramInbound)
 *   a DM from anyone else            → nothing is sent; the chat id is noted
 *                                      for an admin (Team → Channels)
 *   a group message                  → the group watcher, the same payload the
 *                                      plugin's diversion built
 *   the bot added to a group         → registered when a roster person added it
 * Telegram hands updates out once, in order, by `update_id`: the offset on disk
 * is the dedup, and what arrived while this process was down is still there
 * when it comes back (Telegram keeps them 24 hours). One consumer per token:
 * a 409 means another poller is alive — the listener backs off and says so.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.js';
import * as tg from './telegram-sync.js';
import { wsapiTransport } from './telegram-transport.js';
import { userByChatId, isAllowedGroup, addGroup } from '../team.js';
import { saveAttachments } from '../attachments.js';
import { resetSurfaceSession } from './member-dm.js';
import { endWarm } from '../claude.js';

const ID = 'telegram';
const POLL_TIMEOUT_S = 50;
const BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60_000;
const CONFLICT_TELL_AFTER_MS = 60_000;      // a minute of 409s: another poller holds the token
const CONFLICT_TELL_EVERY_MS = 3600_000;
const TYPING_EVERY_MS = 4500;               // Telegram shows "typing…" for ~5 s per call
const TYPING_MAX_MS = 5 * 60_000;
const ATTACHMENT_KINDS = ['document', 'voice', 'audio', 'video_note', 'video', 'sticker'];
const RESTART_RE = /^\/restart(?:@\w+)?\s*$/i;

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function statePath() { return join(projectDir(), '.team', 'telegram-listener-state.json'); }
function pendingPath() { return join(projectDir(), '.team', 'telegram-pending.json'); }

// ─── state ───────────────────────────────────────────────────────────────────

const st = {
  running: false, generation: 0, connected: false, since: null, lastUpdateAt: null, offset: 0,
  self: null, error: null, conflictSince: null, conflictToldAt: 0, abort: null,
};

/** For the Integrations page: is the loop up, since when, what it sees. */
export function status() {
  return {
    running: st.running, connected: st.connected, since: st.since, lastUpdateAt: st.lastUpdateAt, offset: st.offset,
    botUserId: st.self?.id ? String(st.self.id) : null, username: st.self?.username || null,
    conflict: st.conflictSince ? { since: st.conflictSince } : null, error: st.error,
  };
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (Number.isFinite(s?.offset)) st.offset = s.offset;
    if (s?.lastUpdateAt) st.lastUpdateAt = s.lastUpdateAt;
  } catch { /* first run */ }
}
function saveState() {
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(statePath(), JSON.stringify({ offset: st.offset, lastUpdateAt: st.lastUpdateAt }), { mode: 0o660 });
  } catch { /* best effort: Telegram re-delivers from the last confirmed offset */ }
}

// ─── pending people (DMs from Telegram users not on the roster) ──────────────

export function pendingUsers() {
  try { return JSON.parse(readFileSync(pendingPath(), 'utf8')); } catch { return []; }
}
function notePending({ id, name, username }) {
  const cur = pendingUsers().filter(p => p.id !== id);
  cur.push({ id, name: name || null, username: username || null, at: new Date().toISOString() });
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(pendingPath(), JSON.stringify(cur.slice(-50)), { mode: 0o660 });
  } catch (err) { process.stderr.write(`[telegram] pending list not written: ${err.message}\n`); }
}
export function forgetPending(id) {
  const cur = pendingUsers().filter(p => p.id !== id);
  try { writeFileSync(pendingPath(), JSON.stringify(cur), { mode: 0o660 }); } catch { /* best effort */ }
}

// ─── what a message carries ──────────────────────────────────────────────────

/** The largest photo's file id, or an image sent as a document. */
export function photoFileId(m) {
  if (Array.isArray(m?.photo) && m.photo.length) return m.photo[m.photo.length - 1].file_id;
  if (m?.document && typeof m.document.mime_type === 'string' && m.document.mime_type.startsWith('image/')) return m.document.file_id;
  return null;
}

/** A non-image attachment in the shape the group watcher reads (kind/file_id/size/mime/name|emoji). */
export function attachmentOf(m) {
  const att = (kind, f, extra) => (f && f.file_id ? { kind, file_id: f.file_id, size: f.file_size ?? null, ...extra } : null);
  if (m?.document && !photoFileId(m)) return att('document', m.document, { mime: m.document.mime_type ?? null, name: m.document.file_name ?? null });
  if (m?.voice) return att('voice', m.voice, { mime: m.voice.mime_type ?? null });
  if (m?.audio) return att('audio', m.audio, { mime: m.audio.mime_type ?? null, name: m.audio.file_name ?? m.audio.title ?? null });
  if (m?.video_note) return att('video_note', m.video_note, {});
  if (m?.video) return att('video', m.video, { mime: m.video.mime_type ?? null, name: m.video.file_name ?? null });
  if (m?.sticker) return att('sticker', m.sticker, { emoji: m.sticker.emoji ?? null });
  return null;
}

/** Was the bot addressed: an @mention of its username, or a text mention of its id. */
export function mentionsSelf(m, self) {
  const text = m?.text ?? m?.caption ?? '';
  const name = self?.username ? `@${self.username}` : null;
  for (const e of m?.entities ?? m?.caption_entities ?? []) {
    if (e.type === 'text_mention' && self?.id != null && e.user?.id === self.id) return true;
    if (e.type === 'mention' && name && text.substr(e.offset, e.length) === name) return true;
  }
  return false;
}

/** The payload the group watcher takes — what the plugin's diversion (Patch 4f) built. */
export function groupPayload(m, self) {
  const text = m.text ?? m.caption ?? null;
  return {
    chat_id: m.chat?.id != null ? String(m.chat.id) : null,
    chat_title: m.chat?.title ?? null,
    message_id: m.message_id ?? null,
    text,
    photo_file_id: photoFileId(m),
    attachment: attachmentOf(m),
    from_id: m.from?.id != null ? String(m.from.id) : null,
    from_username: m.from?.username ?? null,
    from_name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null,
    reply_to_message_id: m.reply_to_message?.message_id ?? null,
    is_mention: mentionsSelf(m, self),
    is_reply_to_bot: m.reply_to_message?.from?.id != null && self?.id != null && m.reply_to_message.from.id === self.id,
  };
}

// ─── the dispatcher ──────────────────────────────────────────────────────────

/**
 * Build the dispatcher with its dependencies (the real ones by default; tests
 * pass fakes). It takes one Telegram update and returns what it did, as
 * `{ did, ... }`, for the log and the tests.
 */
export function createDispatcher(deps = {}) {
  const d = {
    self: () => st.self,
    userByChatId, isAllowedGroup, addGroup,
    routeInbound: tg.routeTelegramInbound, send: tg.sendTelegramMessage, sendFile: tg.sendGroupDocument,
    typing: tg.sendChatAction, react: tg.reactTelegramMessage, download: tg.downloadTelegramFile,
    admins: tg.getChatAdministrators, logInbound: tg.logTelegramInbound,
    saveAttachments, resetSession: resetSurfaceSession, endWarm, notePending,
    onGroup: null, ackReaction: () => String(process.env.TELEGRAM_ACK_REACTION || '').trim(),
    log: (s) => process.stderr.write(`[telegram] ${s}\n`), ...deps,
  };

  async function attachmentsBlock(m, member) {
    const items = [];
    const pid = photoFileId(m);
    if (pid) items.push({ file_id: pid, name: `photo-${m.message_id}.jpg` });
    const a = attachmentOf(m);
    if (a && ATTACHMENT_KINDS.includes(a.kind)) items.push({ file_id: a.file_id, name: a.name || `${a.kind}-${m.message_id}` });
    if (!items.length) return '';
    const got = [];
    for (const it of items.slice(0, 10)) {
      const r = await d.download(it.file_id);
      if (!r?.ok) { d.log(`attachment from ${member.slug} not fetched: ${r?.error || 'download failed'}`); continue; }
      const name = /\.[A-Za-z0-9]{1,5}$/.test(it.name) ? it.name : `${it.name}.${r.ext || 'bin'}`;
      got.push({ originalname: name, buffer: r.buffer, size: r.buffer.length });
    }
    if (!got.length) return '';
    let saved;
    try { saved = d.saveAttachments(`telegram-${member.slug}`, got); } catch (err) { d.log(`attachments not saved: ${err.message}`); return ''; }
    return `\n\n[Attachments — read these files to answer]\n${saved.map(x => `- ${x.path}`).join('\n')}`;
  }

  async function dm(m) {
    const chatId = String(m.chat.id);
    const from = m.from || {};
    const member = d.userByChatId(chatId);
    if (!member) {
      // Not on the roster: nothing is said (the operator's call), the id is
      // kept so an admin can link a new person without asking for it.
      d.notePending({ id: chatId, name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null, username: from.username || null });
      return { did: 'stranger', chatId };
    }
    const text = String(m.text ?? m.caption ?? '').trim();
    try { d.logInbound({ chat_id: chatId, message_id: m.message_id, user: from.username || from.first_name || null, text }); } catch { /* record only */ }
    if (RESTART_RE.test(text)) {
      // The conversation starts over: the next message opens a new session,
      // and a process kept warm on the old one goes.
      d.resetSession(member.slug, 'telegram');
      try { d.endWarm(`${member.slug}:telegram`, 'restart'); } catch { /* none warm */ }
      await d.send(chatId, 'Starting over — the next message begins a fresh conversation.');
      return { did: 'restart', slug: member.slug };
    }
    const body = `${text}${await attachmentsBlock(m, member)}`.trim();
    if (!body) return { did: 'ignored', why: 'empty' };

    const ack = d.ackReaction();
    if (ack) d.react(chatId, m.message_id, ack).catch?.(() => {});
    // "typing…" while the turn runs: Telegram forgets it after ~5 s.
    const typing = setInterval(() => { d.typing(chatId, 'typing').catch?.(() => {}); }, TYPING_EVERY_MS);
    d.typing(chatId, 'typing').catch?.(() => {});
    const typingCap = setTimeout(() => clearInterval(typing), TYPING_MAX_MS);

    const memberDmDeps = { surface: 'telegram', target: chatId, send: d.send, sendFile: (target, f) => d.sendFile(target, f.abs, { logKind: 'dm' }), react: (emoji) => d.react(chatId, m.message_id, emoji) };
    const r = await d.routeInbound({ chat_id: chatId, text: body, message_id: m.message_id, reply_to_message_id: m.reply_to_message?.message_id ?? null }, { memberDmDeps });
    const done = r?.done || Promise.resolve(r);
    done.then((out) => {
      clearInterval(typing); clearTimeout(typingCap);
      if (out && out.reason === 'error') d.react(chatId, m.message_id, '⚠').catch?.(() => {});
    }).catch(() => { clearInterval(typing); clearTimeout(typingCap); });
    return { did: r?.routed ? 'routed' : 'ignored', why: r?.reason, slug: member.slug, body, done };
  }

  async function joined(u) {
    const self = d.self();
    const nm = u.new_chat_member;
    if (!nm || !self?.id || nm.user?.id !== self.id) return { did: 'ignored', why: 'not me' };
    if (!['member', 'administrator'].includes(nm.status)) return { did: 'ignored', why: `status ${nm.status}` };
    const chatId = String(u.chat?.id ?? '');
    if (!chatId || d.isAllowedGroup(chatId)) return { did: 'ignored', why: 'known group' };
    let creator = null;
    try { creator = (await d.admins(chatId) || []).find(a => a?.status === 'creator')?.user?.id ?? null; } catch { creator = null; }
    const by = (creator != null && d.userByChatId(String(creator))) || (u.from?.id != null && d.userByChatId(String(u.from.id))) || null;
    if (!by) { d.log(`group ${chatId} ("${u.chat?.title || ''}"): creator/adder not on the roster; not registering`); return { did: 'group-ignored', chatId }; }
    d.addGroup({ chatId, title: u.chat?.title, actor: 'auto' });
    d.log(`group ${chatId} ("${u.chat?.title || ''}") registered: ${by.displayName || by.slug} added me`);
    return { did: 'group-registered', chatId, by: by.slug };
  }

  return async function dispatch(update) {
    if (!update || typeof update !== 'object') return { did: 'ignored', why: 'no update' };
    st.lastUpdateAt = new Date().toISOString();
    if (update.my_chat_member) return joined(update.my_chat_member);
    const m = update.message;
    if (!m || !m.chat) return { did: 'ignored', why: 'no message' };
    const self = d.self();
    if (self?.id != null && m.from?.id === self.id) return { did: 'ignored', why: 'own message' };
    if (m.chat.type === 'private') return dm(m);
    if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
      const p = groupPayload(m, self);
      if (!p.text && !p.photo_file_id && !p.attachment) return { did: 'ignored', why: 'nothing to read' };
      if (d.onGroup) { d.onGroup(p); return { did: 'group', chatId: p.chat_id }; }
      return { did: 'ignored', why: 'no group handler' };
    }
    return { did: 'ignored', why: `chat ${m.chat.type}` };
  };
}

let dispatcher = null;
/** The group side plugs in here (the watcher's routeGroupMessage). */
export function setGroupHandler(onGroup) {
  dispatcher = createDispatcher({ onGroup });
}

// ─── the poll ────────────────────────────────────────────────────────────────

function token() {
  try { return store.decryptFor(ID)?.TELEGRAM_BOT_TOKEN || null; } catch { return null; }
}

async function tellConflict() {
  const now = Date.now();
  if (now - st.conflictToldAt < CONFLICT_TELL_EVERY_MS) return;
  st.conflictToldAt = now;
  let admin = null;
  try { admin = store.decryptFor(ID)?.TELEGRAM_ADMIN_CHAT_ID || null; } catch { admin = null; }
  process.stderr.write('[telegram] another process is polling this bot token (409 Conflict for a minute): the plugin in a bot session, an old container, or a second deployment. Messages are being read by it, not here.\n');
  if (admin) await tg.sendTelegramMessage(admin, 'Two processes are reading this bot\'s Telegram updates (409 Conflict). If the channel plugin is still enabled on this deployment, switch it off; if a second container is up, stop it.').catch(() => {});
}

async function pollOnce() {
  const t = token();
  if (!t) throw new Error('no bot token');
  if (!st.self) {
    const id = await tg.getBotUserId();
    const me = await tg.telegramCall('getMe', {});
    st.self = me?.ok ? { id: me.result.id, username: me.result.username || null } : { id: id ? Number(id) : null, username: null };
  }
  const ctl = new AbortController();
  st.abort = () => ctl.abort();
  const timer = setTimeout(() => ctl.abort(), (POLL_TIMEOUT_S + 10) * 1000);
  let json;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${t}/getUpdates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: st.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'my_chat_member'] }),
      signal: ctl.signal,
    });
    json = await resp.json().catch(() => ({}));
    if (resp.status === 409) { const e = new Error('409 Conflict'); e.conflict = true; throw e; }
    if (!resp.ok || json.ok === false) throw new Error(json.description || `telegram ${resp.status}`);
  } finally { clearTimeout(timer); st.abort = null; }
  st.connected = true; st.error = null;
  if (!st.since) st.since = new Date().toISOString();
  if (st.conflictSince) { process.stderr.write('[telegram] the other poller is gone; reading updates here again\n'); st.conflictSince = null; }
  const updates = Array.isArray(json.result) ? json.result : [];
  for (const u of updates) {
    if (Number.isFinite(u.update_id)) st.offset = u.update_id + 1;
    (dispatcher || (dispatcher = createDispatcher()))(u).catch((err) => process.stderr.write(`[telegram] update ${u.update_id} failed: ${err.message}\n`));
  }
  if (updates.length) saveState();
  return updates.length;
}

async function runLoop(generation) {
  let backoff = BACKOFF_MIN_MS;
  while (st.running && generation === st.generation) {
    try {
      await pollOnce();
      backoff = BACKOFF_MIN_MS;
      continue;
    } catch (err) {
      if (!st.running || generation !== st.generation) break;
      st.connected = false;
      if (err?.conflict) {
        st.conflictSince = st.conflictSince || new Date().toISOString();
        if (Date.now() - Date.parse(st.conflictSince) >= CONFLICT_TELL_AFTER_MS) await tellConflict();
        backoff = Math.min(Math.max(backoff * 2, 5000), BACKOFF_MAX_MS);
      } else if (err?.name === 'AbortError') {
        backoff = BACKOFF_MIN_MS;
      } else {
        st.error = String(err?.message || err);
        process.stderr.write(`[telegram] poll failed: ${st.error}\n`);
        if (/unauthorized|not found/i.test(st.error)) { st.running = false; break; }   // a revoked token
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
    await new Promise(r => setTimeout(r, backoff));
  }
}

export function start() {
  if (st.running) return false;
  loadState();
  st.running = true; st.self = null; st.error = null; st.since = null;
  const generation = ++st.generation;
  runLoop(generation).catch((err) => { st.error = String(err?.message || err); st.running = false; });
  return true;
}

export function stop() {
  st.running = false;
  st.generation++;
  st.connected = false;
  if (st.abort) { try { st.abort(); } catch { /* already */ } }
  saveState();
}

/** Match the loop to the flag and the store: up when wsapi owns the transport and Telegram is connected. */
export function reconcile() {
  let usable = false;
  try { usable = wsapiTransport() && store.isUsable(ID); } catch { usable = false; }
  if (usable && !st.running) start();
  else if (!usable && st.running) stop();
  return st.running;
}

export const _state = st;   // tests
