/**
 * Per-user profile avatars (team mode).
 *
 * Stored as one small image per user at PROJECT_DIR/.team/avatars/<slug>.<ext>
 * (`.team` is HARD_HIDDEN — never reachable via the file API). The browser
 * resizes to 512×512 BEFORE upload, so the server does no image processing — it
 * validates a small cap + the image magic (webp / png / jpeg) and writes the
 * file. webp is preferred (smallest) but png/jpeg are accepted too, since some
 * browsers' canvas.toBlob falls back to png.
 *
 * Versioning for cache-busting comes from the file mtime (avatarUpdatedAt) —
 * no coupling to the team store.
 */

import {
  mkdirSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync, chmodSync, createReadStream,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';

const AVATARS_DIR = join(PROJECT_DIR, '.team', 'avatars');
const MAX_BYTES   = 1024 * 1024;                // browser pre-resizes to ~tens of KB; 1 MB is a safety cap

// Supported formats — detected by file magic (not by client-claimed type).
const FORMATS = [
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: 'png',  mime: 'image/png',  test: (b) => b.length >= 8  && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg',  mime: 'image/jpeg', test: (b) => b.length >= 3  && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
const KNOWN_EXTS  = ['webp', 'png', 'jpg', 'jpeg'];
const MIME_BY_EXT = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

// Path-safe slug → never let a crafted slug escape the avatars dir.
function sanitizeSlug(slug) {
  return String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function detectFormat(buffer) {
  for (const f of FORMATS) if (f.test(buffer)) return f;
  return null;
}

// The stored avatar file for a slug (any supported extension), or null.
function findFile(slug) {
  const s = sanitizeSlug(slug);
  if (!s) return null;
  for (const ext of KNOWN_EXTS) {
    const p = join(AVATARS_DIR, `${s}.${ext}`);
    if (existsSync(p)) return { path: p, ext };
  }
  return null;
}

export function hasAvatar(slug) {
  return !!findFile(slug);
}

/** { slug, path, ext, size, avatarUpdatedAt(ms) } for an existing avatar, else null. */
export function getUserAvatar(slug) {
  const f = findFile(slug);
  if (!f) return null;
  try {
    const st = statSync(f.path);
    return { slug: sanitizeSlug(slug), path: f.path, ext: f.ext, size: st.size, avatarUpdatedAt: Math.floor(st.mtimeMs) };
  } catch { return null; }
}

/** Cache-busted URL for a slug's avatar, or null if none. */
export function avatarUrl(slug) {
  const a = getUserAvatar(slug);
  return a ? `/api/me/avatar?slug=${encodeURIComponent(a.slug)}&v=${a.avatarUpdatedAt}` : null;
}

export function saveUserAvatar(slug, buffer) {
  const s = sanitizeSlug(slug);
  if (!s) throw new Error('Invalid user.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty upload.');
  if (buffer.length > MAX_BYTES) throw new Error('That image is too large.');
  const fmt = detectFormat(buffer);
  if (!fmt) throw new Error('Avatar must be a PNG, JPEG, or webp image.');

  mkdirSync(AVATARS_DIR, { recursive: true });
  // Drop any existing avatar in a different format so we don't leave a stale file.
  const existing = findFile(s);
  if (existing && existing.ext !== fmt.ext) { try { unlinkSync(existing.path); } catch {} }

  const p = join(AVATARS_DIR, `${s}.${fmt.ext}`);
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
  return getUserAvatar(s);
}

export function deleteUserAvatar(slug) {
  const f = findFile(slug);
  if (!f) return false;
  unlinkSync(f.path);
  return true;
}

/** Stream the avatar bytes into an Express response (caller checked existence). */
export function streamUserAvatar(slug, res) {
  const a = getUserAvatar(slug);
  if (!a) { res.status(404).end(); return; }
  res.setHeader('Content-Type', MIME_BY_EXT[a.ext] || 'application/octet-stream');
  res.setHeader('Content-Length', a.size);
  res.setHeader('Cache-Control', 'private, max-age=300');
  const s = createReadStream(a.path);
  s.on('error', () => { try { res.end(); } catch {} });
  s.pipe(res);
}
