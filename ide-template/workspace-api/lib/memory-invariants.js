/**
 * What must hold in memory, checked every night on the real data — so a
 * regression shows up in the run log before a person sees it on the screen.
 * Read-only: nothing is fixed here; each violation names the fact and why.
 *
 *   orphan      a current fact none of whose records exists any more
 *   dangling    a fact replaced by a fact that is not in the store
 *   twin        two current facts in one scope with the same key (one thing, twice)
 *   date        a status day whose quoted words are not in its conversation
 *   recital     a fact written from a conversation whose only source line is the
 *               assistant's, with no tool that reads the world
 *   narration   a fact that tells the story of a correction ("Correction: …")
 */
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import { resolve as resolveBranding } from './branding.js';

import { isVerbatim, isNearVerbatim } from './memory-router.js';

export function check(scopes = ledger.allScopes()) {
  const out = [];
  let botName = '';
  try { botName = resolveBranding().botName || ''; } catch { /* the default */ }
  const bots = new Set(['assistant', botName.toLowerCase()].filter(Boolean));
  for (const scope of scopes) {
    let recs;
    try { recs = new Map(ledger.read({ scopes: [scope], includeHidden: true }).map(r => [r.id, r])); } catch { continue; }
    const every = facts.all(scope);
    const current = every.filter(f => !f.hidden && !f.replacedBy && !f.retired);
    const bad = (kind, f, why) => out.push({ kind, scope, id: f.id, title: f.title || String(f.text).slice(0, 60), why });
    const keyed = [];
    for (const f of current) {
      if (f.sources.length && !f.sources.some(id => recs.has(id))) bad('orphan', f, 'none of its records exists');
      // An update stands on a conversation like the fact does; one whose conversation is gone should have gone with it.
      for (const u of f.updates || []) if (u.record && !recs.has(u.record)) bad('stale-update', f, `an update of ${String(u.ts).slice(0, 10)} stands on a record that no longer exists`);
      // A day the gate kept stands on words quoted from its conversation; the
      // check is that the quote is really there (any language), not what it says.
      if (f.standing === 'said' && f.kind === 'status' && f.when && f.whenFrom !== undefined) {
        const r = recs.get(f.record);
        const there = r && (isVerbatim(f.whenFrom, r.text, 2) || isNearVerbatim(f.whenFrom, r.text));
        if (!there) bad('date', f, `day ${f.when} stands on "${f.whenFrom}", which is not in its conversation`);
      }
      if (f.standing === 'said') {
        const r = recs.get(f.record);
        // A fact from a conversation must have something a person said, or a
        // finding, in its record: one made of assistant lines only is a recital.
        if (r && !/\(after checking\)/.test(r.text) && !String(r.text).split('\n').some(l => { const m = l.match(/^([^:\n]{1,40}):/); return m && !bots.has(m[1].trim().toLowerCase()); })) bad('recital', f, 'its record holds no line a person said and no finding');
      }
      const key = f.key || facts.keyOf(f);
      if (key) {
        const twin = keyed.find(k => facts.sameKey(k.key, key));
        if (twin) bad('twin', f, `same key as "${twin.f.title || twin.f.text.slice(0, 40)}" (${key})`);
        else keyed.push({ key, f });
      }
    }
  }
  return out;
}
