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
 *     read reveals it. That token carries the operator's identity, which bot.sh
 *     also sends as X-IDE-Actor.
 * No valid token → no identity (resolve returns null).
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const turns = new Map();   // token → { actor, group }

export function issueTurnToken({ actor = null, group = false } = {}) {
  const token = randomBytes(24).toString('base64url');
  turns.set(token, { actor: actor && actor !== 'default' ? String(actor) : null, group: !!group });
  return token;
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
 * The identity behind a turn token, or null. `claimedActor` is what the caller
 * says in X-IDE-Actor — used only for the bot's token, which proves "this is
 * the operator's brain" but is not minted per turn.
 */
export function resolveTurnToken(token, claimedActor = '') {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) return null;
  const turn = turns.get(t);
  if (turn) return { ...turn, source: 'turn' };
  const expected = botTokenHash();
  if (expected) {
    const got = createHash('sha256').update(t).digest();
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      const actor = /^[a-z0-9-]+$/.test(String(claimedActor || '')) ? String(claimedActor) : null;
      return { actor, group: false, source: 'bot' };
    }
  }
  return null;
}

// For tests.
export function _resetForTests() { turns.clear(); botHash = undefined; }
