/**
 * memory-ledger — memory v4's ground truth: routed conversation excerpts, append-only.
 *
 * Nothing a model decides can destroy information here. A record is appended once
 * and never edited; the only ways content leaves are an owner's redaction (which
 * physically rewrites the month file and leaves a content-free tombstone) and the
 * purge of records hidden more than 30 days ago (which is a redaction too). Every
 * derived structure (vectors, the search index, views) is rebuilt from here.
 *
 * Layout — one tree per scope, so the path-based privacy rules that guard the rest
 * of memory/ guard this too:
 *
 *   memory/ledger/YYYY-MM.jsonl                   scope 'shared'
 *   memory/users/<slug>/ledger/YYYY-MM.jsonl      scope 'user:<slug>'
 *   memory/groups/<chatId>/ledger/YYYY-MM.jsonl   scope 'group:<chatId>'
 *
 * Hide / unhide are overlay flags in a per-scope `_flags.jsonl`, never an edit.
 * Writes go through one in-process queue (workspace-api is the only writer), so
 * concurrent appends never interleave inside a line.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';

const SLUG_RE = /^[a-z0-9-]+$/;
const GROUP_RE = /^-\d{4,20}$/;
const SOURCES = new Set(['web', 'telegram', 'group', 'email', 'note', 'review', 'migration']);
const MAX_TEXT = 12000;
export const HIDE_GRACE_DAYS = 30;

function memoryDir() { return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory'); }
function engineDir() { return join(memoryDir(), '_engine'); }
function tombstonesPath() { return join(engineDir(), 'tombstones.jsonl'); }
function logPath() { return join(engineDir(), 'v4-log.jsonl'); }

// ─── scopes ──────────────────────────────────────────────────────────────────

/** 'shared' | 'user:<slug>' | 'group:<chatId>' → the scope's ledger directory. */
export function scopeDir(scope) {
  if (scope === 'shared') return join(memoryDir(), 'ledger');
  const [kind, id] = String(scope).split(':');
  if (kind === 'user' && SLUG_RE.test(id || '') && id !== 'default') return join(memoryDir(), 'users', id, 'ledger');
  if (kind === 'group' && GROUP_RE.test(id || '')) return join(memoryDir(), 'groups', id, 'ledger');
  throw new Error(`invalid scope ${JSON.stringify(scope)}`);
}

/**
 * The scopes a turn may READ — derived from identity, never from the model.
 *   a person in a 1:1 turn → their own + shared + the groups they belong to
 *   a group turn           → shared + that group only
 * Solo mode is a team of one, not a mode without scopes: the owner's
 * conversations are still theirs, so a group turn — where other people talk to
 * the bot — never reads them, and switching team mode on later exposes nothing.
 */
export function readableScopes({ actor = null, groupId = null, memberGroups = [] }) {
  if (groupId) return ['shared', `group:${groupId}`];
  const out = ['shared'];
  if (actor && SLUG_RE.test(actor) && actor !== 'default' && actor !== 'team') out.push(`user:${actor}`);
  for (const g of memberGroups) if (GROUP_RE.test(String(g))) out.push(`group:${g}`);
  return out;
}

/**
 * MEMORY_V4 = off | shadow | read | on — anything else is off. Moving the old
 * memory in (migration 0005, which leaves `_engine/.v4-migrated`) is what switches
 * a deployment to v4 for good: 'on' from then on, unless the flag says off —
 * the operator's kill switch always wins.
 */
export function v4Mode() {
  const v = String(process.env.MEMORY_V4 || 'off').toLowerCase();
  if (!['shadow', 'read', 'on'].includes(v)) return 'off';
  return existsSync(join(engineDir(), '.v4-migrated')) ? 'on' : v;
}

// ─── ids, hashes, tombstones ─────────────────────────────────────────────────

/** Time-sortable id: base36 millis + random. */
export function newId(ts = Date.now()) {
  return `${ts.toString(36).padStart(9, '0')}${randomBytes(5).toString('hex')}`;
}

export function contentHash(text) {
  return createHash('sha256').update(String(text).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

let tombstoneCache = null;
function tombstones() {
  if (tombstoneCache) return tombstoneCache;
  tombstoneCache = new Set();
  try {
    for (const l of readFileSync(tombstonesPath(), 'utf8').split('\n')) {
      if (!l) continue;
      try { tombstoneCache.add(JSON.parse(l).hash); } catch { /* torn line */ }
    }
  } catch { /* none yet */ }
  return tombstoneCache;
}

/** Was this content erased by its owner? The consolidator must never re-append it. */
export function isTombstoned(text) {
  return tombstones().has(contentHash(text));
}

/**
 * The v4 event log (memory/_engine/v4-log.jsonl): what happened to memory, for
 * the Changes tab — ids, scopes, counts and short labels only, never the text
 * of a record (an erased record must leave nothing behind, and the log is read
 * by every viewer's Changes filter).
 */
export function logEvent(ev) {
  mkdirSync(engineDir(), { recursive: true });
  appendFileSync(logPath(), JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n');
}

/** Events, oldest first, optionally since an ISO time. */
export function readEvents({ since = null, limit = 2000 } = {}) {
  let raw;
  try { raw = readFileSync(logPath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (since && e.ts < since) continue;
    out.push(e);
  }
  return limit ? out.slice(-limit) : out;
}

// ─── the write queue ─────────────────────────────────────────────────────────

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function monthFile(scope, ts) {
  return join(scopeDir(scope), `${String(ts).slice(0, 7)}.jsonl`);
}

function appendLine(path, line) {
  mkdirSync(join(path, '..'), { recursive: true });
  const fd = openSync(path, 'a', 0o664);
  try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Append one record. Returns `{ ok, id }`, or `{ ok:false, skipped }` for content
 * the owner erased (tombstoned) — never throws for that, the caller just moves on.
 */
export function append(rec) {
  return serial(() => {
    const scope = rec.scope;
    scopeDir(scope);   // validates
    const text = String(rec.text || '').trim();
    if (!text) throw new Error('empty record');
    if (text.length > MAX_TEXT) throw new Error(`record too long (${text.length} > ${MAX_TEXT})`);
    const source = SOURCES.has(rec.source) ? rec.source : null;
    if (!source) throw new Error(`invalid source ${JSON.stringify(rec.source)}`);
    if (isTombstoned(text)) return { ok: false, skipped: 'tombstoned' };
    const ts = rec.ts ? new Date(rec.ts).toISOString() : new Date().toISOString();
    const out = {
      v: 1,
      id: newId(Date.parse(ts)),
      ts,
      scope,
      source,
      conv: rec.conv ? String(rec.conv).slice(0, 200) : null,
      // A shared excerpt copied out of someone's 1:1 conversation names that
      // conversation's scope, so its owner (who holds the whole conversation)
      // is not shown the same lines twice.
      origin: rec.origin ? (scopeDir(rec.origin), rec.origin) : null,
      speaker: rec.speaker ? String(rec.speaker).slice(0, 80) : null,
      text,
      notes: Array.isArray(rec.notes) ? rec.notes.map(n => (typeof n === 'string' ? { text: n } : n)).filter(n => n && n.text).slice(0, 5) : [],
      tags: rec.tags && typeof rec.tags === 'object' ? rec.tags : {},
    };
    appendLine(monthFile(scope, ts), JSON.stringify(out) + '\n');
    return { ok: true, id: out.id, record: out };
  });
}

// ─── reads ───────────────────────────────────────────────────────────────────

function readFlags(scope) {
  const flags = new Map();   // id → { hidden, at }
  try {
    for (const l of readFileSync(join(scopeDir(scope), '_flags.jsonl'), 'utf8').split('\n')) {
      if (!l) continue;
      try {
        const f = JSON.parse(l);
        if (f.op === 'hide') flags.set(f.id, { hidden: true, at: f.ts });
        else if (f.op === 'unhide') flags.delete(f.id);
      } catch { /* torn line */ }
    }
  } catch { /* no flags */ }
  return flags;
}

function monthsOf(scope) {
  try { return readdirSync(scopeDir(scope)).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
}

/**
 * Records of the given scopes, oldest first. Hidden records are left out unless
 * `includeHidden`. `since` / `until` are ISO strings (inclusive / exclusive).
 */
export function read({ scopes, since = null, until = null, includeHidden = false } = {}) {
  const out = [];
  for (const scope of scopes || []) {
    let dir;
    try { dir = scopeDir(scope); } catch { continue; }
    const flags = readFlags(scope);
    for (const m of monthsOf(scope)) {
      if (since && `${m.slice(0, 7)}-31` < since.slice(0, 10)) continue;
      if (until && `${m.slice(0, 7)}-01` > until.slice(0, 10)) continue;
      let raw;
      try { raw = readFileSync(join(dir, m), 'utf8'); } catch { continue; }
      for (const l of raw.split('\n')) {
        if (!l) continue;
        let r;
        try { r = JSON.parse(l); } catch { continue; }
        if (since && r.ts < since) continue;
        if (until && r.ts >= until) continue;
        const f = flags.get(r.id);
        if (f && !includeHidden) continue;
        out.push(f ? { ...r, hidden: true, hiddenAt: f.at } : r);
      }
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

export function get(id, scopes) {
  return read({ scopes, includeHidden: true }).find(r => r.id === id) || null;
}

// ─── hide / unhide (reversible) ──────────────────────────────────────────────

export function hide(scope, id, by) {
  return serial(() => {
    appendLine(join(scopeDir(scope), '_flags.jsonl'), JSON.stringify({ op: 'hide', id, by: by || null, ts: new Date().toISOString() }) + '\n');
    logEvent({ op: 'hide', scope, ids: [id], by: by || null });
    return { ok: true };
  });
}

export function unhide(scope, id, by) {
  return serial(() => {
    appendLine(join(scopeDir(scope), '_flags.jsonl'), JSON.stringify({ op: 'unhide', id, by: by || null, ts: new Date().toISOString() }) + '\n');
    logEvent({ op: 'unhide', scope, ids: [id], by: by || null });
    return { ok: true };
  });
}

// ─── redaction (the only destructive operation) ──────────────────────────────

/**
 * Physically remove records from their month files and tombstone their content so
 * no rebuild or backfill can bring it back. Other lines stay byte-identical. The
 * log entry carries ids and hashes only, never text. `onRemoved(scope, month,
 * removedLineIndexes)` lets derived stores (vectors) drop the same rows.
 */
export function redact(scope, ids, by, { onRemoved, titles: given = null } = {}) {
  return serial(() => {
    const want = new Set(ids);
    const dir = scopeDir(scope);
    const hashes = [], titles = Array.isArray(given) ? given.slice(0, 5) : [];
    let removed = 0;
    for (const m of monthsOf(scope)) {
      const path = join(dir, m);
      const lines = readFileSync(path, 'utf8').split('\n');
      const keep = [];
      const gone = [];
      lines.forEach((l, i) => {
        if (!l) { keep.push(l); return; }
        let r = null;
        try { r = JSON.parse(l); } catch { /* keep torn lines as they are */ }
        if (r && want.has(r.id)) {
          gone.push(i);
          removed++;
          // What it was about, for the owner's own log: a fact's heading, never
          // the text. "Erased 1 record — nothing is kept" told them nothing.
          const t = given ? null : (r.notes || []).find(n => n?.title && !n.hidden)?.title;
          if (t && titles.length < 5) titles.push(String(t).slice(0, 80));
          // The record, and each of its lines: the raw logs it came from may be
          // re-read with other chunk boundaries, and every line must stay erased.
          hashes.push(contentHash(r.text));
          for (const ln of String(r.text).split('\n')) if (ln.trim()) hashes.push(contentHash(ln));
        } else keep.push(l);
      });
      if (gone.length) {
        atomicWrite(path, keep.join('\n'));
        onRemoved?.(scope, m, gone);
      }
    }
    if (hashes.length) {
      mkdirSync(engineDir(), { recursive: true });
      const at = new Date().toISOString();
      appendFileSync(tombstonesPath(), [...new Set(hashes)].map(h => JSON.stringify({ hash: h, ts: at })).join('\n') + '\n');
      tombstoneCache = null;
    }
    logEvent({ op: 'redact', scope, ids: [...want], removed, hashes: hashes.length, ...(titles.length ? { titles } : {}), by: by || null });
    return { ok: true, removed };
  });
}

/**
 * Rewrite the TAGS of records in a scope: `fn(record) → tags | null` (null =
 * leave it). Tags are metadata the views are built from, not content — so no
 * tombstone — but the month file is rewritten under the same queue and atomic
 * write as a redaction, so a concurrent append can never tear it. Other lines
 * stay byte-identical. Returns the number of records changed.
 */
export function retag(scope, fn) {
  return rewriteMeta(scope, (r) => { const tags = fn(r); return tags == null ? null : { tags }; }, 'retag');
}

/**
 * Rewrite a record's NOTES and/or TAGS: `fn(record) → { notes?, tags? } | null`.
 * Same rules as retag — metadata only (text, id, ts, scope, source never
 * change), the same queue and atomic write, other lines byte-identical, logged
 * without text. `fn` may be async (a model labels in batches).
 */
export function rewriteMeta(scope, fn, op = 'rewrite-meta') {
  return serial(async () => {
    const dir = scopeDir(scope);
    let changed = 0;
    for (const m of monthsOf(scope)) {
      const path = join(dir, m);
      const lines = readFileSync(path, 'utf8').split('\n');
      let touched = false;
      const out = [];
      for (const l of lines) {
        if (!l) { out.push(l); continue; }
        let r;
        try { r = JSON.parse(l); } catch { out.push(l); continue; }
        const next = await fn(r);
        if (!next) { out.push(l); continue; }
        const notes = next.notes === undefined ? r.notes : next.notes;
        const tags = next.tags === undefined ? (r.tags || {}) : next.tags;
        // `ts` may move, within its month only — the month is the file the
        // record lives in. A migration that learns a better date for a record
        // it stamped "today" uses this; the text never changes here.
        const ts = typeof next.ts === 'string' && next.ts.slice(0, 7) === r.ts.slice(0, 7) ? next.ts : r.ts;
        if (ts === r.ts && JSON.stringify(notes) === JSON.stringify(r.notes) && JSON.stringify(tags) === JSON.stringify(r.tags || {})) { out.push(l); continue; }
        touched = true; changed++;
        out.push(JSON.stringify({ ...r, ts, notes, tags }));
      }
      if (touched) atomicWrite(path, out.join('\n'));
    }
    if (changed) logEvent({ op, scope, changed });
    return { ok: true, changed };
  });
}

/** A record's notes that are still on the screen: a hidden fact stays in the record until it is purged or restored. */
export function visibleNotes(r) { return (r?.notes || []).filter(n => n && !n.hidden); }

/**
 * Redact every record hidden longer than the grace period, and drop every
 * fact (note) hidden that long — the same 30 days, the same "gone for good".
 * Returns counts per scope.
 */
export async function purgeHidden(scopes, { now = Date.now() } = {}) {
  const cutoff = now - HIDE_GRACE_DAYS * 86400_000;
  const out = {};
  for (const scope of scopes) {
    const expired = read({ scopes: [scope], includeHidden: true }).filter(r => r.hidden && Date.parse(r.hiddenAt) < cutoff).map(r => r.id);
    if (expired.length) out[scope] = (await redact(scope, expired, 'purge')).removed;
    const stale = (n) => n?.hidden && n.hiddenAt && Date.parse(n.hiddenAt) < cutoff;
    const facts = await rewriteMeta(scope, (r) => ((r.notes || []).some(stale) ? { notes: r.notes.filter(n => !stale(n)) } : null), 'purge-facts');
    if (facts.changed) out[scope] = (out[scope] || 0) + facts.changed;
  }
  return out;
}

/** Every scope that has a ledger directory on disk. */
export function allScopes() {
  const out = [];
  if (existsSync(join(memoryDir(), 'ledger'))) out.push('shared');
  for (const [base, kind] of [['users', 'user'], ['groups', 'group']]) {
    try {
      for (const e of readdirSync(join(memoryDir(), base), { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(memoryDir(), base, e.name, 'ledger'))) out.push(`${kind}:${e.name}`);
      }
    } catch { /* none */ }
  }
  return out;
}

export function _resetForTests() { tombstoneCache = null; queue = Promise.resolve(); }
