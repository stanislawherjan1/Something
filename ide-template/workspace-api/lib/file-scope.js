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

import { readdirSync, existsSync, renameSync, rmdirSync } from 'node:fs';
import { resolve, relative, sep, extname, join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import * as team from './team.js';
import { pathInScope, USERS_DIR } from './scope-rule.js';

export { USERS_DIR };

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
  const { isAdmin, slug } = actorScope(req);
  return pathInScope(relPosix(absPath), { isAdmin, ownSlug: slug });
}

// ─── Merge personal → workspace (on disabling team mode) ─────────────────────

/** How many entries sit in a user's personal dir (0 if it doesn't exist). */
export function countPersonalFiles(slug) {
  if (!slug) return 0;
  const dir = join(resolve(PROJECT_DIR), USERS_DIR, slug);
  try { return readdirSync(dir).length; } catch { return 0; }
}

// Pick a non-colliding name in `root` for `name`, e.g. "notes.md" →
// "notes (personal).md" → "notes (personal 2).md". Works for dirs (no ext) too.
function freeName(root, name) {
  const ext  = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (personal)${ext}` : `${base} (personal ${n})${ext}`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
}

/**
 * Move ONE user's personal files (users/<slug>/*) up into the shared workspace
 * root, renaming on collision so nothing is overwritten. Used when the user
 * turns team mode off and opts to merge their personal files into public.
 *
 * Caller passes the acting user's OWN slug — never another user's — so this
 * can't be used to exfiltrate someone else's private dir into the shared space.
 * Renames are within one filesystem (atomic). The emptied personal dir is
 * removed; if a move failed it's left in place (not force-deleted).
 */
export function mergePersonalToWorkspace(slug) {
  if (!slug) return { moved: 0 };
  const root = resolve(PROJECT_DIR);
  const personalDir = join(root, USERS_DIR, slug);
  let names;
  try { names = readdirSync(personalDir); } catch { return { moved: 0 }; }

  let moved = 0;
  for (const name of names) {
    const src      = join(personalDir, name);
    const destName = existsSync(join(root, name)) ? freeName(root, name) : name;
    try { renameSync(src, join(root, destName)); moved++; }
    catch (err) { process.stderr.write(`[file-scope] merge move failed for ${name}: ${err.message}\n`); }
  }
  try { rmdirSync(personalDir); } catch { /* not empty (a move failed) — leave it */ }
  return { moved };
}
