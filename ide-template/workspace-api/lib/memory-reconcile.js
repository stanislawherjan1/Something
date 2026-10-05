/**
 * The decisions behind "one fact per thing" — pure, no writing. The facts store
 * (lib/memory-facts.js) asks them when a new fact has no key to match by:
 *
 *   candidates()  the current facts closest to a new one (e5 embeddings, cosine
 *                 >= 0.80; word overlap when the embedder is down)
 *   decide()      one small model call over those: same | merge | unrelated —
 *                 a merge comes with ONE combined title + text, refused by
 *                 covers() if it drops a name, number or date of either side
 *   inheritStatus()  what a combined fact keeps of the status side
 *
 * Any failure (no embedder, the model down, a bad answer) is "unrelated": a fact
 * is never lost to this. Candidates are given by the caller from ONE scope — a
 * private fact never meets a shared one.
 */
import { embed } from './embedder-client.js';
import { atSentence, fullText } from './memory-text.js';
import { runStructured , DECIDE_MODEL } from './memory-llm.js';

const K = 5;
const COSINE_FLOOR = 0.80;      // e5-small: paraphrases of one fact sit above, neighbours below
const JACCARD_FLOOR = 0.35;     // the fallback when the embedder is down

/** Whether a note is current: visible, not an ended status, not replaced by a record that is still there. */
const words = (t) => new Set(String(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}
const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

// A note's vector, embedded once per process: every new note is compared with
// every current one, and re-embedding the whole scope each time made a cleanup
// of 130 notes take most of an hour on the CPU.
const vectors = new Map();
const VECTOR_CAP = 5000;
async function vectorsFor(texts) {
  const missing = [...new Set(texts.filter(t => !vectors.has(t)))];
  if (missing.length) {
    const got = await embed(missing).catch(() => null);
    if (!got || got.length !== missing.length) return null;
    missing.forEach((t, i) => { if (vectors.size >= VECTOR_CAP) vectors.delete(vectors.keys().next().value); vectors.set(t, got[i]); });
  }
  return texts.map(t => vectors.get(t));
}

/** The current notes most like `text`, above the floor; [] when nothing is close. */
export async function candidates(text, current, k = K) {
  if (!current.length) return [];
  const vecs = await vectorsFor([text, ...current.map(c => c.text)]);
  const scored = vecs && vecs.every(Boolean)
    ? current.map((c, i) => ({ ...c, score: cosine(vecs[0], vecs[i + 1]) })).filter(c => c.score >= COSINE_FLOOR)
    : current.map(c => ({ ...c, score: jaccard(text, c.text) })).filter(c => c.score >= JACCARD_FLOOR);
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

export const DECIDE_SYSTEM = `You keep a person's memory to one note per thing. You get ONE new note and a numbered list of notes already in memory. For each existing note decide:
- "same": the new note says nothing the existing one doesn't.
- "merge": both notes describe the SAME specific item — one trip, one meeting, one deal, one role, one filing — and they AGREE (the new one adds detail or says it again), such that a person would naturally keep them as one entry. Write "merged": a "title" (3 to 8 words, a heading without the person's name) and a "text" (one or two self-contained sentences with the context someone needs months later) that keeps EVERY name, number, date and claim from BOTH notes. Where they DISAGREE, it is not a merge: "corrects" or "supersedes" below.
- "corrects": the new note contradicts or updates ONE thing the existing note says while the rest still holds — a contact that turns out not to exist, a detail that changed — typically when the existing note says much more. The existing note is kept as written and the new note is kept with it as a dated remark; nothing to write.
- "supersedes": the new note makes the existing note no longer true as a whole — "I will probably get the job" then "I did not get the job", a plan that fell through, a deal that died, a decision reversed. The existing note is marked no longer true and the new one stands alone; nothing to write.
- "unrelated": different things — even on the same company, person or topic. A cause and its consequence, an earlier event and a later event, a person's role and their shareholding, two meetings, two filings: all unrelated. A dated meeting, call or trip is one thing; a note about the same person that is not about that very meeting ("I can introduce him", "he asked for help") is another, and a meeting on another day is another meeting — unless the new note says THAT meeting moved to the new day ("supersedes") or corrects its day. Merging them would hide one behind the other.
Merge at most one existing note. Never connect two notes causally unless one of them states the connection. When unsure, "unrelated".`;

const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          verdict: { type: 'string', enum: ['same', 'merge', 'corrects', 'supersedes', 'unrelated'] },
          merged: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
        },
        required: ['n', 'verdict'],
      },
    },
  },
  required: ['decisions'],
};

/** `{ verdict, target, merged? }` for one new note: 'same', 'merge', 'corrects' and 'supersedes' name the existing note; anything else is 'unrelated'. */
export async function decide(note, cands) {
  // Two things on different days are two things — whatever a model would say
  // (a call on the 20th once merged into a meeting on the 5th). A date compare,
  // the same in every language.
  const dayOf = (x) => String(x?.when || '').slice(0, 10);
  // ...but a note that moves or cancels it may still reach it: another day's
  // candidate is kept for "supersedes" and "corrects" only, never "same" or
  // "merge" (a call on the 20th once merged into a meeting on the 5th).
  const otherDay = new Set(cands.filter(c => dayOf(note) && dayOf(c) && dayOf(c) !== dayOf(note)).map(c => c.id));
  if (!cands.length) return { verdict: 'unrelated' };
  let raw;
  try {
    raw = await runStructured({
      system: DECIDE_SYSTEM,
      model: DECIDE_MODEL,
      user: `NEW NOTE (${note.kind || 'fact'}${note.ts ? `, ${String(note.ts).slice(0, 10)}` : ''}): ${note.title ? `${note.title} — ` : ''}${note.text}\n\nEXISTING NOTES:
${cands.map((c, i) => `${i + 1}. (${c.kind}, ${c.ts.slice(0, 10)}) ${c.title ? `${c.title} — ` : ''}${fullText(c)}`).join('\n')}`,
      schema: DECIDE_SCHEMA,
      timeoutMs: 60_000,
    });
  } catch { return { verdict: 'unrelated' }; }
  const ds = Array.isArray(raw?.decisions) ? raw.decisions : [];
  const pick = (v) => ds.find(d => d?.verdict === v && Number.isInteger(d.n) && cands[d.n - 1] && !((v === 'same' || v === 'merge') && otherDay.has(cands[d.n - 1].id)));
  const same = pick('same');
  if (same) return { verdict: 'same', target: cands[same.n - 1] };
  // A correction keeps the existing note whole and adds the new one to it as a
  // dated remark: no rewrite by the model, so nothing the old note held is
  // lost, and the Memory screen shows one entry, not the claim and its denial
  // side by side. The entry replaces the old one, which stays in history.
  const sup = pick('supersedes');
  if (sup) return { verdict: 'supersedes', target: cands[sup.n - 1] };
  const cr = pick('corrects');
  if (cr) return { verdict: 'corrects', target: cands[cr.n - 1] };
  const mg = pick('merge');
  const text = atSentence(mg?.merged?.text || '');
  const title = String(mg?.merged?.title || '').trim().replace(/[.\s]+$/, '').slice(0, 80);
  // The merged note replaces both, so it must still carry both: every number,
  // date and proper name of each note has to survive into it. The Stryszowski
  // case is why — a merge that dropped the old note's subject entirely while
  // inventing a causal link between two companies. Facts beat fluency here.
  if (mg && text && title && covers(text, note.text) && covers(text, cands[mg.n - 1].text)) {
    return { verdict: 'merge', target: cands[mg.n - 1], merged: { title, text } };
  }
  return { verdict: 'unrelated' };
}

/**
 * What a combined note inherits beyond its text: the merged note replaces both,
 * so if either side was a status, the result is one — with the later expiry and
 * whatever about/when either side knew. Losing these dropped a merged meeting
 * and a trip out of "Right now" on the canary.
 */
export function inheritStatus(a, b) {
  const out = {};
  if (a?.kind === 'status' || b?.kind === 'status') out.kind = 'status';
  const exp = [a?.expires, b?.expires].filter(Boolean).sort().pop();
  if (exp) out.expires = exp;
  const about = a?.about || b?.about, when = a?.when || b?.when;
  if (about) out.about = about;
  if (when) out.when = when;
  return out;
}

/** Distinctive tokens of a note — numbers, dates, amounts and proper names. */
function distinctive(text) {
  const words = String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'./-]*/gu) || [];
  const out = new Set();
  words.forEach((w, i) => {
    if (/\d/.test(w)) out.add(w.toLowerCase().replace(/[./-]+$/, ''));
    else if (i > 0 && /^\p{Lu}/u.test(w) && !/^\p{Lu}/u.test(words[i - 1]) ? false : /^\p{Lu}[\p{Ll}']+/u.test(w) && i > 0 && !/[.!?]$/.test(words[i - 1] || '.') ) out.add(w.toLowerCase());
  });
  return out;
}
/** Whether `merged` keeps the distinctive tokens of `src` (at most one lost). */
export function covers(merged, src) {
  const have = String(merged).toLowerCase();
  let missing = 0;
  for (const t of distinctive(src)) if (!have.includes(t)) missing++;
  return missing <= 1;
}
