/**
 * locks — an admin's read-only marks on the shared space.
 *
 * A lock is a project-relative path in the shared space; a locked file or
 * folder (and everything under a folder) is read-only for members and for
 * their turns, while admins and the operator's brain keep write access. The
 * store is `.team/locks.json` — `{ "<path>": { by, at } }` — written only
 * here, group `workspace` 0660 so a turn's hook can read it. The rule that
 * answers "may this actor write here" is `pathWritable` in scope-rule.js;
 * this module is the store and its validation.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { pathInScope, lockCovering, normalizeRel } from './scope-rule.js';

const FILE = () => join(PROJECT_DIR, '.team', 'locks.json');

export function readLocks() {
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeLocks(locks) {
  // A lock whose path is gone blocks nothing and shows nowhere: dropped on the next write.
  for (const key of Object.keys(locks)) if (!existsSync(join(PROJECT_DIR, key))) delete locks[key];
  const f = FILE();
  mkdirSync(join(PROJECT_DIR, '.team'), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(locks, null, 2), { mode: 0o660 });
  try { chmodSync(tmp, 0o660); } catch { /* dev */ }
  renameSync(tmp, f);
}

/**
 * Lock a shared path for members. Refuses a private tree (locks are for the
 * shared space), the project root, and a path that does not exist. A nested
 * lock under a locked folder is kept as its own entry (harmless; the UI shows
 * it as covered by the parent).
 */
export function lock(relPath, bySlug) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('The workspace root cannot be locked.');
  if (!pathInScope(rel, { ownSlug: null })) throw new Error('Only shared files and folders can be locked.');
  if (!existsSync(join(PROJECT_DIR, rel))) throw new Error('That path does not exist.');
  const locks = readLocks();
  if (locks[rel]) return locks[rel];
  locks[rel] = { by: bySlug || null, at: new Date().toISOString() };
  writeLocks(locks);
  return locks[rel];
}

export function unlock(relPath) {
  const rel = normalizeRel(relPath);
  const locks = readLocks();
  if (!locks[rel]) return false;
  delete locks[rel];
  writeLocks(locks);
  return true;
}

/** Every lock, with whether its path still exists (a stale one is listed greyed and never blocks). */
export function list() {
  const locks = readLocks();
  return Object.entries(locks).map(([path, v]) => ({ path, by: v.by || null, at: v.at || null, exists: existsSync(join(PROJECT_DIR, path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The lock covering a path (its own or an ancestor's), or null. Stale locks do not count. */
export function covering(relPath) {
  const hit = lockCovering(relPath, readLocks());
  if (!hit) return null;
  return existsSync(join(PROJECT_DIR, hit.path)) ? hit : null;
}
