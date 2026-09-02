/**
 * memory-engine — the ONE write path into `<PROJECT_DIR>/memory/`.
 *
 * Before this module there were two, with different guarantees: the live model
 * wrote markdown directly with no guards at all, and a background pipeline wrote
 * through guards but could only ever APPEND. Neither could correct a fact. The
 * result was the failure this engine exists to end — a correction landed as a
 * second, contradictory bullet beside the falsehood it was meant to replace (or
 * was silently dropped as a "duplicate"), and the wrong version outlived the
 * right one because it sat in the always-loaded cards.
 *
 * The doctrine is now: **a correction REPLACES the claim it corrects.** A
 * falsehood is retired outright, an obsolete fact is superseded in place, and
 * the previous version survives only in this engine's log + undo snapshot —
 * never as `[was: …]`, a strikethrough, or a `## Retired` graveyard on the page.
 *
 * Every mutation, whoever initiates it, goes through `applyEvent()`:
 *
 *      validate → resolve target → guard (secrets, scope, confinement)
 *        → undo pre-image → atomic write → append event to the log
 *        → rebuild that scope's INDEX
 *
 * Ops are expressed as LINE-LEVEL changes (`removed[]` / `added[]`), which is
 * what makes `revert()` correct: restoring a pre-image alone would eat every
 * claim written afterwards, so a revert restores the snapshot and then replays
 * the file's later events.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { USERS_DIR, pathInScope } from './scope-rule.js';
import { CARDS, card as cardDef } from './memory-registry.js';
import { atomicWrite } from './atomic-write.js';
import { reindexScopeOf, rebuildAllIndexes, claimLines } from './memory-index.js';

const SLUG_RE = /^[a-z0-9-]+$/;
const MAX_TEXT = 2000;

function projectRoot() { return resolve(process.env.PROJECT_DIR || PROJECT_DIR); }
function relOf(abs) { return resolve(abs).slice(projectRoot().length + 1); }
function memoryDir() { return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory'); }
function engineDir() { return join(memoryDir(), '_engine'); }
function logPath()   { return join(engineDir(), 'log.jsonl'); }
function undoDir()   { return join(engineDir(), 'undo'); }

// ─── Guard: credentials never reach memory ───────────────────────────────────
// Markdown is plaintext at rest, so a credential must not persist even to a
// private card. The routing prompt is told to discard them; this makes it true
// in CODE regardless of what any writer emits.
const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,                                   // AWS access key id
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,                            // Anthropic key / OAuth token
  /\bsk-[A-Za-z0-9]{20,}\b/,                                // OpenAI-style key
  /\bghp_[A-Za-z0-9]{30,}\b/,                               // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                       // Slack token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                     // PEM private key
  /\bAIza[0-9A-Za-z_-]{30,}\b/,                             // Google API key
  /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,  // JWT
];
export function looksLikeSecret(text) { return SECRET_PATTERNS.some(re => re.test(String(text || ''))); }

// ─── Claim identity ──────────────────────────────────────────────────────────
// A claim is identified by the HASH OF ITS NORMALISED TEXT — no ids are stored
// in the markdown, so pages stay plain files a human can edit, and an edited
// line simply becomes a new claim. Citation tails and list markers are stripped
// so `- X [Source: …]` and `X` are the same claim.
const STOP = new Set(['the', 'and', 'with', 'for', 'that', 'this', 'user', 'via', 'per', 'jest', 'oraz', 'dla']);

export function normalizeClaim(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\[(?:source|src)\s*:[^\]]*\]/g, ' ')
    .replace(/~~/g, ' ')
    .replace(/^[\s\-*+]+/, '')
    .replace(/[^0-9a-ząćęłńóśźż ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function claimId(s) {
  return createHash('sha256').update(normalizeClaim(s)).digest('hex').slice(0, 12);
}

function contentWords(s) {
  return new Set(normalizeClaim(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)));
}

/**
 * Do two lines state the same thing? True when EITHER line's distinctive words
 * are ≥70% contained in the other.
 *
 * The old pipeline used a two-directional test as a DEDUP FILTER, and that is
 * exactly why corrections died: "Renews monthly now, not annually" shares all
 * three distinctive words of "Renews its contract annually in Q3", but adds
 * three of its own, so the symmetric score fell under the bar and the
 * correction was written as a SECOND, contradictory line. Here the same signal
 * does the opposite job — it RECOGNISES that the two lines are about the same
 * fact, so the new one replaces the old instead of joining it.
 *
 * Rival claims that merely share a topic stay distinct: "Standard rate is 400
 * per day" and "Rush rate is 600 per day" overlap on half their words in both
 * directions, which is below the bar either way.
 */
export function sameClaim(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size < 2 || B.size < 2) return normalizeClaim(a) === normalizeClaim(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (shared / A.size) >= 0.7 || (shared / B.size) >= 0.7;
}

/**
 * Does `candidate` answer the search `query`? Containment in ONE direction: the
 * query names a fact, and any line that carries the query's distinctive words is
 * a candidate for it. Deliberately higher recall than sameClaim — a correction
 * usually names the old fact loosely ("that thing about Viktor being the lead"),
 * and missing the old copy is what leaves a falsehood alive.
 */
function matchesQuery(candidate, query) {
  const Q = contentWords(query);
  const C = contentWords(candidate);
  if (Q.size === 0 || C.size === 0) return false;
  if (Q.size < 2) return normalizeClaim(candidate).includes(normalizeClaim(query));
  let shared = 0;
  for (const w of Q) if (C.has(w)) shared++;
  return (shared / Q.size) >= 0.7;
}

// ─── Target resolution ───────────────────────────────────────────────────────

/** A line that carries a claim (a bullet, or a `Field: value` row). */
function isClaimLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('---')) return false;
  return /^[-*+]\s+\S/.test(t) || /^[A-Za-zĄĆĘŁŃÓŚŹŻ][^:]{0,40}:\s+\S/.test(t);
}

/**
 * Resolve a write target to an absolute path inside memory/.
 *   { card: 'USER_PROFILE' }  → a registry card (shared or the owner's private)
 *   { page: 'acme' }          → concepts/acme.md, or topics/acme.md when the
 *                               entity has already graduated to long-form (a
 *                               graduated page must keep taking new claims,
 *                               otherwise a second page appears beside it and
 *                               nothing can ever supersede what it says).
 * Returns { abs, rel } or { error }.
 */
export function resolveTarget({ card, page, scope, owner }) {
  const base = memoryDir();
  const isPrivate = scope === 'private';
  if (isPrivate && !SLUG_RE.test(String(owner || ''))) {
    // Never silently fall back to the SHARED tree: that would publish a fact the
    // caller explicitly marked private.
    return { error: `private write needs a valid owner slug (got ${JSON.stringify(owner)})` };
  }
  const root = isPrivate ? join(base, USERS_DIR, owner) : base;

  let abs;
  if (card) {
    const def = cardDef(card);
    if (!def) return { error: `unknown card "${card}" (not in the memory registry)` };
    if (def.machine) return { error: `${card} is auto-maintained and must not be written by hand` };
    if (def.tier === 'user' && !isPrivate) return { error: `${card} is a private card — write it with scope:"private"` };
    if (def.tier === 'shared' && isPrivate) return { error: `${card} is a shared card — write it with scope:"shared"` };
    abs = join(root, def.file);
  } else if (page) {
    const slug = String(page).toLowerCase().trim();
    if (!SLUG_RE.test(slug) || slug.length < 2) return { error: `invalid page slug ${JSON.stringify(page)}` };
    abs = join(root, 'concepts', `${slug}.md`);
    if (!existsSync(abs) && existsSync(join(root, 'topics', `${slug}.md`))) {
      abs = join(root, 'topics', `${slug}.md`);
    }
  } else {
    return { error: 'need either a card or a page' };
  }

  // Belt-and-braces confinement: the resolved path must stay under memory/.
  const memRoot = resolve(base);
  const abs2 = resolve(abs);
  if (abs2 !== memRoot && !abs2.startsWith(memRoot + sep)) return { error: 'resolved path escapes memory/' };
  return { abs: abs2, rel: relOf(abs2) };
}

/** Seed body for a brand-new concept page. */
function seedPage(slug) {
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const today = new Date().toISOString().slice(0, 10);
  return `---
title: ${title}
kind: concept
created: ${today}
purpose: Accreting claims about ${title}. One atomic, cited claim per line. A correction REPLACES the claim it corrects — the previous wording lives in the engine log, never on this page.
---

Accreting claims about **${title}**. Each line is one atomic, cited assertion.

## Claims
`;
}

// ─── Readable surface (for resolving a correction) ───────────────────────────

/**
 * Files whose claims `actor` may read and therefore correct: the shared tree
 * plus their OWN private tree. Never another person's. Machine-written files
 * (INDEX, the RECENT_* tails, CHANNELS, TEAM) are excluded — they are generated
 * output, not claims, and rewriting them would just be undone.
 */
export function readableClaimFiles(actor) {
  const base = memoryDir();
  const machine = new Set(CARDS.filter(c => c.machine).map(c => c.file));
  const out = [];
  const addDir = (dir, { cardsOnly = false } = {}) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (machine.has(e.name) || e.name.toLowerCase() === 'about.md') continue;
      if (cardsOnly && e.name.toLowerCase() === 'index.md') continue;
      out.push(join(dir, e.name));
    }
  };
  addDir(base, { cardsOnly: true });
  addDir(join(base, 'concepts'));
  addDir(join(base, 'topics'));
  if (actor && actor !== 'default' && SLUG_RE.test(actor)) {
    const mine = join(base, USERS_DIR, actor);
    addDir(mine, { cardsOnly: true });
    addDir(join(mine, 'concepts'));
    addDir(join(mine, 'topics'));
  }
  return out;
}

/**
 * Every line in the actor's readable surface that states the same thing as
 * `match`. This is what makes a correction TRANSITIVE: the same falsehood is
 * usually written in more than one place (a card bullet, a concept claim), and
 * fixing one copy while the others survive is how a corrected fact comes back.
 */
export function findClaims(match, { actor } = {}) {
  const needle = String(match || '').trim();
  if (!needle) return [];
  const hits = [];
  for (const abs of readableClaimFiles(actor)) {
    let body;
    try { body = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!isClaimLine(lines[i])) continue;
      const line = lines[i];
      const exact = normalizeClaim(line) === normalizeClaim(needle);
      const substr = normalizeClaim(needle).length >= 8
        && normalizeClaim(line).includes(normalizeClaim(needle));
      if (exact || substr || matchesQuery(line, needle)) {
        hits.push({ file: relOf(abs), abs, line: i + 1, text: line.trim(), id: claimId(line) });
      }
    }
  }
  return hits;
}

function groupByFile(hits) {
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.abs)) byFile.set(h.abs, []);
    byFile.get(h.abs).push(h);
  }
  return byFile;
}

/** True when every hit states the same thing — i.e. they are copies, not rivals. */
function oneCluster(hits) {
  return hits.every(h => sameClaim(h.text, hits[0].text));
}

// ─── Line-level primitives (also the replay vocabulary for revert) ───────────

function removeLines(text, targets) {
  const drop = new Set(targets.map(t => normalizeClaim(t)));
  return text.split('\n').filter(l => !(isClaimLine(l) && drop.has(normalizeClaim(l)))).join('\n');
}

/**
 * Insert `line` at the end of `## section` (case-insensitively matched — a
 * case-drifted section name used to create a SECOND `## identity` heading), or
 * append a new section when it does not exist yet.
 */
function addLine(text, section, line) {
  const body = text.replace(/\s+$/, '');
  if (!section) return `${body}\n${line}\n`;
  const lines = body.split('\n');
  const wanted = section.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m && m[1].trim().toLowerCase() === wanted) { start = i; break; }
  }
  if (start === -1) return `${body}\n\n## ${section}\n${line}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  let insert = end;
  while (insert > start + 1 && !lines[insert - 1].trim()) insert--;   // before trailing blanks
  lines.splice(insert, 0, line);
  return lines.join('\n');
}

/** Apply one logged event's line changes to a file's text. Used by revert replay. */
function applyChanges(text, { removed = [], added = [] }) {
  let out = removed.length ? removeLines(text, removed) : text;
  for (const a of added) out = addLine(out, a.section, a.line);
  return out;
}

// ─── The write pipeline ──────────────────────────────────────────────────────

function newId() { return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 10); }

function writeUndo(absTarget, beforeText) {
  if (!beforeText) return null;
  try {
    mkdirSync(undoDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const safe = absTarget.split('/').pop().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
    const abs = join(undoDir(), `${stamp}-${newId()}-${safe}`);
    atomicWrite(abs, beforeText);
    return relOf(abs);
  } catch { return null; }
}

function logEvent(entry) {
  try {
    mkdirSync(engineDir(), { recursive: true });
    appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  } catch { /* logging must never fail a write */ }
  return entry;
}

/** Read the whole event log, oldest first. */
export function readLog({ limit = 200, since = null } = {}) {
  let raw;
  try { raw = readFileSync(logPath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (since && Date.parse(e.ts) < since) continue;
      out.push(e);
    } catch { /* skip a torn line */ }
  }
  return limit ? out.slice(-limit) : out;
}

/**
 * Write one file and record it. `changes` is the line-level description of what
 * happened, which is what lets revert replay later events over a restored
 * snapshot instead of silently discarding them.
 */
function applyEvent({ abs, rel, before, after, op, actor, scope, owner, section, source, changes, groupId }) {
  const undo = writeUndo(abs, before);
  atomicWrite(abs, after);   // creates the parent dir + tmp-then-rename
  const event = logEvent({
    id: newId(),
    group: groupId || null,
    ts: new Date().toISOString(),
    op,
    actor: actor || null,
    target: rel,
    scope: scope || 'shared',
    owner: owner || null,
    section: section || null,
    source: source || null,
    removed: changes.removed || [],
    added: changes.added || [],
    before_sha256: createHash('sha256').update(before || '').digest('hex'),
    undo,
  });
  reindexScopeOf(abs);
  return event;
}

/** Shared validation for anything that puts text into memory. */
function guardText(text) {
  const t = String(text || '').trim();
  if (!t) return { error: 'empty text' };
  if (t.length > MAX_TEXT) return { error: `text too long (${t.length} > ${MAX_TEXT})` };
  if (looksLikeSecret(t)) {
    return { error: 'refused: this looks like a credential, and credentials are never written to memory' };
  }
  return { text: t };
}

/** Scope check — the same rule that guards reads, applied to writes. */
function guardScope(rel, actor) {
  const relFromProject = rel.replace(/\\/g, '/');
  if (pathInScope(relFromProject, { isAdmin: false, ownSlug: actor && actor !== 'default' ? actor : null })) return null;
  return `refused: ${relFromProject} is not this actor's to write`;
}

function asBullet(text) {
  const t = String(text).trim();
  return /^[-*+]\s/.test(t) ? t : `- ${t}`;
}

// ─── Ops ─────────────────────────────────────────────────────────────────────

/**
 * Record a NEW fact. Refuses when the same thing is already stated differently:
 * that is a correction, not an addition, and appending it would leave both the
 * old and the new version on the page — the exact failure this engine exists to
 * stop. The caller is told to use `supersede` instead.
 */
export function remember({ actor, scope = 'shared', owner, card, page, section, text, source }) {
  const t = guardText(text);
  if (t.error) return { ok: false, error: t.error };
  const line = card ? asBullet(t.text) : `${asBullet(t.text)}${/\[Source:/i.test(t.text) ? '' : `  [Source: ${source || 'conversation'}, ${new Date().toISOString().slice(0, 10)}]`}`;

  const target = resolveTarget({ card, page, scope, owner });
  if (target.error) return { ok: false, error: target.error };
  const scopeErr = guardScope(target.rel, actor);
  if (scopeErr) return { ok: false, error: scopeErr };

  let before = '';
  if (existsSync(target.abs)) {
    before = readFileSync(target.abs, 'utf8');
  } else if (page) {
    before = seedPage(target.abs.split('/').pop().replace(/\.md$/, ''));
  } else if (scope === 'private') {
    // A teammate's private card is created on first use — only the shared cards
    // are seeded from templates at container start.
    before = `---\ncard: ${card}\nowner: ${owner}\n---\n\n# ${card}\n`;
  } else {
    return { ok: false, error: `card file ${target.rel} does not exist` };
  }

  // Already stated, verbatim → nothing to do.
  const existing = before.split('\n').filter(isClaimLine);
  if (existing.some(l => normalizeClaim(l) === normalizeClaim(line))) {
    return { ok: true, noop: true, target: target.rel, claim_id: claimId(line), note: 'already recorded' };
  }
  // Stated differently → this is a correction. Do not append a rival line.
  const rival = existing.find(l => sameClaim(l, line));
  if (rival) {
    return {
      ok: false,
      needs_supersede: true,
      target: target.rel,
      existing: rival.trim(),
      error: 'memory already states this differently — call supersede with the existing wording as `match`, so the old claim is replaced instead of duplicated',
    };
  }

  const sec = section || (page ? 'Claims' : '');
  const after = addLine(before, sec, line);
  const event = applyEvent({
    abs: target.abs, rel: target.rel, before, after,
    op: 'remember', actor, scope, owner, section: sec, source,
    changes: { removed: [], added: [{ section: sec, line }] },
  });
  return { ok: true, target: target.rel, claim_id: claimId(line), event_id: event.id, wrote: line };
}

/**
 * Replace a claim wherever the actor can see it. Replacing EVERY copy is the
 * point: the same fact is usually written in more than one place, and a
 * correction that fixes one copy is how a "corrected" fact comes back weeks
 * later from the copy nobody touched.
 *
 * When the matches do not agree with each other, nothing is written and they are
 * returned — replacing the wrong claim is worse than replacing none.
 */
export function supersede({ actor, match, text, source }) {
  const t = guardText(text);
  if (t.error) return { ok: false, error: t.error };
  const hits = findClaims(match, { actor });
  if (!hits.length) {
    return { ok: false, not_found: true, error: 'no matching claim found — if this is a new fact, call remember' };
  }
  if (!oneCluster(hits)) {
    return {
      ok: false,
      ambiguous: hits.map(h => ({ file: h.file, line: h.line, text: h.text })),
      error: 'several different claims match — nothing was changed; re-run with wording that identifies one of them',
    };
  }

  const groupId = newId();
  const events = [];
  const byFile = groupByFile(hits);

  for (const [abs, fileHits] of byFile) {
    const before = readFileSync(abs, 'utf8');
    const rel = fileHits[0].file;
    const scopeErr = guardScope(rel, actor);
    if (scopeErr) return { ok: false, error: scopeErr };
    // Keep the replacement where the old claim lived: same section, same page.
    const section = sectionOf(before, fileHits[0].line);
    const isPage = /\/(concepts|topics)\//.test(rel);
    const line = isPage && !/\[Source:/i.test(t.text)
      ? `${asBullet(t.text)}  [Source: ${source || 'correction'}, ${new Date().toISOString().slice(0, 10)}]`
      : asBullet(t.text);
    const removed = fileHits.map(h => h.text);
    const after = applyChanges(before, { removed, added: [{ section, line }] });
    events.push(applyEvent({
      abs, rel, before, after, op: 'supersede', actor, section, source, groupId,
      scope: rel.includes(`memory/${USERS_DIR}/`) ? 'private' : 'shared',
      changes: { removed, added: [{ section, line }] },
    }));
  }
  return {
    ok: true,
    replaced: hits.map(h => ({ file: h.file, was: h.text })),
    targets: [...new Set(hits.map(h => h.file))],
    event_group: groupId,
    event_ids: events.map(e => e.id),
  };
}

/** The `## Section` a 1-based line number sits under, or '' at file top. */
function sectionOf(text, lineNo) {
  const lines = text.split('\n');
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Delete a claim outright — for a fact that was never true, or that the user
 * has retracted. Nothing is left on the page: no strikethrough, no `[was: …]`.
 * The old text stays in the log and in the undo snapshot, which is where a
 * record of a mistake belongs — not in the prompt every future turn reads.
 */
export function retire({ actor, match, reason }) {
  const hits = findClaims(match, { actor });
  if (!hits.length) return { ok: false, not_found: true, error: 'no matching claim found' };
  if (!oneCluster(hits)) {
    return {
      ok: false,
      ambiguous: hits.map(h => ({ file: h.file, line: h.line, text: h.text })),
      error: 'several different claims match — nothing was removed',
    };
  }
  const groupId = newId();
  const byFile = groupByFile(hits);
  const events = [];
  for (const [abs, fileHits] of byFile) {
    const before = readFileSync(abs, 'utf8');
    const rel = fileHits[0].file;
    const scopeErr = guardScope(rel, actor);
    if (scopeErr) return { ok: false, error: scopeErr };
    const removed = fileHits.map(h => h.text);
    const after = removeLines(before, removed);
    events.push(applyEvent({
      abs, rel, before, after, op: 'retire', actor, source: reason, groupId,
      scope: rel.includes(`memory/${USERS_DIR}/`) ? 'private' : 'shared',
      changes: { removed, added: [] },
    }));
  }
  return { ok: true, removed: hits.map(h => ({ file: h.file, was: h.text })), event_group: groupId, event_ids: events.map(e => e.id) };
}

/**
 * Retire a whole page (a concept/topic that should not exist — a duplicate, or
 * one created under a wrong name). The file is deleted; its last content is kept
 * as the undo snapshot, so this is reversible.
 */
export function retirePage({ actor, page, scope = 'shared', owner, reason }) {
  const target = resolveTarget({ page, scope, owner });
  if (target.error) return { ok: false, error: target.error };
  if (!existsSync(target.abs)) return { ok: false, error: `no such page: ${target.rel}` };
  const scopeErr = guardScope(target.rel, actor);
  if (scopeErr) return { ok: false, error: scopeErr };
  const before = readFileSync(target.abs, 'utf8');
  const undo = writeUndo(target.abs, before);
  unlinkSync(target.abs);
  const event = logEvent({
    id: newId(), ts: new Date().toISOString(), op: 'retire_page', actor,
    target: target.rel, scope, owner: owner || null, source: reason || null,
    removed: [], added: [], before_sha256: createHash('sha256').update(before).digest('hex'), undo,
  });
  reindexScopeOf(target.abs);
  return { ok: true, target: target.rel, event_id: event.id };
}

/**
 * Rename an entity's page and every reference to it.
 *
 * This is the other half of a correction. A page's FILENAME is a claim too: the
 * verdict/summary passes feed existing slugs back to the model as the canonical
 * name for a referent, so a page created under a wrong name keeps teaching that
 * name back to the system long after the text inside it was fixed.
 */
export function renameEntity({ actor, from, to, scope = 'shared', owner }) {
  const src = resolveTarget({ page: from, scope, owner });
  if (src.error) return { ok: false, error: src.error };
  const dst = resolveTarget({ page: to, scope, owner });
  if (dst.error) return { ok: false, error: dst.error };
  if (!existsSync(src.abs)) return { ok: false, error: `no such page: ${src.rel}` };
  for (const rel of [src.rel, dst.rel]) {
    const scopeErr = guardScope(rel, actor);
    if (scopeErr) return { ok: false, error: scopeErr };
  }

  const fromSlug = String(from).toLowerCase().trim();
  const toSlug = String(to).toLowerCase().trim();
  const body = readFileSync(src.abs, 'utf8');
  const merged = existsSync(dst.abs);
  const groupId = newId();

  // Merge into an existing page rather than clobbering it.
  const beforeDst = merged ? readFileSync(dst.abs, 'utf8') : '';
  const after = merged
    ? claimLines(body).reduce((acc, l) => (claimLines(acc).some(x => sameClaim(x, l)) ? acc : addLine(acc, 'Claims', l)), beforeDst)
    : body.replace(/^title:\s*.+$/m, `title: ${toSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`);

  applyEvent({
    abs: dst.abs, rel: dst.rel, before: beforeDst, after, op: 'rename_entity',
    actor, scope, owner, source: `renamed from ${fromSlug}`, groupId,
    changes: { removed: [], added: merged ? claimLines(body).map(l => ({ section: 'Claims', line: l })) : [] },
  });

  const undo = writeUndo(src.abs, body);
  unlinkSync(src.abs);
  logEvent({
    id: newId(), group: groupId, ts: new Date().toISOString(), op: 'retire_page', actor,
    target: src.rel, scope, owner: owner || null, source: `renamed to ${toSlug}`,
    removed: [], added: [], before_sha256: createHash('sha256').update(body).digest('hex'), undo,
  });

  // Repoint [[wiki-links]] across the actor's readable surface, so the old name
  // stops being reachable — and stops being re-learned as canonical.
  const linkRe = new RegExp(`\\[\\[${fromSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`, 'gi');
  const relinked = [];
  for (const abs of readableClaimFiles(actor)) {
    if (abs === src.abs || abs === dst.abs) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (!linkRe.test(text)) continue;
    linkRe.lastIndex = 0;
    const rel = relOf(abs);
    if (guardScope(rel, actor)) continue;
    applyEvent({
      abs, rel, before: text, after: text.replace(linkRe, `[[${toSlug}]]`), op: 'relink',
      actor, source: `${fromSlug} → ${toSlug}`, groupId,
      scope: rel.includes(`memory/${USERS_DIR}/`) ? 'private' : 'shared',
      changes: { removed: [], added: [] },
    });
    relinked.push(rel);
  }
  reindexScopeOf(src.abs);
  return { ok: true, from: src.rel, to: dst.rel, merged, relinked, event_group: groupId };
}

/**
 * Undo one logged write. A pre-image alone is not enough — restoring it would
 * silently discard every claim written to that file afterwards — so the snapshot
 * is restored and the file's LATER events are replayed over it.
 */
export function revert({ eventId, actor }) {
  const all = readLog({ limit: 0 });
  const idx = all.findIndex(e => e.id === eventId || e.group === eventId);
  if (idx === -1) return { ok: false, error: `no such event: ${eventId}` };

  const group = all[idx].group;
  const targets = all.filter(e => (group ? e.group === group : e.id === eventId));
  const restored = [];

  for (const ev of targets) {
    const abs = join(projectRoot(), ev.target);
    const scopeErr = guardScope(ev.target, actor);
    if (scopeErr) return { ok: false, error: scopeErr };
    let base = '';
    if (ev.undo) {
      try { base = readFileSync(join(projectRoot(), ev.undo), 'utf8'); }
      catch { return { ok: false, error: `undo snapshot is gone for ${ev.target}` }; }
    }
    // Replay everything that happened to this file after the reverted event.
    const later = all.slice(all.indexOf(ev) + 1).filter(e => e.target === ev.target);
    let text = base;
    for (const l of later) text = applyChanges(text, l);

    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    if (!text.trim() && !before.trim()) continue;
    applyEvent({
      abs, rel: ev.target, before, after: text, op: 'revert', actor,
      scope: ev.scope, owner: ev.owner, source: `revert of ${ev.id}`,
      changes: { removed: ev.added.map(a => a.line), added: ev.removed.map(line => ({ section: ev.section || '', line })) },
    });
    restored.push({ target: ev.target, replayed: later.length });
  }
  return { ok: true, reverted: eventId, restored };
}

/** Rebuild every INDEX map (boot + maintenance). */
export function reindexAll() { return rebuildAllIndexes(); }
