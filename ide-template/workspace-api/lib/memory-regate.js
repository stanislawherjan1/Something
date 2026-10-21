/**
 * memory-regate — the sharing gate for a note saved mid-turn (memory_note),
 * and the night's second look at the notes that gate could not judge.
 *
 * A note in a person's own memory goes to the team, to a question, or stays,
 * by the router's reading of the person's words and lib/memory-sharing.js. The
 * router is a model call; when it fails the gate used to fall silent — the
 * note stayed private with nobody ever asked (on a production client the
 * owner's "auto" mode shared nothing for days while the model was slow). Now
 * such a note's record is tagged `ungated`, and the nightly pass judges it
 * once the model answers again.
 */
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import { route as routeWords } from './memory-router.js';
import { modeOf, decide, fileTeamFact, factKey } from './memory-sharing.js';
import { addAsk, listRules, decisions as askDecisions } from './memory-asks.js';
import { getTeamMode, list as rosterList } from './team.js';

/** The router's reading of what the person said, or null when the call failed. */
export async function routeSaid({ name, said, ts = new Date().toISOString() }) {
  try { return await routeWords({ name, channel: 'web', ts, text: `${name}: ${said}` }); } catch { return null; }
}

/**
 * Each fresh fact goes to the team, to a question, or stays — by the owner's
 * mode, rules and earlier answers. `routed` is the router's reading (routeSaid).
 * Returns how many were shared and how many wait for the owner.
 */
export async function gateFacts(slug, fresh, { routed, said, name, ts = new Date().toISOString(), conv = null, source = 'note' }) {
  const out = { shared: 0, asked: 0 };
  if (!routed || !fresh.length) return out;
  const gate = { mode: modeOf(slug), rules: listRules(slug), decided: askDecisions(slug) };
  for (const f of fresh) {
    const d = decide({ mode: gate.mode, fact: f, routed, rules: gate.rules, decided: gate.decided });
    if (d.outcome === 'team') {
      const r = await fileTeamFact(slug, f, { ts, conv, source, name, by: source });
      if (r.recordId) out.shared++;
    } else if (d.outcome === 'ask') {
      addAsk(slug, { text: f.text, question: routed.askQuestion || '', conv, ts, source, fact: f, reason: d.reason, key: factKey(f) });
      out.asked++;
    }
  }
  return out;
}

// What the person said, as the note's record holds it: the words alone, or
// the note with "(said: …)" under it (routes/memory-v4.js, the note route).
function saidOf(record) {
  const m = String(record.text || '').match(/\n\n\(said: ([\s\S]*)\)$/);
  return m ? m[1] : String(record.text || '');
}

/**
 * The night's pass over notes the gate could not judge: each `ungated` record
 * in a person's own memory is routed once more and its current facts go
 * through the gate; the tag comes off whether something was offered or not.
 * A router that fails again leaves the tag for the next night. Capped, so a
 * long outage is worked off over a few nights.
 */
export async function regateUngated({ cap = 20, now = Date.now(), log = () => {} } = {}) {
  const out = { records: 0, shared: 0, asked: 0, left: 0 };
  if (!getTeamMode()) return out;
  let budget = cap;
  for (const m of rosterList()) {
    if (budget <= 0) break;
    const slug = m.slug;
    if (!slug) continue;
    const scope = `user:${slug}`;
    const todo = ledger.read({ scopes: [scope] }).filter(r => r.tags?.ungated).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const name = m.displayName || slug;
    const done = new Set();
    for (const r of todo) {
      if (budget <= 0) { out.left++; continue; }
      budget--;
      const routed = await routeSaid({ name, said: saidOf(r), ts: r.ts });
      if (!routed) { out.left++; log(`regate ${scope}: the router did not answer for ${r.id}; kept for tomorrow`); continue; }
      const fresh = facts.all(scope).filter(f => f.record === r.id && !f.hidden && !f.replacedBy && !f.retired);
      try {
        const g = await gateFacts(slug, fresh, { routed, said: saidOf(r), name, ts: new Date(now).toISOString(), conv: r.conv || null });
        out.shared += g.shared; out.asked += g.asked; out.records++;
      } catch (e) { log(`regate ${scope}: ${r.id}: ${e.message}`); }
      done.add(r.id);
    }
    if (done.size) await ledger.retag(scope, (r) => (done.has(r.id) ? Object.fromEntries(Object.entries(r.tags || {}).filter(([k]) => k !== 'ungated')) : null));
  }
  return out;
}
