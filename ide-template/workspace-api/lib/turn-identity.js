/**
 * Who a memory call comes from, proven rather than claimed.
 *
 * The memory routes (/api/memory/grep, /api/internal/memory-write) are called
 * from inside the container by workspace-api-mcp on behalf of a turn. They used
 * to take the turn's identity from an X-IDE-Actor header, trusted because the
 * caller was on loopback — but every turn with a shell is on loopback too, so
 * any of them could name a teammate's slug and read their private memory.
 *
 * Now each caller presents a turn token (X-IDE-Turn):
 *   - a turn workspace-api starts (runClaudeTurn) gets a fresh random token,
 *     bound here to its actor and group flag, and revoked when it ends;
 *   - the Telegram brain (bot.sh, its own uid) reads a token entrypoint wrote at
 *     boot into a file only the bot user can read; workspace-api keeps only its
 *     SHA-256 (BOT_TURN_ID_HASH_FILE), so nothing workspace-api's own turns can
 *     read reveals it. That token IS the operator's identity — the primary
 *     admin, resolved here from the roster; an X-IDE-Actor header beside it is
 *     not consulted.
 * No valid token → no identity (resolve returns null).
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { primaryAdminSlug } from './team.js';
import { normalizeGroupId } from './group-id.js';

const turns = new Map();   // token → { actor, group, groupId }

export function issueTurnToken({ actor = null, group = false, groupId = null } = {}) {
  const token = randomBytes(24).toString('base64url');
  turns.set(token, {
    actor: actor && actor !== 'default' ? String(actor) : null,
    group: !!group,
    // Which group, for memory v4: a group turn reads and writes that group's scope only.
    groupId: group ? normalizeGroupId(groupId) : null,
  });
  return token;
}

/** The memory excerpts (record ids) a turn was handed, so what the turn makes can be tied to them. */
export function setTurnRecall(token, ids) {
  const t = turns.get(String(token || ''));
  if (t) t.recall = Array.isArray(ids) ? ids.map(String).slice(0, 40) : [];
}

export function revokeTurnToken(token) {
  if (token) turns.delete(token);
}

const BOT_TURN_ID_HASH_FILE = process.env.BOT_TURN_ID_HASH_FILE || '/var/wsapi-store/bot-turn-id.sha256';
let botHash;   // Buffer | null, read once
function botTokenHash() {
  if (botHash === undefined) {
    try {
      const hex = readFileSync(BOT_TURN_ID_HASH_FILE, 'utf8').trim();
      botHash = /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
    } catch { botHash = null; }
  }
  return botHash;
}

/**
 * The identity behind a turn token, or null. The second argument (what the
 * caller says in X-IDE-Actor) is kept for the callers' sake and not used: a
 * per-turn token knows its actor, and the bot's token is the operator's.
 */
export function resolveTurnToken(token, _claimedActor = '') {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) return null;
  const turn = turns.get(t);
  if (turn) return { ...turn, source: 'turn' };
  const expected = botTokenHash();
  if (expected) {
    const got = createHash('sha256').update(t).digest();
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      return { actor: primaryAdminSlug() || null, group: false, groupId: null, source: 'bot' };
    }
  }
  return null;
}

// workspace-api sometimes calls its own /internal routes over loopback (the
// Telegram relay-back in telegram-sync.js). Those calls carry this per-process
// value in X-IDE-Internal; nothing outside this process knows it, so a route
// can tell its own caller from a turn's shell on the same loopback.
export const INTERNAL_TOKEN = randomBytes(24).toString('base64url');
export function isInternalCall(value) {
  const v = typeof value === 'string' ? value : '';
  if (v.length !== INTERNAL_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(v), Buffer.from(INTERNAL_TOKEN));
}

// For tests.
export function _resetForTests() { turns.clear(); botHash = undefined; }
