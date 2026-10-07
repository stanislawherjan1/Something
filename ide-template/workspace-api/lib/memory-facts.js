/**
 * Facts — what memory holds as true, one per thing, each with a stable id.
 *
 * A record (lib/memory-ledger.js) is a conversation: evidence, never edited. A
 * FACT is what was taken from it: a title, a description, and for a status what
 * it is about and when. Facts used to live inside records as `notes`, known by
 * their place (`recordId:index`); "replaced" pointed at a RECORD, so a record
 * that held no note could retire a fact, and three writers each kept the
 * bookkeeping their own way. Here a fact is its own thing:
 *
 *   memory/facts.jsonl                    shared
 *   memory/users/<slug>/facts.jsonl       one person
 *   memory/groups/<id>/facts.jsonl        one group
 *
 * — next to the scope's ledger, so privacy is still the path. The file is
 * append-only events, folded on read:
 *
 *   add      a new fact (its record, the words it rests on, who wrote it)
 *   confirm  the same thing said again: another source, a later lastSeen
 *   replace  it changed: the old fact is history, `by` is the fact that took its place
 *   amend    a title or a date added later (never the substance)
 *   hide / unhide     off the screen / back; purged after 30 days hidden
 *
 * Erasing for good rewrites the file without the fact (and remembers the hash
 * of its text, so it cannot be learned again from the same words).
 *
 * `remember()` is the ONLY writer of new facts — the consolidator and
 * memory_note both go through it. It decides, per candidate:
 *   - by KEY first: a meeting, trip or deadline with a day and a name has the
 *     key `about|day|name`; the same key on a current fact IS the same thing —
 *     confirmed when the new words add nothing, replaced when they do. No model.
 *   - otherwise the closest current facts (embeddings) and one small model call:
 *     same | merge | unrelated (lib/memory-reconcile.js). A merge is a replace
 *     whose text keeps every name, number and date of both.
 * Never across scopes.
 *
 * A scope with no facts file yet reads its facts from the notes its records
 * carry (everything written before this module); the first write — or the boot
 * migration — materialises them into the file, with ids `<recordId>n<index>`.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ledger from './memory-ledger.js';
import { atomicWrite } from './atomic-write.js';
import { candidates, decide, covers, inheritStatus } from './memory-reconcile.js';

const KEYED = new Set(['meeting', 'travel', 'deadline']);
const nameKey = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function factsPath(scope) { return join(dirname(ledger.scopeDir(scope)), 'facts.jsonl'); }

// ─── the write queue (one per process, like the ledger's) ────────────────────
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
function appendEvents(scope, events) {
  if (!events.length) return;
  const path = factsPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o664);
  try { writeSync(fd, events.map(e => JSON.stringify(e)).join('\n') + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

// ─── reading ─────────────────────────────────────────────────────────────────

function readEvents(scope) {
  let raw;
  try { raw = readFileSync(factsPath(scope), 'utf8'); } catch { return null; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn line is skipped, never "fixed" */ }
  }
  return out;
}

/**
 * The events a scope's legacy notes amount to — the same list whether it is
 * read on the fly or written by the migration. A note "replaced" by a record
 * that holds no note stays current: that pointer was the bug.
 */
export function eventsFromNotes(scope) {
  const recs = ledger.read({ scopes: [scope], includeHidden: true });
  const firstFact = new Map(recs.filter(r => (r.notes || []).some(n => n?.text)).map(r => [r.id, `${r.id}n${(r.notes || []).findIndex(n => n?.text)}`]));
  const ev = [];
  for (const r of recs) {
    (r.notes || []).forEach((n, i) => {
      if (!n?.text) return;
      const id = `${r.id}n${i}`;
      ev.push({
        op: 'add', id, ts: r.ts, record: r.source === 'review' ? (r.tags?.evidenceRecord || r.id) : r.id,
        ...(n.title ? { title: n.title } : {}), text: n.text, kind: n.kind || 'fact',
        ...(n.about ? { about: n.about } : {}), ...(n.when ? { when: n.when } : {}), ...(n.expires ? { expires: n.expires } : {}),
        ...(n.subject ? { subject: n.subject } : {}), ...(n.whenFrom ? { whenFrom: n.whenFrom } : {}),
        importance: n.importance || null, ...(n.evidence ? { evidence: n.evidence } : {}), ...(n.undated ? { undated: true } : {}),
        standing: r.source === 'note' ? 'note' : 'legacy', by: r.source,
        ...(r.tags?.entities?.length ? { entities: r.tags.entities } : {}),
      });
      for (const s of Array.isArray(n.sources) ? n.sources : []) ev.push({ op: 'confirm', id, record: s, ts: n.lastSeen || r.ts });
      const by = n.supersededBy && firstFact.get(n.supersededBy);
      if (by) ev.push({ op: 'replace', id, by, ts: n.supersededAt || n.superseded || r.ts });
      else if (n.superseded && !n.supersededBy) ev.push({ op: 'retire', id, ts: n.superseded, why: 'superseded' });
      if (n.hidden) ev.push({ op: 'hide', id, ts: n.hiddenAt || r.ts, by: n.hiddenBy || null, ...(n.hiddenWhy ? { why: n.hiddenWhy } : {}) });
    });
  }
  return ev;
}

function fold(scope, events) {
  const facts = new Map();
  const erased = new Set();
  for (const e of events) {
    if (e.op === 'add') {
      const { op, ...f } = e;
      facts.set(e.id, { ...f, scope, sources: e.record ? [e.record] : [], lastSeen: e.ts, at: e.at || e.ts });
      continue;
    }
    if (e.op === 'erased') { erased.add(e.hash); continue; }
    const f = facts.get(e.id);
    if (!f) continue;
    if (e.op === 'confirm') { if (e.record && !f.sources.includes(e.record)) f.sources.push(e.record); if (e.ts > f.lastSeen) f.lastSeen = e.ts; }
    else if (e.op === 'replace') { f.replacedBy = e.by; f.replacedAt = e.ts; if (e.why) f.replacedWhy = e.why; }
    // A correction of one claim: the fact stays as written and carries the
    // remark, dated, with the record it stands on — shown under it, never
    // folded into its text.
    // The update's record is not a source of the fact: hide or erase the
    // conversation the fact came from and the fact goes, remark or no remark.
    else if (e.op === 'update') { (f.updates ||= []).push({ ts: e.ts, text: String(e.text || ''), ...(e.record ? { record: e.record } : {}) }); if (e.ts > f.lastSeen) f.lastSeen = e.ts; }
    else if (e.op === 'retire') { f.retired = e.ts; if (e.why) f.retiredWhy = e.why; }
    else if (e.op === 'amend') { for (const k of ['title', 'text', 'kind', 'about', 'when', 'expires', 'key', 'subject', 'whenFrom', 'entities', 'namesJudged']) if (e[k] !== undefined) { if (e[k] === null) delete f[k]; else f[k] = e[k]; } }
    else if (e.op === 'hide') { f.hidden = true; f.hiddenAt = e.ts; f.hiddenBy = e.by || null; if (e.why) f.hiddenWhy = e.why; }
    else if (e.op === 'unhide') { delete f.hidden; delete f.hiddenAt; delete f.hiddenBy; delete f.hiddenWhy; }
  }
  // "Replaced by" is a live relation: gone or hidden, the fact that took its
  // place gives the place back.
  for (const f of facts.values()) {
    if (f.replacedBy) { const by = facts.get(f.replacedBy); if (!by || by.hidden) { delete f.replacedBy; delete f.replacedAt; } }
  }
  return { facts, erased };
}

function state(scope) {
  const file = readEvents(scope);
  if (!file) return fold(scope, eventsFromNotes(scope));
  // Records still carry their notes, and an older writer may touch them after
  // the file was written: a migration run later adds notes, or marks one
  // superseded. Those count — new notes as facts, marks on the legacy facts —
  // but the file has the last word: its own events come after them (an unhide
  // here beats a hide still on the note), and an erased text never comes back.
  const fileAdds = file.filter(e => e.op === 'add');
  const have = new Set(fileAdds.map(e => e.id));
  const erased = new Set(file.filter(e => e.op === 'erased').map(e => e.hash));
  const legacy = eventsFromNotes(scope);
  const lateAdds = legacy.filter(e => e.op === 'add' && !have.has(e.id) && !erased.has(ledger.contentHash(e.text)));
  const marks = legacy.filter(e => e.op !== 'add');
  return fold(scope, [...fileAdds, ...lateAdds, ...marks, ...file.filter(e => e.op !== 'add')]);
}

/** Every fact of a scope, oldest first — hidden and replaced ones included. */
export function all(scope) {
  return [...state(scope).facts.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Facts of the scopes whose conversation is still there to see: a fact whose
 * every source record is hidden or erased goes with them. `history` keeps the
 * replaced and retired ones (the "Past" list); hidden facts never show.
 */
export function visible(scopes, { history = false } = {}) {
  const out = [];
  for (const scope of scopes) {
    let present;
    try { present = new Set(ledger.read({ scopes: [scope] }).map(r => r.id)); } catch { continue; }
    for (const f of all(scope)) {
      if (f.hidden) continue;
      if (!history && (f.replacedBy || f.retired)) continue;
      if (f.sources.length && !f.sources.some(id => present.has(id))) continue;
      // An update whose conversation was erased or hidden goes with it, like a fact would.
      const updates = (f.updates || []).filter(u => !u.record || present.has(u.record));
      out.push(updates.length === (f.updates || []).length ? f : { ...f, updates });
    }
  }
  return out;
}
export const current = (scopes) => visible(scopes);

export function get(scope, id) { return state(scope).facts.get(String(id)) || null; }

/** The facts a record gave rise to (still on the screen), for its transcript and previews. */
export function forRecord(scope, recordId, { includeHidden = false } = {}) {
  return all(scope).filter(f => (f.record === recordId || f.sources.includes(recordId)) && (includeHidden || !f.hidden));
}

/** Which scope a fact id lives in, among the ones given. */
export function find(scopes, id) {
  for (const scope of scopes) { const f = get(scope, id); if (f) return f; }
  return null;
}

// ─── keys ────────────────────────────────────────────────────────────────────

/**
 * `about|day|subject` for a meeting, trip or deadline with a day and a subject
 * — the person, company or place it is with or about, as the extractor named
 * it (the model reads any language; the code only compares). A legacy fact
 * without a subject takes its record's single name, if it has exactly one.
 * Two facts with one key are one thing by definition.
 */
export function keyOf(f, entities = []) {
  // A status with a day and a kind of thing — or the fact a meeting became
  // once it happened (kind 'fact', `about` and `when` kept): one thing.
  if (!['status', 'fact'].includes(f.kind) || !KEYED.has(f.about) || !f.when) return null;
  let subject = f.subject;
  if (!subject) {
    const names = [...(entities || []), ...(f.entities || [])].map(e => (typeof e === 'string' ? e : e?.name)).filter(Boolean);
    const distinct = [...new Set(names.map(nameKey))];
    if (distinct.length === 1) subject = names[0];
  }
  return subject ? `${f.about}|${String(f.when).slice(0, 10)}|${nameKey(subject)}` : null;
}

/**
 * Two keys name one thing: the same kind on the same day, and one name the
 * other's start ("Marek" and "Marek Kowal" are one lunch; "Marek" and "Jan" two).
 */
export function sameKey(a, b) {
  if (!a || !b) return false;
  const [ka, da, na] = a.split('|'), [kb, db, nb] = b.split('|');
  return ka === kb && da === db && !!na && !!nb && (na.startsWith(nb) || nb.startsWith(na));
}

// ─── writing ─────────────────────────────────────────────────────────────────

/** Make sure the scope's file exists, materialising the legacy notes into it once. */
function materialise(scope) {
  if (existsSync(factsPath(scope))) return;
  const ev = eventsFromNotes(scope);
  mkdirSync(dirname(factsPath(scope)), { recursive: true });
  atomicWrite(factsPath(scope), ev.length ? ev.map(e => JSON.stringify(e)).join('\n') + '\n' : '');
}
/** For the boot migration: write the file for a scope that has none. Returns the number of facts. */
export function materialiseScope(scope) {
  return serial(() => { materialise(scope); return all(scope).length; });
}

export { atSentence, fullText, FACT_CHARS } from './memory-text.js';
import { atSentence, fullText, FACT_CHARS } from './memory-text.js';

const pickFields = (c) => ({
  ...(c.title ? { title: String(c.title).slice(0, 80) } : {}), text: atSentence(c.text, FACT_CHARS), kind: c.kind || 'fact',
  ...(c.subject ? { subject: String(c.subject).slice(0, 80) } : {}), ...(c.whenFrom ? { whenFrom: String(c.whenFrom).slice(0, 120) } : {}),
  ...(c.about ? { about: c.about } : {}), ...(c.when ? { when: c.when } : {}), ...(c.expires ? { expires: c.expires } : {}),
  importance: c.importance || null, ...(c.evidence ? { evidence: String(c.evidence).slice(0, 400) } : {}),
  ...(Array.isArray(c.entities) && c.entities.length ? { entities: c.entities.slice(0, 5) } : {}),
  ...(['said', 'found', 'note'].includes(c.standing) ? { standing: c.standing } : {}),
});

/**
 * Decide what each candidate is against the scope's current facts — nothing is
 * written. Returns one decision per candidate:
 *   { op: 'add', fact }                       new
 *   { op: 'confirm', target }                 memory already has it
 *   { op: 'replace', target, fact }           it changed; `fact` takes the place of `target`
 * Later candidates in the batch see the earlier ones.
 */
export async function plan(scope, cands = [], { entities = [], conv = null } = {}) {
  const st = state(scope);
  let cur = [...st.facts.values()].filter(f => !f.hidden && !f.replacedBy && !f.retired);
  const out = [];
  // Two imported meetings with the same person on one day share a key but are
  // two meetings: an import's fact never keys with another import's. (A
  // chat-made "call with X" on that day still keys with the import of it.)
  let convOf = null;
  const otherImport = (f) => {
    if (!conv || !String(conv).startsWith('import:') || !f.record) return false;
    if (!convOf) convOf = new Map(ledger.read({ scopes: [scope], includeHidden: true }).map(r => [r.id, r.conv]));
    const c = convOf.get(f.record) || '';
    return c.startsWith('import:') && c !== conv;
  };
  for (const c of cands) {
    if (!c?.text) continue;
    if (st.erased.has(ledger.contentHash(c.text))) { out.push({ op: 'skip', why: 'erased' }); continue; }
    const fact = pickFields(c);
    const key = keyOf({ ...fact, entities: c.entities }, entities);
    if (key) fact.key = key;
    let d = null;
    const twin = key && cur.find(f => sameKey(f.key || keyOf(f), key) && !otherImport(f));
    if (twin) {
      // The same thing by its key. New words that add nothing → confirm; a
      // candidate that carries all the old one had → it replaces; otherwise
      // one model call words the combined fact (and may only merge). A
      // meeting read from a notetaker takes no shortcut: its summary is never
      // "nothing new" to the one-line plan it meets (covers() once swallowed
      // a whole call), and the plan's who-and-when is never dropped for it —
      // the judgment words the one fact from both.
      const fromImport = !!(conv && String(conv).startsWith('import:'));
      if (!fromImport && covers(fullText(twin), fact.text)) d = { op: 'confirm', target: twin };
      else if (!fromImport && covers(fact.text, twin.text)) d = { op: 'replace', target: twin, fact: { ...fact, ...inheritStatus(fact, twin) } };
      // The same meeting at another time: the status itself changes (Right now
      // plans by `when`), so it is replaced, with the old time kept as history —
      // never a remark under a fact that still says the old time.
      // (A day said without a time against the same day with one — a meeting
      // read from a notetaker meets the chat that planned it — is not a move:
      // the judgment below words the one fact, time kept.)
      else if (fact.when && twin.when && fact.when !== twin.when && !(fact.when.slice(0, 10) === twin.when.slice(0, 10) && (fact.when.length === 10 || twin.when.length === 10))) d = { op: 'replace', target: twin, fact: { ...fact, ...inheritStatus(fact, twin) } };
      else {
        const m = await decide({ ...fact, ts: c.ts }, [{ ...twin, kind: twin.kind || 'fact' }]);
        d = m.verdict === 'same' ? { op: 'confirm', target: twin }
          : m.verdict === 'supersedes' ? { op: 'add', fact, supersedes: twin }
          : m.verdict === 'corrects' ? { op: 'update', target: twin, fact }
          // A merge takes the model's wording — and the title of the fact the
          // owner's convention wrote ("Call with X (date)") when an imported
          // meeting meets a chat-made "call with X".
          : m.verdict === 'merge' ? { op: 'replace', target: twin, fact: { ...fact, ...inheritStatus(fact, twin), title: (conv && String(conv).startsWith('import:') && fact.title) ? fact.title : (m.merged.title || fact.title), text: m.merged.text } }
          : { op: 'replace', target: twin, fact: { ...fact, ...inheritStatus(fact, twin) } };
      }
    } else {
      let near = await candidates(fact.text, cur.map(f => ({ ...f, kind: f.kind || 'fact' }))).catch(() => []);
      // A terse correction ("it was X, not Y") shares too few words with the
      // fact it corrects for similarity to find it; the facts about the same
      // person or company are the next place to look — by name, in any language.
      if (!near.length && fact.entities?.length) near = byName(fact.entities, cur).map(f => ({ ...f, kind: f.kind || 'fact' }));
      const m = await decide({ ...fact, ts: c.ts }, near);
      if (m.verdict === 'same') d = { op: 'confirm', target: m.target };
      // No longer true as a whole: the new fact stands alone and the old one is
      // marked superseded by it — struck through on the screen, kept in history.
      else if (m.verdict === 'supersedes') d = { op: 'add', fact, supersedes: m.target };
      // One claim of a richer fact changes: the fact keeps its words and gets
      // the new note as a dated remark under it.
      else if (m.verdict === 'corrects') d = { op: 'update', target: m.target, fact };
      else if (m.verdict === 'merge') d = { op: 'replace', target: m.target, fact: { ...fact, ...inheritStatus(fact, m.target), title: (conv && String(conv).startsWith('import:') && fact.title) ? fact.title : (m.merged.title || fact.title), text: m.merged.text } };
      else d = { op: 'add', fact };
    }
    out.push(d);
    // What comes next in the batch is compared with this one too.
    if (d.op === 'add') cur = [...cur, { ...d.fact, id: `pending-${out.length}`, ts: c.ts || new Date().toISOString() }];
    if (d.op === 'replace') cur = [...cur.filter(f => f.id !== d.target.id), { ...d.fact, id: `pending-${out.length}`, ts: c.ts || new Date().toISOString() }];
  }
  return out;
}

/** The newest current facts that share a name with the candidate, most recent first (at most five). */
function byName(entities, cur) {
  const keys = new Set(entities.map(e => nameKey(typeof e === 'string' ? e : e?.name)).filter(Boolean));
  return cur.filter(f => (f.entities || []).some(e => keys.has(nameKey(typeof e === 'string' ? e : e?.name))))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 5);
}

/** Write a plan. Returns `{ added, confirmed, replaced: [titles], superseded, updated, ids, titles }`. */
export function apply(scope, decisions, { record = null, standing = 'said', by = null, ts = new Date().toISOString(), entities = [], conv = null, single = false } = {}) {
  return serial(() => {
    materialise(scope);
    const ev = [];
    const res = { added: 0, confirmed: 0, replaced: [], superseded: [], updated: [], repeats: [], ids: [], titles: [] };
    const pending = (t) => String(t?.id || '').startsWith('pending-');
    // One conversation filed in parts (a long window in chunks, a meeting's
    // notes and transcript) is still ONE conversation: a thing it says twice
    // is one fact with one source, and a fuller wording of it in a later part
    // is the fact written out, not a version to keep under it. Without this a
    // meeting showed "3 sources" and two "earlier versions" of the same minute.
    let convOf = null;
    const samePiece = (t) => {
      if (!conv || !t?.record || pending(t)) return false;
      if (!convOf) convOf = new Map(ledger.read({ scopes: [scope], includeHidden: true }).map(r => [r.id, r.conv]));
      return convOf.get(t.record) === conv;
    };
    for (let d of decisions) {
      // A remark on a fact that is only being added in this same batch has
      // nothing to attach to yet: it stands as a fact of its own.
      if (d.op === 'update' && pending(d.target)) d = { op: 'add', fact: d.fact };
      if (d.op !== 'add' && !pending(d.target) && samePiece(d.target)) {
        if (d.op === 'confirm') { res.repeats.push(d.target.title || d.target.text); continue; }
        // A merge, a correction or a replacement from the same conversation:
        // the fact takes the fuller wording in place — no history, no new source.
        const { entities: ownNames, standing: _s, ...fact } = d.fact;
        const have = new Set((d.target.entities || []).map(e => nameKey(typeof e === 'string' ? e : e?.name)));
        const more = (ownNames || []).filter(e => e?.name && !have.has(nameKey(e.name)));
        const patch = { ...(fact.title ? { title: fact.title } : {}), text: atSentence(fact.text, FACT_CHARS), ...(fact.kind ? { kind: fact.kind } : {}), ...(fact.about ? { about: fact.about } : {}), ...(fact.when ? { when: fact.when } : {}), ...(fact.expires ? { expires: fact.expires } : {}), ...(more.length ? { entities: [...(d.target.entities || []), ...more].slice(0, 8) } : {}) };
        ev.push({ op: 'amend', id: d.target.id, ts, ...patch });
        res.ids.push(d.target.id); res.repeats.push(d.target.title || d.target.text);
        continue;
      }
      if (d.op === 'confirm') {
        if (pending(d.target)) continue;
        ev.push({ op: 'confirm', id: d.target.id, ...(record ? { record } : {}), ts });
        res.confirmed++; res.repeats.push(d.target.title || d.target.text);
      } else if (d.op === 'update') {
        ev.push({ op: 'update', id: d.target.id, ts, text: atSentence(d.fact.text, FACT_CHARS), ...(record ? { record } : {}) });
        // A correction that names someone new puts the fact on their timeline too.
        const have = new Set((d.target.entities || []).map(e => nameKey(typeof e === 'string' ? e : e?.name)));
        const more = (d.fact.entities || []).filter(e => e?.name && !have.has(nameKey(e.name)));
        if (more.length) ev.push({ op: 'amend', id: d.target.id, ts, entities: [...(d.target.entities || []), ...more].slice(0, 8) });
        res.updated.push(d.target.title || d.target.text); res.ids.push(d.target.id);
      } else if (d.op === 'add' || d.op === 'replace') {
        const old = d.op === 'replace' && !String(d.target.id).startsWith('pending-') ? d.target : null;
        // A fact that takes another's place is dated by the later of the two
        // conversations: a filing that reached an earlier chat second once made
        // the replacement look older than what it replaced.
        const when = old && old.ts > ts ? old.ts : ts;
        const id = ledger.newId(Date.parse(when) || Date.now());
        // The names a fact is about: its own, from the note. A record's names
        // stand in only when the record holds this one note (a saved note is
        // about one thing): with several notes a nameless one took every name
        // of the conversation, and a sugar routine sat on a client's timeline.
        const { entities: ownNames, standing: ownStanding, ...fact } = d.fact;
        const names = ownNames?.length ? ownNames : single ? entities : [];
        // `ts` is the conversation's time (the story); `at` is when memory
        // learned it (the Facts list reads newest-learned first).
        ev.push({ op: 'add', id, ts: when, at: new Date().toISOString(), ...(record ? { record } : {}), ...fact, standing: ownStanding || standing, by, ...(names?.length ? { entities: names } : {}), ...(old ? { replaces: old.id } : {}) });
        // The fact that takes another's place keeps its sources: what was said before still stands behind it.
        if (old) {
          for (const s of old.sources || []) if (s !== record) ev.push({ op: 'confirm', id, record: s, ts });
          // What was corrected on the old fact still holds on the one that takes its place.
          for (const u of old.updates || []) ev.push({ op: 'update', id, ts: u.ts, text: u.text, ...(u.record ? { record: u.record } : {}) });
          ev.push({ op: 'replace', id: old.id, by: id, ts }); res.replaced.push(old.title || old.text);
        }
        // Superseded: the old fact is no longer true; the new one does not inherit its sources.
        const gone = d.supersedes && !String(d.supersedes.id).startsWith('pending-') ? d.supersedes : null;
        if (gone) { ev.push({ op: 'replace', id: gone.id, by: id, ts, why: 'superseded' }); res.superseded.push(gone.title || gone.text); }
        res.added++; res.ids.push(id); if (d.fact.title) res.titles.push(d.fact.title);
      }
    }
    appendEvents(scope, ev);
    return res;
  });
}

/** Decide and write in one go — what the consolidator calls once a record is on disk. */
export async function remember(scope, cands, opts = {}) {
  const decisions = await plan(scope, cands.map(c => ({ ...c, ts: opts.ts })), { entities: opts.entities, conv: opts.conv || null });
  return apply(scope, decisions, { ...opts, single: cands.length === 1 });
}

function event(scope, e) { return serial(() => { materialise(scope); appendEvents(scope, [e]); }); }

export function hide(scope, id, by, { why = null, ts = new Date().toISOString() } = {}) { return event(scope, { op: 'hide', id, ts, by: by || null, ...(why ? { why } : {}) }); }
export function unhide(scope, id, by, { ts = new Date().toISOString() } = {}) { return event(scope, { op: 'unhide', id, ts, by: by || null }); }
export function amend(scope, id, patch, { ts = new Date().toISOString() } = {}) { return event(scope, { op: 'amend', id, ts, ...patch }); }
export function replaceWith(scope, oldId, newId, { ts = new Date().toISOString() } = {}) { return event(scope, { op: 'replace', id: oldId, by: newId, ts }); }

/**
 * Erase facts for good: the file is rewritten without any line of theirs, and
 * the hash of each text is kept so the same words cannot be learned again.
 */
export function erase(scope, ids) {
  return serial(() => {
    materialise(scope);
    const want = new Set(ids.map(String));
    // The whole state, not the file alone: a legacy fact whose record arrived
    // after the file was written is not a line in it, and only its text hash
    // keeps it from coming back — folding the file alone found no such fact
    // and erased nothing.
    const st = state(scope);
    const hashes = [...want].map(id => st.facts.get(id)).filter(Boolean).flatMap(f => [f.text, ...(f.updates || []).map(u => u.text)]).map(t => ledger.contentHash(t));
    const kept = (readFileSync(factsPath(scope), 'utf8').split('\n').filter(Boolean)).filter(l => {
      try { const e = JSON.parse(l); return !(want.has(e.id) || (e.op === 'replace' && want.has(e.by))); } catch { return true; }
    });
    const at = new Date().toISOString();
    atomicWrite(factsPath(scope), [...kept, ...hashes.map(h => JSON.stringify({ op: 'erased', hash: h, ts: at }))].join('\n') + (kept.length || hashes.length ? '\n' : ''));
    return { erased: hashes.length };
  });
}

/**
 * Facts none of whose records is left (their conversation was erased) go with
 * it; a record erased from under a fact that has other sources just leaves the list.
 */
export async function sweepOrphans(scope) {
  let present;
  try { present = new Set(ledger.read({ scopes: [scope], includeHidden: true }).map(r => r.id)); } catch { return { erased: 0 }; }
  const gone = all(scope).filter(f => f.sources.length && !f.sources.some(id => present.has(id))).map(f => f.id);
  const res = gone.length ? await erase(scope, gone) : { erased: 0 };
  // An update whose conversation is gone takes its words with it — off the
  // disk, not only off the screen.
  const stale = all(scope).some(f => (f.updates || []).some(u => u.record && !present.has(u.record)));
  if (stale) {
    await serial(() => {
      materialise(scope);
      const kept = (readFileSync(factsPath(scope), 'utf8').split('\n').filter(Boolean)).filter(l => {
        try { const e = JSON.parse(l); return !(e.op === 'update' && e.record && !present.has(e.record)); } catch { return true; }
      });
      atomicWrite(factsPath(scope), kept.join('\n') + (kept.length ? '\n' : ''));
    });
  }
  return res;
}

/** Facts hidden longer than the ledger's grace period are erased; returns the count. */
export async function purgeHidden(scopes, { now = Date.now() } = {}) {
  const cutoff = now - ledger.HIDE_GRACE_DAYS * 86400_000;
  let n = 0;
  for (const scope of scopes) {
    const stale = all(scope).filter(f => f.hidden && f.hiddenAt && Date.parse(f.hiddenAt) < cutoff).map(f => f.id);
    if (stale.length) n += (await erase(scope, stale)).erased;
    n += (await sweepOrphans(scope)).erased;
  }
  return n;
}

/**
 * The backlog of duplicates, folded the way a new fact would be: the keyed
 * ones for free, the rest a few model decisions per call. Oldest first; the
 * later fact of a pair is the one that stays.
 */
export async function dedupeBacklog(scope, { capDecisions = 15, ts = new Date().toISOString() } = {}) {
  const out = { same: 0, replaced: 0, decisions: 0 };
  const facts = all(scope).filter(f => !f.hidden && !f.replacedBy && !f.retired);
  const earlier = [];
  for (const f of facts) {
    const key = f.key || keyOf(f);
    const twin = key && earlier.find(e => sameKey(e.key || keyOf(e), key));
    let d = null;
    if (twin) d = covers(fullText(twin), f.text) ? { verdict: 'same', target: twin } : { verdict: 'replace', target: twin };
    else {
      const near = await candidates(f.text, earlier.map(e => ({ ...e, kind: e.kind || 'fact' }))).catch(() => []);
      if (!near.length) { earlier.push(f); continue; }
      if (out.decisions >= capDecisions) { earlier.push(f); continue; }
      out.decisions++;
      const m = await decide({ ...f }, near);
      if (m.verdict === 'same') d = { verdict: 'same', target: m.target };
      else if (m.verdict === 'merge') d = { verdict: 'replace', target: m.target, merged: m.merged };
      else if (m.verdict === 'corrects') d = { verdict: 'corrects', target: m.target };
      else if (m.verdict === 'supersedes') d = { verdict: 'supersedes', target: m.target };
    }
    if (!d) { earlier.push(f); continue; }
    if (d.verdict === 'same') {
      // The later copy leaves the screen; the earlier one gains its sources and its remarks.
      await serial(() => { materialise(scope); appendEvents(scope, [...f.sources.map(s => ({ op: 'confirm', id: d.target.id, record: s, ts })), ...(f.updates || []).map(u => ({ op: 'update', id: d.target.id, ts: u.ts, text: u.text, ...(u.record ? { record: u.record } : {}) })), { op: 'hide', id: f.id, ts, by: null, why: 'duplicate' }]); });
      ledger.logEvent({ op: 'hide_fact', scope, by: 'nightly', factIds: [f.id], facts: 1, titles: [f.title].filter(Boolean), why: 'duplicate' });
      out.same++;
      continue;
    }
    if (d.verdict === 'corrects') {
      // The later fact is a remark on the earlier one: it moves under it.
      await serial(() => { materialise(scope); appendEvents(scope, [{ op: 'update', id: d.target.id, ts: f.ts, text: f.text, ...(f.sources[0] ? { record: f.sources[0] } : {}) }, { op: 'hide', id: f.id, ts, by: null, why: 'folded as an update' }]); });
      out.updated = (out.updated || 0) + 1;
      continue;
    }
    if (d.verdict === 'supersedes') {
      await serial(() => { materialise(scope); appendEvents(scope, [{ op: 'replace', id: d.target.id, by: f.id, ts, why: 'superseded' }]); });
      out.superseded = (out.superseded || 0) + 1;
      const i = earlier.findIndex(e => e.id === d.target.id); if (i >= 0) earlier.splice(i, 1);
      earlier.push(f);
      continue;
    }
    await serial(() => {
      materialise(scope);
      const patch = { ...inheritStatus(f, d.target), ...(d.merged ? { title: d.merged.title, text: d.merged.text } : {}) };
      appendEvents(scope, [...(Object.keys(patch).length ? [{ op: 'amend', id: f.id, ts, ...patch }] : []), ...d.target.sources.map(s => ({ op: 'confirm', id: f.id, record: s, ts: f.lastSeen || ts })), ...(d.target.updates || []).map(u => ({ op: 'update', id: f.id, ts: u.ts, text: u.text, ...(u.record ? { record: u.record } : {}) })), { op: 'replace', id: d.target.id, by: f.id, ts }]);
    });
    out.replaced++;
    const i = earlier.findIndex(e => e.id === d.target.id);
    if (i >= 0) earlier.splice(i, 1);
    earlier.push(d.merged ? { ...f, title: d.merged.title, text: d.merged.text } : f);
  }
  return out;
}

export function _resetForTests() { queue = Promise.resolve(); }
