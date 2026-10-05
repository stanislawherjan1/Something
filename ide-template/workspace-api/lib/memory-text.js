/**
 * What a fact reads as, and how long it may be — shared by the store, the
 * reconcile judgment and the views, with no dependency between them.
 */
export const FACT_CHARS = 1200;

/**
 * A fact is a few sentences; one that runs past `max` ends at its last whole
 * sentence before the limit (or its last whole word, with an ellipsis), never
 * mid-word — a note written as a paragraph once ended in "with a".
 */
export function atSentence(text, max = FACT_CHARS) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  let cut = -1;
  for (const m of head.matchAll(/[.!?。](?=\s|$)/g)) cut = m.index + 1;
  if (cut >= max / 3) return head.slice(0, cut).trimEnd();
  const space = head.lastIndexOf(' ');
  return `${(space > max / 3 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** What a reader gets: the description, then each update as a dated sentence. */
export function fullText(f) {
  const ups = Array.isArray(f?.updates) ? f.updates : [];
  return ups.length ? `${f.text} ${ups.map(u => `Update (${String(u.ts).slice(0, 10)}): ${u.text}`).join(' ')}` : String(f?.text || '');
}
