/**
 * 0102 — facts move out of records into their own store.
 *
 * Until now a fact was a note inside the record of the conversation it came
 * from, known by its place (`recordId:index`), and "replaced" pointed at a
 * RECORD — so a record that held no note could retire a fact, and three writers
 * each kept the bookkeeping their own way. lib/memory-facts.js keeps facts in
 * `facts.jsonl` next to each scope's ledger: append-only events, a stable id per
 * fact, "replaced" pointing at the fact that took its place.
 *
 * Structural, automatic at boot once the workspace is on v4: for every scope
 * without a facts file, the notes its records carry are written as events
 * (ids `<recordId>n<index>`; sources, replacements and hides carried over; a
 * replacement that pointed at a record holding no note is dropped — that was
 * the bug). Records are not touched: their notes stay as they were, and the
 * store reads them on the fly for a scope that has no file, so nothing reads
 * differently before or after. Verify: every scope has its file and the same
 * number of facts as its records' notes.
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ledger from '../lib/memory-ledger.js';
import * as facts from '../lib/memory-facts.js';
const noteCount = (scope) => ledger.read({ scopes: [scope], includeHidden: true }).reduce((n, r) => n + (r.notes || []).filter(x => x?.text).length, 0);

export default {
  id: '0102-facts-store',
  title: 'Facts get their own store, with a stable id each',
  kind: 'structural',
  enabled: (ctx) => ctx.flag !== 'off' && existsSync(join(ctx.memoryDir, '_engine', '.v4-migrated')),
  paths: (ctx) => ledger.allScopes().map(s => relative(ctx.projectDir, facts.factsPath(s))),
  check: async () => {
    const todo = ledger.allScopes().filter(s => !existsSync(facts.factsPath(s)));
    return { needed: todo.length > 0, summary: todo.length ? `${todo.length} scope(s) without a facts file: ${todo.join(', ')}` : 'every scope has its facts file' };
  },
  plan: async () => {
    return {
      summary: 'write each scope\'s notes as fact events into facts.jsonl next to its ledger; records stay as they are',
      actions: ledger.allScopes().filter(s => !existsSync(facts.factsPath(s))).map(s => ({ op: 'write', path: facts.factsPath(s), detail: `${noteCount(s)} note(s)` })),
    };
  },
  apply: async (ctx) => {
    let changed = 0;
    for (const s of ledger.allScopes()) {
      if (existsSync(facts.factsPath(s))) continue;
      const n = await facts.materialiseScope(s);
      ctx.log(`0102: ${s} — ${n} fact(s)`);
      changed++;
    }
    return { changed };
  },
  verify: async () => {
    const problems = [];
    for (const s of ledger.allScopes()) {
      if (!existsSync(facts.factsPath(s))) { problems.push(`${s}: no facts file`); continue; }
      const want = noteCount(s);
      const got = facts.all(s).filter(f => /^[0-9a-z]+n\d+$/.test(f.id)).length;
      if (got < want) problems.push(`${s}: ${got} of ${want} notes became facts`);
    }
    return { ok: problems.length === 0, problems };
  },
};
