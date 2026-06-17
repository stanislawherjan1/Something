/**
 * Actor-scoped file access for team mode (Phase A).
 *
 * Layered ON TOP of resolveSafePath (which jails every path to PROJECT_DIR):
 *   - admin            → everything, including system files (the `users/` tree,
 *                        dotfiles) when the system-files toggle is passed.
 *   - member/observer  → the shared TEAM space (everything under PROJECT_DIR
 *                        that is NOT under `users/`) plus their OWN
 *                        `users/<slug>/...`. Any other `users/<other>/...` path
 *                        is rejected.
 *
 * Non-destructive layout: the existing PROJECT_DIR root IS the team space — no
 * content moves. Personal space is the new `users/<slug>/` subtree.
 *
 * v1 enforcement lives at the web file API only (per MULTI_USER_TEAM_MODE spec);
 * the shell/tmux side stays convention-bound until the v2 per-uid split.
 */

import { resolve, relative, sep } from 'node:path';
import { PROJECT_DIR } from './config.js';
import * as team from './team.js';

export const USERS_DIR = 'users';

/**
 * Resolve the requesting actor's scope from req.actor (the verified email).
 * Returns { email, isAdmin, slug, personalPrefix } — personalPrefix is the
 * project-relative root of the user's private space, or null if unknown.
 */
export function actorScope(req) {
  const email = req?.actor || null;
  const user = email ? team.getUser(email) : null;
  const isAdmin = user?.role === 'admin';
  const slug = user?.slug || null;
  return {
    email,
    isAdmin,
    slug,
    role: user?.role || null,
    displayName: user?.displayName || null,
    personalPrefix: slug ? `${USERS_DIR}/${slug}` : null,
  };
}

// Project-relative POSIX path; '' for PROJECT_DIR itself.
function relPosix(absPath) {
  const r = relative(resolve(PROJECT_DIR), absPath);
  if (!r || r === '.') return '';
  return r.split(sep).join('/');
}

/**
 * True if the actor may touch this (already PROJECT_DIR-jailed) absolute path.
 *   admin            → always.
 *   member/observer  → team space (not under users/) OR own users/<slug>/...
 */
export function actorCanAccess(absPath, req) {
  const { isAdmin, personalPrefix } = actorScope(req);
  if (isAdmin) return true;

  const rel = relPosix(absPath);
  if (rel === '') return true;   // team root listing (users/ is filtered out of it)

  if (personalPrefix && (rel === personalPrefix || rel.startsWith(personalPrefix + '/'))) {
    return true;                 // own personal subtree
  }
  // Anything else under users/ is another user's private space → deny.
  return rel.split('/')[0] !== USERS_DIR;
}
