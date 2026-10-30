/**
 * Who is looking, and at what: one person's view of memory, the board and the
 * files, from their roster entry alone. Every surface that reads as a person
 * (the Memory screen, the MCP endpoint for coding agents) builds the same
 * object, so the scopes a person may read are decided in one place:
 *   own    — their private memory scope (`user:<slug>`)
 *   read   — every scope they may read: shared, their own, their rooms
 *   groups — the rooms they belong to
 * An admin's view is no wider than a member's: privacy is by path, never by role.
 */
import * as ledger from './memory-ledger.js';
import { getUser, getTeamMode, primaryAdminSlug, memberGroupsOf } from './team.js';

const SLUG_RE = /^[a-z0-9-]+$/;

/** The view of the person behind an email, or null when they are nobody here. */
export function viewerFor(email) {
  if (!email) return null;
  const u = getUser(email);
  const slug = u?.slug || (getTeamMode() ? null : primaryAdminSlug());
  if (!slug || slug === 'default' || !SLUG_RE.test(slug)) return null;
  const groups = memberGroupsOf(slug);
  return {
    email: String(email).toLowerCase(),
    slug,
    own: `user:${slug}`,
    groups,
    read: ledger.readableScopes({ actor: slug, memberGroups: groups }),
    isAdmin: u?.role === 'admin',
    displayName: u?.displayName || null,
  };
}
