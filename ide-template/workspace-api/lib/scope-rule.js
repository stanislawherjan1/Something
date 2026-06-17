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
  const rel = String(relPosix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel === '' || rel === '.') return true;
  const personal = ownSlug ? `${USERS_DIR}/${ownSlug}` : null;
  if (personal && (rel === personal || rel.startsWith(personal + '/'))) return true;
  return rel.split('/')[0] !== USERS_DIR;
}
