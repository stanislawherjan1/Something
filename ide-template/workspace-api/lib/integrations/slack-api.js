/**
 * Slack Web API, the little of it the surface needs — no SDK.
 *
 * Every call is one POST to https://slack.com/api/<method> with the bot token
 * (or the app-level token for the Socket Mode handshake) as a Bearer header.
 * The token is decrypted from the store per call, like a Telegram send — it is
 * never kept on the object, in env or on disk. Outbound traffic goes through
 * the egress proxy by name (an explicit CONNECT, so `*.slack.com` matches the
 * suffix rule the catalog opens) and falls back to the transparent path.
 *
 * Posting: one message is a `markdown` block (standard Markdown, 12k chars)
 * with the same text as the plain fallback; a workspace that refuses the block
 * gets the text. Slack takes ~1 message/s per channel, so sends are queued per
 * channel and a 429 waits out `Retry-After` once.
 */
import { ProxyAgent } from 'undici';
import * as store from './store.js';

const API = 'https://slack.com/api/';
export const MARKDOWN_MAX = 12000;   // the markdown block's limit per payload
const POST_GAP_MS = 1100;             // ~1 msg/s per channel

const PROXY_URL = process.env.SLACK_PROXY_URL ?? process.env.MCP_OAUTH_PROXY_URL ?? 'http://egress-proxy:3130';
let dispatcher = null;
function proxyDispatcher() {
  if (!PROXY_URL) return undefined;
  if (!dispatcher) { try { dispatcher = new ProxyAgent(PROXY_URL); } catch { return undefined; } }
  return dispatcher;
}

let fetchImpl = (url, init) => fetch(url, init);
/** Tests swap the transport. */
export function configure({ fetch: f } = {}) { if (f) fetchImpl = f; }

export class SlackError extends Error {
  constructor(method, code, extra = {}) {
    super(`slack ${method}: ${code}`);
    this.code = code;
    this.method = method;
    Object.assign(this, extra);
  }
}

/** { bot, app } from the encrypted store; throws when Slack is not connected. */
export function tokens() {
  const plain = store.decryptFor('slack');
  return { bot: String(plain?.SLACK_BOT_TOKEN || ''), app: String(plain?.SLACK_APP_TOKEN || '') };
}

async function post(url, init, { allowFallback = true } = {}) {
  const d = proxyDispatcher();
  try {
    return await fetchImpl(url, d ? { ...init, dispatcher: d } : init);
  } catch (err) {
    // The explicit proxy is not reachable (dev, a test rig): the transparent
    // path is the same gate, just by IP.
    if (!d || !allowFallback) throw err;
    return fetchImpl(url, init);
  }
}

/**
 * One Web API call. `params` is sent as JSON. Returns the parsed body; throws
 * SlackError(`error` field) when Slack says `ok: false`. A 429 is retried once
 * after `Retry-After` seconds (capped), anything else is the caller's.
 */
export async function call(method, params = {}, { token = null, retried = false } = {}) {
  const tok = token ?? tokens().bot;
  if (!tok) throw new SlackError(method, 'no_token');
  const resp = await post(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(params),
  });
  if (resp.status === 429 && !retried) {
    const wait = Math.min(Number(resp.headers?.get?.('retry-after')) || 1, 30);
    await new Promise(r => setTimeout(r, wait * 1000));
    return call(method, params, { token: tok, retried: true });
  }
  let data;
  try { data = await resp.json(); } catch { throw new SlackError(method, `http_${resp.status}`); }
  if (!data || data.ok !== true) throw new SlackError(method, data?.error || `http_${resp.status}`, { needed: data?.needed, warning: data?.warning });
  return data;
}

// ─── identity ────────────────────────────────────────────────────────────────

/** Who the bot is: { user_id, bot_id, team_id, team, url }. */
export function authTest(token) { return call('auth.test', {}, { token }); }

/** One user: { id, team_id, deleted, is_bot, is_restricted, is_ultra_restricted, profile: { email, real_name } }. */
export async function usersInfo(user) {
  const r = await call('users.info', { user });
  return r.user;
}

// ─── conversations ───────────────────────────────────────────────────────────

export async function conversationsInfo(channel) {
  const r = await call('conversations.info', { channel });
  return r.channel;
}

/** Every member id of a conversation (paged). */
export async function conversationsMembers(channel) {
  const out = [];
  let cursor = '';
  do {
    const r = await call('conversations.members', { channel, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(r.members || []));
    cursor = r.response_metadata?.next_cursor || '';
  } while (cursor);
  return out;
}

export function conversationsLeave(channel) { return call('conversations.leave', { channel }); }

/** The DM channel with one user (opens it when needed). */
export async function openDm(user) {
  const r = await call('conversations.open', { users: user });
  return r.channel?.id || null;
}

// ─── posting ─────────────────────────────────────────────────────────────────

/**
 * Cut a long text into pieces the markdown block takes, at paragraph, then
 * line, then word boundaries. Exported for the tests.
 */
export function splitText(text, max = MARKDOWN_MAX) {
  const s = String(text || '');
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ['\n\n', '\n', ' ']) {
      const i = rest.lastIndexOf(sep, max);
      if (i > max * 0.4) { cut = i; break; }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

// One send at a time per channel, a second apart: Slack's per-channel limit.
const lanes = new Map();   // channel → Promise
function inLane(channel, fn) {
  const prev = lanes.get(channel) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const r = await fn();
    await new Promise(res => setTimeout(res, POST_GAP_MS));
    return r;
  });
  lanes.set(channel, next.finally(() => { if (lanes.get(channel) === next) lanes.delete(channel); }));
  return next;
}

/** The message body for one piece of text: markdown block + plain fallback. */
export function messageBody(text) {
  return { text, blocks: [{ type: 'markdown', text }] };
}

/**
 * Post one or more messages (a long text becomes several, in order) into a
 * channel, optionally in a thread. Returns the ts of each message posted.
 */
export async function postMessage({ channel, text, thread_ts = null }) {
  const pieces = splitText(text);
  const posted = [];
  for (const piece of pieces) {
    const ts = await inLane(channel, async () => {
      const base = { channel, ...(thread_ts ? { thread_ts } : {}) };
      let r;
      try { r = await call('chat.postMessage', { ...base, ...messageBody(piece) }); }
      catch (err) {
        if (err.code !== 'invalid_blocks' && err.code !== 'invalid_blocks_format') throw err;
        r = await call('chat.postMessage', { ...base, text: piece });   // a workspace without the markdown block
      }
      return r.ts;
    });
    posted.push(ts);
  }
  return posted;
}

export function addReaction(channel, timestamp, name) {
  return call('reactions.add', { channel, timestamp, name }).catch((err) => {
    if (err.code === 'already_reacted') return null;
    throw err;
  });
}
export function removeReaction(channel, timestamp, name) {
  return call('reactions.remove', { channel, timestamp, name }).catch((err) => {
    if (err.code === 'no_reaction') return null;
    throw err;
  });
}

// ─── files ───────────────────────────────────────────────────────────────────

/**
 * Upload one file (the three-step external upload). `bytes` is a Buffer.
 * Returns the file id.
 */
export async function uploadFile({ channel, filename, bytes, title = null, thread_ts = null, initial_comment = null }) {
  const slot = await call('files.getUploadURLExternal', { filename, length: bytes.length });
  const put = await post(slot.upload_url, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!put.ok) throw new SlackError('files.upload', `http_${put.status}`);
  const done = await call('files.completeUploadExternal', {
    files: [{ id: slot.file_id, ...(title ? { title } : {}) }],
    ...(channel ? { channel_id: channel } : {}),
    ...(thread_ts ? { thread_ts } : {}),
    ...(initial_comment ? { initial_comment } : {}),
  });
  return done.files?.[0]?.id || slot.file_id;
}

/** Fetch a file the person sent (its `url_private`), bounded. Returns a Buffer. */
export async function downloadFile(urlPrivate, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const u = new URL(urlPrivate);
  if (u.protocol !== 'https:' || !/(^|\.)slack\.com$|(^|\.)slack-files\.com$/.test(u.hostname)) throw new SlackError('files.download', 'not_a_slack_url');
  const resp = await post(u.href, { headers: { Authorization: `Bearer ${tokens().bot}` } });
  if (!resp.ok) throw new SlackError('files.download', `http_${resp.status}`);
  const len = Number(resp.headers?.get?.('content-length') || 0);
  if (len > maxBytes) throw new SlackError('files.download', 'too_large');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new SlackError('files.download', 'too_large');
  return buf;
}

// ─── Socket Mode handshake ───────────────────────────────────────────────────

/** The WebSocket URL for one Socket Mode connection (app-level token). */
export async function connectionsOpen() {
  const { app } = tokens();
  if (!app) throw new SlackError('apps.connections.open', 'no_app_token');
  const r = await call('apps.connections.open', {}, { token: app });
  return r.url;
}

/** For the listener: a WebSocket through the proxy, else direct. */
export function socketOptions() {
  const d = proxyDispatcher();
  return d ? { dispatcher: d } : {};
}
