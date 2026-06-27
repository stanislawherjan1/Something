/**
 * memory-graph — walk `project/memory/` and return a `{nodes, edges}` graph
 * ready for the dashboard's React force-directed renderer (P3.03).
 *
 * Node kinds:
 *   - card    → one of the seven canonical cards (RULES, USER_*, AGENT_*)
 *   - index   → memory/INDEX.md (wiki root, slightly bigger)
 *   - topic   → memory/topics/<slug>.md
 *   - thread  → memory/threads/<id>.md  (verdict cards, P4 Track B)
 *   - concept → memory/concepts/<slug>.md  (accreting entity/concept pages —
 *               the durable, citable surface a recurring `entities:` slug earns
 *               once it crosses the squeeze-point heat threshold). A concept
 *               node may be SYNTHETIC (`synthetic:true`): a slug that recurs
 *               across ≥ CONCEPT_HEAT verdict threads but has no page on disk
 *               YET — rendered so its cross-thread edges resolve instead of
 *               dangling, and so the dashboard shows the cluster ripe for
 *               promotion. See lib/reflect-distill.js (concept proposals) and
 *               docs/memory-evolution-plan.md.
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
 * Cost: we re-scan on every call. The bare-name pass is bounded to ~O(files) —
 * it runs only FROM the bounded card/topic/INDEX nodes, never from the unbounded
 * thread/concept accretion surfaces (see the edge loop). If the wiki grows large
 * enough that even node enumeration shows up in profiles, cache by (file, mtime).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { USERS_DIR } from './scope-rule.js';

// Resolved lazily so env-var overrides + hermetic tests work without
// re-importing the module. Production picks up PROJECT_DIR once at boot
// and the values stay constant; the function calls are negligible.
function memoryDir()   { return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory'); }
function topicsDir()   { return join(memoryDir(), 'topics'); }
function threadsDir()  { return join(memoryDir(), 'threads'); }
function conceptsDir() { return join(memoryDir(), 'concepts'); }

// Squeeze-point threshold: a slug must recur across at least this many DISTINCT
// verdict threads before it earns a concept page (and before a synthetic
// placeholder node is rendered for it). Mirrors REFLECT_CONCEPT_HEAT in
// lib/reflect-distill.js — keep the two in sync.
const CONCEPT_HEAT = (() => {
  const v = Number(process.env.REFLECT_CONCEPT_HEAT);
  return Number.isFinite(v) && v >= 1 ? v : 3;
})();

const CANONICAL_CARDS = new Set([
  'RULES',
  'USER_PROFILE', 'USER_PREFERENCES', 'USER_RELATIONSHIPS', 'USER_REFLECTIONS',
  'AGENT_IDENTITY', 'AGENT_TOOLS',
  'TEAM',   // shared team-directory card (team mode)
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

  // Shared (flat) tree — team-wide.
  pushDir(memDir,        { rootCards: true,  relPrefix: 'memory/',         scope: 'shared' });
  pushDir(topicsDir(),   { kind: 'topic',    relPrefix: 'memory/topics/',   scope: 'shared' });
  pushDir(threadsDir(),  { kind: 'thread',   relPrefix: 'memory/threads/',  scope: 'shared' });
  pushDir(conceptsDir(), { kind: 'concept',  relPrefix: 'memory/concepts/', scope: 'shared' });

  // The current actor's OWN private tree (team mode). Never another user's.
  if (actorSlug && /^[a-z0-9-]+$/.test(actorSlug)) {
    const ud = join(memDir, USERS_DIR, actorSlug);
    const pfx = `memory/users/${actorSlug}/`;
    pushDir(ud,                   { rootCards: true, relPrefix: pfx,               scope: 'yours', idPrefix: 'yours:' });
    pushDir(join(ud, 'topics'),   { kind: 'topic',   relPrefix: `${pfx}topics/`,   scope: 'yours', idPrefix: 'yours:' });
    pushDir(join(ud, 'threads'),  { kind: 'thread',  relPrefix: `${pfx}threads/`,  scope: 'yours', idPrefix: 'yours:' });
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
 * Count how many DISTINCT verdict threads name each entity slug — the "heat"
 * (in-degree) signal that drives concept emergence. A slug that recurs across
 * ≥ CONCEPT_HEAT threads has crossed a computable squeeze-point and earns a
 * first-class concept page (proposed by reflect-distill, operator-approved).
 *
 * Pure read over the verdict-card trees. `owner` selects which tree:
 *   - owner = null (default)  → the SHARED threads (memory/threads/). This is the
 *     team-wide heat used by the v1 distiller, which only proposes SHARED concept
 *     pages (a shared verdict's entities are already team-visible — promoting one
 *     to a shared page leaks nothing new).
 *   - owner = '<slug>'        → that teammate's PRIVATE threads
 *     (memory/users/<slug>/threads/). For forward-compat (per-owner private
 *     concepts); not yet emitted by the distiller.
 *
 * Returns a plain object { <slug>: <distinct-thread-count> }. Counting is
 * distinct-per-thread (a slug named twice in one verdict counts once).
 */
export function computeConceptHeat(owner = null) {
  const counts = Object.create(null);
  let dir;
  if (owner === null) {
    dir = threadsDir();
  } else if (typeof owner === 'string' && /^[a-z0-9-]+$/.test(owner)) {
    dir = join(memoryDir(), USERS_DIR, owner, 'threads');
  } else {
    return counts;   // malformed owner → empty, never a path escape
  }
  let files;
  try { files = readdirSync(dir).filter(f => /\.md$/i.test(f)); } catch { return counts; }
  for (const f of files) {
    const body = readBody(join(dir, f));
    if (!body) continue;
    for (const ent of new Set(parseEntitiesFromFrontmatter(body))) {
      counts[ent] = (counts[ent] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Build the memory graph. Pure read; no writes. Returns:
 *   {
 *     nodes: [{ id, kind, name, relPath, preview, size? }],
 *     edges: [{ source, target, kind: 'wiki' | 'bare', weight }],
 *     generated_at: ISO,
 *   }
 */
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

  // Phase-0 graph honesty: a verdict's `entities:` edge can only land on a node
  // that EXISTS — otherwise addEdge drops it and the cross-thread link dangles
  // against nothing. For a slug that has recurred across ≥ CONCEPT_HEAT distinct
  // verdict threads but has no concept page on disk yet, synthesise a placeholder
  // concept node so (a) those edges resolve, and (b) the dashboard surfaces the
  // cluster ripe for promotion. reflect-distill later promotes the slug to a real
  // page (operator-approved); until then the node carries `synthetic:true`.
  const synthHeat = new Map();   // candidate placeholder id → distinct-thread count
  for (const f of files) {
    if (f.kind !== 'thread') continue;
    const seen = new Set();
    for (const ent of parseEntitiesFromFrontmatter(bodies.get(f.id) || '')) {
      // Clean slug + a noise floor (mirrors MIN_BARE_NAME_LEN / reflect-distill's
      // isConceptSlug): ≥ 2 chars, not purely numeric — so 'q3' is fine but a
      // stray 'a' / '42' is never promoted to a first-class concept node.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(ent) || ent.length < 2 || /^\d+$/.test(ent)) continue;
      if (resolveTarget(f.scope, ent)) continue;          // already a real node
      const id = f.scope === 'yours' ? `yours:${ent}` : ent;
      if (byId.has(id) || seen.has(id)) continue;         // distinct per thread
      seen.add(id);
      synthHeat.set(id, (synthHeat.get(id) || 0) + 1);
    }
  }
  const synthNodes = [];
  for (const [id, count] of synthHeat) {
    if (count < CONCEPT_HEAT) continue;
    const baseStem = id.replace(/^yours:/, '');
    const node = {
      id, baseStem, kind: 'concept',
      scope: id.startsWith('yours:') ? 'yours' : 'shared',
      name: `${baseStem}.md`, absPath: null, relPath: null,
      synthetic: true, heat: count,
    };
    byId.set(id, node);
    synthNodes.push(node);
  }

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
        const t = resolveTarget(src.scope, ent);
        if (t) addEdge(src.id, t, 'wiki');
      }
    }

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
    if (src.kind !== 'thread' && src.kind !== 'concept') {
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

  // Synthetic placeholder concepts (heat ≥ CONCEPT_HEAT, no page yet).
  for (const s of synthNodes) {
    nodes.push({
      id: s.id,
      kind: 'concept',
      scope: s.scope,
      name: s.name,
      relPath: null,
      preview: `Emerging concept — named in ${s.heat} verdict threads, no page yet.`,
      purpose: '',
      synthetic: true,
      heat: s.heat,
    });
  }

  return {
    nodes,
    edges: Array.from(edgeMap.values()),
    generated_at: new Date().toISOString(),
  };
}
