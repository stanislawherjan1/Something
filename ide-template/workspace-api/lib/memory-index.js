/**
 * memory-index — regenerate the INDEX.md map of a memory scope.
 *
 * An INDEX is the auto-maintained MAP of everything in ITS scope: the shared
 * tree → memory/INDEX.md (every shared card + topic + concept); each person's
 * private tree → memory/users/<slug>/INDEX.md. It is load-bearing three ways:
 *
 *   1. Prefix — the shared INDEX and the per-user one are the map the model
 *      navigates from. Concept/topic pages are deliberately NOT preloaded and
 *      memory_grep skips other people's trees, so without the map a page is
 *      undiscoverable.
 *   2. Graph — the index node's [[wiki-links]] are the strong edges that make
 *      each scope's index the visible hub.
 *   3. Freshness — each entry carries the page's date, and a page nobody has
 *      confirmed in STALE_DAYS is marked, so the model prefers asking over
 *      asserting from an old page.
 *
 * The file is fully machine-generated: written wholesale, never hand-edited
 * (an edit is overwritten on the next memory write).
 *
 * Ported from the retired reflect-apply.py (`rebuild_scope_index`) so INDEX
 * generation lives with the one writer instead of in a Python script the write
 * path had to shell out to.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { USERS_DIR } from './scope-rule.js';
import { CARD_DESCRIPTIONS, CARDS } from './memory-registry.js';
import { atomicWrite } from './atomic-write.js';

const SLUG_RE = /^[a-z0-9-]+$/;
/** A page whose newest dated claim is older than this is flagged unreviewed. */
const STALE_DAYS = Number(process.env.MEMORY_STALE_DAYS) || 90;

function memoryDir() { return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory'); }

/** Cards whose content is dated fact rather than standing rule/identity. */
const STALEABLE = new Set(CARDS.filter(c => c.stale === 'claims').map(c => c.id));

function mdFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort();
  } catch { return []; }
}

function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: '', body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fm: '', body: raw };
  return { fm: raw.slice(3, end), body: raw.slice(end + 4) };
}

function frontmatterField(fm, field) {
  const m = fm.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].trim() : '';
}

/** First sentence, whitespace-collapsed, capped — a one-line blurb. */
function clipBlurb(s) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=[.!?])\s+/)[0] || '';
  return first.trim().replace(/\.$/, '').slice(0, 110);
}

function cleanLine(s) {
  return String(s || '')
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/\s*\[(?:Source|src)\s*:.*?\]\s*$/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .trim();
}

/** The `## Claims` bullets of a page, in append order (oldest first). */
export function claimLines(body) {
  const parts = String(body || '').split(/\n##\s+/);
  const sec = parts.find(p => /^Claims\b/i.test(p.trimStart()));
  if (!sec) return [];
  return sec.split('\n').slice(1)
    .map(l => l.trim())
    .filter(l => l.startsWith('-'));
}

/** Every date cited by a `[Source: … YYYY-MM-DD]` tag in the page. */
function citedDates(body) {
  return [...String(body || '').matchAll(/\[(?:Source|src)\s*:[^\]]*?(\d{4}-\d{2}-\d{2})[^\]]*\]/gi)]
    .map(m => m[1]);
}

/**
 * Best freshness stamp for an entry: the newest date a claim cites, else the
 * file's mtime. Concept pages carry only `created:` in frontmatter, so without
 * this nothing on the recall surface says how old a page's content is.
 */
function pageDate(absPath, body) {
  const dates = citedDates(body);
  if (dates.length) return dates.sort().at(-1);
  try { return new Date(statSync(absPath).mtimeMs).toISOString().slice(0, 10); }
  catch { return ''; }
}

/**
 * One-line description for an index entry. Order: canonical card → a
 * non-boilerplate `purpose:`/`summary:` → the first real prose line (skipping
 * the Claims buffer, whose FIRST line is the OLDEST claim) → the newest claim →
 * the H1 → `title:`.
 */
function describe(absPath, stemUpper) {
  if (CARD_DESCRIPTIONS[stemUpper]) return CARD_DESCRIPTIONS[stemUpper];
  let raw;
  try { raw = readFileSync(absPath, 'utf8'); } catch { return ''; }
  const { fm, body } = splitFrontmatter(raw);
  const purpose = frontmatterField(fm, 'purpose') || frontmatterField(fm, 'summary');
  if (purpose && !/^accreting claims about/i.test(purpose)) return clipBlurb(purpose);

  let heading = '';
  let inClaims = false;
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      if (!heading && s.startsWith('# ')) heading = s.slice(2).trim();
      inClaims = /^##\s+Claims\b/i.test(s);
      continue;
    }
    if (inClaims) continue;
    if (s.startsWith('<!--') || /^accreting claims about/i.test(s)) continue;
    const cleaned = cleanLine(s);
    if (cleaned.length >= 8) return clipBlurb(cleaned);
  }
  const claims = claimLines(body);
  if (claims.length) return clipBlurb(cleanLine(claims.at(-1)));   // newest, not oldest
  return clipBlurb(heading || frontmatterField(fm, 'title'));
}

function isStale(stamp) {
  if (!stamp) return false;
  const ms = Date.parse(`${stamp}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) > STALE_DAYS * 86400 * 1000;
}

/**
 * Regenerate one scope's INDEX.md as the full map of `scopeRoot`: every root
 * card, every topics/<x>.md and concepts/<x>.md, one `[[stem]] — blurb · date`
 * line each, grouped under Cards / Topics / Concepts. Written wholesale.
 * Writes nothing when the scope is empty, so we never litter empty indexes.
 * Best-effort: never throws into the caller.
 */
export function rebuildScopeIndex(scopeRoot, indexPath, { title, intro }) {
  try {
    const cards = [];
    const topics = [];
    const concepts = [];

    const entry = (abs, stem) => {
      const stemUpper = stem.toUpperCase();
      const blurb = describe(abs, stemUpper);
      let stamp = '';
      try { stamp = pageDate(abs, readFileSync(abs, 'utf8')); } catch { /* keep empty */ }
      // Age travels on the line the model reads when deciding what to open.
      // Without it, two pages about one entity — one current, one months stale —
      // are indistinguishable at the moment of choosing.
      const flag = (!CARD_DESCRIPTIONS[stemUpper] || STALEABLE.has(stemUpper)) && isStale(stamp)
        ? ' ⚠ unreviewed'
        : '';
      return `- [[${stem}]]${blurb ? ` — ${blurb}` : ''}${stamp ? ` · ${stamp}` : ''}${flag}`;
    };

    for (const name of mdFiles(scopeRoot)) {
      if (['index.md', 'about.md'].includes(name.toLowerCase())) continue;
      const stem = name.slice(0, -3);
      (CARD_DESCRIPTIONS[stem.toUpperCase()] ? cards : topics).push(entry(join(scopeRoot, name), stem));
    }
    for (const name of mdFiles(join(scopeRoot, 'topics'))) {
      if (name.toLowerCase() === 'about.md') continue;
      topics.push(entry(join(scopeRoot, 'topics', name), name.slice(0, -3)));
    }
    for (const name of mdFiles(join(scopeRoot, 'concepts'))) {
      if (name.toLowerCase() === 'about.md') continue;
      concepts.push(entry(join(scopeRoot, 'concepts', name), name.slice(0, -3)));
    }

    if (!cards.length && !topics.length && !concepts.length) return false;

    const parts = [`# ${title}\n\n${intro}\n`];
    for (const [label, items] of [['Cards', cards], ['Topics', topics], ['Concepts', concepts]]) {
      if (items.length) parts.push(`\n## ${label}\n${[...new Set(items)].sort().join('\n')}\n`);
    }
    mkdirSync(indexPath.slice(0, indexPath.lastIndexOf('/')), { recursive: true });
    atomicWrite(indexPath, parts.join(''));
    return true;
  } catch { return false; }
}

export function rebuildSharedIndex() {
  const dir = memoryDir();
  return rebuildScopeIndex(dir, join(dir, 'INDEX.md'), {
    title: 'Memory index',
    intro: 'Map of SHARED (team-wide) memory — cards, topics, concepts. The wiki '
         + 'entry point; `Read` a target when a turn needs its depth.',
  });
}

export function rebuildPrivateIndex(owner) {
  if (!SLUG_RE.test(String(owner || ''))) return false;
  const dir = join(memoryDir(), USERS_DIR, owner);
  return rebuildScopeIndex(dir, join(dir, 'INDEX.md'), {
    title: `${owner}'s private memory`,
    intro: `Map of ${owner}'s PRIVATE memory — cards, topics, concepts. \`Read\` a `
         + 'target for its depth; these are not all in the prefix and memory_grep '
         + 'only reaches your own tree.',
  });
}

/**
 * Rebuild the INDEX for the scope a just-written page belongs to (shared, or
 * that owner's private tree). Called by the engine after every write, so the
 * map always reflects reality.
 */
export function reindexScopeOf(absPath) {
  try {
    const root = memoryDir();
    if (!absPath.startsWith(root)) return false;
    const rel = absPath.slice(root.length + 1);
    const parts = rel.split('/');
    if (parts[0] === USERS_DIR && SLUG_RE.test(parts[1] || '')) return rebuildPrivateIndex(parts[1]);
    return rebuildSharedIndex();
  } catch { return false; }
}

/** Rebuild every index: the shared tree plus each user's private tree. */
export function rebuildAllIndexes() {
  let n = rebuildSharedIndex() ? 1 : 0;
  const usersDir = join(memoryDir(), USERS_DIR);
  if (existsSync(usersDir)) {
    for (const e of readdirSync(usersDir, { withFileTypes: true })) {
      if (e.isDirectory() && SLUG_RE.test(e.name) && rebuildPrivateIndex(e.name)) n++;
    }
  }
  return n;
}
