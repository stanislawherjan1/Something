/**
 * Files shared by link: a Markdown file a person opens to anyone who has the
 * link, read only, always its current content. The link is a random token;
 * revoking it, deleting or moving the file, or an admin switching sharing off
 * ends it at once.
 *
 * A link ends by itself after a while (30 days unless the person picks another
 * span or "no end"): an old link nobody remembers is the usual way a shared
 * file leaks long after it mattered. An ended link reads like a revoked one;
 * sharing the file again makes a new one.
 *
 * Who may share what is decided here, not in the UI:
 *   - only a Markdown file, in a place the person can open (the same path rule
 *     as the file API: the team's space, or their OWN private tree, admin or not),
 *   - never the memory tree, a hidden or dot folder, or a hard-hidden file,
 *   - only while the workspace allows sharing.
 * The public view shows the file's name and text, never its path: a path can
 * say whose private tree it is in, or what a folder is called.
 *
 * Kept in the store dir (not the project), so the bot and the file tree never
 * see the tokens.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveSafePath, readTextFile, pathContainsHardHidden } from './files.js';
import { pathInScope } from './scope-rule.js';
import { getFileSharing } from './team.js';
import { atomicWrite } from './atomic-write.js';

function storeFile() { return join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'shares.json'); }
function readAll() {
  try { const d = JSON.parse(readFileSync(storeFile(), 'utf8')); return d && typeof d === 'object' && d.links ? d : { links: {} }; }
  catch { return { links: {} }; }
}
function writeAll(d) { atomicWrite(storeFile(), JSON.stringify(d, null, 1), { mode: 0o600 }); }

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
// days: a whole number of days 1..365, or 0 for no end; anything else → the default.
function spanFrom(days) {
  const d = days === undefined || days === null || days === '' ? DEFAULT_DAYS : Number(days);
  if (d === 0) return 0;
  return Number.isInteger(d) && d >= 1 && d <= MAX_DAYS ? d : DEFAULT_DAYS;
}
// The link's span (days, 0 = no end) and when it ends, counted from `from`.
function expiryFrom(days, from = Date.now()) {
  const span = spanFrom(days);
  return { days: span, expiresAt: span ? new Date(from + span * 86400_000).toISOString() : null };
}
const live = (l, now = Date.now()) => !!l && (!l.expiresAt || Date.parse(l.expiresAt) > now);
const clean = (p) => String(p || '').replace(/^\/+/, '').split('/').filter((s) => s && s !== '.').join('/');

/**
 * Why `path` can't be shared by this person, or null when it can.
 * `who` = { slug, isAdmin }.
 */
export function refusal(path, who) {
  if (!getFileSharing()) return 'Sharing by link is switched off for this workspace.';
  const rel = clean(path);
  if (!rel || !/\.md$/i.test(rel)) return 'Only Markdown files can be shared.';
  const parts = rel.split('/');
  if (parts.some((p) => p === '..')) return 'Not a file in this workspace.';
  if (parts[0] === 'memory') return 'Memory files can\'t be shared.';
  if (parts.some((p) => p.startsWith('.'))) return 'Hidden files and folders can\'t be shared.';
  const abs = resolveSafePath(rel);
  if (!abs || pathContainsHardHidden(abs)) return 'Not a file in this workspace.';
  if (!pathInScope(rel, { isAdmin: !!who?.isAdmin, ownSlug: who?.slug || null })) return 'You can\'t open this file.';
  try { if (!statSync(abs).isFile()) return 'Not a file.'; } catch { return 'No such file.'; }
  return null;
}

/**
 * The link for `path`, made by `who`: the existing one when the file is already
 * shared and the link still works; an ended one is replaced by a new link.
 * `opts.days`: how long it works (default 30, 0 = no end).
 */
export function share(path, who, { days } = {}) {
  const why = refusal(path, who);
  if (why) return { ok: false, error: why };
  const rel = clean(path);
  const all = readAll();
  const existing = Object.entries(all.links).find(([, l]) => l.path === rel);
  if (existing && live(existing[1])) return { ok: true, token: existing[0], ...existing[1] };
  if (existing) delete all.links[existing[0]];
  const token = randomBytes(18).toString('base64url');
  all.links[token] = { path: rel, by: who.slug, createdAt: new Date().toISOString(), ...expiryFrom(days) };
  writeAll(all);
  return { ok: true, token, ...all.links[token] };
}

/** The live link for a path, if there is one and the person may see it. */
export function linkFor(path, who) {
  const rel = clean(path);
  if (!pathInScope(rel, { isAdmin: !!who?.isAdmin, ownSlug: who?.slug || null })) return null;
  const hit = Object.entries(readAll().links).find(([, l]) => l.path === rel && live(l));
  return hit ? { token: hit[0], ...hit[1] } : null;
}

/** Whether a file has a link that works now (for the assistant's note after it edits one). */
export function isShared(path) {
  const rel = clean(path);
  const hit = Object.values(readAll().links).find((l) => l.path === rel && live(l));
  return hit && getFileSharing() ? { shared: true, expiresAt: hit.expiresAt || null } : { shared: false };
}

/**
 * The links a person can see and end: the ones they made, and for an admin
 * every link to a file in the team's space. Never a link into someone else's
 * private tree, not even for an admin.
 */
export function listFor(who) {
  return Object.entries(readAll().links)
    .filter(([, l]) => l.by === who.slug || (who.isAdmin && pathInScope(l.path, { isAdmin: true, ownSlug: who.slug })))
    .filter(([, l]) => pathInScope(l.path, { isAdmin: !!who.isAdmin, ownSlug: who.slug }))
    .map(([token, l]) => ({ token, ...l, exists: existsSync(resolveSafePath(l.path) || ''), expired: !live(l) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Its maker, or an admin for a file in the team's space (never someone's private file).
const mayManage = (l, who) => l.by === who.slug || (who.isAdmin && pathInScope(l.path, { isAdmin: true, ownSlug: who.slug }) && !l.path.startsWith('users/'));

/** End a link: its maker, or an admin for a file in the team's space. */
export function revoke(token, who) {
  const all = readAll();
  const l = TOKEN_RE.test(String(token)) ? all.links[token] : null;
  if (!l) return { ok: false, error: 'No such link.' };
  if (!mayManage(l, who)) return { ok: false, error: 'Only the person who shared it, or an admin, can stop this link.' };
  delete all.links[token];
  writeAll(all);
  return { ok: true };
}

/** How long a link works, from now: `days` 1..365, or 0 for no end. Same people as revoke. */
export function setExpiry(token, days, who) {
  const all = readAll();
  const l = TOKEN_RE.test(String(token)) ? all.links[token] : null;
  if (!l || !live(l)) return { ok: false, error: 'No such link.' };
  if (!mayManage(l, who)) return { ok: false, error: 'Only the person who shared it, or an admin, can change this link.' };
  Object.assign(l, expiryFrom(days));
  writeAll(all);
  return { ok: true, token, ...l };
}

/**
 * What anyone with the link sees: the file's name and text, nothing else.
 * Null when the link is unknown or ended, sharing is off, or the file is gone
 * or no longer something its maker could share (moved into a hidden folder…).
 */
export function publicView(token) {
  if (!TOKEN_RE.test(String(token)) || !getFileSharing()) return null;
  const l = readAll().links[token];
  if (!live(l)) return null;
  const abs = resolveSafePath(l.path);
  if (!abs || refusal(l.path, { slug: l.by })) return null;
  const r = readTextFile(abs);
  if (r.kind === 'error') return null;
  return { name: basename(l.path), content: r.content, mtime: r.mtime };
}

/** The file behind a link, for someone signed in who can open it themselves; null otherwise. */
export function pathFor(token, who) {
  if (!TOKEN_RE.test(String(token))) return null;
  const l = readAll().links[token];
  if (!live(l)) return null;
  return pathInScope(l.path, { isAdmin: !!who?.isAdmin, ownSlug: who?.slug || null }) ? l.path : null;
}
