/**
 * Shared helpers for turning a file-path token into a clickable link.
 *
 * Used by the chat renderer and the markdown file viewer so a path the model
 * (or a user, inside a file) writes — `documents/brand/voice.md`,
 * `/home/coder/project/Tasks.md`, `memory/USER_PROFILE.md` — becomes a link
 * that opens that file in the workspace.
 */

const HOME_PREFIX = '/home/coder/project/';

// Extensions we confidently treat as files even without a path separator
// (so a bare `README.md` links, but `v2.0` or `e.g.` doesn't).
const KNOWN_EXT = /\.(md|markdown|mdx|txt|json|jsonl|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|sh|bash|zsh|csv|tsv|ya?ml|toml|ini|html?|css|scss|pdf|png|jpe?g|gif|webp|svg|env|lock|sql)$/i;

/** Normalise an absolute in-container path to a workspace-relative one. */
export function toRelPath(p) {
  let s = String(p || '').trim();
  if (s.startsWith(HOME_PREFIX)) s = s.slice(HOME_PREFIX.length);
  return s.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * True if a bare token looks like a workspace file/folder path worth linking:
 * no whitespace, valid path shape, and either it contains a `/` (a real path)
 * or ends in a known file extension. Trailing `/` marks a folder.
 */
export function looksLikePath(s) {
  const raw = String(s || '').trim();
  if (!raw || /\s/.test(raw)) return false;
  const t = toRelPath(raw);
  if (!t || !/^[\w.\-]+(?:\/[\w.\-]+)*\/?$/.test(t)) return false;
  return t.includes('/') || KNOWN_EXT.test(t);
}

/** Resolve a path token to a `{ path, type, name }` selection for navigation. */
export function pathToSelection(p) {
  const rel = toRelPath(p).replace(/\/+$/, '');
  const name = rel.split('/').filter(Boolean).pop() || rel;
  const isFolder = String(p).trim().endsWith('/') || !name.includes('.');
  return { path: rel, type: isFolder ? 'dir' : 'file', name };
}
