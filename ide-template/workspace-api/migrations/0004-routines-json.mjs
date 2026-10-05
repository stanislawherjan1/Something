/**
 * 0004 — routines out of memory: seed each person's `routines.json` from their
 * RESPONSIBILITIES card.
 *
 * Structural and non-destructive: the card is read, never changed — legacy memory
 * keeps reading and writing it until the v4 write path is switched on. A person
 * who already has a routines.json is left alone (it may hold edits made since).
 * Lines in the card that do not match the duty grammar are carried over in
 * `unparsed`, never dropped. Runs only when MEMORY_V4 is enabled.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { legacyCardPath, parseLegacyCard, readRoutines, routinesPath, writeRoutines } from '../lib/routines-store.js';

function people(ctx) {
  return ctx.teamMode ? ctx.roster : ['default'];
}

/** [{ slug, card, target }] for everyone who has a card but no routines.json yet. */
function todo(ctx) {
  return people(ctx)
    .map(slug => ({ slug, card: legacyCardPath(slug, { team: ctx.teamMode }), target: routinesPath(slug) }))
    .filter(x => existsSync(x.card) && !existsSync(x.target));
}

const rel = (ctx, p) => relative(ctx.projectDir, p);

export default {
  id: '0004-routines-json',
  title: 'Routines leave memory: RESPONSIBILITIES → routines.json',
  kind: 'structural',
  enabled: (ctx) => ctx.flag !== 'off',
  paths: (ctx) => people(ctx).map(s => rel(ctx, routinesPath(s))),
  inputs: (ctx) => people(ctx).map(s => rel(ctx, legacyCardPath(s, { team: ctx.teamMode }))),
  check: (ctx) => {
    const t = todo(ctx);
    return { needed: t.length > 0, summary: t.length ? `seed routines for ${t.map(x => x.slug).join(', ')}` : 'nothing to seed' };
  },
  plan: (ctx) => ({
    summary: 'parse each RESPONSIBILITIES card into routines.json (the card is not changed)',
    actions: todo(ctx).map(x => {
      const parsed = parseLegacyCard(readFileSync(x.card, 'utf8'));
      return { op: 'write', path: rel(ctx, x.target), detail: `${parsed.routines.length} routine(s), ${parsed.unparsed.length} unparsed line(s)` };
    }),
  }),
  apply: (ctx) => {
    let changed = 0;
    for (const x of todo(ctx)) {
      const parsed = parseLegacyCard(readFileSync(x.card, 'utf8'));
      writeRoutines(x.slug, { routines: parsed.routines.map(r => ({ ...r, source: 'card' })), unparsed: parsed.unparsed });
      changed++;
    }
    return { changed };
  },
  verify: (ctx) => {
    const problems = [];
    for (const slug of people(ctx)) {
      const card = legacyCardPath(slug, { team: ctx.teamMode });
      if (!existsSync(card)) continue;
      let stored;
      try { stored = readRoutines(slug); } catch (e) { problems.push(`${slug}: routines.json unreadable (${e.message})`); continue; }
      if (!existsSync(routinesPath(slug))) { problems.push(`${slug}: routines.json missing`); continue; }
      // A seed nobody has edited yet must match its card exactly; once someone edits
      // routines.json it is the source of truth and may legitimately differ.
      const parsed = parseLegacyCard(readFileSync(card, 'utf8'));
      const untouchedSeed = stored.routines.every(r => r.source === 'card');
      if (untouchedSeed && (stored.routines.length !== parsed.routines.length || stored.unparsed.length !== parsed.unparsed.length)) {
        problems.push(`${slug}: ${stored.routines.length} routine(s) stored, ${parsed.routines.length} in the card`);
      }
    }
    return { ok: problems.length === 0, problems };
  },
};
