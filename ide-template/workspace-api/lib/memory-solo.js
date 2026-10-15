/**
 * When collaboration is switched on, what a solo workspace kept in shared
 * memory — the migration's records, never shared on purpose — becomes the
 * owner's private memory, so a new member does not find the owner's history
 * there. Each such record is copied into user:<owner> with its current facts
 * (one the owner already has, by its wording, is not doubled), then the shared
 * facts are erased and the shared record hidden. A fact someone shared on
 * purpose (sharedFact) and anything from another person stay shared.
 */
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';

const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function soloSharedToOwner(owner) {
  if (!owner || owner === 'default' || !/^[a-z0-9-]+$/.test(owner)) return { moved: 0, facts: 0 };
  const own = `user:${owner}`;
  const have = new Set(facts.all(own).map(f => norm(f.text)));
  const recs = ledger.read({ scopes: ['shared'] }).filter(r =>
    !r.tags?.sharedFact && r.source === 'migration' && (!r.origin || r.origin === own));
  let moved = 0, copied = 0;
  for (const r of recs) {
    const current = facts.forRecord('shared', r.id);
    const out = await ledger.append({ scope: own, source: r.source, ts: r.ts, conv: r.conv, speaker: r.speaker, text: r.text, tags: { ...(r.tags || {}) } });
    if (out.ok) {
      const add = current.filter(f => !have.has(norm(f.text)));
      for (const f of add) have.add(norm(f.text));
      if (add.length) {
        try { await facts.apply(own, add.map(f => ({ op: 'add', fact: { title: f.title, text: f.text, kind: f.kind || 'fact', subject: f.subject, entities: f.entities || [], when: f.when, expires: f.expires, about: f.about } })), { record: out.id, standing: 'said', by: 'migration', ts: r.ts }); } catch (e) { process.stderr.write(`[memory-solo] copy of ${r.id} failed, kept shared: ${e.message}\n`); continue; }
        copied += add.length;
      }
    }
    if (current.length) await facts.erase('shared', current.map(f => f.id));
    await ledger.hide('shared', r.id, 'solo-to-private');
    moved++;
  }
  if (moved) ledger.logEvent({ op: 'solo-to-private', scope: own, by: owner, records: moved, facts: copied });
  return { moved, facts: copied };
}
