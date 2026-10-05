/**
 * routines-store — the bot's standing duties toward one person, as data.
 *
 * Until memory v4 these lived as bullet lines in a memory card
 * (memory/users/<slug>/RESPONSIBILITIES.md, flat in solo), read by the Routines
 * view and the morning planner, written by the model through memory_write. A card
 * is prose with a grammar only the model and one frontend parser agreed on: a
 * stray `section` split it into shapes nothing downstream could read, and edits
 * landed on the wrong copy. Routines are working data with a fixed shape (what,
 * for whom, since when, active or retired), so they get a typed file instead:
 *
 *   PROJECT_DIR/.team/users/<slug>/routines.json      (solo: slug 'default')
 *
 * `.team/` is per-user app data, private by path like the chat history next to it.
 * The card stays untouched while legacy memory runs; migration 0004 seeds this
 * file from it.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite } from './atomic-write.js';

const SLUG_RE = /^[a-z0-9-]+$/;

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }

export function routinesPath(slug) {
  const s = slug || 'default';
  if (!SLUG_RE.test(s)) throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  return join(projectDir(), '.team', 'users', s, 'routines.json');
}

/** The legacy card this person's routines come from (team: per user; solo: flat). */
export function legacyCardPath(slug, { team }) {
  return team && slug && slug !== 'default'
    ? join(projectDir(), 'memory', 'users', slug, 'RESPONSIBILITIES.md')
    : join(projectDir(), 'memory', 'RESPONSIBILITIES.md');
}

// ─── the legacy card grammar (ported from ResponsibilitiesDashboard.parseRole) ──

function cardBody(md) {
  if (!md) return '';
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

// A duty is `- {icon} **Title** — description #tags`; also accepted without the
// list marker and with the icon's braces dropped (the model writes both).
// A struck-through (retired) duty wraps the whole entry in ~~…~~, icon included —
// the frontend parser missed that form and showed it as unreadable.
const DUTY_LINE = /^\s*(?:[-*]\s+)?((?:~~)?(?:\{[a-z0-9-]+\}|[a-z0-9-]+)?\s*\*\*.+)$/i;
const DUTY_SECTIONS = ['responsibilities', 'duties', 'recurring duties', 'proactive watch'];

/**
 * Parse a RESPONSIBILITIES card into `{ routines, unparsed }`. Lines inside the
 * duty sections that do not match the grammar are returned, never dropped — an
 * empty list with lines sitting in the file is the failure that cost a user three
 * rounds of "it's broken".
 */
export function parseLegacyCard(md) {
  const sections = {};
  let cur = null;
  for (const line of cardBody(md).split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].trim().toLowerCase(); sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  const routines = [];
  const unparsed = [];
  // Outside the duty sections — under a stray heading, or before any — a line in
  // the duty grammar is still a duty, and any other list item is kept as
  // unparsed. Plain prose there (the card's intro) is not a duty and is left out.
  const outside = [];
  cur = null;
  for (const line of cardBody(md).split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].trim().toLowerCase(); continue; }
    if (cur === null || !DUTY_SECTIONS.includes(cur)) {
      const t = line.trim();
      if (t && !/^#/.test(t) && (DUTY_LINE.test(t) && /\*\*/.test(t) || /^[-*]\s+\S/.test(t))) outside.push(t);
    }
  }
  const lines = [...DUTY_SECTIONS.flatMap(name => sections[name] || []), ...outside];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(DUTY_LINE);
    if (!m) { unparsed.push(line); continue; }
    let clean = m[1].trim();
    const retired = /^~~[\s\S]*~~$/.test(clean);
    clean = clean.replace(/^~~|~~$/g, '').trim();
    let icon = null;
    const im = clean.match(/^\{([a-z0-9-]+)\}\s*/i) || clean.match(/^([a-z0-9-]+)\s+(?=\*\*)/i);
    if (im) { icon = im[1].toLowerCase(); clean = clean.slice(im[0].length); }
    const bold = clean.match(/^\*\*(.+?)\*\*\s*([\s\S]*)$/);
    const title = (bold ? bold[1] : clean).trim();
    let description = bold ? bold[2].replace(/^[—–:-]\s*/, '').trim() : '';
    const tags = [];
    description = description
      .replace(/#([\w-]+)/g, (_m, t) => { tags.push(t.toLowerCase()); return ''; })
      .replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
    routines.push({ title, description, icon, tags, retired });
  }
  return { routines, unparsed };
}

// ─── the store ───────────────────────────────────────────────────────────────

function newId() { return `r_${randomBytes(6).toString('hex')}`; }

function normalizeRoutine(r, now) {
  const title = String(r.title || '').trim().slice(0, 200);
  if (!title) throw new Error('a routine needs a title');
  return {
    id: typeof r.id === 'string' && /^r_[0-9a-f]{12}$/.test(r.id) ? r.id : newId(),
    title,
    description: String(r.description || '').trim().slice(0, 2000),
    // The one-line version people read (Marketplace routines have one); the
    // description stays the full instruction the bot works from.
    ...(r.summary ? { summary: String(r.summary).trim().slice(0, 300) } : {}),
    icon: r.icon && /^[a-z0-9-]{1,32}$/.test(r.icon) ? r.icon : null,
    tags: Array.isArray(r.tags) ? [...new Set(r.tags.map(t => String(t).toLowerCase()).filter(t => /^[\w-]{1,40}$/.test(t)))] : [],
    retired: !!r.retired,
    source: ['card', 'ui', 'bot', 'catalog'].includes(r.source) ? r.source : 'bot',
    // Which marketplace entry it came from (drives "Added" in the Marketplace).
    ...(typeof r.catalogId === 'string' && /^[a-z0-9-]{2,60}$/.test(r.catalogId) ? { catalogId: r.catalogId } : {}),
    createdAt: r.createdAt || now,
    updatedAt: now,
  };
}

/** `{ version, routines, unparsed }` — an empty store when the file is absent. */
export function readRoutines(slug) {
  const p = routinesPath(slug);
  if (!existsSync(p)) return { version: 1, routines: [], unparsed: [] };
  const data = JSON.parse(readFileSync(p, 'utf8'));
  return { version: 1, routines: Array.isArray(data.routines) ? data.routines : [], unparsed: Array.isArray(data.unparsed) ? data.unparsed : [] };
}

export function writeRoutines(slug, { routines, unparsed = [] }) {
  const now = new Date().toISOString();
  const p = routinesPath(slug);
  mkdirSync(dirname(p), { recursive: true });
  const data = { version: 1, routines: routines.map(r => normalizeRoutine(r, now)), unparsed: unparsed.map(String) };
  atomicWrite(p, JSON.stringify(data, null, 2) + '\n');
  return data;
}

/**
 * Move one person's routines into another owner's list — the routines half of
 * switching team mode. Team mode keeps the admin's routines under their slug;
 * solo mode reads 'default'. Without the move, flipping the switch left the
 * Routines screen saying "Nothing yet" while the six routines sat in the other
 * file. Merged, never overwritten: a routine already in the target (same title,
 * case-insensitive) stays as it is; unparsed lines are united. The source file
 * goes once its contents are in the target. Returns how many routines moved.
 */
export function moveRoutines(fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return 0;
  const src = routinesPath(fromSlug);
  if (!existsSync(src)) return 0;
  const from = readRoutines(fromSlug);
  const to = readRoutines(toSlug);
  const key = (r) => String(r.title || '').trim().toLowerCase();
  const have = new Set(to.routines.map(key));
  const add = from.routines.filter((r) => !have.has(key(r)));
  const unparsed = [...to.unparsed, ...from.unparsed.filter((l) => !to.unparsed.includes(l))];
  writeRoutines(toSlug, { routines: [...to.routines, ...add], unparsed });
  try { unlinkSync(src); } catch { /* the target already holds everything */ }
  return add.length;
}
