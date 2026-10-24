/**
 * Slack, as a surface: one Socket Mode connection, held open from inside
 * workspace-api, and what each event it brings turns into.
 *
 * Why here and not a process of its own: workspace-api already decrypts the
 * store, already runs the member DMs and the group watcher, and already does
 * every Telegram send from those paths — a second process would need a second
 * key holder and a setuid wrapper for nothing. Why Socket Mode: one outbound
 * WebSocket, no request URL, nothing new through Caddy; it fits a box that
 * accepts nothing from outside.
 *
 * What an event becomes (lib docs/future-plans/SLACK_CHANNEL.md):
 *   a DM from a roster person        → a turn AS that person (member-dm)
 *   a DM from anyone else            → one fixed line, once; listed as pending
 *   a channel message                → the group watcher, through its adapter
 *                                      (only in a channel an admin approved)
 *   tokens_revoked / app_uninstalled → the keys leave the store, the socket closes
 * Every envelope is acknowledged before it is looked at (a slow ack makes Slack
 * send it again) and every message is seen once (`channel:ts` — a mention
 * arrives twice, as `app_mention` and as `message`). Events sent while the
 * socket was down are gone: the gap is recorded and shown, never hidden.
 */
import { WebSocket } from 'undici';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from './slack-api.js';
import * as store from './store.js';
import { writeAllowedHostsFile } from './egress.js';
import { userBySlackId, setSlack, find as memberByEmail, listGroups } from '../team.js';
import { startMemberDm } from './member-dm.js';
import { saveAttachments } from '../attachments.js';
import { __setSlackStatus } from './channel-adapter.js';

const ID = 'slack';
const RECONNECT_MIN_MS = 1000, RECONNECT_MAX_MS = 60_000;
const SEEN_TTL_MS = 10 * 60_000;
const LOST_WINDOWS_KEPT = 5;
// System messages the surface never answers. `thread_broadcast` and
// `file_share` are people talking and stay in.
const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive',
  'channel_unarchive', 'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name', 'group_archive',
  'group_unarchive', 'bot_message', 'ekm_access_denied', 'tombstone', 'reminder_add', 'pinned_item', 'unpinned_item',
]);
const STRANGER_LINE = 'I can only talk with people on this workspace\'s team. Ask an admin to add your email to the team, then write to me again.';

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function pendingPath() { return join(projectDir(), '.team', 'slack-pending.json'); }

// ─── state ───────────────────────────────────────────────────────────────────

const st = {
  running: false, generation: 0, ws: null, connected: false, since: null,
  lastEventAt: null, lastDisconnectAt: null, lost: [], self: null, error: null, closeNow: null,
};
const seen = new Map();        // `channel:ts` → first seen (ms)
const told = new Set();        // Slack user ids already given the stranger line
const paneThreads = new Map(); // person's Slack id → { channel, thread_ts, at } of the assistant-pane conversation they last wrote in or opened
// A week: a message for a person (a delegate's answer, a reminder) must find
// their Chat even when they last wrote days ago. Kept on disk — a deploy
// emptied the map and the next "sent to your DM" went to Activity.
const PANE_THREAD_MAX_AGE_MS = 7 * 24 * 3600_000;
function panePath() { return join(projectDir(), '.team', 'slack-pane-threads.json'); }
let paneLoaded = false;
function loadPanes() {
  if (paneLoaded) return;
  paneLoaded = true;
  try {
    const saved = JSON.parse(readFileSync(panePath(), 'utf8'));
    for (const [user, p] of Object.entries(saved || {})) {
      if (p && p.channel && p.thread_ts && Number.isFinite(p.at) && Date.now() - p.at < PANE_THREAD_MAX_AGE_MS) paneThreads.set(user, p);
    }
  } catch { /* none yet */ }
}
/** Remember the assistant thread a person has open (they wrote in it, or opened it). */
export function notePane(user, channel, threadTs, now = Date.now()) {
  if (!user || !channel || !threadTs) return;
  loadPanes();
  paneThreads.set(String(user), { channel: String(channel), thread_ts: String(threadTs), at: now });
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(panePath(), JSON.stringify(Object.fromEntries(paneThreads)), { mode: 0o660 });
  } catch { /* best effort: RAM still has it */ }
}
/**
 * Where a message for one person goes in Slack: the assistant-pane
 * conversation they last wrote in (that is the Chat they have open; a message
 * posted outside any thread lands in History and the Activity feed instead),
 * when it is recent. Null otherwise: then their DM, at the top level.
 */
export function dmPlace(user, now = Date.now()) {
  loadPanes();
  const p = paneThreads.get(String(user || ''));
  return p && now - p.at < PANE_THREAD_MAX_AGE_MS ? { channel: p.channel, thread_ts: p.thread_ts } : null;
}
const recentDms = new Map();   // DM channel → when a message was last seen (ms; for the catch-up after a lost window)
const titled = new Set();      // assistant-pane threads already given a title
const CATCH_UP_WINDOW_MS = 6 * 3600_000;
const CATCH_UP_CHANNELS = 5;

/** For the Integrations page: is the surface up, since when, what was missed. */
export function status() {
  return {
    running: st.running, connected: st.connected, since: st.since, lastEventAt: st.lastEventAt,
    lastDisconnectAt: st.lastDisconnectAt, lost: st.lost.slice(-LOST_WINDOWS_KEPT),
    team: st.self?.team || null, teamId: st.self?.team_id || null, botUserId: st.self?.user_id || null, error: st.error,
  };
}
__setSlackStatus(status);   // the channel adapter learns the bot's own id from here

// ─── pending people (DMs from workspace users not on the roster) ─────────────

export function pendingUsers() {
  try { return JSON.parse(readFileSync(pendingPath(), 'utf8')); } catch { return []; }
}
function notePending({ id, email, name }) {
  const cur = pendingUsers().filter(p => p.id !== id);
  cur.push({ id, email: email || null, name: name || null, at: new Date().toISOString() });
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(pendingPath(), JSON.stringify(cur.slice(-50)), { mode: 0o660 });
  } catch (err) { process.stderr.write(`[slack] pending list not written: ${err.message}\n`); }
}
export function forgetPending(id) {
  const cur = pendingUsers().filter(p => p.id !== id);
  try { writeFileSync(pendingPath(), JSON.stringify(cur), { mode: 0o660 }); } catch { /* best effort */ }
}

// ─── identity ────────────────────────────────────────────────────────────────

/**
 * The roster member behind a Slack user id, or null. A first sighting is
 * matched by the email Slack holds for the user — only when the user is in the
 * connected workspace (same team id), is a person, and is not deleted — and
 * remembered on the roster. `deps.api` and `deps.self` are injectable.
 */
export async function resolveMember(userId, deps = {}) {
  const hit = (deps.userBySlackId || userBySlackId)(userId);
  if (hit) return hit;
  const self = deps.self || st.self;
  let u;
  try { u = await (deps.api || api).usersInfo(userId); } catch (err) { process.stderr.write(`[slack] users.info ${userId}: ${err.message}\n`); return null; }
  if (!u || u.deleted || u.is_bot || u.id === 'USLACKBOT') return null;
  if (self?.team_id && u.team_id && u.team_id !== self.team_id) return null;   // Slack Connect, another workspace
  const email = String(u.profile?.email || '').trim().toLowerCase();
  if (!email) return null;
  const member = (deps.memberByEmail || memberByEmail)(email);
  if (!member) {
    deps.notePending ? deps.notePending({ id: u.id, email, name: u.real_name || u.profile?.real_name || u.name }) : notePending({ id: u.id, email, name: u.real_name || u.profile?.real_name || u.name });
    return null;
  }
  try { (deps.setSlack || setSlack)(member.email, { userId: u.id }, 'slack'); }
  catch (err) { process.stderr.write(`[slack] could not link ${u.id} to ${member.slug}: ${err.message}\n`); return null; }
  return (deps.userBySlackId || userBySlackId)(u.id) || member;
}

// ─── message text ────────────────────────────────────────────────────────────

/** Slack's message markup → plain text: our own mention gone, links as "label (url)", user mentions by name when known. */
export function plainText(text, { selfId = null, nameOf = () => null } = {}) {
  return String(text || '')
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => (id === selfId ? '' : `@${nameOf(id) || id}`))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(channel|here|everyone)>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').trim();
}

// ─── the event handler ───────────────────────────────────────────────────────

function dedupe(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

/**
 * Build the handler with its dependencies (the real ones by default; tests
 * pass fakes). The handler takes one Events API event and returns what it did,
 * as `{ did, ... }`, for the log and the tests.
 */
export function createHandler(deps = {}) {
  const d = {
    api, self: () => st.self, resolveMember: (id) => resolveMember(id, { ...deps, self: deps.self ? deps.self() : st.self }),
    memberDm: startMemberDm, saveAttachments, onChannel: null, onChannelEvent: null, onRevoked: () => disconnectIntegration('revoked'),
    log: (s) => process.stderr.write(`[slack] ${s}\n`), ...deps,
  };

  async function attachmentsBlock(ev, member) {
    const files = Array.isArray(ev.files) ? ev.files.filter(f => f && f.url_private) : [];
    if (!files.length) return '';
    const got = [];
    for (const f of files.slice(0, 10)) {
      try {
        const buffer = await d.api.downloadFile(f.url_private);
        got.push({ originalname: f.name || f.title || 'file', buffer, size: buffer.length });
      } catch (err) { d.log(`file ${f.id || ''} from ${member.slug} not fetched: ${err.message}`); }
    }
    if (!got.length) return '';
    let saved;
    try { saved = d.saveAttachments(`slack-${member.slug}`, got); } catch (err) { d.log(`attachments not saved: ${err.message}`); return ''; }
    return `\n\n[Attachments — read these files to answer]\n${saved.map(a => `- ${a.path}`).join('\n')}`;
  }

  async function dm(ev) {
    const self = d.self();
    const member = await d.resolveMember(ev.user);
    if (!member) {
      if (told.has(ev.user)) return { did: 'ignored', why: 'stranger (told)' };
      told.add(ev.user);
      try { await d.api.postMessage({ channel: ev.channel, text: STRANGER_LINE }); } catch (err) { d.log(`stranger line not sent: ${err.message}`); }
      return { did: 'stranger-told', user: ev.user };
    }
    const text = plainText(ev.text, { selfId: self?.user_id });
    const body = `${text}${await attachmentsBlock(ev, member)}`.trim();
    if (!body) return { did: 'ignored', why: 'empty' };
    recentDms.set(ev.channel, Date.now());
    saveState(true);
    const thread = ev.thread_ts && ev.thread_ts !== ev.ts ? ev.thread_ts : null;
    // In the assistant pane every conversation is a thread: a status line
    // there says the assistant is on it, and the thread gets the person's
    // first words as its title. Elsewhere a reaction does the same job.
    const pane = !!ev.thread_ts;
    if (pane) notePane(ev.user, ev.channel, ev.thread_ts);
    if (pane) {
      if (d.api.setAssistantStatus) d.api.setAssistantStatus(ev.channel, ev.thread_ts, 'is thinking…').catch?.(() => {});
      if (d.api.setAssistantTitle && !titled.has(`${ev.channel}:${ev.thread_ts}`)) { titled.add(`${ev.channel}:${ev.thread_ts}`); d.api.setAssistantTitle(ev.channel, ev.thread_ts, text.slice(0, 60)).catch?.(() => {}); }
    } else {
      d.api.addReaction(ev.channel, ev.ts, 'eyes').catch(() => {});
    }
    const send = (channel, reply) => d.api.postMessage({ channel, text: reply, ...(thread ? { thread_ts: thread } : {}) }).then(ts => ({ ok: ts.length > 0 }));
    // A file the reply hands over goes into the same conversation (and thread).
    const sendFile = (channel, f) => d.api.uploadFile({ channel, filename: f.name, bytes: readFileSync(f.abs), ...(thread ? { thread_ts: thread } : {}) }).then(() => ({ ok: true }));
    const done = d.memberDm(member, body, { surface: 'slack', target: ev.channel, send, sendFile });
    done.then((r) => {
      if (pane) { if (d.api.setAssistantStatus) d.api.setAssistantStatus(ev.channel, ev.thread_ts, '').catch?.(() => {}); return; }
      d.api.removeReaction(ev.channel, ev.ts, 'eyes').catch(() => {});
      if (r && r.reason === 'error') d.api.addReaction(ev.channel, ev.ts, 'warning').catch(() => {});
      else d.api.addReaction(ev.channel, ev.ts, 'white_check_mark').catch(() => {});
    }).catch(() => {});
    return { did: 'member-dm', slug: member.slug, body, done };
  }

  return async function handle(ev) {
    if (!ev || typeof ev !== 'object') return { did: 'ignored', why: 'no event' };
    st.lastEventAt = new Date().toISOString();
    saveState();
    const self = d.self();
    switch (ev.type) {
      case 'tokens_revoked':
      case 'app_uninstalled':
        await d.onRevoked(ev.type);
        return { did: 'revoked' };
      case 'member_joined_channel': case 'member_left_channel': case 'channel_left': case 'channel_shared':
      case 'channel_unshared': case 'channel_archive': case 'channel_deleted': case 'group_left': case 'group_archive':
        if (d.onChannelEvent) return d.onChannelEvent(ev);
        return { did: 'ignored', why: 'no channel handler' };
      case 'assistant_thread_started': {
        // The person opened the assistant pane: that thread is where a message
        // for them shows in Chat, before they have written a word.
        const t = ev.assistant_thread || {};
        notePane(t.user_id, t.channel_id, t.thread_ts);
        return { did: 'pane-opened', user: t.user_id || null };
      }
      case 'message': case 'app_mention': break;
      default: return { did: 'ignored', why: `type ${ev.type}` };
    }
    if (ev.bot_id || ev.subtype === 'bot_message') return { did: 'ignored', why: 'a bot' };
    if (self?.user_id && ev.user === self.user_id) return { did: 'ignored', why: 'own message' };
    if (ev.subtype && SKIP_SUBTYPES.has(ev.subtype)) return { did: 'ignored', why: `subtype ${ev.subtype}` };
    if (ev.subtype === 'message_changed' || ev.subtype === 'message_deleted') {
      if (d.onChannelEvent && ev.channel_type !== 'im') return d.onChannelEvent(ev);
      return { did: 'ignored', why: ev.subtype };
    }
    if (self?.team_id && (ev.user_team || ev.team) && (ev.user_team || ev.team) !== self.team_id && ev.channel_type === 'im') {
      return { did: 'ignored', why: 'another workspace' };
    }
    const key = `${ev.channel}:${ev.ts}`;
    if (!ev.channel || !ev.ts || !dedupe(key)) return { did: 'ignored', why: 'seen' };
    if (ev.channel_type === 'im') return dm(ev);
    if (d.onChannel) return d.onChannel(ev);
    return { did: 'ignored', why: 'channel (no handler)' };
  };
}

// What a restart must not lose: when the socket last heard anything, and the DMs
// that were live. A lost window used to be noticed only by the running process;
// a deploy is a new process, so nothing was caught up — not even a DM.
const CATCH_UP_AFTER_RESTART_MS = 30 * 60_000;
let bootCaughtUp = false;
/** The approved, unpaused Slack channels: where a missed mention is looked for. */
function roomsToCatchUp() {
  try { return listGroups().filter(g => g.kind === 'slack' && !g.paused).map(g => String(g.chatId).replace(/^slack-/, '')); }
  catch { return []; }
}
function statePath() { return join(projectDir(), '.team', 'slack-listener-state.json'); }
let stateSavedAt = 0;
function saveState(force = false) {
  const now = Date.now();
  if (!force && now - stateSavedAt < 15_000) return;
  stateSavedAt = now;
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(statePath(), JSON.stringify({ lastEventAt: st.lastEventAt, dms: Object.fromEntries(recentDms) }), { mode: 0o660 });
  } catch { /* best effort */ }
}
/** Where the last process left off: its last event, and its live DMs back into the map. */
export function restoreState(now = Date.now()) {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    for (const [ch, at] of Object.entries(s?.dms || {})) if (Number.isFinite(at) && now - at < CATCH_UP_WINDOW_MS && !recentDms.has(ch)) recentDms.set(ch, at);
    const last = Date.parse(s?.lastEventAt || '') || 0;
    return last && now - last < CATCH_UP_AFTER_RESTART_MS ? new Date(last).toISOString() : null;
  } catch { return null; }
}

/**
 * After a lost window — a dropped socket, or a restart (the last process's
 * state on disk) — the DMs that were live shortly before it are read back from
 * Slack and handled as if they had arrived, and so are the messages in approved
 * channels that mention the bot (a question asked during a deploy went
 * unanswered). Bounded: a few conversations, a few messages each; the dedup
 * (and the room's durable history, for what was already answered) keeps
 * anything already handled out. Best-effort; a history read that fails (the
 * rate limit, a closed DM) is logged and skipped.
 */
export async function catchUp(sinceIso, deps = {}) {
  const a = deps.api || api;
  const h = deps.handle || handler || (handler = createHandler());
  const since = Date.parse(sinceIso || '') || 0;
  if (!since) return { channels: 0, messages: 0 };
  const now = deps.now ? deps.now() : Date.now();
  const live = [...recentDms.entries()].filter(([, at]) => now - at < CATCH_UP_WINDOW_MS).slice(-CATCH_UP_CHANNELS);
  let messages = 0;
  for (const [channel] of live) {
    let rows = [];
    try { rows = await a.conversationsHistory(channel, { oldest: String(Math.floor(since / 1000) - 60), limit: 15 }); }
    catch (err) { process.stderr.write(`[slack] catch-up ${channel}: ${err.message}\n`); continue; }
    for (const m of rows) {
      if (!m || !m.user || m.bot_id || m.subtype) continue;
      try { const r = await h({ ...m, type: 'message', channel, channel_type: 'im' }); if (r?.did === 'member-dm') messages += 1; }
      catch (err) { process.stderr.write(`[slack] catch-up message ${channel}/${m.ts}: ${err.message}\n`); }
    }
  }
  // Approved channels: only messages that mention the bot (top-level history;
  // a thread reply is a message the person can repeat).
  const self = st.self?.user_id || (deps.selfId ? deps.selfId() : null);
  const rooms = (deps.rooms ? deps.rooms() : roomsToCatchUp()).slice(0, CATCH_UP_CHANNELS);
  let mentions = 0;
  if (self) {
    const mention = new RegExp(`<@${self}(?:\\|[^>]*)?>`);
    for (const channel of rooms) {
      let rows = [];
      try { rows = await a.conversationsHistory(channel, { oldest: String(Math.floor(since / 1000) - 60), limit: 15 }); }
      catch (err) { process.stderr.write(`[slack] catch-up ${channel}: ${err.message}\n`); continue; }
      for (const m of [...rows].reverse()) {
        if (!m || !m.user || m.user === self || m.bot_id || m.subtype || !mention.test(String(m.text || ''))) continue;
        try { const r = await h({ ...m, type: 'message', channel, channel_type: 'channel' }); if (r?.did === 'routed') mentions += 1; }
        catch (err) { process.stderr.write(`[slack] catch-up message ${channel}/${m.ts}: ${err.message}\n`); }
      }
    }
  }
  if (messages || mentions) process.stderr.write(`[slack] caught up ${messages} DM message(s) and ${mentions} channel mention(s) after the lost window from ${sinceIso}\n`);
  return { channels: live.length, messages, rooms: rooms.length, mentions };
}

let handler = null;
/** The group side plugs in here (phase 2); until then channels are silent. */
export function setChannelHandlers({ onChannel = null, onChannelEvent = null } = {}) {
  handler = createHandler({ onChannel, onChannelEvent });
}

// ─── the socket ──────────────────────────────────────────────────────────────

async function disconnectIntegration(why) {
  process.stderr.write(`[slack] ${why}: removing the connection\n`);
  try { store.remove(ID); } catch (err) { process.stderr.write(`[slack] store remove failed: ${err.message}\n`); }
  try { writeAllowedHostsFile(); } catch { /* best effort */ }
  stop(why);
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url, api.socketOptions()); } catch (err) { return reject(err); }
    const onErr = (e) => reject(e?.error || e?.message ? new Error(e.message || String(e.error)) : new Error('socket error'));
    ws.addEventListener('error', onErr, { once: true });
    ws.addEventListener('open', () => { ws.removeEventListener('error', onErr); resolve(ws); }, { once: true });
  });
}

async function connectOnce(generation) {
  if (!st.self) st.self = await api.authTest();
  const url = await api.connectionsOpen();
  const ws = await openSocket(url);
  st.ws = ws;
  return new Promise((resolve) => {
    let closed = false;
    const finish = (why) => {
      if (closed) return;
      closed = true;
      if (st.connected) { st.lastDisconnectAt = new Date().toISOString(); st.lost.push({ from: st.lastDisconnectAt, why }); }
      st.connected = false;
      st.ws = null;
      resolve(why);
    };
    st.closeNow = (why) => { try { ws.close(1000, why); } catch { /* already */ } finish(why); };
    ws.addEventListener('message', (m) => {
      if (generation !== st.generation) return;
      let env;
      try { env = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      if (env.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch { /* closing */ } }
      if (env.type === 'hello') {
        st.connected = true; st.since = new Date().toISOString(); st.error = null;
        const last = st.lost[st.lost.length - 1];
        if (last && !last.to) { last.to = st.since; catchUp(last.from).catch(() => {}); }
        else if (!bootCaughtUp) {
          // The first connection of this process: read back what arrived while
          // the last one was going down and this one was coming up.
          bootCaughtUp = true;
          const since = restoreState();
          if (since) catchUp(since).catch(() => {});
        }
        return;
      }
      if (env.type === 'disconnect') { try { ws.close(1000, env.reason || 'disconnect'); } catch { /* */ } return finish(env.reason || 'disconnect'); }
      if (env.type === 'events_api' && env.payload?.event) {
        (handler || (handler = createHandler()))(env.payload.event).catch((err) => process.stderr.write(`[slack] event failed: ${err.message}\n`));
      }
    });
    ws.addEventListener('close', (e) => finish(e?.reason || 'closed'));
    ws.addEventListener('error', (e) => { st.error = String(e?.message || 'socket error'); finish('error'); });
  });
}

async function runLoop(generation) {
  let backoff = RECONNECT_MIN_MS;
  while (st.running && generation === st.generation) {
    try {
      const why = await connectOnce(generation);
      backoff = why === 'refresh_requested' || why === 'disconnect' ? RECONNECT_MIN_MS : Math.min(backoff * 2, RECONNECT_MAX_MS);
    } catch (err) {
      st.error = String(err?.message || err);
      process.stderr.write(`[slack] connect failed: ${st.error}\n`);
      if (/invalid_auth|not_authed|account_inactive|token_revoked|no_token|no_app_token/.test(st.error)) { st.running = false; break; }
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
    if (!st.running || generation !== st.generation) break;
    await new Promise(r => setTimeout(r, backoff));
  }
}

export function start() {
  if (st.running) return false;
  st.running = true; st.self = null; st.error = null;
  const generation = ++st.generation;
  runLoop(generation).catch((err) => { st.error = String(err?.message || err); st.running = false; });
  return true;
}

export function stop(why = 'stopped') {
  st.running = false;
  st.generation++;
  if (st.closeNow) { st.closeNow(why); st.closeNow = null; }
}

/** Match the socket to the store: up when Slack is connected and not paused, down otherwise. */
export function reconcile() {
  let usable = false;
  try { usable = store.isUsable(ID); } catch { usable = false; }
  if (usable && !st.running) start();
  else if (!usable && st.running) stop('disconnected');
  return st.running;
}

/** For a post from elsewhere (a reminder, a relay): the DM channel of a roster member. */
export async function dmChannelOf(member) {
  if (!member?.slackUserId) return null;
  return api.openDm(member.slackUserId);
}
