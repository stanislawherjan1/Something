/**
 * memory-search — hybrid retrieval over the v4 ledger.
 *
 * Measured choices (MEMORY_V4 §7, real canary questions + LongMemEval):
 *   - rank raw ledger records, not derived notes or reviews (mixing them in the
 *     ranking displaced the source excerpts and lost 0.05);
 *   - BM25 ∪ embedding similarity, fused by reciprocal rank (k = 60); BM25 alone
 *     when the embedder is unavailable;
 *   - no recency prior (it hurt knowledge-update questions), no score-gated
 *     widening (best-hit similarity carries no signal on e5-small);
 *   - k = 10 by default (6 lost killed-project answers, 15 fed guessing).
 *
 * The index is built lazily per scope from the ledger files and refreshed when a
 * month file changes (size + mtime), so appends and redactions show up on the
 * next search without any explicit invalidation.
 *
 * Vectors are kept per scope in that scope's own directory (`_vectors.json`,
 * int8 with a per-row scale — path-private like the ledger next to it) and
 * pruned to the records that exist, so an erased record's vector goes with it.
 * A few missing vectors are filled before answering; a large backlog (a fresh
 * install, a migration) is filled in the background while search answers with
 * BM25, so no turn waits for it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ledger from './memory-ledger.js';
import { atomicWrite } from './atomic-write.js';
import { embed, EMBEDDER_MODEL } from './embedder-client.js';

const RRF_K = 60;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const EMBED_CHARS = 2000;
const FILL_INLINE = 256;   // missing vectors filled before answering; more → background

export function tokens(text) {
  return (String(text).toLowerCase().match(TOKEN_RE) || []).filter(t => t.length > 1 || /\p{N}/u.test(t));
}

/**
 * Two tokens are the same word when equal — or, for words of five letters or
 * more, when they differ in length by at most three and share their first
 * four letters, or all but the last two of the shorter one: "bergman" and
 * "bergmana", "lindholm" and "lindholmowi". A rule that holds in every script, with
 * no word lists; what it cannot bend ("Janek" / "Jan") is the model's call,
 * folded into a topic's spellings at night and added to the query.
 */
export function near(a, b) {
  if (a === b) return true;
  const short = Math.min(a.length, b.length), diff = Math.abs(a.length - b.length);
  if (short < 5 || diff > 3 || (diff === 3 && short < 6)) return false;
  const n = Math.max(4, short - 2);
  return a.slice(0, n) === b.slice(0, n);
}

// ─── per-scope index cache ───────────────────────────────────────────────────

const cache = new Map();   // scope → { scope, sig, docs: [{ rec, toks, len }], df: Map, avgLen, vecs: Map(id → Float32Array) }
let filling = null;       // the background fill in progress, if any

// ─── stored vectors ──────────────────────────────────────────────────────────

function vectorsPath(scope) { return join(ledger.scopeDir(scope), '_vectors.json'); }

function loadVectors(scope) {
  const out = new Map();
  try {
    const f = JSON.parse(readFileSync(vectorsPath(scope), 'utf8'));
    if (f.model !== EMBEDDER_MODEL) return out;   // another model: re-embed
    for (const [id, [scale, b64]] of Object.entries(f.rows || {})) {
      const buf = Buffer.from(b64, 'base64');   // may sit in Node's shared pool: view its own bytes only
      const q = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
      const v = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) v[i] = q[i] * scale;
      out.set(id, v);
    }
  } catch { /* none yet, or unreadable: re-embed */ }
  return out;
}

function saveVectors(entry) {
  const rows = {};
  for (const [id, v] of entry.vecs) {
    let max = 0;
    for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
    const scale = max / 127 || 1;
    const q = new Int8Array(v.length);
    for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
    rows[id] = [scale, Buffer.from(q.buffer).toString('base64')];
  }
  try { atomicWrite(vectorsPath(entry.scope), JSON.stringify({ model: EMBEDDER_MODEL, rows })); }
  catch (e) { process.stderr.write(`[memory-search] vectors for ${entry.scope} not saved: ${e.message}\n`); }
}

function signature(scope) {
  let dir;
  try { dir = ledger.scopeDir(scope); } catch { return ''; }
  try {
    return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
      .map(f => { const st = statSync(join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
  } catch { return ''; }
}

function indexFor(scope) {
  const sig = signature(scope);
  const hit = cache.get(scope);
  if (hit && hit.sig === sig) return hit;
  const docs = ledger.read({ scopes: [scope] }).map(rec => {
    const toks = tokens(rec.text);
    return { rec, toks, len: toks.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  // Vectors survive a refresh; a record that is gone (erased, purged) loses its
  // vector here and on disk at once — an erasure leaves no embedding behind.
  const vecs = hit ? hit.vecs : loadVectors(scope);
  const present = new Set(docs.map(d => d.rec.id));
  let pruned = false;
  for (const id of [...vecs.keys()]) if (!present.has(id)) { vecs.delete(id); pruned = true; }
  const entry = { scope, sig, docs, df, avgLen, vecs };
  cache.set(scope, entry);
  if (pruned) saveVectors(entry);
  return entry;
}

function bm25(entries, query, k1 = 1.5, b = 0.75) {
  const q = tokens(query);
  const all = entries.flatMap(e => e.docs.map(d => ({ d, e })));
  const N = all.length;
  const df = new Map();
  let lenSum = 0;
  for (const e of entries) { lenSum += e.avgLen * e.docs.length; for (const [t, n] of e.df) df.set(t, (df.get(t) || 0) + n); }
  const avg = lenSum / Math.max(N, 1);
  // Each query word, with the vocabulary words near it and how many documents
  // hold any of them — computed once per query, not per document.
  const terms = q.map(t => {
    const alike = [...df.keys()].filter(v => near(t, v));
    return { t, alike: new Set(alike), n: alike.reduce((s, v) => s + (df.get(v) || 0), 0) };
  });
  const scored = [];
  for (const { d } of all) {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const { alike, n } of terms) {
      let f = 0;
      for (const [v, c] of tf) if (alike.has(v)) f += c;
      if (!f) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (avg || 1)));
    }
    if (s > 0) scored.push({ rec: d.rec, s });
  }
  return scored.sort((a, b) => b.s - a.s).map(x => x.rec);
}

async function fill(missing) {
  const touched = new Set();
  try {
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const v = await embed(batch.map(x => x.d.rec.text.slice(0, EMBED_CHARS)), 'passage');
      if (!v) return false;
      batch.forEach((x, j) => { x.e.vecs.set(x.d.rec.id, Float32Array.from(v[j])); touched.add(x.e); });
    }
    return true;
  } finally {
    for (const e of touched) saveVectors(e);
  }
}

/**
 * True when every record in the scopes has a vector. A small gap is filled
 * first; a large one, or one already being filled, answers false (BM25 now) and
 * fills in the background.
 */
async function ensureVectors(entries) {
  const missing = [];
  for (const e of entries) for (const d of e.docs) if (!e.vecs.has(d.rec.id)) missing.push({ e, d });
  if (!missing.length) return true;
  if (filling) return false;
  if (missing.length <= FILL_INLINE) return fill(missing);
  filling = fill(missing).catch(() => false).finally(() => { filling = null; });
  return false;
}

function cosineRank(entries, qv) {
  const q = Float32Array.from(qv);
  const scored = [];
  for (const e of entries) for (const d of e.docs) {
    const v = e.vecs.get(d.rec.id);
    if (!v) continue;
    let s = 0;
    for (let i = 0; i < q.length; i++) s += q[i] * v[i];
    scored.push({ rec: d.rec, s });
  }
  return scored.sort((a, b) => b.s - a.s).map(x => x.rec);
}

/**
 * Search the given scopes. Returns `{ hits, total, vectors }`: up to `k` records
 * (oldest first — the order the reader reasons in), how many records the scopes
 * hold (for the coverage line), and whether embeddings took part.
 * `exclude` = record ids already shown in this session.
 */
export async function search({ query, scopes, k = 10, exclude = [], includeReviews = false }) {
  const entries = scopes.map(indexFor);
  const total = entries.reduce((s, e) => s + e.docs.length, 0);
  if (!total || !String(query || '').trim()) return { hits: [], total, vectors: false };
  // Shared lines copied out of the reader's own conversation are already in
  // their own scope, whole; showing both would spend two of ten slots on one fact.
  const own = new Set(scopes.filter(s => s.startsWith('user:')));
  const skip = new Set(exclude);
  // Reviews are summaries; pinned into Q&A they made answers confident and stale.
  const keep = (r) => !skip.has(r.id) && !(r.origin && own.has(r.origin)) && (includeReviews || r.source !== 'review');
  const lexical = bm25(entries, query).filter(keep);
  let semantic = [];
  let vectors = false;
  if (await ensureVectors(entries)) {
    const qv = await embed([String(query).slice(0, EMBED_CHARS)], 'query');
    if (qv) { semantic = cosineRank(entries, qv[0]).filter(keep); vectors = true; }
  }
  const score = new Map();
  const byId = new Map();
  lexical.forEach((r, i) => { score.set(r.id, (score.get(r.id) || 0) + 1 / (RRF_K + i)); byId.set(r.id, r); });
  semantic.forEach((r, i) => { score.set(r.id, (score.get(r.id) || 0) + 1 / (RRF_K + i)); byId.set(r.id, r); });
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => byId.get(id));
  // The reader reasons in time order (`hits`); a person scanning a screen
  // wants the best match first (`ranked`).
  const top = ranked.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { hits: top, ranked, total, vectors };
}

/**
 * Everything the scopes hold about a term, in time order — "what changed about X",
 * the page-about-X view, and aggregation questions (count from a dated list).
 */
export function timeline({ term, scopes, since = null, limit = 60 }) {
  const want = tokens(term);
  if (!want.length) return [];
  const out = [];
  for (const scope of scopes) {
    for (const d of indexFor(scope).docs) {
      if (since && d.rec.ts < since) continue;
      if (d.rec.source === 'review') continue;
      const set = new Set(d.toks);
      if (want.every(t => set.has(t))) out.push(d.rec);
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out.slice(-limit);
}

/** Wait for a background fill (tests, and the nightly integrity pass). */
export function settled() { return filling || Promise.resolve(true); }

export function _resetForTests() { cache.clear(); filling = null; }
