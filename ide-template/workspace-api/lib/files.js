/**
 * File browser primitives — visibility rules, path safety, listing, reading.
 *
 * All paths from clients are treated as relative to PROJECT_DIR. Any attempt
 * to escape (`..`, absolute paths) is rejected at resolveSafePath. Callers
 * MUST go through resolveSafePath before touching the filesystem.
 */

import {
  readdirSync, readFileSync, writeFileSync, statSync, realpathSync,
  createReadStream, mkdirSync, existsSync, rmSync, renameSync,
} from 'node:fs';
import { resolve, relative, sep, extname, dirname } from 'node:path';
import {
  PROJECT_DIR, READ_MAX_BYTES, RAW_MAX_BYTES,
  HARD_HIDDEN, SOFT_HIDDEN, VISIBLE_DOT,
} from './config.js';

/**
 * Resolve a user-supplied relative path against PROJECT_DIR. Returns the
 * absolute path on success, null if the resolved path escapes PROJECT_DIR.
 *
 * Symlink defence: if any component of the resolved path is a symlink,
 * we realpath() it and verify the canonical target still lives under
 * PROJECT_DIR. Without this, a symlink planted inside the project (e.g.
 * by Claude with --dangerously-skip-permissions, or any tool with FS
 * access) could redirect a `/api/files/read` to /etc/passwd.
 */
export function resolveSafePath(rel) {
  if (typeof rel !== 'string') return null;
  const clean = rel.replace(/^\/+/, '');
  const abs = resolve(PROJECT_DIR, clean);
  const projectAbs = resolve(PROJECT_DIR);
  if (abs !== projectAbs && !abs.startsWith(projectAbs + sep)) return null;

  // Realpath both sides before comparing — handles cases where PROJECT_DIR
  // itself is a symlink (e.g. /tmp on macOS resolves to /private/tmp), which
  // would otherwise make every realpath(abs) appear to escape.
  let projectReal;
  try { projectReal = realpathSync(projectAbs); }
  catch { projectReal = projectAbs; }

  // Resolve symlinks if the file actually exists. Missing files are fine —
  // create/write paths legitimately don't exist yet, and the parent dir
  // realpath check still catches an attacker-planted symlink-as-parent.
  try {
    const real = realpathSync(abs);
    if (real !== projectReal && !real.startsWith(projectReal + sep)) return null;
  } catch (err) {
    if (err.code !== 'ENOENT') return null;
    // For not-yet-existing paths, realpath the deepest existing ancestor —
    // catches a parent component like `safe/../link → /etc`.
    let probe = dirname(abs);
    while (probe !== projectAbs && probe.startsWith(projectAbs + sep)) {
      try {
        const realProbe = realpathSync(probe);
        if (realProbe !== projectReal && !realProbe.startsWith(projectReal + sep)) return null;
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') return null;
        probe = dirname(probe);
      }
    }
  }
  return abs;
}

/**
 * Walk every component of a project-relative path; return true if any
 * component is HARD_HIDDEN. Use for read/write defence: leaf-only checks
 * miss e.g. `.integrations/credentials.json` (leaf is `credentials.json`,
 * but the whole folder is HARD_HIDDEN).
 */
export function pathContainsHardHidden(absPath) {
  const projectAbs = resolve(PROJECT_DIR);
  const rel = relative(projectAbs, absPath);
  if (!rel || rel.startsWith('..')) return false;
  for (const part of rel.split(sep)) {
    if (HARD_HIDDEN.has(part)) return true;
  }
  return false;
}

/**
 * Visibility predicate. HARD_HIDDEN entries are never visible regardless of
 * the includeHidden flag.
 */
export function isVisibleEntry(name, { includeHidden = false } = {}) {
  if (HARD_HIDDEN.has(name)) return false;
  if (includeHidden) return true;
  if (SOFT_HIDDEN.has(name)) return false;
  if (name.startsWith('.') && !VISIBLE_DOT.has(name)) return false;
  return true;
}

/** True if this entry is a "technical" file (soft-hidden or dot-prefixed). */
export function isTechnical(name) {
  if (SOFT_HIDDEN.has(name)) return true;
  if (name.startsWith('.') && !VISIBLE_DOT.has(name)) return true;
  return false;
}

/**
 * Map a file extension to a MIME type for /api/files/raw. Defaults to
 * application/octet-stream when unknown — the browser will refuse to render
 * that as an image, which is the safe behaviour.
 */
const MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.bmp':  'image/bmp',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.tsv':  'text/tab-separated-values; charset=utf-8',
};
export function mimeFor(filename) {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * List one directory's children, sorted folders-first then alphabetically.
 * Throws on filesystem errors; caller decides the HTTP mapping.
 */
export function listDir(absPath, { includeHidden = false } = {}) {
  const raw = readdirSync(absPath, { withFileTypes: true });
  const out = [];
  for (const e of raw) {
    if (!isVisibleEntry(e.name, { includeHidden })) continue;
    const isDir = e.isDirectory();
    const entry = { name: e.name, type: isDir ? 'dir' : 'file' };
    if (isTechnical(e.name)) entry.technical = true;
    if (!isDir) {
      try {
        const st = statSync(resolve(absPath, e.name));
        entry.size  = st.size;
        entry.mtime = st.mtimeMs;
      } catch {}
    }
    out.push(entry);
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Read a small text file. Refuses to read above READ_MAX_BYTES or files
 * that look binary (any null byte in the first 8 KiB).
 *
 * Returns { kind: 'ok', size, mtime, content } on success or
 * { kind: 'error', status, error } on rejection.
 */
export function readTextFile(absPath) {
  if (pathContainsHardHidden(absPath)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  let st;
  try { st = statSync(absPath); }
  catch (err) {
    return err.code === 'ENOENT'
      ? { kind: 'error', status: 404, error: 'not found' }
      : { kind: 'error', status: 500, error: err.message };
  }
  if (st.isDirectory()) return { kind: 'error', status: 400, error: 'is a directory' };
  if (st.size > READ_MAX_BYTES) {
    return { kind: 'error', status: 413, error: `file too large (${st.size} bytes, max ${READ_MAX_BYTES})` };
  }
  let buf;
  try { buf = readFileSync(absPath); }
  catch (err) { return { kind: 'error', status: 500, error: err.message }; }
  if (buf.slice(0, 8 * 1024).includes(0)) {
    return { kind: 'error', status: 415, error: 'binary file — use /api/files/raw' };
  }
  return { kind: 'ok', size: st.size, mtime: st.mtimeMs, content: buf.toString('utf8') };
}

/**
 * Stream a file as raw bytes for image / binary previews. The route handler
 * pipes the returned stream into `res` and applies the headers from this
 * helper.
 *
 * Returns { kind: 'ok', size, mime, stream } or { kind: 'error', status, error }.
 */
export function openRawFile(absPath) {
  if (pathContainsHardHidden(absPath)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  let st;
  try { st = statSync(absPath); }
  catch (err) {
    return err.code === 'ENOENT'
      ? { kind: 'error', status: 404, error: 'not found' }
      : { kind: 'error', status: 500, error: err.message };
  }
  if (st.isDirectory()) return { kind: 'error', status: 400, error: 'is a directory' };
  if (st.size > RAW_MAX_BYTES) {
    return { kind: 'error', status: 413, error: `file too large (${st.size} bytes, max ${RAW_MAX_BYTES})` };
  }
  return {
    kind:  'ok',
    size:  st.size,
    mtime: st.mtimeMs,
    mime:  mimeFor(absPath),
    stream: createReadStream(absPath),
  };
}

/** Convenience: for a request, compute the "display path" relative to project root. */
export function displayPath(absPath) {
  const projectAbs = resolve(PROJECT_DIR);
  return relative(projectAbs, absPath).replace(/\\/g, '/');
}

/**
 * Create a new directory under PROJECT_DIR. Recursive — parent path is
 * created too. Idempotent: succeeds if the directory already exists.
 *
 * Refuses HARD_HIDDEN leaf names (defence in depth).
 */
export function makeDir(absPath) {
  if (pathContainsHardHidden(absPath)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  try {
    mkdirSync(absPath, { recursive: true });
    return { kind: 'ok' };
  } catch (err) {
    if (err.code === 'EACCES') return { kind: 'error', status: 403, error: 'permission denied' };
    return { kind: 'error', status: 500, error: err.message };
  }
}

/**
 * Create a new (empty by default) file. Refuses to overwrite an existing
 * one — the editor uses /api/files/write for in-place updates.
 */
export function createFile(absPath, content = '') {
  if (typeof content !== 'string') {
    return { kind: 'error', status: 400, error: 'content must be a string' };
  }
  if (existsSync(absPath)) {
    return { kind: 'error', status: 409, error: 'file already exists' };
  }
  if (pathContainsHardHidden(absPath)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
    const st = statSync(absPath);
    return { kind: 'ok', size: st.size, mtime: st.mtimeMs };
  } catch (err) {
    if (err.code === 'EACCES') return { kind: 'error', status: 403, error: 'permission denied' };
    return { kind: 'error', status: 500, error: err.message };
  }
}

/**
 * Move (rename) a file or directory. Both source and target are resolved
 * against PROJECT_DIR by the caller (resolveSafePath). Refuses:
 *   - identical paths (no-op)
 *   - moving a folder into itself or its descendants (would create a loop)
 *   - target already existing (conflict — caller should suggest a rename)
 *   - HARD_HIDDEN at either side
 *
 * Parent of target is created if missing — this matches the UX where the
 * user drops onto a folder that may not have all intermediate dirs yet.
 */
export function movePath(absFrom, absTo) {
  if (absFrom === absTo) {
    return { kind: 'error', status: 400, error: 'source and target are the same' };
  }
  if (absTo.startsWith(absFrom + sep)) {
    return { kind: 'error', status: 400, error: 'cannot move folder into itself' };
  }
  if (pathContainsHardHidden(absFrom) || pathContainsHardHidden(absTo)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  if (!existsSync(absFrom)) {
    return { kind: 'error', status: 404, error: 'source not found' };
  }
  if (existsSync(absTo)) {
    return { kind: 'error', status: 409, error: 'target already exists' };
  }
  try {
    mkdirSync(dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
    return { kind: 'ok' };
  } catch (err) {
    if (err.code === 'EACCES') return { kind: 'error', status: 403, error: 'permission denied' };
    if (err.code === 'EXDEV')  return { kind: 'error', status: 500, error: 'cross-device move not supported' };
    return { kind: 'error', status: 500, error: err.message };
  }
}

/**
 * Delete a file or directory (recursive). The route handler must decide
 * whether to require a confirmation hop on the client; here we just nuke.
 *
 * Hard guards:
 *   - The PROJECT_DIR root itself is refused.
 *   - HARD_HIDDEN leaves are refused (credentials must not be deletable
 *     through the workspace API even though they're already invisible).
 */
export function deletePath(absPath) {
  const projectAbs = resolve(PROJECT_DIR);
  if (absPath === projectAbs) {
    return { kind: 'error', status: 400, error: 'cannot delete project root' };
  }
  if (pathContainsHardHidden(absPath)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  if (!existsSync(absPath)) {
    return { kind: 'error', status: 404, error: 'not found' };
  }
  try {
    rmSync(absPath, { recursive: true, force: false });
    return { kind: 'ok' };
  } catch (err) {
    if (err.code === 'EACCES') return { kind: 'error', status: 403, error: 'permission denied' };
    return { kind: 'error', status: 500, error: err.message };
  }
}

/**
 * Write text content to a file under PROJECT_DIR. Path safety must already
 * have been applied by the caller (resolveSafePath returned this absPath).
 *
 * Refuses if the resolved path's leaf is HARD_HIDDEN (defence in depth — the
 * caller's resolveSafePath only blocks escape from PROJECT_DIR, not writes
 * to e.g. PROJECT_DIR/.email/credentials).
 *
 * Caps content size at READ_MAX_BYTES so a malformed editor can't DoS the
 * disk.
 */
export function writeTextFile(absPath, content) {
  if (typeof content !== 'string') {
    return { kind: 'error', status: 400, error: 'content must be a string' };
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > READ_MAX_BYTES) {
    return { kind: 'error', status: 413, error: `content too large (${size} bytes, max ${READ_MAX_BYTES})` };
  }
  if (pathContainsHardHidden(absPath)) {
    return { kind: 'error', status: 403, error: 'forbidden path' };
  }
  try {
    // Refuse to clobber a directory.
    let st = null;
    try { st = statSync(absPath); } catch { /* fine: file may not exist yet */ }
    if (st && st.isDirectory()) {
      return { kind: 'error', status: 400, error: 'is a directory' };
    }
    writeFileSync(absPath, content, 'utf8');
    const after = statSync(absPath);
    return { kind: 'ok', size: after.size, mtime: after.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT')  return { kind: 'error', status: 404, error: 'parent directory does not exist' };
    if (err.code === 'EACCES')  return { kind: 'error', status: 403, error: 'permission denied' };
    return { kind: 'error', status: 500, error: err.message };
  }
}
