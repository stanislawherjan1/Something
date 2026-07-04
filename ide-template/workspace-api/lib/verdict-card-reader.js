/**
 * verdict-card-reader — read structured data out of `memory/threads/*.md`
 * verdict cards (P4 Track B follow-up).
 *
 * Pair with `lib/verdict-card-writer.js`: the writer produces the file,
 * this module reads it back into a typed object. The dedicated
 * `GET /api/memory/threads` endpoint uses `listVerdictCards()`; future
 * overseer code can use `readVerdictCard()` per-thread.
 *
 * Why not a full YAML parser:
 *   - The frontmatter shape is produced by the workspace's own writer; the field
 *     set + their value shapes are fixed (strings, numbers, flow-style
 *     arrays of slugs, ISO timestamps, dates).
 *   - Adding `js-yaml` to the workspace-api would mean another dependency
 *     to audit, version, and ship in the Docker image. Not worth it for
 *     ~9 known fields.
 *   - The trade-off: hand-edited frontmatter with exotic YAML (block
 *     scalars, anchors, weird quoting) won't parse. We document that the
 *     writer's output is the contract and fall back gracefully on parse
 *     failures (returns the file as { _unparseable: true, raw }) so the
 *     dashboard can still surface the file rather than 500.
 *
 * The frontmatter shape we expect (per verdict-card-writer.js):
 *   title:        string  (double-quoted YAML scalar with escape)
 *   date:         YYYY-MM-DD
 *   thread_id:    string (double-quoted scalar)
 *   status:       'done' | 'junked' | 'active' (bare keyword)
 *   source:       'reflect-summary' (bare keyword)
 *   confidence:   number 0..1 (two-decimal)
 *   written_at:   ISO timestamp
 *   entities:     ["slug-a", "slug-b"] (flow array; quoted scalars)
 *   supersedes:   string | null  (quoted scalar or bare `null`)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PROJECT_DIR } from './config.js';

const MAX_CARD_BYTES = 256 * 1024;

function threadsDir() {
  return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_reflect', 'threads');
}

/**
 * Parse a YAML frontmatter block (between the leading `---` lines) into
 * the structured-object shape the workspace emits. Returns `null` if the body
 * doesn't start with frontmatter.
 *
 * Unknown fields are preserved into `_extra` as raw string values for
 * future-compat (e.g. if Lane B adds `scope_snapshot:` to verdict cards
 * later, this module surfaces it without code changes — and the
 * dashboard can ignore it until ready).
 */
export function parseVerdictFrontmatter(body) {
  if (typeof body !== 'string' || !body.startsWith('---')) return null;
  const close = body.indexOf('\n---', 3);
  if (close === -1) return null;
  const fm = body.slice(3, close); // includes the first \n after opening `---`
  const out = {
    title: null,
    date: null,
    thread_id: null,
    status: null,
    source: null,
    confidence: null,
    written_at: null,
    entities: [],
    supersedes: null,
    _extra: {},
  };

  // Each frontmatter line we care about is `key: value` at column 0.
  // Block-style arrays (entities:\n  - a\n  - b) are accepted but flow-
  // style is the primary path because that's what the writer emits.
  const lines = fm.split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    i++;
    if (!raw.trim()) continue;
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];

    if (key === 'entities') {
      // Flow style first (writer's default)
      const flow = val.match(/^\[(.*)\]\s*$/);
      if (flow) {
        out.entities = splitYamlFlowList(flow[1]);
        continue;
      }
      // Block style fallback: the next lines starting with `  - …`
      const block = [];
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        const blkM = lines[i].match(/^\s+-\s+(.*)$/);
        if (blkM) block.push(unquoteYamlScalar(blkM[1]));
        i++;
      }
      out.entities = block.filter(Boolean);
      continue;
    }

    if (key === 'confidence') {
      const n = Number(val);
      out.confidence = Number.isFinite(n) ? n : null;
      continue;
    }

    if (key === 'supersedes') {
      out.supersedes = (val === 'null' || val === '') ? null : unquoteYamlScalar(val);
      continue;
    }

    if (key in out) {
      out[key] = unquoteYamlScalar(val);
    } else {
      out._extra[key] = unquoteYamlScalar(val);
    }
  }

  return out;
}

/**
 * Strip wrapping double-quotes and unescape backslash + quote. The
 * writer uses double-quoted YAML scalars exclusively; single-quoted
 * scalars are accepted defensively for hand-edited files.
 */
function unquoteYamlScalar(s) {
  const t = String(s).trim();
  if (t.length >= 2) {
    if (t.startsWith('"') && t.endsWith('"')) {
      return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      return t.slice(1, -1).replace(/''/g, "'");
    }
  }
  return t;
}

function splitYamlFlowList(inside) {
  // The writer always quotes its scalars, so a comma-split + unquote
  // is sufficient. Hand-edited files might use bare scalars with
  // commas inside — those would mis-split, but a verdict-card entity
  // is a slug (kebab-case ASCII, no commas) by SKILL contract.
  return inside
    .split(',')
    .map(s => unquoteYamlScalar(s))
    .filter(Boolean);
}

/**
 * Read + parse a single verdict-card file. Returns:
 *   { thread_id, title, date, status, source, confidence, written_at,
 *     entities, supersedes, path, bytes, mtime }
 * or `{ _unparseable: true, path, bytes, mtime, raw }` if the file
 * exists but the frontmatter can't be parsed.
 * Returns `null` for missing files.
 */
export function readVerdictCard(threadId) {
  if (typeof threadId !== 'string' || threadId.length === 0) return null;
  if (/[\\/]|\.\./.test(threadId)) return null;
  const abs = join(threadsDir(), `${threadId}.md`);
  if (!existsSync(abs)) return null;
  let body;
  let stat;
  try {
    stat = statSync(abs);
    if (stat.size > MAX_CARD_BYTES) {
      return { _unparseable: true, path: `memory/_reflect/threads/${threadId}.md`, bytes: stat.size, mtime: stat.mtime.toISOString(), reason: 'too-large' };
    }
    body = readFileSync(abs, 'utf8');
  } catch (err) {
    return null;
  }
  const fm = parseVerdictFrontmatter(body);
  if (!fm) {
    return { _unparseable: true, path: `memory/_reflect/threads/${threadId}.md`, bytes: stat.size, mtime: stat.mtime.toISOString(), reason: 'no-frontmatter' };
  }
  return {
    thread_id: fm.thread_id || threadId,
    title: fm.title,
    date: fm.date,
    status: fm.status,
    source: fm.source,
    confidence: fm.confidence,
    written_at: fm.written_at,
    entities: fm.entities,
    supersedes: fm.supersedes,
    path: `memory/_reflect/threads/${threadId}.md`,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

/**
 * List every verdict card under `memory/threads/`. Returns an array
 * sorted by `written_at` DESC (newest first). Cheap — sauna typically
 * has 0–N hundred threads; we re-scan on every call. If a card fails
 * to parse, it surfaces as `{ _unparseable: true, ... }` so the
 * dashboard can flag it instead of pretending it doesn't exist.
 *
 * @param {object} [opts]
 * @param {'done'|'junked'|'active'} [opts.status]  filter by status
 * @param {number} [opts.limit=200]                cap result size
 */
export function listVerdictCards({ status, limit = 200 } = {}) {
  const dir = threadsDir();
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    if (e.name.toLowerCase() === 'about.md') continue;
    const threadId = e.name.replace(/\.md$/i, '');
    const card = readVerdictCard(threadId);
    if (!card) continue;
    if (status && !card._unparseable && card.status !== status) continue;
    out.push(card);
  }
  out.sort((a, b) => {
    const aTs = a.written_at || a.mtime || '';
    const bTs = b.written_at || b.mtime || '';
    return bTs.localeCompare(aTs);
  });
  return out.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
}
