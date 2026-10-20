/**
 * The group watcher's view of a chat platform: everything it has to DO to a
 * room — send, attach a file, react, fetch a file someone posted, say who a
 * sender is — behind one small interface, chosen by the group id's kind
 * (lib/group-id.js). The watcher itself (gate, brain, markers, sessions,
 * history, memory) is the same for every platform; only this file knows that
 * Telegram takes a chat id and Slack a channel and a thread.
 *
 * Two adapters: Telegram over telegram-sync.js (what the watcher called
 * directly before), Slack over slack-api.js. Tests swap one in with
 * `__setAdapter`.
 */
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { PROJECT_DIR } from '../config.js';
import { groupIdKind } from '../group-id.js';
import { userByChatId, userBySlackId } from '../team.js';

const FILE_MAX_BYTES = 50 * 1024 * 1024;

/** A file the brain may send: a regular file under PROJECT_DIR, ≤ 50 MB. Returns { ok, abs, name } or { ok:false, error }. */
export function confinedFile(filePath) {
  const raw = String(filePath == null ? '' : filePath).trim();
  if (!raw) return { ok: false, error: 'no file path' };
  let abs;
  try { abs = realpathSync(resolve(PROJECT_DIR, raw)); } catch { return { ok: false, error: 'file not found' }; }
  let root;
  try { root = realpathSync(PROJECT_DIR); } catch { root = resolve(PROJECT_DIR); }
  if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, error: 'file is outside the project directory' };
  let st;
  try { st = statSync(abs); } catch { return { ok: false, error: 'file not found' }; }
  if (!st.isFile()) return { ok: false, error: 'not a regular file' };
  if (st.size > FILE_MAX_BYTES) return { ok: false, error: `file too large (${st.size} bytes)` };
  return { ok: true, abs, name: basename(abs), size: st.size };
}

// ─── Telegram ────────────────────────────────────────────────────────────────

const TELEGRAM_REACTIONS = '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 😢 🎉 🤩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 😡';

let telegramSelfId = String(process.env.TELEGRAM_BOT_USER_ID || '').trim();
let telegramResolving = false;

function telegramAdapter() {
  const tg = () => import('./telegram-sync.js');
  return {
    kind: 'telegram',
    label: 'Telegram',
    roomNoun: 'Telegram GROUP CHAT',
    replyMax: 4000,   // under Telegram's 4096-character message limit
    prompt: {
      otherBots: '- OTHER BOTS: you CANNOT see messages sent by other Telegram bots — the Telegram platform never delivers bot messages to bots (loop prevention). If someone asks you to talk to another bot or react to what another bot said, explain this limitation plainly instead of waiting or improvising.',
      reactions: `only Telegram's own reaction set (${TELEGRAM_REACTIONS}) — anything else is refused.`,
    },
    async send(chatId, text, opts = {}) { return (await tg()).sendTelegramMessage(chatId, text, { logKind: opts.logKind || 'group' }); },
    async sendFile(target, filePath, opts = {}) { return (await tg()).sendGroupDocument(target, filePath, { logKind: opts.logKind || 'group' }); },
    async typing(chatId, action = 'typing') { return (await tg()).sendChatAction(chatId, action); },
    async react(chatId, messageId, emoji) { return (await tg()).reactTelegramMessage(chatId, messageId, emoji); },
    async download(ref) { return (await tg()).downloadTelegramFile(typeof ref === 'object' && ref ? ref.file_id : ref); },
    memberOf(fromId) { try { return userByChatId(fromId); } catch { return null; } },
    selfId() { return telegramSelfId || null; },
    isSelf(fromId) { return !!telegramSelfId && String(fromId) === telegramSelfId; },
    ensureSelf() {
      if (telegramSelfId || telegramResolving) return;
      telegramResolving = true;
      tg().then(m => m.getBotUserId()).then(id => { if (id) telegramSelfId = String(id); }).catch(() => {}).finally(() => { telegramResolving = false; });
    },
    sendingReady() { return !!telegramSelfId; },
    /** Where a reply to `target` goes: a Telegram group is one stream. */
    replyRef() { return {}; },
    /** The group's creator, when the bot may ask (retroactive registration). */
    async creatorOf(chatId) {
      const admins = await (await tg()).getChatAdministrators(chatId);
      const owner = Array.isArray(admins) ? admins.find((a) => a && a.status === 'creator') : null;
      return owner?.user?.id != null ? String(owner.user.id) : null;
    },
    async afterRegister() { try { (await tg()).syncTelegramGroups().catch(() => {}); } catch { /* best effort */ } },
  };
}

// ─── Slack ───────────────────────────────────────────────────────────────────

// The brain reacts with an emoji; Slack takes a name. The set the prompt
// offers, in Slack's names; anything else is refused, as Telegram refuses.
export const SLACK_REACTIONS = {
  '👍': '+1', '👎': '-1', '❤': 'heart', '❤️': 'heart', '🔥': 'fire', '🥰': 'smiling_face_with_3_hearts', '👏': 'clap', '😁': 'grin',
  '🤔': 'thinking_face', '🤯': 'exploding_head', '😱': 'scream', '😢': 'cry', '🎉': 'tada', '🤩': 'star-struck', '🙏': 'pray',
  '👌': 'ok_hand', '🕊': 'dove_of_peace', '🕊️': 'dove_of_peace', '🤡': 'clown_face', '🥱': 'yawning_face', '🥴': 'woozy_face', '😍': 'heart_eyes',
  '🐳': 'whale', '🌚': 'new_moon_with_face', '🌭': 'hotdog', '💯': '100', '🤣': 'rolling_on_the_floor_laughing', '⚡': 'zap', '⚡️': 'zap',
  '🍌': 'banana', '🏆': 'trophy', '💔': 'broken_heart', '🤨': 'face_with_raised_eyebrow', '😐': 'neutral_face', '🍓': 'strawberry',
  '🍾': 'champagne', '💋': 'kiss', '😈': 'smiling_imp', '😴': 'sleeping', '😭': 'sob', '🤓': 'nerd_face', '👻': 'ghost',
  '👨‍💻': 'male-technologist', '👀': 'eyes', '🎃': 'jack_o_lantern', '🙈': 'see_no_evil', '😇': 'innocent', '😨': 'fearful',
  '🤝': 'handshake', '✍': 'writing_hand', '✍️': 'writing_hand', '🤗': 'hugging_face', '🫡': 'saluting_face', '🎅': 'santa', '🎄': 'christmas_tree',
  '☃': 'snowman', '☃️': 'snowman', '💅': 'nail_care', '🤪': 'zany_face', '🗿': 'moyai', '🆒': 'cool', '💘': 'cupid', '🙉': 'hear_no_evil',
  '🦄': 'unicorn_face', '😘': 'kissing_heart', '💊': 'pill', '🙊': 'speak_no_evil', '😎': 'sunglasses', '👾': 'space_invader',
  '🤷': 'shrug', '😡': 'rage', '✅': 'white_check_mark', '⚠️': 'warning', '⚠': 'warning',
};
export function slackReactionName(emoji) {
  const e = String(emoji || '').trim();
  if (SLACK_REACTIONS[e]) return SLACK_REACTIONS[e];
  if (/^[a-z0-9_+-]{1,40}$/.test(e)) return e;   // already a Slack name
  return null;
}

/** 'slack-C0123' → 'C0123' (the conversation id Slack wants). */
export function slackChannelOf(chatId) {
  const s = String(chatId || '').trim();
  return s.startsWith('slack-') ? s.slice(6) : s;
}

function slackAdapter() {
  const api = () => import('./slack-api.js');
  const listener = () => import('./slack-listener.js');
  return {
    kind: 'slack',
    label: 'Slack',
    roomNoun: 'Slack CHANNEL',
    replyMax: 12000,   // one markdown block
    prompt: {
      otherBots: '- OTHER BOTS: messages from other Slack apps and bots are never shown to you (loop prevention). If someone asks you to react to what another bot posted, say plainly that you cannot see it.',
      reactions: 'a common emoji (👀 👍 ❤ 🔥 👏 😁 🤔 🎉 🙏 👌 💯 🤣 ⚡ 🏆 😎 🫡 🤝 ✅ and the like) — Slack refuses the rest, and then nothing happens.',
    },
    async send(chatId, text, opts = {}) {
      try {
        const ts = await (await api()).postMessage({ channel: slackChannelOf(chatId), text, ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}) });
        return { ok: ts.length > 0, messageId: ts[ts.length - 1] || null };
      } catch (err) { return { ok: false, error: err.message }; }
    },
    async sendFile(target, filePath, opts = {}) {
      const f = confinedFile(filePath);
      if (!f.ok) return f;
      try {
        const a = await api();
        // A person's id → their DM; a channel id → the channel.
        const channel = /^[UW][A-Z0-9]+$/.test(String(target)) ? await a.openDm(String(target)) : slackChannelOf(target);
        if (!channel) return { ok: false, error: 'no DM channel' };
        await a.uploadFile({ channel, filename: f.name, bytes: readFileSync(f.abs), ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}) });
        return { ok: true };
      } catch (err) { return { ok: false, error: err.message }; }
    },
    async typing() { /* Slack has no typing indicator for apps in channels */ },
    async react(chatId, messageId, emoji) {
      const name = slackReactionName(emoji);
      if (!name) return { ok: false, error: 'not a Slack reaction' };
      try { await (await api()).addReaction(slackChannelOf(chatId), String(messageId), name); return { ok: true }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    async download(ref) {
      const r = typeof ref === 'object' && ref ? ref : { file_id: ref };
      const url = String(r.file_id || r.url || '');
      try {
        const buffer = await (await api()).downloadFile(url);
        const ext = (String(r.name || url).match(/\.([A-Za-z0-9]{1,5})(?:\?|$)/)?.[1] || (String(r.mime || '').split('/')[1] || 'bin')).toLowerCase();
        return { ok: true, buffer, ext };
      } catch (err) { return { ok: false, error: err.message }; }
    },
    memberOf(fromId) { try { return userBySlackId(fromId); } catch { return null; } },
    selfId() { let s = null; try { s = slackSelf(); } catch { s = null; } return s; },
    isSelf(fromId) { const s = this.selfId(); return !!s && String(fromId) === s; },
    ensureSelf() { /* the listener learns it at connect time */ },
    sendingReady() { return !!this.selfId(); },
    /** A reply in Slack goes into the thread of the message it answers. */
    replyRef(target) {
      const t = target && (target.thread_id || target.message_id);
      return t && !String(t).startsWith('sys-') && !String(t).startsWith('n') ? { thread_ts: String(t) } : {};
    },
    async creatorOf() { return null; },   // a Slack channel is approved by an admin, never by its creator
    async afterRegister() { /* nothing to re-seed */ },
    _listener: listener,
  };
}

// The listener's own id, read synchronously from its status (set at connect).
let slackStatus = null;
export function __setSlackStatus(fn) { slackStatus = fn; }
function slackSelf() {
  if (slackStatus) return slackStatus()?.botUserId || null;
  return null;
}

// ─── registry ────────────────────────────────────────────────────────────────

const adapters = { telegram: null, slack: null };
const overrides = {};

/** The adapter for a group id (a Telegram chat id, `slack-C…`); Telegram when the id is not a group id at all (legacy callers). */
export function adapterFor(chatId) {
  const kind = groupIdKind(chatId) || 'telegram';
  if (overrides[kind]) return overrides[kind];
  if (!adapters[kind]) adapters[kind] = kind === 'slack' ? slackAdapter() : telegramAdapter();
  return adapters[kind];
}

/** Tests: replace one platform's adapter (null restores). */
export function __setAdapter(kind, adapter) { if (adapter) overrides[kind] = adapter; else delete overrides[kind]; }
