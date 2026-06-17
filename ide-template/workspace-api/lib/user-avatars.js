/**
 * Per-user profile avatars (team mode).
 *
 * Stored as ONE small webp per user at PROJECT_DIR/.team/avatars/<slug>.webp
 * (`.team` is HARD_HIDDEN — never reachable via the file API). The browser
 * resizes to 512×512 webp BEFORE upload, so the server does no image
 * processing — it just validates a small cap + webp magic and writes the file.
 *
 * Versioning for cache-busting comes from the file mtime (avatarUpdatedAt) —
 * no coupling to the team store, so there's no "must remember to bump a
 * timestamp" failure mode.
 */

import {
  mkdirSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync, chmodSync, createReadStream,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';

const AVATARS_DIR = join(PROJECT_DIR, '.team', 'avatars');
const MAX_BYTES   = 512 * 1024;                 // browser pre-resizes; 512 KB is generous
const WEBP_RIFF   = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF"

// Path-safe slug → never let a crafted slug escape the avatars dir.
function sanitizeSlug(slug) {
  return String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

export function avatarPath(slug) {
  const s = sanitizeSlug(slug);
  return s ? join(AVATARS_DIR, `${s}.webp`) : null;
}

export function hasAvatar(slug) {
  const p = avatarPath(slug);
  return !!p && existsSync(p);
}

/** { slug, path, avatarUpdatedAt(ms) } for an existing avatar, else null. */
export function getUserAvatar(slug) {
  const p = avatarPath(slug);
  if (!p || !existsSync(p)) return null;
  try {
    const st = statSync(p);
    return { slug: sanitizeSlug(slug), path: p, size: st.size, avatarUpdatedAt: Math.floor(st.mtimeMs) };
  } catch { return null; }
}

/** Cache-busted URL for a slug's avatar, or null if none. */
export function avatarUrl(slug) {
  const a = getUserAvatar(slug);
  return a ? `/api/me/avatar?slug=${encodeURIComponent(a.slug)}&v=${a.avatarUpdatedAt}` : null;
}

export function saveUserAvatar(slug, buffer) {
  const p = avatarPath(slug);
  if (!p) throw new Error('Invalid user.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty upload.');
  if (buffer.length > MAX_BYTES) throw new Error('Avatar must be ≤ 512 KB (resize before upload).');
  // webp magic: "RIFF"...."WEBP"
  const isWebp = buffer.length >= 12
    && buffer.subarray(0, 4).equals(WEBP_RIFF)
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isWebp) throw new Error('Avatar must be a webp image.');

  mkdirSync(AVATARS_DIR, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, buffer, { mode: 0o644 });
    try { chmodSync(tmp, 0o644); } catch {}
    renameSync(tmp, p);
    try { chmodSync(p, 0o644); } catch {}
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return getUserAvatar(slug);
}

export function deleteUserAvatar(slug) {
  const p = avatarPath(slug);
  if (!p || !existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/** Stream the avatar bytes into an Express response (caller checked existence). */
export function streamUserAvatar(slug, res) {
  const a = getUserAvatar(slug);
  if (!a) { res.status(404).end(); return; }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Content-Length', a.size);
  res.setHeader('Cache-Control', 'private, max-age=300');
  const s = createReadStream(a.path);
  s.on('error', () => { try { res.end(); } catch {} });
  s.pipe(res);
}
