/**
 * atomic-write — shared helper for the tmp-then-rename file replace
 * pattern repeated ~12 times across lib/. POSIX `rename(2)` is atomic
 * on the same filesystem, so a concurrent reader sees either the
 * pre- or post-write content but never a half-written file (and a
 * crash mid-write leaves only the orphan `.tmp.<pid>` to GC, not a
 * truncated target).
 *
 *   atomicWrite(path, content, options?)
 *
 * options:
 *   - mode:      file mode for the new tmp file (default 0o644)
 *   - ensureDir: mkdir the parent recursively first (default true).
 *                Set false when the caller has already prepared the
 *                directory (avoids redundant stats on the hot path).
 *
 * Throws on write or rename failure — callers handle.
 */

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function atomicWrite(path, content, options = {}) {
  const { mode = 0o644, ensureDir = true } = options;
  if (ensureDir) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}
