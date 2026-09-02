/**
 * memory-graph — walk `project/memory/` and return a `{nodes, edges}` graph
 * ready for the dashboard's React force-directed renderer (P3.03).
 *
 * Node kinds:
 *   - card    → one of the seven canonical cards (RULES, USER_*, AGENT_*)
 *   - index   → memory/INDEX.md (wiki root, slightly bigger)
 *   - topic   → memory/topics/<slug>.md
 *   - concept → memory/concepts/<slug>.md  (accreting entity pages — the
 *               durable, citable surface for a recurring entity)
 *
 * The graph shows what EXISTS. It used to also render "emerging" placeholder
 * nodes for slugs that were merely hot in the retired verdict pipeline; pages
 * are now created deliberately, in the conversation that earns them, so a node
 * always has a file behind it.
 *
 * Edges are computed by scanning each file's body for:
 *   - [[wiki-link]]  — produces a 'wiki' edge (strong stroke in the UI)
 *   - bare-name mention of another file's basename, length ≥ 4
 *     — produces a 'bare' edge (thin stroke; can be toggled off in the UI)
 *
 * Cost: we re-scan on every call. The bare-name pass is bounded to ~O(files) —
 * it runs only FROM the bounded card/topic/INDEX nodes, never from the unbounded
 * concept accretion surface (see the edge loop). If the wiki grows large
 * enough that even node enumeration shows up in profiles, cache by (file, mtime).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { USERS_DIR } from './scope-rule.js';
import { CANONICAL_CARD_IDS } from './memory-registry.js';

// Resolved lazily so env-var overrides + hermetic tests work without
// re-importing the module. Production picks up PROJECT_DIR once at boot
// and the values stay constant; the function calls are negligible.
function memoryDir()   { return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory'); }
function topicsDir()   { return join(memoryDir(), 'topics'); }
function conceptsDir() { return join(memoryDir(), 'concepts'); }

const CANONICAL_CARDS = CANONICAL_CARD_IDS;

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

/** Classify a memory file by its stem + whether it sits at a memory root. */
function fileKind(fileStem, atRoot) {
  if (atRoot && fileStem.toUpperCase() === 'INDEX') return 'index';
  if (CANONICAL_CARDS.has(fileStem.toUpperCase())) return 'card';
  return 'topic';
}

/**
 * Enumerate the .md files that make up ONE actor's view of memory. Returns:
 *   [{ id, baseStem, kind, name, absPath, relPath, scope }]
 *
 * `scope` is 'shared' (the flat memory/ tree — team-wide) or 'yours' (the
 * current actor's private memory/users/<slug>/ tree). Private node ids are
 * prefixed `yours:` so they can never collide with a shared node of the same
 * stem; `baseStem` keeps the bare stem for link/bare-name matching. When
 * actorSlug is null (solo / no team), only the shared tree is enumerated and
 * everything is 'shared'. Another teammate's private memory is NEVER included.
 */
function enumerateMemoryFiles(actorSlug) {
  const out = [];
  const seen = new Set();        // unique ids (dedupe)
  const memDir = memoryDir();
  if (!existsSync(memDir)) return out;

  const pushDir = (dir, { rootCards = false, kind = 'topic', relPrefix, scope, idPrefix = '' }) => {
    if (!existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      if (e.name.toLowerCase() === 'about.md') continue;   // meta-file, not a node
      const fileStem = e.name.replace(/\.md$/i, '');
      const base = stem(e.name);
      const id = idPrefix + base;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        baseStem: base,
        kind: rootCards ? fileKind(fileStem, true) : kind,
        name: e.name,
        absPath: join(dir, e.name),
        relPath: `${relPrefix}${e.name}`,
        scope,
      });
    }
  };

  // Shared (flat) tree — team-wide. Verdict cards (_reflect/) are deliberately
  // NOT enumerated: they are pipeline plumbing, not knowledge (reflect v2).
  pushDir(memDir,        { rootCards: true,  relPrefix: 'memory/',         scope: 'shared' });
  pushDir(topicsDir(),   { kind: 'topic',    relPrefix: 'memory/topics/',   scope: 'shared' });
  pushDir(conceptsDir(), { kind: 'concept',  relPrefix: 'memory/concepts/', scope: 'shared' });

  // The current actor's OWN private tree (team mode). Never another user's.
  if (actorSlug && /^[a-z0-9-]+$/.test(actorSlug)) {
    const ud = join(memDir, USERS_DIR, actorSlug);
    const pfx = `memory/users/${actorSlug}/`;
    pushDir(ud,                   { rootCards: true, relPrefix: pfx,               scope: 'yours', idPrefix: 'yours:' });
    pushDir(join(ud, 'topics'),   { kind: 'topic',   relPrefix: `${pfx}topics/`,   scope: 'yours', idPrefix: 'yours:' });
    pushDir(join(ud, 'concepts'), { kind: 'concept', relPrefix: `${pfx}concepts/`, scope: 'yours', idPrefix: 'yours:' });
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

export function buildMemoryGraph(actorSlug = null) {
  const files = enumerateMemoryFiles(actorSlug);
  if (files.length === 0) {
    return { nodes: [], edges: [], generated_at: new Date().toISOString() };
  }

  // Build a unique-id → file map for resolving link targets.
  const byId = new Map(files.map(f => [f.id, f]));

  // Resolve a bare target stem to a node id, honouring scope: a link FROM a
  // private ('yours') card prefers a private target of the same stem, then
  // falls back to the shared one; a shared card only links shared. This keeps a
  // teammate's private cluster self-contained while still letting it reference
  // shared topics.
  const resolveTarget = (srcScope, targetStem) => {
    if (srcScope === 'yours' && byId.has(`yours:${targetStem}`)) return `yours:${targetStem}`;
    if (byId.has(targetStem)) return targetStem;
    return null;
  };

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

    // [[wiki-link]] — strong edges. The payload can be a bare name
    // (`[[sam]]`), a path (`[[topics/sam]]`), or include `.md`.
    for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const t = resolveTarget(src.scope, stem(basename(m[1].trim())));
      if (t) addEdge(src.id, t, 'wiki');
    }

    // Bare-name mentions — thin edges. Skip if the target was already
    // referenced via a wiki-link (it's already in the graph as a strong
    // edge; piling on a bare-edge between the same pair would just thicken
    // the visual without adding information).
    //
    // This inner loop is O(files) per source. We do NOT run it FROM a thread or
    // concept node: those are the UNBOUNDED accretion surfaces (verdict cards +
    // concept pages grow without limit), so running the scan from them would make
    // the whole pass O(files²) as the wiki grows — and a bare-name edge out of a
    // verdict/claim list is low-signal noise anyway. Bounded sources (cards,
    // topics, INDEX) still emit bare edges, keeping the pass ~O(files).
    if (src.kind !== 'concept') {
      for (const tgt of files) {
        if (tgt.id === src.id) continue;
        if (tgt.baseStem.length < MIN_BARE_NAME_LEN) continue;
        const t = resolveTarget(src.scope, tgt.baseStem);
        if (!t || t === src.id) continue;
        // Honour the wiki-deduplication rule above.
        if (edgeMap.has(edgeKey(src.id, t, 'wiki'))) continue;
        if (lower.includes(tgt.baseStem)) {
          addEdge(src.id, t, 'bare');
        }
      }
    }
  }

  // Project node fields the UI cares about.
  const nodes = files.map(f => {
    const body = bodies.get(f.id) || '';
    return {
      id: f.id,
      kind: f.kind,
      scope: f.scope,           // 'shared' (team-wide) | 'yours' (this actor's private)
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
