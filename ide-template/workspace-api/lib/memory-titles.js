/**
 * Titles for notes. Every note carries a short `title` (3-8 words) beside its
 * text, and a status also says what it is `about` and `when` it happens — the
 * Memory screen's "Right now" and the facts list read by them. The router and
 * the reviews write them with the note; this backfills every note that arrived
 * WITHOUT one (older migrations, memory_note, a failed call), so the format
 * holds across the whole ledger no matter which path wrote it. Metadata only —
 * a note's text never changes here.
 *
 * Called nightly (memory-maintenance) and by the operator's bin/title-notes.mjs.
 */
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import { runStructured } from './memory-llm.js';
import { createHash } from 'node:crypto';

const BATCH = 15;
const stampOf = (text, names) => createHash('sha1').update(`${text}\u0000${names.map(e => typeof e === 'string' ? e : e.name).join('\u0000')}`).digest('hex').slice(0, 16);
const ABOUT = ['meeting', 'travel', 'deadline', 'waiting', 'other'];

export const TITLE_SYSTEM = `You write short headings for notes in a person's memory. For each numbered note give:
- "title": 3 to 8 English words saying what it is about, like a heading, without the person's name ("Trip to Lisbon", "Call with Lena about the restock", "Job offer waiting on contract terms").
- for a note marked (status) only: "about" = meeting|travel|deadline|waiting|other, and "when" = the day it happens as an ISO date, with the time if the note says one ("2026-10-05T12:00"), else null.
- "subject": what tells this thing apart from others like it — for a meeting or call the other person or company, for a trip the destination, for a deadline what is due — as the note names it ("Marek Kowal", "Lisbon"); never the person the note is about; else null.
Never add facts that are not in the note.`;
const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    n: { type: 'integer' }, title: { type: 'string' },
    about: { type: ['string', 'null'] }, when: { type: ['string', 'null'] }, subject: { type: ['string', 'null'] },
  }, required: ['n', 'title'] } } },
  required: ['items'],
};

/** Title every untitled note in `scopes`. Returns per-scope counts; never throws. */
export async function titleUntitled(scopes, { log = () => {}, cap = Infinity } = {}) {
  const out = {};
  for (const scope of scopes) {
    const todo = [];
    // Untitled facts, and dated meetings, trips and deadlines without a subject:
    // the subject is what tells one such thing from another (their key), and
    // facts written before it existed have none — the same trip said in a DM
    // and in a group showed twice in Right now.
    const keyed = (f) => f.kind === 'status' && ['meeting', 'travel', 'deadline'].includes(f.about) && f.when && !f.subject;
    for (const f of facts.all(scope)) if (f.text && !f.hidden && !f.replacedBy && !f.retired && (!f.title || keyed(f))) todo.push({ id: f.id, text: f.text, kind: f.kind || 'fact', hasTitle: !!f.title });
    if (!todo.length) { out[scope] = 0; continue; }
    const batch = todo.slice(0, cap);
    const got = new Map();
    for (let b = 0; b < batch.length; b += BATCH) {
      const chunk = batch.slice(b, b + BATCH);
      let raw;
      try {
        raw = await runStructured({ system: TITLE_SYSTEM, user: chunk.map((c, k) => `${k + 1}. (${c.kind}) ${c.text}`).join('\n'), schema: SCHEMA, timeoutMs: 120_000 });
      } catch (e) { log(`${scope}: title batch failed (${e.message})`); continue; }
      for (const it of raw?.items || []) {
        const c = chunk[it.n - 1];
        const title = String(it?.title || '').trim().replace(/[.\s]+$/, '').slice(0, 80);
        if (!c || !title) continue;
        const meta = c.hasTitle ? {} : { title };
        const subject = String(it?.subject || '').trim().slice(0, 80);
        if (subject && c.kind === 'status') meta.subject = subject;
        if (c.kind === 'status') {
          if (ABOUT.includes(it.about)) meta.about = it.about;
          if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(it.when || ''))) meta.when = it.when;
        }
        if (Object.keys(meta).length) got.set(c.id, meta);
      }
    }
    // A title (and for a status what it is about and when) is metadata: the
    // fact's text never changes.
    for (const [id, meta] of got) await facts.amend(scope, id, meta);
    out[scope] = got.size;
  }
  return out;
}

export const NAMES_SYSTEM = `You get numbered facts from a person's memory, each with the names (people, companies, projects) it was filed under. For each fact say which of its listed names the fact's own words mention — in ANY form: inflected, declined, a short form, a first name alone, a transliteration, a typo. Give each name exactly as listed. A name the fact's words do not mention at all is left out; a fact that mentions none gets an empty list. Never add a name that is not listed for that fact.`;
const NAMES_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, mentioned: { type: 'array', items: { type: 'string' } } }, required: ['n', 'mentioned'] } } },
  required: ['items'],
};

/**
 * The names a fact is about. Facts written before notes carried their own
 * names took every name of their conversation — a meeting with someone filed
 * under the product that came up in the same chat. For a current fact with
 * names, keep the ones its own words mention (title, text, updates, subject)
 * and drop the rest — a fact that mentions none is about none of them.
 * Whether "Vellmarkowi" mentions Vellmark Logistics is the model's call, not a
 * string rule's: the same question the extractor answers when filing. Judged
 * once per fact (the pass remembers what it judged, so a night re-asks only
 * about facts whose text or names changed). The fact stays in Facts either
 * way; only the topic timelines change.
 */
export async function narrowNames(scopes, { log = () => {}, cap = 300 } = {}) {
  let narrowed = 0, judged = 0;
  for (const scope of scopes) {
    let list;
    try { list = facts.current([scope]); } catch (e) { log(`names ${scope}: ${e.message}`); continue; }
    const todo = [];
    for (const f of list) {
      const names = (f.entities || []).filter(e => e && (typeof e === 'string' ? e : e.name));
      if (!names.length) continue;
      const text = `${f.title || ''} ${facts.fullText(f)} ${f.subject || ''}`;
      if (f.namesJudged === stampOf(text, names)) continue;
      todo.push({ f, names, text });
    }
    for (let i = 0; i < todo.length && judged < cap; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const user = batch.map((x, k) => `${k + 1}. NAMES: ${x.names.map(e => typeof e === 'string' ? e : e.name).join(' | ')}\n   FACT: ${x.text.replace(/\s+/g, ' ').trim().slice(0, 700)}`).join('\n\n');
      let raw;
      try { raw = await runStructured({ system: NAMES_SYSTEM, user, schema: NAMES_SCHEMA, timeoutMs: 90_000 }); } catch (e) { log(`names ${scope}: ${e.message}`); break; }
      const got = new Map((raw?.items || []).map(it => [it.n, it.mentioned]));
      for (const [k, x] of batch.entries()) {
        const ans = got.get(k + 1);
        judged++;
        if (!Array.isArray(ans)) continue;   // no verdict for this one: ask again tomorrow
        const keep = x.names.filter(e => ans.includes(typeof e === 'string' ? e : e.name));
        // Stamped with the names it keeps, so tomorrow's pass passes it by.
        const meta = { namesJudged: stampOf(x.text, keep) };
        if (keep.length !== x.names.length) { meta.entities = keep.length ? keep : null; narrowed++; }
        try { await facts.amend(scope, x.f.id, meta); } catch (e) { log(`names ${scope} ${x.f.id}: ${e.message}`); }
      }
    }
  }
  return { narrowed, judged };
}
