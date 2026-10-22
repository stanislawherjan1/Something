/**
 * Pure actor file-scope rule — the single definition of "may this user touch
 * this path". Shared by the web file API (lib/file-scope.js) and the web
 * claude's PreToolUse path-guard hook (hooks/scope-guard.js) so the two can
 * never drift.
 *
 * No imports, no side effects — safe to require from a standalone hook script.
 */

export const USERS_DIR = 'users';

/**
 * May an actor touch this project-relative POSIX path? The same answer for
 * admins and members — privacy is by path, never by role:
 *   the shared team space                                  → yes
 *   their own users/, memory/users/ and .team/users/ tree  → yes
 *   anyone else's                                          → no
 *   memory/groups/ (membership, not a path, decides)       → no, for everyone
 * `relPosix === ''` is the project root (allowed — the shared listing). Callers
 * may still pass `isAdmin`; it changes nothing.
 */
export function pathInScope(relPosix, { ownSlug = null } = {}) {
  // Normalize BEFORE the positional check so it can't be defeated by empty
  // ('//') or dot ('/./') segments — 'memory//users/bob' and 'memory/./users/bob'
  // must both classify as the memory tree and get denied. Reject upward
  // traversal outright: nobody legitimately needs '..' through this API (the
  // real path has none), so any '..' is treated as out of scope.
  const parts = String(relPosix || '').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return false;
  if (parts.length === 0) return true;              // project root / '.' → shared listing
  // Each user has TWO private trees: their files (users/<slug>/…) and their
  // memory (memory/users/<slug>/…). Another member's private tree is denied to
  // EVERYONE through the product surfaces — including admins and the operator.
  // (An admin's out-of-band escape is raw DB/SSH on their own box; the bot + UI
  // never hand one member another member's private data.) Own tree → allow.
  const isUsersTree = parts[0] === USERS_DIR;                            // users/<slug>/…
  const isMemTree   = parts[0] === 'memory' && parts[1] === USERS_DIR;   // memory/users/<slug>/…
  // .team/users/<slug>/ is the same person's app data — chat history, routines.
  const isTeamTree  = parts[0] === '.team' && parts[1] === USERS_DIR;    // .team/users/<slug>/…
  if (isUsersTree || isMemTree || isTeamTree) {
    if (!ownSlug) return false;                     // a private tree, but the actor has no slug
    return (isUsersTree ? parts[1] : parts[2]) === ownSlug;   // only your OWN — admin or not
  }
  // memory/groups/<chatId>/ holds a group's memory (the v4 ledger). Who may read
  // it depends on who is in that group, which a path cannot tell — so no raw
  // path reaches it, for anyone, admins included; group memory is read through
  // the memory tools, which check membership from the turn's identity.
  if (parts[0] === 'memory' && parts[1] === 'groups') return false;
  // Not a private tree: the shared team space, the same for admins and members.
  return true;
}

/**
 * Group-context scope rule (group-mode v2, D2). A group turn's output is public
 * to the whole group and its session context is SHARED across turns run as
 * different senders — so whatever enters it is de facto group-visible. Hence the
 * hard rule: NO private tree is readable in a group turn — not the sender's own,
 * not an admin's. One rule, no exceptions (private work is delegated to a
 * sender-scoped DM turn instead). Everything outside users/ + memory/users/ is
 * the shared team space and stays allowed.
 */
/** A project-relative POSIX path with empty and dot segments dropped; '' for the root. */
export function normalizeRel(relPosix) {
  return String(relPosix || '').split('/').filter(p => p && p !== '.').join('/');
}

/**
 * The lock that covers a path — its own entry or an ancestor folder's — from
 * a locks map `{ "<path>": { by, at } }`, or null. Pure: the caller decides
 * what a stale entry means.
 */
export function lockCovering(relPosix, locks) {
  if (!locks || typeof locks !== 'object') return null;
  const parts = String(relPosix || '').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null;
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join('/');
    if (locks[key]) return { path: key, ...locks[key], inherited: i !== parts.length };
  }
  return null;
}

/**
 * May an actor WRITE this project-relative path? In scope (pathInScope), and
 * not under a lock — for everyone: a lock is read-only for admins and the
 * operator's brain too, until an admin unlocks it. One rule for the file API
 * and the hook; the message the two give is the lock's own ("Locked by
 * <name>…"). `isAdmin` is accepted and changes nothing, like in pathInScope.
 */
export function pathWritable(relPosix, { ownSlug = null, isAdmin = false, locks = null } = {}) {
  void isAdmin;
  if (!pathInScope(relPosix, { ownSlug })) return { ok: false, why: 'scope' };
  const hit = lockCovering(relPosix, locks);
  if (hit) return { ok: false, why: 'locked', lock: hit };
  return { ok: true };
}

export function pathInGroupScope(relPosix) {
  const parts = String(relPosix || '').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return false;
  if (parts.length === 0) return true;              // project root → shared listing
  if (parts[0] === USERS_DIR) return false;                            // anyone's private files
  if (parts[0] === 'memory' && parts[1] === USERS_DIR) return false;   // anyone's private memory
  if (parts[0] === '.team' && parts[1] === USERS_DIR) return false;    // anyone's chats and routines
  if (parts[0] === 'memory' && parts[1] === 'groups') return false;    // any group's memory (tools check membership)
  return true;
}

// ─── a room's transcript ─────────────────────────────────────────────────────
// `.group-watcher/<room>-history.jsonl` (and the room's session, audit and
// marker files beside it) is what the room said: readable by the room's own
// turn and by a person who is in that room, nobody else. The bot once agreed,
// asked, that a non-member's turn could read it — the file sat in the shared
// tree and only its manners stood in the way. Which room a path belongs to:
const TRANSCRIPT_RE = /^\.group-watcher(?:\/(-?\d{4,20}|slack-[A-Z][A-Z0-9]{5,20})(?:[-.]|$))?/;
/** The room id a transcript path names, '' for the directory itself, null when the path is not under it. */
export function transcriptRoomOf(relPosix) {
  const parts = String(relPosix || '').split('/').filter(p => p && p !== '.');
  const rel = parts.join('/');
  const m = rel.match(TRANSCRIPT_RE);
  if (!m) return null;
  // A traversal that starts in the directory is nobody's, like the directory.
  if (parts.some(p => p === '..')) return '';
  return m[1] || '';
}
/**
 * May this turn read a transcript path? A room's turn reads its own room; a
 * person reads the rooms they are in (`isMember(roomId)` — the registry's
 * answer); the directory itself, or a file whose room cannot be told, is
 * nobody's. Paths outside `.group-watcher/` are not this rule's business (true).
 */
export function transcriptAllowed(relPosix, { groupCtx = false, groupId = null, isMember = () => false } = {}) {
  const room = transcriptRoomOf(relPosix);
  if (room == null) return true;
  if (room === '') return false;
  if (groupCtx) return !!groupId && String(groupId) === room;
  try { return !!isMember(room); } catch { return false; }
}
