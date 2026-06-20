/**
 * recent-snapshot — write rolling snapshots of recent conversation tails
 * into memory cards (RECENT_WEB.md, RECENT_TELEGRAM.md) so the agent
 * picks up where the user left off after a session restart or chat reset.
 *
 * Why a snapshot and not "read the JSONL on the fly":
 *   - The cached system-prompt prefix (see memory-loader.js) is what makes
 *     prompt-caching work. It loads the cards verbatim. If we read the
 *     transcript inside the agent's first turn instead, the cache misses
 *     and every turn pays full input tokens.
 *   - The snapshot lives in `memory/RECENT_<CHANNEL>.md` — picked up by
 *     buildCachedPrefix() automatically because both files are in
 *     LOAD_ORDER.
 *
 * Update cadence (per channel):
 *   - On idle (≥IDLE_SECONDS since last message in the source JSONL) via
 *     PM2 monitor (bot/recent-snapshot-monitor.sh).
 *   - Immediately on chat reset (web only — Telegram has no reset concept).
 *   - NOT updated mid-conversation: would break the prompt cache.
 *
 * Channels:
 *   - web      → reads PROJECT_DIR/.chat/conversation.jsonl,
 *                writes memory/RECENT_WEB.md
 *   - telegram → reads /home/bot/.telegram/conversation.jsonl
 *                (written by the plugin via bot.sh Patch 4),
 *                writes memory/RECENT_TELEGRAM.md
 */

import { existsSync, readFileSync, statSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { atomicWrite } from './atomic-write.js';
import { getTeamMode, primaryAdminSlug } from './team.js';
import { USERS_DIR } from './scope-rule.js';

const TELEGRAM_LOG_PATH = process.env.TELEGRAM_LOG_PATH || '/home/bot/.telegram/conversation.jsonl';
const MEMORY_DIR = join(PROJECT_DIR, 'memory');

// Web chat history lives in per-session files at
// `<workspace>/.team/users/<actor>/chats/<sessionId>.jsonl` — one chats dir per
// user. A web conversation tail is one person's private chat with the bot, so
// in TEAM mode each user gets their OWN RECENT_WEB at memory/users/<slug>/, and
// the shared memory/RECENT_WEB.md (which the Telegram bot reads for
// cross-surface awareness) holds only the PRIMARY ADMIN's web sessions — the
// bot has no per-user identity, it acts as the admin. The old behaviour merged
// every user's chats into one shared file, which leaked everyone's web
// conversations to whoever read it (esp. the operator's Telegram). Solo mode →
// one user dir → one shared file, unchanged.
const WEB_USERS_ROOT = join(PROJECT_DIR, '.team', 'users');

// Map<slug, string[]> — *.jsonl session transcripts grouped by their owner's
// slug (the .team/users/<slug> dir name). Skips _index.json and archive/.
function listWebSessionsByUser() {
  const out = new Map();
  let users;
  try { users = readdirSync(WEB_USERS_ROOT, { withFileTypes: true }); }
  catch { return out; }
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const chatsDir = join(WEB_USERS_ROOT, u.name, 'chats');
    const files = [];
    try {
      for (const f of readdirSync(chatsDir)) {
        if (f.endsWith('.jsonl')) files.push(join(chatsDir, f));
      }
    } catch { continue; } // this user has no chats dir yet — skip
    if (files.length) out.set(u.name, files);
  }
  return out;
}

// Merge a set of per-session transcripts into one timestamp-ordered tail.
// Interleaving distinct conversations of ONE user is intentional — RECENT_WEB
// is a "what did I talk about on web recently" snapshot. It is NOT injected
// into the web chat prefix (excluded in lib/claude.js), so it can't bleed one
// web chat into another.
function readMessagesFrom(files) {
  const all = [];
  for (const f of files) {
    for (const m of readJsonl(f)) all.push(m);
  }
  all.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return all;
}

// All web messages across every user — only used for solo mode (one user dir).
function readWebMessages() {
  const files = [];
  for (const fs of listWebSessionsByUser().values()) files.push(...fs);
  return readMessagesFrom(files);
}

// Staleness key: newest mtime across EVERY user's session files, so a refresh
// fires when any user is idle-done (the writer then rewrites all per-user
// snapshots). Kept aggregate on purpose — see isSnapshotStale.
function webSourceMtimeMs() {
  let newest = 0;
  for (const fs of listWebSessionsByUser().values()) {
    for (const f of fs) {
      try { newest = Math.max(newest, statSync(f).mtimeMs); } catch { /* skip */ }
    }
  }
  return newest;
}

// Default caps. 50 messages is enough for ~3-5 typical exchanges; 4000
// tokens (approximated at 3.5 chars/token) is the safety bound so a
// monologue-heavy session doesn't blow the cached prefix budget.
const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_CHARS = 4000 * 3.5; // ~14000 chars ≈ 4000 tokens

const CHANNELS = {
  web: {
    readMessages: readWebMessages,
    sourceMtimeMs: webSourceMtimeMs,
    snapshotPath: join(MEMORY_DIR, 'RECENT_WEB.md'),
    headerName: 'RECENT_WEB',
    title: 'Recent web-chat conversation',
    sourceDescription: 'web chat (per-session files under `<workspace>/.team/users/<actor>/chats/`)',
    formatEntry: formatWebEntry,
  },
  telegram: {
    sourcePath: TELEGRAM_LOG_PATH,
    snapshotPath: join(MEMORY_DIR, 'RECENT_TELEGRAM.md'),
    headerName: 'RECENT_TELEGRAM',
    title: 'Recent Telegram conversation',
    sourceDescription: 'Telegram plugin log (`/home/bot/.telegram/conversation.jsonl`, populated by the plugin\'s logging patch)',
    formatEntry: formatTelegramEntry,
  },
};

/**
 * Parse a JSONL file safely. Bad lines are dropped (defensive against
 * truncated writes mid-tail). Returns array of objects in file order
 * (oldest first).
 */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') out.push(obj);
      } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Web JSONL entry shape (from lib/chatHistory.js):
 *   { ts, role: 'user'|'assistant'|'system', text, ?attachments, ?kind }
 */
function formatWebEntry(msg) {
  const ts = msg.ts || '?';
  if (msg.kind === 'reset') return `## ${ts} — — — reset marker — — —`;
  const role = msg.role || 'unknown';
  const text = String(msg.text == null ? '' : msg.text).trim();
  return `## ${ts} — ${role}\n${text}`;
}

/**
 * Telegram JSONL entry shape (from bot.sh Patch 4):
 *   { ts, direction: 'inbound'|'outbound', chat_id, user?, kind?, text, message_id?, method? }
 */
function formatTelegramEntry(msg) {
  const ts = msg.ts || '?';
  const direction = msg.direction === 'outbound' ? 'assistant' : 'user';
  const userLabel = msg.user ? ` (${msg.user})` : '';
  const chatLabel = msg.chat_id ? ` [chat ${msg.chat_id}]` : '';
  const kindLabel = msg.kind && msg.kind !== 'text' ? ` (${msg.kind})` : '';
  const text = String(msg.text == null ? '' : msg.text).trim() || (msg.file ? '(file attached)' : '');
  return `## ${ts}${chatLabel} — ${direction}${userLabel}${kindLabel}\n${text}`;
}

function buildHeader(cfg, total, updatedAt) {
  return `---
name: ${cfg.headerName}
purpose: Rolling snapshot of recent messages. Auto-maintained by workspace-api — do NOT hand-edit (your edits will be overwritten on the next snapshot tick).
write_when: recent-snapshot-monitor fires (idle ≥10 min on the source, or chat reset for web). Never written by the agent.
write_how: Atomic rewrite. Old content replaced wholesale with the new tail.
do_not_write_here: Don't add observations or summaries. This is the raw transcript window.
---

# ${cfg.title}

*Last updated: ${updatedAt}. ${total} total messages in source; showing tail. Source: ${cfg.sourceDescription}.*

`;
}

// Render the full snapshot file (header + tail body) for a set of messages.
function renderSnapshot(cfg, channel, messages, maxMessages, maxChars, updatedAt) {
  const head = buildHeader(cfg, messages.length, updatedAt);
  let body;
  if (messages.length === 0) {
    body = `_(no messages yet — ${channel === 'telegram' ? 'no Telegram conversations logged yet' : 'start a conversation in the workspace web chat'})_\n`;
  } else {
    let chunks = messages.slice(-maxMessages).map(cfg.formatEntry);
    body = chunks.join('\n\n');
    // Trim oldest if over budget.
    while (body.length > maxChars && chunks.length > 1) {
      chunks.shift();
      body = chunks.join('\n\n');
    }
  }
  return { content: head + body + '\n', charCount: body.length };
}

/**
 * Read the source JSONL tail and write the snapshot card for one channel.
 * Idempotent — safe to call repeatedly. Returns a small summary object
 * the caller (PM2 monitor, route handler) can log.
 *
 * Team mode + web: writes ONE snapshot per user under memory/users/<slug>/ (a
 * web tail is that person's private conversation) and the shared
 * memory/RECENT_WEB.md from the primary admin's sessions only (the Telegram
 * surface acts as the admin). Solo / telegram: a single shared file, unchanged.
 */
export function writeRecentSnapshot({
  channel = 'web',
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const cfg = CHANNELS[channel];
  if (!cfg) throw new Error(`unknown channel: ${channel}`);
  const updatedAt = new Date().toISOString();

  // Per-user web snapshots (team mode only).
  if (channel === 'web' && getTeamMode()) {
    const byUser = listWebSessionsByUser();
    const adminSlug = primaryAdminSlug();
    let wrote = 0;
    let total = 0;
    // 1) Each user's own private RECENT_WEB.
    for (const [slug, files] of byUser) {
      if (!/^[a-z0-9-]+$/.test(slug)) continue; // path-segment safety
      const messages = readMessagesFrom(files);
      total += messages.length;
      const { content } = renderSnapshot(cfg, channel, messages, maxMessages, maxChars, updatedAt);
      const dir = join(MEMORY_DIR, USERS_DIR, slug);
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
      atomicWrite(join(dir, 'RECENT_WEB.md'), content);
      wrote++;
    }
    // 2) Shared file = the admin's sessions (Telegram cross-surface = admin).
    const adminFiles = byUser.get(adminSlug) || [];
    const adminMsgs = readMessagesFrom(adminFiles);
    const { content } = renderSnapshot(cfg, channel, adminMsgs, maxMessages, maxChars, updatedAt);
    atomicWrite(cfg.snapshotPath, content);
    return {
      channel,
      path: cfg.snapshotPath,
      perUser: wrote,
      total,
      written_at: updatedAt,
    };
  }

  // Per-operator Telegram snapshot (team mode). The bot's ONE Telegram log is
  // the OPERATOR's private conversation (single token). Writing it to the shared
  // memory/RECENT_TELEGRAM.md let any teammate read it via /api/files/read (the
  // prompt-exclusion alone is not an ACL). Write it to the admin's per-user dir
  // instead — scope-rule.js guards memory/users/<slug>/ — and remove the stale
  // flat file so old content can't leak.
  const adminSlug = channel === 'telegram' && getTeamMode() ? primaryAdminSlug() : null;
  if (adminSlug && /^[a-z0-9-]+$/.test(adminSlug)) {
    const messages = cfg.readMessages ? cfg.readMessages() : readJsonl(cfg.sourcePath);
    const { content, charCount } = renderSnapshot(cfg, channel, messages, maxMessages, maxChars, updatedAt);
    const dir = join(MEMORY_DIR, USERS_DIR, adminSlug);
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    const perUserPath = join(dir, 'RECENT_TELEGRAM.md');
    atomicWrite(perUserPath, content);
    try { if (existsSync(cfg.snapshotPath)) unlinkSync(cfg.snapshotPath); } catch { /* best-effort */ }
    return { channel, path: perUserPath, total: messages.length, written_at: updatedAt, char_count: charCount };
  }

  // Solo web, or telegram in solo: one shared file (legacy behaviour).
  const messages = cfg.readMessages ? cfg.readMessages() : readJsonl(cfg.sourcePath);
  const { content, charCount } = renderSnapshot(cfg, channel, messages, maxMessages, maxChars, updatedAt);
  atomicWrite(cfg.snapshotPath, content);
  return {
    channel,
    path: cfg.snapshotPath,
    total: messages.length,
    written_at: updatedAt,
    char_count: charCount,
  };
}

/**
 * Check whether a channel's snapshot is stale enough to merit a refresh.
 * "Stale" = the source file has a newer mtime than the snapshot AND the
 * source's last touch is older than idleSeconds (so we don't update
 * mid-turn and bust the cache).
 *
 * Returns true | false. Pure check, no IO side effects beyond stat().
 */
export function isSnapshotStale({ channel = 'web', idleSeconds = 600 } = {}) {
  const cfg = CHANNELS[channel];
  if (!cfg) return false;
  // Newest source mtime — aggregated across per-session files for web, the
  // single log file for telegram.
  const srcMtimeMs = cfg.sourceMtimeMs
    ? cfg.sourceMtimeMs()
    : (existsSync(cfg.sourcePath) ? (() => { try { return statSync(cfg.sourcePath).mtimeMs; } catch { return 0; } })() : 0);
  if (!srcMtimeMs) return false; // no source activity at all
  // If source is too new (within idleSeconds), we are mid-turn — skip.
  if (Date.now() - srcMtimeMs < idleSeconds * 1000) return false;
  // If snapshot doesn't exist yet, definitely stale.
  if (!existsSync(cfg.snapshotPath)) return true;
  let snapStat;
  try { snapStat = statSync(cfg.snapshotPath); } catch { return true; }
  // Snapshot exists; stale only if source has newer changes than it.
  return srcMtimeMs > snapStat.mtimeMs;
}

export const SUPPORTED_CHANNELS = Object.keys(CHANNELS);
