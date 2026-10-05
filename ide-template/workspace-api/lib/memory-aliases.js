/**
 * Two spellings of one thing — "Jan Kowal" and "Janek Kowal", "Marek" and
 * "Marek Nowak", "harbor.works" and "Harbor Works" — are one topic. Code
 * folds only what holds in every language (one key per spelling family, a
 * bare first name into the one full name it starts); whether a diminutive,
 * an inflected form, a nickname or a typo names the same person is the
 * model's call, made here once a night over the names memory keeps as tiles,
 * with what memory says about each. A merge is written as the owner's own
 * would be (lib/memory-views.js decideAlias) and logged; the owner's "not the
 * same" from the Memory screen is never overridden.
 */
import * as ledger from './memory-ledger.js';
import * as views from './memory-views.js';
import * as facts from './memory-facts.js';
import { runStructured } from './memory-llm.js';

export const ALIAS_SYSTEM = `You get the names an AI assistant's memory keeps as separate topics, numbered, each with its kind and what memory says about it. Say which entries are the SAME person, company or project under two spellings: a short form or nickname ("Marek" / "Marek Nowak"), a diminutive ("Janek" / "Jan"), an inflected or transliterated form, a typo, a name with or without a suffix ("Harbor Works" / "Harbor Works OÜ").
Only when the spelling leaves no doubt or what memory says about them agrees — the same role, company, project or events. Two people who share a first name are different people unless memory shows otherwise; two companies with similar names are different unless memory shows otherwise. When unsure, leave them apart.
For each pair give "from" (the entry to fold) and "into" (the entry to keep — the fuller or more formal name), by their numbers, and "why" in a few words.`;
const ALIAS_SCHEMA = {
  type: 'object',
  properties: { pairs: { type: 'array', items: { type: 'object', properties: { from: { type: 'integer' }, into: { type: 'integer' }, why: { type: 'string' } }, required: ['from', 'into'] } } },
  required: ['pairs'],
};

/**
 * One viewer's tiles (what they may read), judged once; merges are global, as
 * the owner's own are. Returns `{ merged: [{from, into, why}], seen }`.
 */
export async function mergeLookalikes(key, scopes, { log = () => {}, max = 80 } = {}) {
  const tiles = views.topics(scopes, { min: 2 }).slice(0, max);
  if (tiles.length < 2) return { merged: [], seen: tiles.length };
  const profiles = views.readProfiles(key).topics || {};
  const about = (t) => {
    const line = profiles[t.key]?.line;
    if (line) return line;
    const f = views.topicFacts(scopes, [t.key, ...t.aliases.map(views.topicKey)], { history: false }).slice(-2);
    return f.map(x => x.title || facts.fullText(x)).join('; ') || '(nothing yet)';
  };
  const list = tiles.map((t, i) => `${i + 1}. ${t.name}${t.aliases.length ? ` (also written: ${t.aliases.join(', ')})` : ''} — ${t.kind} — ${about(t).slice(0, 200)}`);
  let raw;
  try {
    raw = await runStructured({ system: ALIAS_SYSTEM, user: list.join('\n'), schema: ALIAS_SCHEMA, timeoutMs: 90_000 });
  } catch (e) { log(`aliases ${key}: ${e.message}`); return { merged: [], seen: tiles.length }; }
  const merged = [];
  const aliases = views.readAliases();
  const distinct = (a, b) => aliases.distinct.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (const p of Array.isArray(raw?.pairs) ? raw.pairs : []) {
    const from = tiles[Number(p?.from) - 1], into = tiles[Number(p?.into) - 1];
    if (!from || !into || from === into) continue;
    // A kind each tile is sure of must agree; the owner's "not the same" wins.
    if (from.kindKnown && into.kindKnown && from.kind !== into.kind) continue;
    if (distinct(from.key, into.key)) continue;
    views.decideAlias({ from: from.name, into: into.name, same: true });
    const why = String(p?.why || '').trim().slice(0, 120);
    ledger.logEvent({ op: 'alias', scope: 'shared', by: 'nightly', from: from.name.slice(0, 80), into: into.name.slice(0, 80), same: true, ...(why ? { why } : {}) });
    merged.push({ from: from.name, into: into.name, why });
  }
  return { merged, seen: tiles.length };
}
