/**
 * Slack channels, as the group watcher's rooms — and the rules that keep the
 * assistant out of rooms it must not be in.
 *
 *   invited to a channel      → a request an ADMIN approves (never automatic:
 *                               anyone in a workspace can add an app to a
 *                               channel); not approved in 24 h → the bot leaves
 *   approved                  → registered in the group registry (team.js
 *                               `groups`, id `slack-C…`), answering when
 *                               addressed by default
 *   someone joins / a channel → the AUDIENCE CHECK: every member must be a
 *   is shared                   roster person of this workspace, else the
 *                               channel is PAUSED (silent) until it is ours
 *                               again; a Slack Connect channel is never
 *                               approved at all
 *   a channel message         → the group watcher, as a Telegram group's
 *                               message would be, with the thread it sits in
 *
 * Why so strict: a channel turn speaks from the team's shared memory. A room
 * with a guest or a partner in it would show them what the team knows.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from './slack-api.js';
import { resolveMember, plainText, status as listenerStatus } from './slack-listener.js';
import { addGroup, removeGroup, getGroup, touchGroupMeta, userBySlackId, list as teamList, listGroups, recordGroupMember } from '../team.js';
import { publish as publishNotification } from '../notify.js';
import { routeGroupMessage } from './group-watcher.js';

const PENDING_TTL_MS = 24 * 3600_000;
const SWEEP_MS = 10 * 60_000;

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function pendingPath() { return join(projectDir(), '.team', 'slack-pending-channels.json'); }
export const groupIdOf = (channel) => `slack-${String(channel || '').trim()}`;

// ─── dependencies (tests swap them) ──────────────────────────────────────────
let d = {
  api, resolveMember, self: () => listenerStatus(), addGroup, removeGroup, getGroup, touchGroupMeta, userBySlackId, teamList, listGroups, recordGroupMember,
  notify: publishNotification, route: routeGroupMessage, now: () => Date.now(), log: (s) => process.stderr.write(`[slack-channels] ${s}\n`),
};
export function __setDeps(over) { d = { ...d, ...over }; }

// ─── pending requests ────────────────────────────────────────────────────────

export function pendingChannels() {
  try { return JSON.parse(readFileSync(pendingPath(), 'utf8')); } catch { return []; }
}
function writePending(list) {
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(pendingPath(), JSON.stringify(list), { mode: 0o660 });
  } catch (err) { d.log(`pending list not written: ${err.message}`); }
}
function dropPending(chatId) { writePending(pendingChannels().filter(p => p.chatId !== chatId)); }

function admins() { try { return d.teamList().filter(m => m.role === 'admin' && m.slug).map(m => m.slug); } catch { return []; } }
function tellAdmins(title, body, meta = {}) {
  for (const slug of admins()) {
    try { d.notify({ kind: 'team', recipient: slug, title, body, meta: { surface: 'slack', ...meta } }); } catch { /* best effort */ }
  }
}

async function channelInfo(channel) {
  try { return await d.api.conversationsInfo(channel); } catch (err) { d.log(`conversations.info ${channel}: ${err.message}`); return null; }
}
const isShared = (info) => !!(info && (info.is_ext_shared || info.is_shared || info.is_org_shared));
const titleOf = (info, channel) => (info?.name ? `#${info.name}` : channel);

/** The bot was added to a channel: a request for an admin — or an immediate exit from a shared channel. */
export async function requestChannel(channel, { inviter = null } = {}) {
  const chatId = groupIdOf(channel);
  if (d.getGroup(chatId)) return { did: 'already-registered' };
  const info = await channelInfo(channel);
  if (isShared(info)) {
    await leave(channel, 'a shared (Slack Connect) channel');
    tellAdmins('Slack: left a shared channel', `${titleOf(info, channel)} is shared with another organisation, so the assistant left it. Shared channels cannot be approved.`);
    return { did: 'left-shared' };
  }
  const by = inviter ? (d.userBySlackId(inviter) || await d.resolveMember(inviter) || null) : null;
  // Added by one of this workspace's admins: that is the admin's yes. The
  // request-and-approve round trip is for anyone else — a member or a
  // stranger can add an app to any channel in Slack.
  if (by && by.role === 'admin') {
    const group = await approveChannel(chatId, { actor: by.email || by.slug, title: titleOf(info, channel) });
    tellAdmins('Slack: joined a channel', `${by.displayName || by.slug} added the assistant to ${group.title || titleOf(info, channel)}; as an admin, that registered it — it joins in there from now on. Change its settings on the Slack page.`, { chatId });
    return { did: 'approved-by-admin', group };
  }
  const entry = {
    chatId, channel, title: titleOf(info, channel), inviter: inviter || null, inviterSlug: by?.slug || null,
    members: Number(info?.num_members) || null, private: !!info?.is_private, at: new Date(d.now()).toISOString(),
  };
  writePending([...pendingChannels().filter(p => p.chatId !== chatId), entry]);
  tellAdmins('Slack: a channel waits for your approval',
    `${by ? (by.displayName || by.slug) : 'Someone'} added the assistant to ${entry.title}. It stays silent there until an admin approves the channel on the Slack page; if nobody does within a day it leaves.`,
    { chatId });
  return { did: 'pending', entry };
}

async function leave(channel, why) {
  try { await d.api.conversationsLeave(channel); d.log(`left ${channel}: ${why}`); return true; }
  catch (err) { d.log(`could not leave ${channel}: ${err.message}`); return false; }
}

/** An admin said yes: register the channel and check who is in it. */
export async function approveChannel(chatId, { actor = null, title = null, requireMention = null, language = null, beat = null, openAudience = null } = {}) {
  const channel = chatId.replace(/^slack-/, '');
  const info = await channelInfo(channel);
  if (isShared(info)) {
    dropPending(chatId);
    await leave(channel, 'shared channel at approval time');
    throw new Error('That channel is shared with another organisation and cannot be approved.');
  }
  const group = d.addGroup({ chatId, title: title ?? titleOf(info, channel), requireMention, language, beat, openAudience, actor });
  dropPending(chatId);
  await checkAudience(chatId, { quiet: true });
  return d.getGroup(chatId) || group;
}

/** An admin said no (or the request aged out): leave and forget. */
export async function rejectChannel(chatId, why = 'declined') {
  const channel = chatId.replace(/^slack-/, '');
  dropPending(chatId);
  if (d.getGroup(chatId)) d.removeGroup(chatId, 'slack');
  await leave(channel, why);
  return { ok: true };
}

/**
 * Is everyone in the room ours? Every member but the bot must resolve to a
 * roster person of this workspace. Otherwise the channel is paused and the
 * admins hear who is in the way; when the room is ours again it resumes.
 */
export async function checkAudience(chatId, { quiet = false } = {}) {
  const group = d.getGroup(chatId);
  if (!group || group.kind !== 'slack') return null;
  const channel = chatId.replace(/^slack-/, '');
  const self = d.self()?.botUserId || null;
  const info = await channelInfo(channel);
  let members = [];
  try { members = await d.api.conversationsMembers(channel); } catch (err) { d.log(`conversations.members ${channel}: ${err.message}`); return null; }
  const outsiders = [];
  // Everyone in the room, named: a teammate as the roster names them (and
  // recorded as in the room, whether or not they have written), anyone else
  // by the name Slack shows — the room's pile says who, not an id.
  for (const id of members) {
    if (id === self) continue;
    const m = d.userBySlackId(id) || await d.resolveMember(id);
    if (m) { try { d.recordGroupMember(chatId, id, m.displayName || m.slug); } catch { /* best effort */ } continue; }
    let name = null;
    try { const u = await d.api.usersInfo(id); name = u?.real_name || u?.profile?.real_name || u?.name || null; } catch { /* the id then */ }
    outsiders.push({ id, name: name || id });
  }
  const shared = isShared(info);
  const audience = { ok: !shared && outsiders.length === 0, outsiders: outsiders.slice(0, 20), shared, members: members.length, checkedAt: new Date(d.now()).toISOString() };
  // An open-audience room is never paused for outsiders (it reads only its own
  // memory); a shared channel is paused whatever the room's setting.
  const paused = shared || (!audience.ok && !group.openAudience);
  const wasPaused = !!group.paused;
  d.touchGroupMeta(chatId, { audience, paused, ...(info?.name ? { title: `#${info.name}` } : {}) });
  if (paused && !wasPaused && !quiet) {
    tellAdmins('Slack: a channel is paused', `${group.title || chatId} has ${shared ? 'become a shared channel' : `${outsiders.length} ${outsiders.length === 1 ? 'person' : 'people'} not on the team`}. The assistant stays silent there until the room is the team's again.`, { chatId });
  }
  if (!paused && wasPaused && !quiet) {
    tellAdmins('Slack: a channel resumed', `${group.title || chatId} is the team's again; the assistant answers there once more.`, { chatId });
  }
  return audience;
}

/** Requests nobody answered within a day: the bot leaves. Called by the sweep. */
export async function sweepPending() {
  const now = d.now();
  let left = 0;
  for (const p of pendingChannels()) {
    if (now - Date.parse(p.at) < PENDING_TTL_MS) continue;
    await rejectChannel(p.chatId, 'not approved within a day');
    left += 1;
  }
  return left;
}

/**
 * Who is in each room, once an hour — besides every join, leave or share
 * event, which check at once. A membership change the socket missed (a lost
 * window) is caught here, so a room never stays open to an outsider for long
 * and never stays paused after they left. Nothing for a person to press.
 */
const AUDIENCE_SWEEP_MS = 60 * 60_000;
let lastAudienceSweep = 0;
export async function sweepAudience({ force = false } = {}) {
  const now = d.now();
  if (!force && now - lastAudienceSweep < AUDIENCE_SWEEP_MS) return 0;
  lastAudienceSweep = now;
  let n = 0;
  for (const g of (d.listGroups ? d.listGroups() : [])) {
    if (g.kind !== 'slack') continue;
    try { await checkAudience(g.chatId); n += 1; } catch (err) { d.log(`audience sweep ${g.chatId}: ${err.message}`); }
  }
  return n;
}
let sweeper = null;
export function startSweep() {
  if (sweeper) return;
  sweeper = setInterval(() => { sweepPending().catch(() => {}); sweepAudience().catch(() => {}); }, SWEEP_MS);
  sweeper.unref?.();
}
export function stopSweep() { if (sweeper) clearInterval(sweeper); sweeper = null; }

// ─── events from the listener ────────────────────────────────────────────────

const nameCache = new Map();   // Slack user id → display name (for strangers in a channel)
async function nameOf(userId) {
  const m = d.userBySlackId(userId);
  if (m) return m.displayName || m.slug;
  if (nameCache.has(userId)) return nameCache.get(userId);
  let name = userId;
  try { const u = await d.api.usersInfo(userId); name = u?.real_name || u?.profile?.real_name || u?.name || userId; } catch { /* keep the id */ }
  nameCache.set(userId, name);
  return name;
}

export async function onChannelEvent(ev) {
  const self = d.self()?.botUserId || null;
  const channel = ev.channel || ev.channel_id || null;
  if (!channel) return { did: 'ignored', why: 'no channel' };
  const chatId = groupIdOf(channel);
  switch (ev.type) {
    case 'member_joined_channel':
      if (ev.user === self) return requestChannel(channel, { inviter: ev.inviter || null });
      if (d.getGroup(chatId)) { const a = await checkAudience(chatId); return { did: 'audience', audience: a }; }
      return { did: 'ignored', why: 'not registered' };
    case 'member_left_channel':
      if (ev.user === self) { dropPending(chatId); if (d.getGroup(chatId)) d.removeGroup(chatId, 'slack'); return { did: 'removed' }; }
      if (d.getGroup(chatId)) { const a = await checkAudience(chatId); return { did: 'audience', audience: a }; }
      return { did: 'ignored', why: 'not registered' };
    case 'channel_left': case 'group_left':
      dropPending(chatId);
      if (d.getGroup(chatId)) d.removeGroup(chatId, 'slack');
      return { did: 'removed' };
    case 'channel_shared':
      if (d.getGroup(chatId)) { const a = await checkAudience(chatId); return { did: 'audience', audience: a }; }
      dropPending(chatId);
      await leave(channel, 'became a shared channel');
      return { did: 'left-shared' };
    case 'channel_unshared':
      if (d.getGroup(chatId)) { const a = await checkAudience(chatId); return { did: 'audience', audience: a }; }
      return { did: 'ignored', why: 'not registered' };
    case 'channel_archive': case 'channel_deleted': case 'group_archive':
      dropPending(chatId);
      if (d.getGroup(chatId)) d.removeGroup(chatId, 'slack');
      return { did: 'removed' };
    case 'message':
      // An edit or a deletion in a channel: the ring keeps what was said at
      // the time; a correction arrives as a new message (v1).
      return { did: 'ignored', why: ev.subtype || 'message' };
    default:
      return { did: 'ignored', why: `type ${ev.type}` };
  }
}

const IMAGE_RE = /^image\//;

/** A message in a channel → the group watcher, in the shape a Telegram group message takes. */
export async function onChannelMessage(ev) {
  const self = d.self()?.botUserId || null;
  const chatId = groupIdOf(ev.channel);
  const group = d.getGroup(chatId);
  if (!group) return { did: 'ignored', why: 'not registered' };
  if (group.paused) return { did: 'ignored', why: 'paused' };
  if (ev.user_team && self && d.self()?.team && ev.user_team !== (d.self()?.teamId || ev.user_team)) { /* team ids are checked by the audience rule */ }
  const member = d.userBySlackId(ev.user) || await d.resolveMember(ev.user);
  const fromName = member ? (member.displayName || member.slug) : await nameOf(ev.user);
  const text = plainText(ev.text, { selfId: self, nameOf: (id) => d.userBySlackId(id)?.displayName || null });
  const mentioned = ev.type === 'app_mention' || (!!self && new RegExp(`<@${self}(?:\\|[^>]*)?>`).test(String(ev.text || '')));
  const files = Array.isArray(ev.files) ? ev.files.filter(f => f && f.url_private) : [];
  const image = files.find(f => IMAGE_RE.test(String(f.mimetype || '')));
  const doc = files.find(f => !IMAGE_RE.test(String(f.mimetype || '')));
  const payload = {
    chat_id: chatId,
    chat_title: group.title || null,
    message_id: String(ev.ts),
    thread_id: ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : null,
    text,
    from_id: String(ev.user || ''),
    from_name: fromName,
    from_username: '',
    is_mention: mentioned,
    is_reply_to_bot: !!(self && ev.parent_user_id === self),
    ...(image ? { photo_file_id: { file_id: image.url_private, name: image.name || '', mime: image.mimetype || '' } } : {}),
    ...(doc ? { attachment: { kind: 'document', file_id: doc.url_private, name: doc.name || doc.title || '', mime: doc.mimetype || '', size: Number(doc.size) || null } } : {}),
  };
  const r = d.route(payload);
  return { did: 'routed', payload, result: r };
}
