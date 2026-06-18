/**
 * memory-graph — walk `project/memory/` and return a `{nodes, edges}` graph
 * ready for the dashboard's React force-directed renderer (P3.03).
 *
 * Node kinds:
 *   - card   → one of the seven canonical cards (RULES, USER_*, AGENT_*)
 *   - index  → memory/INDEX.md (wiki root, slightly bigger)
 *   - topic  → memory/topics/<slug>.md
 *   - thread → memory/threads/<id>.md  (verdict cards, P4 Track B)
 *
 * Edges are computed by scanning each file's body for:
 *   - [[wiki-link]]  — produces a 'wiki' edge (strong stroke in the UI)
 *   - bare-name mention of another file's basename, length ≥ 4
 *     — produces a 'bare' edge (thin stroke; can be toggled off in the UI)
 *
 * Verdict cards additionally turn their frontmatter `entities:` field into
 * 'wiki' edges from the thread → each entity. This is the cross-thread
 * memory layer the overseer (P0.7) reads — "thread A touched these
 * entities, so when entity X resurfaces in thread B, the overseer can
 * pull the verdict instead of re-reading the whole transcript."
 *
 * Cheap: memory/ is ≤ ~30 files in practice. We re-scan on every call;
 * if it ever shows up in profiles we can cache by (file, mtime).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PROJECT_DIR } from './config.js';

// Resolved lazily so env-var overrides + hermetic tests work without
// re-importing the module. Production picks up PROJECT_DIR once at boot
// and the values stay constant; the function calls are negligible.
function memoryDir()  { return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory'); }
function topicsDir()  { return join(memoryDir(), 'topics'); }
function threadsDir() { return join(memoryDir(), 'threads'); }

const CANONICAL_CARDS = new Set([
  'RULES',
  'USER_PROFILE', 'USER_PREFERENCES', 'USER_RELATIONSHIPS', 'USER_REFLECTIONS',
  'AGENT_IDENTITY', 'AGENT_TOOLS',
]);

const MAX_FILE_BYTES = 1 * 1024 * 1024;  // 1 MB per file when scanning
const MIN_BARE_NAME_LEN = 4;             // skip 'cv', 'q3', 'me' — too noisy

/** Read a file body, defensively capped. Returns '' on missing/unreadable. */
function readBody(absPath) {
  try {
    const st = statSync(absPath);
    if (st.size > MAX_FILE_BYTES) return '';
    return readFileSync(absPath, 'utf8');
  } catch { return ''; }
}

/** Strip YAML frontmatter so the preview doesn't show the metadata block. */
function stripFrontmatter(body) {
  if (!body.startsWith('---')) return body;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return body;
  return body.slice(end + 4).trimStart();
}

/** First N visible chars (post-frontmatter) for a hover tooltip. */
function preview(body, n = 200) {
  const stripped = stripFrontmatter(body);
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > n ? collapsed.slice(0, n) + '…' : collapsed;
}

/** Lower-cased basename without `.md`. */
function stem(name) {
  return name.toLowerCase().replace(/\.md$/i, '');
}

/**
 * Enumerate all .md files under memory/. Returns:
 *   [{ id, kind, name, absPath, relPath }]
 * where id = stem(name). Cards and INDEX live at memory/ root; topics live
 * one level deeper under topics/.
 */
function enumerateMemoryFiles() {
  const memDir = memoryDir();
  const topDir = topicsDir();
  const thrDir = threadsDir();
  const out = [];
  if (!existsSync(memDir)) return out;

  // memory/ root — cards + INDEX
  let rootEntries;
  try { rootEntries = readdirSync(memDir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of rootEntries) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const fileStem = e.name.replace(/\.md$/i, '');
    let kind = 'topic';                   // fall-through (shouldn't happen at root)
    if (fileStem === 'INDEX') kind = 'index';
    else if (CANONICAL_CARDS.has(fileStem.toUpperCase())) kind = 'card';
    out.push({
      id: stem(e.name),
      kind,
      name: e.name,
      absPath: join(memDir, e.name),
      relPath: `memory/${e.name}`,
    });
  }

  // memory/topics/<slug>.md
  if (existsSync(topDir)) {
    let topicEntries;
    try { topicEntries = readdirSync(topDir, { withFileTypes: true }); }
    catch { topicEntries = []; }
    for (const e of topicEntries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      // Skip ABOUT.md — it's a meta-file, not a topic node.
      if (e.name.toLowerCase() === 'about.md') continue;
      out.push({
        id: stem(e.name),
        kind: 'topic',
        name: e.name,
        absPath: join(topDir, e.name),
        relPath: `memory/topics/${e.name}`,
      });
    }
  }

  // memory/threads/<thread-id>.md — verdict cards (P4 Track B).
  // Same enumeration shape as topics: any .md except ABOUT.md.
  if (existsSync(thrDir)) {
    let threadEntries;
    try { threadEntries = readdirSync(thrDir, { withFileTypes: true }); }
    catch { threadEntries = []; }
    for (const e of threadEntries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      if (e.name.toLowerCase() === 'about.md') continue;
      out.push({
        id: stem(e.name),
        kind: 'thread',
        name: e.name,
        absPath: join(thrDir, e.name),
        relPath: `memory/threads/${e.name}`,
      });
    }
  }

  return out;
}

/**
 * Pull the `purpose:` (or fallback `description:`) line out of a card's YAML
 * frontmatter. Returns a single-line string (newlines collapsed) or '' when
 * the field isn't present. This is the curator-authored one-line description
 * of what the card holds — much better than auto-stripped body preview as a
 * UI label. Used by the dashboard's hover preview + modal description line.
 */
function parsePurposeFromFrontmatter(body) {
  if (!body.startsWith('---')) return '';
  const fmEnd = body.indexOf('\n---', 3);
  if (fmEnd === -1) return '';
  const fm = body.slice(3, fmEnd);
  // Match `purpose:` first, then `description:` as fallback. Captures the
  // value through end of line or block-style continuation (lines beginning
  // with whitespace). Stops at the next top-level key or frontmatter end.
  for (const key of ['purpose', 'description']) {
    const re = new RegExp(`^${key}:\\s*(.+?)(?:\\n(?!\\s)|$)`, 'ms');
    const m = fm.match(re);
    if (m && m[1]) {
      return m[1].replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/**
 * Parse the `entities:` array out of a verdict-card frontmatter. Defensive
 * — accepts both flow style (`entities: [a, b, c]`) and block style
 * (`entities:\n  - a\n  - b`). Returns lowercased slugs only.
 *
 * Pure string parse; no YAML library needed for this single field. If we
 * grow to parsing more frontmatter shapes here, swap to a real parser.
 */
function parseEntitiesFromFrontmatter(body) {
  if (!body.startsWith('---')) return [];
  const fmEnd = body.indexOf('\n---', 3);
  if (fmEnd === -1) return [];
  const fm = body.slice(3, fmEnd);

  // Flow style: entities: [a, "b-c", d]
  const flow = fm.match(/^entities:\s*\[(.*)\]\s*$/m);
  if (flow) {
    return flow[1]
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  // Block style: entities:\n  - a\n  - b
  const block = fm.match(/^entities:\s*\n((?:\s+-\s+.*\n?)+)/m);
  if (block) {
    return block[1]
      .split('\n')
      .map(line => line.match(/^\s+-\s+["']?(.*?)["']?\s*$/))
      .filter(Boolean)
      .map(m => m[1].trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/**
 * Build the memory graph. Pure read; no writes. Returns:
 *   {
 *     nodes: [{ id, kind, name, relPath, preview, size? }],
 *     edges: [{ source, target, kind: 'wiki' | 'bare', weight }],
 *     generated_at: ISO,
 *   }
 */
export function buildMemoryGraph() {
  const files = enumerateMemoryFiles();
  if (files.length === 0) {
    return { nodes: [], edges: [], generated_at: new Date().toISOString() };
  }

  // Build a basename → file map for resolving link targets.
  const byId = new Map(files.map(f => [f.id, f]));

  // Read all bodies once.
  const bodies = new Map(); // id → body
  for (const f of files) bodies.set(f.id, readBody(f.absPath));

  // For wiki-link matching: extract `[[target]]` payloads per source file.
  // For bare-name matching: scan the lower-cased body for each known file's
  // basename (length ≥ 4) — same algorithm as document-index.js.
  const edgeKey = (s, t, k) => `${s}\t${t}\t${k}`;
  const edgeMap = new Map(); // edgeKey → { source, target, kind, weight }

  const addEdge = (sourceId, targetId, kind) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (!byId.has(targetId)) return;
    const key = edgeKey(sourceId, targetId, kind);
    const existing = edgeMap.get(key);
    if (existing) { existing.weight += 1; return; }
    edgeMap.set(key, { source: sourceId, target: targetId, kind, weight: 1 });
  };

  for (const src of files) {
    const body = bodies.get(src.id) || '';
    if (!body) continue;
    const lower = body.toLowerCase();

    // Verdict cards: frontmatter `entities:` → strong wiki edges. The
    // entities are wiki-link targets by construction (the SKILL teaches
    // kebab-case ASCII slugs) so addEdge resolves them via byId.
    if (src.kind === 'thread') {
      for (const ent of parseEntitiesFromFrontmatter(body)) {
        addEdge(src.id, ent, 'wiki');
      }
    }

    // [[wiki-link]] — strong edges. The payload can be a bare name
    // (`[[sam]]`), a path (`[[topics/sam]]`), or include `.md`.
    for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const targetId = stem(basename(m[1].trim()));
      addEdge(src.id, targetId, 'wiki');
    }

    // Bare-name mentions — thin edges. Skip if the target was already
    // referenced via a wiki-link (it's already in the graph as a strong
    // edge; piling on a bare-edge between the same pair would just thicken
    // the visual without adding information).
    for (const tgt of files) {
      if (tgt.id === src.id) continue;
      if (tgt.id.length < MIN_BARE_NAME_LEN) continue;
      // Honour the wiki-deduplication rule above.
      if (edgeMap.has(edgeKey(src.id, tgt.id, 'wiki'))) continue;
      if (lower.includes(tgt.id)) {
        addEdge(src.id, tgt.id, 'bare');
      }
    }
  }

  // Project node fields the UI cares about.
  const nodes = files.map(f => {
    const body = bodies.get(f.id) || '';
    return {
      id: f.id,
      kind: f.kind,
      name: f.name,
      relPath: f.relPath,
      preview: preview(body),
      purpose: parsePurposeFromFrontmatter(body),
    };
  });

  return {
    nodes,
    edges: Array.from(edgeMap.values()),
    generated_at: new Date().toISOString(),
  };
}
