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
 * May an actor touch this project-relative POSIX path?
 *   admin            → everything.
 *   member/observer  → the shared team space (anything NOT under users/) plus
 *                      their own users/<ownSlug>/...; another user's
 *                      users/<other>/ is denied.
 * `relPosix === ''` is the project root (allowed — the shared listing).
 */
export function pathInScope(relPosix, { isAdmin = false, ownSlug = null } = {}) {
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
  if (isUsersTree || isMemTree) {
    if (!ownSlug) return false;                     // a private tree, but the actor has no slug
    return (isMemTree ? parts[2] : parts[1]) === ownSlug;   // only your OWN — admin or not
  }
  // Not a private tree. Admins get everything else; members get the shared team
  // space. memory/groups/ stays denied to non-admins as defence in depth: a
  // per-group memory tree was designed and never built (nothing writes it, and
  // a group's durable facts go to SHARED memory instead, where they are
  // visible, searchable and correctable). The deny costs nothing and means a
  // future writer cannot quietly expose raw group content to every member.
  if (isAdmin) return true;
  if (parts[0] === 'memory' && parts[1] === 'groups') return false;
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
export function pathInGroupScope(relPosix) {
  const parts = String(relPosix || '').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return false;
  if (parts.length === 0) return true;              // project root → shared listing
  if (parts[0] === USERS_DIR) return false;                            // anyone's private files
  if (parts[0] === 'memory' && parts[1] === USERS_DIR) return false;   // anyone's private memory
  return true;
}
