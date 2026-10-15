/**
 * memory-file-links — the notes and write-ups a conversation produced.
 *
 * A conversation that leaves a fact behind often leaves files behind too: a
 * note, a draft, a report the bot wrote on the way. The nightly filing offers
 * the markdown files written while the conversation ran to the extraction,
 * which ties each note to the files it is about; the fact then points at
 * them, the Memory screen shows them, and the bot's memory excerpts name them
 * (with "gone" when a file has since been removed). A person's conversation
 * may link the workspace's files and their own; a group's only the workspace's.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as facts from './memory-facts.js';
import { factsByRecord } from './memory-task-links.js';

const projectDir = () => process.env.PROJECT_DIR || '/home/coder/project';
// Not a person's files: memory, the team's machinery, the bot's own folders.
const SKIP_DIRS = new Set(['memory', 'node_modules', '.git']);
const MAX_FILES = 12;
const MAX_DEPTH = 6;

function* walk(dir, depth, rel = '', owner = null) {
  if (depth > MAX_DEPTH) return;
  // users/<someone else>: not walked at all (their files are not this conversation's).
  if (/^users\/[^/]+$/.test(rel) && rel !== `users/${owner}`) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(p, depth + 1, r, owner);
    else if (e.isFile() && /\.md$/i.test(e.name)) yield { abs: p, rel: r };
  }
}

/** Whose a path is: the workspace's, or the person whose private folder holds it. */
export function ownerOfPath(rel) {
  const m = /^users\/([a-z0-9-]+)\//.exec(rel);
  return m ? m[1] : null;
}

/**
 * Markdown files written inside a conversation's time span — between its first
 * and its last message, half a minute of slack either side for clocks, and no
 * more: a file written for the NEXT conversation a few minutes later once came
 * out as this one's. The workspace's files, plus the person's own for a
 * person's conversation. Newest first, a dozen at most.
 */
export function filesWrittenDuring({ from, to, owner = null, group = false, slackMs = 30_000 } = {}) {
  const a = Date.parse(from) - slackMs, b = Date.parse(to || from) + slackMs;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  const out = [];
  for (const f of walk(projectDir(), 0, '', group ? null : owner)) {
    const who = ownerOfPath(f.rel);
    if (who && (group || who !== owner)) continue;
    let st; try { st = statSync(f.abs); } catch { continue; }
    // Modification time only: writing or editing a file sets it. Creation time
    // means different things per file system (Linux keeps it when mtime is set
    // back, macOS moves it), so it would make the window platform-dependent.
    const t = st.mtimeMs || 0;
    if (t < a || t > b) continue;
    out.push({ path: f.rel, at: new Date(t).toISOString() });
  }
  return out.sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, MAX_FILES);
}

/** The files a fact carries, with whether each still exists. */
export function filesOfFact(f) {
  return (Array.isArray(f?.files) ? f.files : []).map(p => ({ path: String(p), exists: existsSync(join(projectDir(), String(p))) }));
}

/** Under each excerpt, the files its facts point at. Mutates the hits: `h.files = [line, …]`. */
export function attachFiles(hits, scopes, idx = null) {
  if (!hits?.length) return hits;
  const allowed = new Set(scopes || []);
  const byRec = idx || factsByRecord([...new Set(hits.map(h => h?.scope).filter(s => allowed.has(s)))]);
  for (const h of hits) {
    if (!h?.id || !h.scope || !allowed.has(h.scope)) continue;
    const fs = byRec.get(h.scope)?.get(h.id) || [];
    const lines = [];
    for (const f of fs) for (const x of filesOfFact(f)) lines.push(x.exists ? x.path : `${x.path} (gone)`);
    if (lines.length) h.files = [...new Set(lines)];
  }
  return hits;
}

/** Record on a filed fact the files it is about. */
export async function linkFactToFiles(scope, factId, paths) {
  const list = [...new Set((paths || []).map(String).filter(Boolean))].slice(0, MAX_FILES);
  if (!list.length || !facts.get(scope, factId)) return false;
  await facts.amend(scope, factId, { files: list });
  return true;
}
