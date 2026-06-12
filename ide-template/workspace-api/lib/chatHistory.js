/**
 * Per-session chat history.
 *
 * Each session is one jsonl file at:
 *   PROJECT_DIR/.team/users/{actor}/chats/{sessionId}.jsonl
 *
 * Each line: { ts, role: 'user'|'assistant'|'system', text, ?attachments, ?kind, ?state }
 *   - role        : speaker
 *   - text        : message body (markdown OK)
 *   - attachments : optional [{name, path, size}] for upload chips
 *   - kind        : optional discriminator on system entries (e.g. 'reset')
 *   - state       : optional. Today the only value is 'interrupted', set by
 *                   Phase 4 when an assistant turn is cut short by the user
 *                   sending a follow-up mid-stream. Phase 1 just plumbs it.
 *
 * Append-only — never rewritten — so two concurrent SSE streams writing to
 * different sessions don't conflict, and a single session's writes don't need
 * locking (POSIX append is atomic up to PIPE_BUF).
 *
 * Migration: on first call after this module ships, migrateLegacyConversation
 * moves the old PROJECT_DIR/.chat/conversation.jsonl into the new layout as
 * a single session titled "Imported". One-shot, idempotent.
 *
 * Compat shims at the bottom: the old single-conversation API (appendMessage
 * with role/text/attachments/kind, readPage, appendResetMarker, summary)
 * still works against the "current" session (the most recently touched one,
 * created on demand if absent). Phase 2 replaces these with session-aware
 * routes; Phase 3 frontend always sends an explicit sessionId.
 */

import {
  mkdirSync, appendFileSync, readFileSync, existsSync,
  writeFileSync, renameSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import {
  listSessions, createSession, bumpSessionStats, _paths, _internal,
} from './sessions.js';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

const LEGACY_FILE = join(PROJECT_DIR, '.chat', 'conversation.jsonl');

let migrationDone = false;

function sessionFilePath(actor, sessionId) {
  return join(_paths.chatsDir(actor), `${sessionId}.jsonl`);
}

/**
 * One-time migration of the pre-multi-session conversation.jsonl into the new
 * per-session layout. Runs lazily before the first read or write.
 *
 * Idempotent: skips when an _index.json with at least one entry already
 * exists for the actor, or when the legacy file is gone.
 */
function migrateLegacyConversation(actor = 'default') {
  if (migrationDone) return;
  migrationDone = true;

  if (!existsSync(LEGACY_FILE)) return;

  const idx = _internal.readIndex(actor);
  if (idx.sessions.length > 0) {
    // Already migrated, or a fresh client used the new path first. Either
    // way the legacy file is no longer authoritative — leave it for archival
    // (operator audit) and stop here.
    return;
  }

  let raw;
  try { raw = readFileSync(LEGACY_FILE, 'utf8'); }
  catch (err) {
    process.stderr.write(`[chat-history] legacy read failed: ${err.message}\n`);
    return;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return;

  // Derive timestamps from the file content where possible; fall back to
  // filesystem mtimes. We use these to seed createdAt / lastMessageAt so the
  // imported session sorts correctly in the sidebar.
  const stats = statSync(LEGACY_FILE);
  let firstTs = (stats.birthtime || stats.mtime).toISOString();
  let lastTs  = stats.mtime.toISOString();
  for (const line of lines) {
    try {
      const ts = JSON.parse(line).ts;
      if (typeof ts === 'string' && /^\d{4}-/.test(ts)) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs)  lastTs  = ts;
      }
    } catch { /* skip malformed */ }
  }

  // Create the manifest entry first, then drop the jsonl into place. If we
  // crash between these two writes the worst case is an orphan manifest
  // entry pointing at a missing file — readPage returns empty + UI shows an
  // empty session, recoverable. The reverse (jsonl exists, manifest missing)
  // would lose the session from the sidebar entirely.
  const session = createSession(actor, { title: 'Imported' });
  // createSession defaults titleSource to 'default' when no title is passed,
  // but we passed one — manually override since 'Imported' is not a user-chosen
  // title and we want the auto-title job to NOT run on it (the conversation
  // is too long and heterogeneous for a meaningful 7-word summary).
  _markImportedTitleSource(actor, session.id);

  // Backfill stats — createSession set messageCount=0, lastMessageAt=now.
  // Use the real numbers so sidebar ordering and unread badges work.
  const idx2 = _internal.readIndex(actor);
  const s = idx2.sessions.find(x => x.id === session.id);
  if (s) {
    s.createdAt     = firstTs;
    s.lastMessageAt = lastTs;
    s.messageCount  = lines.length;
    _internal.writeIndex(actor, idx2);
  }

  // Move the file content to its new home. Use writeFileSync (not rename)
  // because the legacy file is on the workspace volume; the target may be
  // on the same volume but cross-host moves via rename are not guaranteed
  // for bind mounts. Then archive the legacy file aside so we don't re-run.
  writeFileSync(sessionFilePath(actor, session.id), raw);
  try { renameSync(LEGACY_FILE, LEGACY_FILE + '.migrated'); }
  catch (err) {
    // Non-fatal — set the migrationDone flag (already done above) so we don't
    // loop, and surface the error for the operator.
    process.stderr.write(`[chat-history] legacy rename failed (content already copied): ${err.message}\n`);
  }

  process.stdout.write(
    `[chat-history] migrated legacy conversation.jsonl → session ${session.id} (${lines.length} messages)\n`,
  );
}

// "Imported" session shouldn't trigger auto-title regeneration in Phase 5 —
// mark it 'default' so the job leaves it alone, and the UI shows the pencil
// affordance prompting the operator to rename it if they want.
function _markImportedTitleSource(actor, sessionId) {
  const idx = _internal.readIndex(actor);
  const s = idx.sessions.find(x => x.id === sessionId);
  if (!s) return;
  s.titleSource = 'default';
  _internal.writeIndex(actor, idx);
}

// ─── Public per-session API (Phase 2 routes use these directly) ──────────────

/**
 * Append a message to a session's jsonl. Updates the manifest in the same call
 * so messageCount + lastMessageAt stay consistent with the file's actual
 * contents.
 *
 * `state` is the new optional field for Phase 4 — pass 'interrupted' when
 * persisting a partial assistant turn that was cut short.
 */
export function appendToSession(actor, sessionId, { role, text, attachments, kind, state }) {
  migrateLegacyConversation(actor);
  if (!text && !(attachments && attachments.length) && !kind) return null;

  const ts = new Date().toISOString();
  const entry = { ts, role, text: text || '' };
  if (attachments && attachments.length) entry.attachments = attachments;
  if (kind)  entry.kind  = kind;
  if (state) entry.state = state;

  mkdirSync(_paths.chatsDir(actor), { recursive: true });
  appendFileSync(sessionFilePath(actor, sessionId), JSON.stringify(entry) + '\n', 'utf8');
  bumpSessionStats(actor, sessionId, { ts, deltaCount: 1 });
  return entry;
}

/**
 * Read a page of session history.
 *   before — ISO timestamp; return entries strictly older than this
 *   limit  — page size (default 50, capped at 200)
 * Returns oldest-first within the page so the UI prepends on scroll-up.
 */
export function readSessionPage(actor, sessionId, { before, limit } = {}) {
  migrateLegacyConversation(actor);
  const cap = Math.max(1, Math.min(PAGE_MAX, Number(limit) || PAGE_DEFAULT));
  const beforeTs = typeof before === 'string' && before ? before : null;

  let raw;
  try { raw = readFileSync(sessionFilePath(actor, sessionId), 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return { messages: [], hasMore: false };
    throw err;
  }
  const lines = raw.split('\n').filter(Boolean);

  const out = [];
  let hasMore = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let m;
    try { m = JSON.parse(lines[i]); } catch { continue; }
    if (beforeTs && !(String(m.ts || '') < beforeTs)) continue;
    if (out.length === cap) { hasMore = true; break; }
    out.push(m);
  }
  out.reverse();
  return { messages: out, hasMore };
}

/**
 * Move a session's jsonl into the dated archive subtree. Called from the
 * DELETE /sessions/:id route handler in Phase 2 after deleteSession() trims
 * the manifest. Idempotent: missing source = no-op (we treat a manifest
 * delete as authoritative even when the file is already gone).
 */
export function archiveSessionFile(actor, sessionId) {
  migrateLegacyConversation(actor);
  const src = sessionFilePath(actor, sessionId);
  if (!existsSync(src)) return;
  const ym = new Date().toISOString().slice(0, 7);  // YYYY-MM
  const archDir = join(_paths.chatsDir(actor), 'archive', ym);
  mkdirSync(archDir, { recursive: true });
  try { renameSync(src, join(archDir, `${sessionId}.jsonl`)); }
  catch (err) {
    process.stderr.write(`[chat-history] archive ${sessionId}: ${err.message}\n`);
  }
}

// ─── Compat shims (Phase 2 will replace these with session-aware routes) ─────

/**
 * Pick a "current" session for the legacy single-conversation routes — the
 * most recently touched non-archived session. Creates one on demand if the
 * manifest is empty (fresh workspace, no migration). Idempotent.
 */
function currentSessionId(actor = 'default') {
  migrateLegacyConversation(actor);
  const sessions = listSessions(actor);
  for (const s of sessions) {
    if (!s.archived) return s.id;
  }
  // No sessions at all — fresh workspace. Create one so the first turn lands
  // somewhere sensible.
  const created = createSession(actor, {});
  return created.id;
}

/** Legacy signature: appendMessage(role, text, attachments, kind). */
export function appendMessage(role, text, attachments, kind) {
  const actor = 'default';
  return appendToSession(actor, currentSessionId(actor), { role, text, attachments, kind });
}

/** Legacy signature: appendResetMarker() → appends a topic-boundary system message. */
export function appendResetMarker() {
  appendMessage('system', '--- new topic ---', null, 'reset');
}

/** Legacy signature: readPage({before, limit}) — reads from the current session. */
export function readPage({ before, limit } = {}) {
  const actor = 'default';
  return readSessionPage(actor, currentSessionId(actor), { before, limit });
}

/** Legacy signature: summary() — message count for the current session. */
export function summary() {
  const actor = 'default';
  const sid = currentSessionId(actor);
  let active = 0;
  try {
    const raw = readFileSync(sessionFilePath(actor, sid), 'utf8');
    active = raw.split('\n').filter(Boolean).length;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return { active };
}
