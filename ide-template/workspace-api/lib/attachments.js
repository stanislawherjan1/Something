/**
 * Chat attachments — files uploaded with a chat turn.
 *
 * Saved under PROJECT_DIR/.attachments/<thread>/<ts>-<sanitised-name> so
 * Claude Code can `Read` them with the path we embed in the prompt. The
 * directory is hidden from the file tree by default (see lib/config.js
 * SOFT_HIDDEN) — users see attachments inline with the chat bubble, not
 * as a sidebar folder.
 *
 * Filenames are sanitised aggressively (path traversal + weird chars stripped).
 * No MIME validation — Claude handles whatever we hand it; users sending
 * .pdf / .png / .docx / .txt / source code are all valid use cases.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';

export const ATTACHMENTS_DIR = '.attachments';

// Per-file and per-turn caps. nginx already enforces client_max_body_size 50m
// at the proxy level; this is a defence-in-depth check.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;     // 25 MB / file
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;    // 50 MB / turn
export const MAX_FILES = 10;

function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();   // strip any path
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  return cleaned || 'file';
}

function safeThread(threadId) {
  return String(threadId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

/**
 * Save uploaded files (multer in-memory `{ originalname, buffer, size }`).
 * Returns metadata for each saved file:
 *   [{ name: 'foo.pdf', path: '.attachments/abc/1714.../foo.pdf', size }]
 *
 * Throws if a file exceeds MAX_FILE_BYTES, the batch exceeds MAX_TOTAL_BYTES,
 * or there are more than MAX_FILES. Caller should respond 413 / 400.
 */
export function saveAttachments(threadId, files) {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files (${files.length}): max ${MAX_FILES} per message.`);
  }

  let total = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      throw new Error(`File "${f.originalname}" exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`);
    }
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`Total upload (${Math.round(total / 1024 / 1024)} MB) exceeds the ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB limit.`);
  }

  const ts = Date.now();
  const threadDir = join(PROJECT_DIR, ATTACHMENTS_DIR, safeThread(threadId), String(ts));
  mkdirSync(threadDir, { recursive: true });

  const out = [];
  for (const f of files) {
    const name = safeName(f.originalname);
    const abs = join(threadDir, name);
    writeFileSync(abs, f.buffer);
    out.push({
      name,
      path: `${ATTACHMENTS_DIR}/${safeThread(threadId)}/${ts}/${name}`,
      size: f.size,
    });
  }
  return out;
}
