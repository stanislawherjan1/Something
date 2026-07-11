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
  if (isAdmin) return true;
  // Normalize BEFORE the positional check so it can't be defeated by empty
  // ('//') or dot ('/./') segments — 'memory//users/bob' and 'memory/./users/bob'
  // must both classify as the memory tree and get denied. Reject upward
  // traversal outright: a member never legitimately needs '..' (the real path
  // has none), so any '..' is treated as out of scope.
  const parts = String(relPosix || '').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return false;
  if (parts.length === 0) return true;              // project root / '.' → shared listing
  // Each user has TWO private trees: their files (users/<slug>/…) and their
  // memory (memory/users/<slug>/…). Own → allow; another user's → deny;
  // everything else (the shared team space) → allow.
  const isUsersTree = parts[0] === USERS_DIR;                            // users/<slug>/…
  const isMemTree   = parts[0] === 'memory' && parts[1] === USERS_DIR;   // memory/users/<slug>/…
  // Group-mode memory (memory/groups/<gid>/…) is the GROUP brain's working set,
  // not a member-browsable space — deny it to every non-admin via the file API
  // (admin already returned true above). The group brain itself has no file
  // tools, so this only gates web members; it stops a teammate reading raw group
  // transcripts/notes through /api/files.
  if (parts[0] === 'memory' && parts[1] === 'groups') return false;
  if (!isUsersTree && !isMemTree) return true;
  if (!ownSlug) return false;                       // a private tree, but the actor has no slug
  return (isMemTree ? parts[2] : parts[1]) === ownSlug;
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
