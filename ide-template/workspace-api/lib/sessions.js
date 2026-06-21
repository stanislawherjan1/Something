/**
 * Multi-session manifest + Claude session pointer.
 *
 * Web-chat history is split per topic, ChatGPT-style. Each topic gets:
 *   PROJECT_DIR/.team/users/{actor}/chats/{sessionId}.jsonl   — append-only log
 *   PROJECT_DIR/.team/users/{actor}/chats/_index.json         — manifest
 *
 * actor is the user identifier. Single-user deployments use 'default' until
 * MULTI_USER_TEAM_MODE lands. The layout already includes the actor segment
 * so the eventual team mode doesn't need a path migration — just multi-actor
 * logic in API.
 *
 * sessionId is OUR id (a UUID we generate). Separately, Claude tracks its own
 * session id internally; we capture it from the first turn's `session_id`
 * SSE event and store it on the manifest entry as `claudeSessionId`. The two
 * are decoupled so we can regenerate Claude's session (recovery, /resume bug)
 * without losing the sidebar entry.
 *
 * Compat shims at the bottom: getSessionId / setSessionId / clearSession
 * still work — they operate on the "current" session (the one most recently
 * touched). When the frontend goes multi-session-aware in Phase 3 these get
 * removed.
 */

import { mkdirSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_DIR } from './config.js';
import { atomicWrite } from './atomic-write.js';

const INDEX_VERSION = 1;

// Path helpers — all per-actor so multi-actor is a one-line change later.
const userDir   = (actor) => join(PROJECT_DIR, '.team', 'users', actor);
const chatsDir  = (actor) => join(userDir(actor), 'chats');
const indexFile = (actor) => join(chatsDir(actor), '_index.json');

// Legacy single-session pointer file (for the compat shims).
const LEGACY_SESSIONS_FILE = join(PROJECT_DIR, '.chat', 'sessions.json');

function ensureDirs(actor) {
  mkdirSync(chatsDir(actor), { recursive: true });
}

function readIndex(actor) {
  ensureDirs(actor);
  try {
    const raw = readFileSync(indexFile(actor), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
      throw new Error('manifest shape invalid');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: INDEX_VERSION, sessions: [] };
    // Manifest got corrupted somehow — refuse to silently lose state.
    throw new Error(`[sessions] _index.json unreadable: ${err.message}`);
  }
}

function writeIndex(actor, data) {
  ensureDirs(actor);
  // pid+random tmp via atomicWrite so a concurrent manifest write can't
  // interleave into a shared scratch file (the old fixed `.tmp` could).
  // Residual: the read-modify-write across callers is still last-writer-wins
  // under concurrency — the manifest is metadata only (titles, counts,
  // ordering), so the worst case is a transient stat/title drift, not message
  // loss; a per-actor write queue would close it fully if it ever matters.
  atomicWrite(indexFile(actor), JSON.stringify({ ...data, version: INDEX_VERSION }, null, 2));
}

/**
 * One-time: adopt the legacy single-user 'default' chat history under the
 * primary admin's slug when team mode switches to per-user keys. Idempotent —
 * fires only when 'default' exists and the target doesn't. Renames the whole
 * dir (atomic on one filesystem), so no history is lost.
 */
export function migrateDefaultSessions(targetActor) {
  if (!targetActor || targetActor === 'default') return false;
  const from = userDir('default');
  const to   = userDir(targetActor);
  if (!existsSync(from) || existsSync(to)) return false;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return true;
  } catch (err) {
    process.stderr.write(`[sessions] default→${targetActor} session migration failed: ${err.message}\n`);
    return false;
  }
}

function sortSessions(sessions) {
  // Pinned first, then by lastMessageAt desc. Mutates in place; callers rely
  // on sortSessions(idx.sessions) being the canonical UI ordering so we don't
  // re-sort on the frontend.
  sessions.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
  });
  return sessions;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return the array of sessions for the actor, ordered for UI. By default
 * excludes archived; pass `{ archived: true }` to include them.
 */
export function listSessions(actor, { archived = false } = {}) {
  const idx = readIndex(actor);
  const out = archived
    ? idx.sessions
    : idx.sessions.filter(s => !s.archived);
  return sortSessions([...out]);
}

/** Single-session lookup. Returns null when missing — callers handle 404. */
export function getSession(actor, sessionId) {
  const idx = readIndex(actor);
  return idx.sessions.find(s => s.id === sessionId) || null;
}

/**
 * Create a session with the optional given title (defaults to "New chat",
 * which the auto-title job overwrites after the first turn). The jsonl file
 * itself is NOT created here — append-on-first-write avoids littering disk
 * with abandoned drafts the user opened-and-closed without sending.
 */
export function createSession(actor, { title, relayPeers } = {}) {
  const idx = readIndex(actor);
  const now = new Date().toISOString();
  const entry = {
    id:              randomUUID(),
    title:           title || 'New chat',
    titleSource:     title ? 'user' : 'default',
    createdAt:       now,
    lastMessageAt:   now,
    messageCount:    0,
    pinned:          false,
    archived:        false,
    claudeSessionId: null,
    // Never-blind watermark: how many messages the bot's brain has consumed for
    // this session. The chat route force-feeds messages with a higher index
    // (out-of-band relay-in / proactive) into the next turn. 0 = nothing
    // consumed yet (a fresh session replays its full tail once, harmless).
    syncedSeq:       0,
    // B3 v2 relay threading: peerSlug → that teammate's paired session id.
    // Present only on relay-anchored sessions; omitted otherwise.
    ...(relayPeers && typeof relayPeers === 'object' ? { relayPeers } : {}),
  };
  idx.sessions.push(entry);
  writeIndex(actor, idx);
  return entry;
}

/**
 * B3 v2 relay threading — pair this session with a peer teammate's session so a
 * reply relays back INTO the same thread instead of spawning a new one.
 * `relayPeers` maps peerSlug → that peer's session id (one thread per peer).
 * Idempotent; no-op if the session is gone. Caller writes both directions.
 */
export function linkRelayPeer(actor, sessionId, peerSlug, peerSessionId) {
  if (!peerSlug || !peerSessionId) return null;
  const idx = readIndex(actor);
  const s = idx.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  if (!s.relayPeers || typeof s.relayPeers !== 'object') s.relayPeers = {};
  s.relayPeers[peerSlug] = peerSessionId;
  writeIndex(actor, idx);
  return s;
}

/**
 * PATCH-style update — only the supplied fields are written. Renaming via
 * `title` auto-marks `titleSource: 'user'` so the UI knows to hide the
 * "auto-generated" affordance.
 */
export function updateSession(actor, sessionId, patch) {
  const idx = readIndex(actor);
  const s = idx.sessions.find(x => x.id === sessionId);
  if (!s) return null;

  if (typeof patch.title === 'string') {
    s.title = patch.title;
    s.titleSource = 'user';
  }
  if (typeof patch.pinned   === 'boolean') s.pinned   = patch.pinned;
  if (typeof patch.archived === 'boolean') s.archived = patch.archived;
  // titleSource override is for the auto-title job — it sets `llm`. Not
  // exposed via the UI PATCH path.
  if (patch.titleSource === 'llm' || patch.titleSource === 'default') {
    s.titleSource = patch.titleSource;
  }

  writeIndex(actor, idx);
  return s;
}

/**
 * Capture Claude's internal session id for `--resume`. Called from the chat
 * route when claude.js surfaces a session_id on the first turn of a session.
 * Decoupling our sessionId from Claude's lets us recover from a corrupt Claude
 * session by clearing this field without affecting the sidebar entry.
 */
export function setClaudeSessionId(actor, sessionId, claudeSessionId) {
  const idx = readIndex(actor);
  const s = idx.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  s.claudeSessionId = claudeSessionId || null;
  writeIndex(actor, idx);
  return s;
}

/**
 * Advance the never-blind watermark — the count of messages the bot's brain has
 * consumed for this session. Stamped after a turn's context is built (to the
 * count captured BEFORE the process spawned, so anything appended mid-turn
 * keeps a higher index and surfaces next turn). Monotonic: never moves backward.
 * Synchronous read-mutate-write, same as setClaudeSessionId — no lock needed
 * (single wsapi process, no await between read and write).
 */
export function setSyncedSeq(actor, sessionId, seq) {
  const n = Number(seq);
  if (!Number.isFinite(n) || n < 0) return null;
  const idx = readIndex(actor);
  const s = idx.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  if (typeof s.syncedSeq !== 'number' || n > s.syncedSeq) {
    s.syncedSeq = n;
    writeIndex(actor, idx);
  }
  return s;
}

/**
 * Bump message count + lastMessageAt. Called from chatHistory.appendMessage
 * on every append. No-op when the session doesn't exist (defensive — append
 * shouldn't be possible without a session, but the manifest is the
 * source-of-truth and we tolerate a torn write).
 */
export function bumpSessionStats(actor, sessionId, { ts, deltaCount = 1 } = {}) {
  const idx = readIndex(actor);
  const s = idx.sessions.find(x => x.id === sessionId);
  if (!s) return;
  s.messageCount = Math.max(0, (s.messageCount || 0) + deltaCount);
  s.lastMessageAt = ts || new Date().toISOString();
  writeIndex(actor, idx);
}

/**
 * Soft-delete: remove from manifest, move the jsonl to archive/{YYYY-MM}/ for
 * a 30-day grace window. The jsonl move happens out-of-band (chatHistory
 * owns the file path); this function ONLY edits the manifest, and returns
 * the removed entry so the caller can do the file move.
 */
export function deleteSession(actor, sessionId) {
  const idx = readIndex(actor);
  const i = idx.sessions.findIndex(x => x.id === sessionId);
  if (i < 0) return null;
  const removed = idx.sessions.splice(i, 1)[0];
  writeIndex(actor, idx);
  return removed;
}

// ─── Compat shims (used by the existing routes/chat.js — Phase 2 removes) ────

/**
 * Returns the Claude session id of the "current" session — defined as the
 * most recently touched non-archived session. Used by the legacy single-chat
 * route handler to keep working without sessionId routing.
 */
export function getSessionId() {
  const sessions = listSessions('default');
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.claudeSessionId) return s.claudeSessionId;
  }
  // Fallback to the legacy sessions.json pointer for the immediate
  // post-migration window — before any new turn writes a claudeSessionId
  // into the manifest, the legacy pointer is still authoritative.
  try {
    const raw = readFileSync(LEGACY_SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.session_id === 'string') return parsed.session_id;
  } catch { /* none */ }
  return null;
}

/**
 * Set the Claude session id on the current session. Picks the most recent
 * non-archived session — creates one if none exist yet.
 */
export function setSessionId(claudeSessionId) {
  if (typeof claudeSessionId !== 'string' || !claudeSessionId) return;
  const actor = 'default';
  let cur = listSessions(actor).find(s => !s.archived) || null;
  if (!cur) cur = createSession(actor, {});
  setClaudeSessionId(actor, cur.id, claudeSessionId);
}

/**
 * Wipe the Claude session pointer on the current session. UI's "Reset chat"
 * uses this — next turn starts a fresh Claude session, transcript untouched.
 */
export function clearSession() {
  const actor = 'default';
  const cur = listSessions(actor).find(s => !s.archived);
  if (!cur) return;
  setClaudeSessionId(actor, cur.id, null);
}

// ─── Internal helpers exposed for chatHistory.js ─────────────────────────────

export const _paths = { userDir, chatsDir, indexFile };
export const _internal = { readIndex, writeIndex, sortSessions };
