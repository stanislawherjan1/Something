/**
 * 0006 — the cards v4 still loads are sorted into what belongs on them.
 *
 * After the move (0005), USER_PROFILE, USER_PREFERENCES and RULES were left as
 * they were, because v4 loads them into every turn. On the canary they had
 * become the place everything went: dated facts and live statuses on the
 * profile, one-off task instructions among the preferences, tool tips in RULES,
 * and the same fact stated twice as it changed. One labelling call per card
 * (lib/memory-cards-v4.js) sorts every bullet: profile and standing preferences
 * stay; facts, statuses and projects become dated ledger records (a project is a
 * Topics tile already); tool tips go to AGENT_TOOLS; team rules stay in RULES;
 * a later duplicate is dropped (the earlier line stays). A kept line is the
 * original bullet, verbatim. Lines the model does not label keep their card.
 *
 * The routines file's `unparsed` lines go through the same sorter: a fact that
 * the bot once wrote on the duties card becomes a record, a duty written in
 * another shape becomes a routine, and `unparsed` ends up empty.
 *
 * Content migration: never automatic; planned and applied from the upgrade bar
 * or bin/migrate.mjs, backed up first. Runs once (a stamp), only on v4.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ledger from '../lib/memory-ledger.js';
import { sortCard, destinationOf, bullets, isSystemSelfDescription, batchCount, plainText } from '../lib/memory-cards-v4.js';
import { readRoutines, writeRoutines, parseLegacyCard, routinesPath } from '../lib/routines-store.js';
import { primaryAdminSlug, list as rosterList, memberGroupsOf } from '../lib/team.js';
import { updateDigest } from '../lib/memory-views.js';
import { atomicWrite } from '../lib/atomic-write.js';

export const STAMP = '_engine/.cards-v4';
const USER_CARDS = ['USER_PROFILE', 'USER_PREFERENCES'];
const SHARED_CARDS = ['RULES'];

function people(ctx) {
  return ctx.teamMode ? ctx.roster.filter(s => s && s !== 'default') : [primaryAdminSlug()].filter(s => s && s !== 'default');
}
function nameOf(slug) {
  try { return rosterList().find(u => u.slug === slug)?.displayName || slug; } catch { return slug; }
}
/** [{ card, slug|null, abs, rel, scope }] for every card file that exists. */
function cards(ctx) {
  const out = [];
  for (const slug of people(ctx)) {
    const dir = ctx.teamMode ? join(ctx.memoryDir, 'users', slug) : ctx.memoryDir;
    for (const card of USER_CARDS) {
      const abs = join(dir, `${card}.md`);
      if (existsSync(abs)) out.push({ card, slug, abs, rel: relative(ctx.projectDir, abs), scope: `user:${slug}` });
    }
  }
  for (const card of SHARED_CARDS) {
    const abs = join(ctx.memoryDir, `${card}.md`);
    if (existsSync(abs)) out.push({ card, slug: null, abs, rel: relative(ctx.projectDir, abs), scope: 'shared' });
  }
  return out;
}
/** Per person, the routines file's `unparsed` lines as a card body: [{ slug, key, store, md }]. */
function unparsedRoutines(ctx) {
  const out = [];
  for (const slug of people(ctx)) {
    const key = ctx.teamMode ? slug : 'default';
    if (!existsSync(routinesPath(key))) continue;
    const store = readRoutines(key);
    if (!store.unparsed.length) continue;
    out.push({ slug, key, store, md: `## Responsibilities\n${store.unparsed.map(l => (/^[-*]\s/.test(l) ? l : `- ${l}`)).join('\n')}\n` });
  }
  return out;
}

/**
 * Where a sorted bullet goes: destinationOf, with two rules only the card can
 * decide. A shared card has no person to hand a profile or preference line to
 * (in team mode the flat USER_* files are loaded by nothing) — on the canary
 * RULES held "never message for a run meant to be silent", a rule for the bot
 * in front of everyone, so such a line stays where it is. And a duplicate is
 * dropped only when the model said which earlier line it repeats; without
 * that, it becomes a dated record and nothing is lost.
 */
function destFor(c, b) {
  const d = destinationOf(b.kind, c.card);
  if (!c.slug && (d === 'USER_PROFILE' || d === 'USER_PREFERENCES')) return c.card;
  if (b.kind === 'duplicate' && !(Number.isInteger(b.by) && b.by > 0 && b.by < b.n)) return null;
  return d;
}

/** Rebuild a card body from the bullets that stay, under their original sections. */
function rebuild(md, keep) {
  const fm = md.match(/^---[\s\S]*?\n---\n/)?.[0] || '';
  const title = md.replace(fm, '').match(/^#\s+.*$/m)?.[0] || '';
  const bySection = new Map();
  for (const b of keep) {
    if (!bySection.has(b.section)) bySection.set(b.section, []);
    bySection.get(b.section).push(b.line);
  }
  const parts = [fm, title, ''];
  for (const [section, lines] of bySection) {
    if (section) parts.push(`## ${section}`);
    parts.push(...lines, '');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

function appendToCard(abs, section, lines) {
  let md = '';
  try { md = readFileSync(abs, 'utf8'); } catch { md = `# ${abs.split('/').pop().replace(/\.md$/, '')}\n`; }
  const block = `\n## ${section}\n${lines.join('\n')}\n`;
  atomicWrite(abs, md.replace(/\s*$/, '\n') + block);
}

/** Sort every card + the unparsed routine lines; the plan is this, apply does it. */
async function sortAll(ctx, runner) {
  // Progress: the denominator is known before the first call (batches per
  // card + per scope of migrated notes), so the screen never shows a bare spinner.
  const cardList = cards(ctx).map(c => ({ ...c, md: readFileSync(c.abs, 'utf8') }));
  const unparsedList = unparsedRoutines(ctx);
  const scopes = migratedScopes();
  const total = [...cardList, ...unparsedList, ...scopes].reduce((n, x) => n + batchCount(x.md), 0) + 1;
  let done = 0;
  const tick = (label) => { done++; ctx.progress?.(done, total, label); };
  ctx.progress?.(0, total, 'Sorting the cards');
  const hooks = { runner, shouldStop: ctx.shouldStop || null };
  const out = [];
  for (const c of cardList) {
    const sorted = await sortCard({ card: c.card, md: c.md, name: c.slug ? nameOf(c.slug) : 'the team', ...hooks, onBatch: () => tick(`Sorting ${c.card}`) });
    out.push({ ...c, sorted, failures: sorted.failures || [] });
  }
  const routines = [];
  for (const u of unparsedList) {
    const sorted = await sortCard({ card: 'RESPONSIBILITIES', md: u.md, name: nameOf(u.slug), ...hooks, onBatch: () => tick('Sorting the routines card') });
    routines.push({ ...u, sorted });
  }
  // The migrated notes, labelled once here; the labels travel in the plan so
  // apply reuses them instead of paying for every call a second time.
  const resort = [];
  for (const sc of scopes) {
    const sorted = sc.md ? await sortCard({ card: 'MIGRATED', md: sc.md, name: sc.scope.startsWith('user:') ? nameOf(sc.scope.slice(5)) : 'the team', ...hooks, onBatch: () => tick(`Sorting remembered facts (${sc.scope.startsWith('user:') ? nameOf(sc.scope.slice(5)) : 'team'})`) }) : [];
    const labels = {};   // note text → { kind, by (date), byId (the record that supersedes it) }
    sorted.forEach((b, i) => { labels[sc.lines[i].text] = { kind: b.kind, by: b.by ? sc.lines[b.by - 1]?.ts || null : null, byId: b.by ? sc.lines[b.by - 1]?.id || null : null }; });
    const kinds = sc.all.map(l => (l.self ? 'self' : labels[l.text]?.kind || null));
    const unsorted = kinds.filter(k => k === null).length;   // a failed batch: these stay, unsorted
    const keptN = kinds.filter(k => k === 'fact' || k === 'status').length + unsorted;
    const sup = kinds.filter(k => k === 'superseded').length;
    resort.push({ scope: sc.scope, total: sc.all.length, kept: keptN, unsorted, superseded: sup, dropped: sc.all.length - keptN - sup, labels });
  }
  tick('Done sorting');
  return { cards: out, routines, resort };
}

/** Per scope: the migrated notes to label (self-description already excluded) and all of them. */
function migratedScopes() {
  const out = [];
  for (const scope of ledger.allScopes()) {
    const recs = ledger.read({ scopes: [scope], includeHidden: true }).filter(r => r.source === 'migration' && r.notes?.length);
    const all = [], lines = [];
    for (const r of recs) {
      const page = String(r.conv || '').replace(/^migration:/, '').split('#')[0];
      for (const n of r.notes || []) {
        const self = isSystemSelfDescription({ page, text: n.text });
        all.push({ text: n.text, self });
        if (!self) lines.push({ text: n.text, ts: r.ts.slice(0, 10), id: r.id });
      }
    }
    if (all.length) out.push({ scope, all, lines, md: lines.length ? `## Notes\n${lines.map(l => `- ${l.text}`).join('\n')}\n` : '' });
  }
  return out;
}

/**
 * Re-sort the notes of migrated records in every scope: keep fact/status notes
 * and project entities, drop the rest from the Facts and Topics views. Batched
 * per scope (one sorter call per 12 notes). Returns the number of records changed.
 */
async function resortMigrated(ctx, all, only) {
  let changed = 0;
  for (const entry of all.resort) {
    const scope = entry.scope;
    const recs = ledger.read({ scopes: [scope], includeHidden: true }).filter(r => r.source === 'migration' && only.has(r.id) && (r.notes?.length || r.tags?.entities?.length));
    if (!recs.length) continue;
    // Labels come from the plan (or this run's sortAll), keyed by the note's
    // text: rewriteMeta re-reads records from disk, so identity would miss.
    const kind = (n) => entry.labels[n?.text]?.kind;
    const sup = new Map(Object.entries(entry.labels).filter(([, v]) => v.kind === 'superseded').map(([t, v]) => [t, v]));
    const r = await ledger.rewriteMeta(scope, (rec) => {
      if (rec.source !== 'migration' || !only.has(rec.id)) return null;
      // Kept as Facts rows: facts and statuses — and superseded ones, pointing
      // at the record that replaced them, so they fold as past only while that
      // record exists (erase the newer and the older is current again).
      // Self-description and unlabelled notes leave the views; the record's
      // text is untouched.
      const page = String(rec.conv || '').replace(/^migration:/, '').split('#')[0];
      const notes = (rec.notes || []).flatMap(n => {
        // The old wiki's notes to itself never reach the views; otherwise no
        // label (a sorter batch that failed) keeps the note: the safe outcome,
        // as for a card line — never a fact gone with no trace.
        if (isSystemSelfDescription({ page, text: n.text })) return [];
        const k = kind(n);
        if (k == null || k === 'fact' || k === 'status') return [n];
        if (k === 'superseded') return [{ ...n, superseded: sup.get(n.text)?.by || rec.ts.slice(0, 10), supersededBy: sup.get(n.text)?.byId || null }];
        return [];
      });
      // A page whose notes describe a project IS that project's topic: its own
      // title (the record's first line, "Beacon App — Claims") becomes the
      // project entity — never a name guessed out of a sentence.
      const pageTitle = String(rec.text).split('\n')[0].split(/\s+[—–]\s+/)[0].trim().slice(0, 60);
      const isProject = (rec.notes || []).some(n => kind(n) === 'project');
      // A page-title entity survives only when a kept note names it; the project
      // entity is added by construction, after that filter.
      const keptText = notes.map(n => n.text.toLowerCase()).join('\n');
      const entities = (rec.tags?.entities || []).filter(e => { const nm = (typeof e === 'string' ? e : e?.name || '').toLowerCase(); return nm && keptText.includes(nm.split(' ')[0]); });
      if (isProject && pageTitle && !entities.some(e => (e.name || e).toLowerCase() === pageTitle.toLowerCase())) entities.push({ name: pageTitle, kind: 'project' });
      return { notes, tags: { ...(rec.tags || {}), entities } };
    }, 'resort-migrated');
    changed += r.changed;
  }
  return changed;
}

/** `all` as sortAll would return it, from the plan's stored labels — no model calls. */
function reuseLabels(ctx, labels) {
  const byRel = new Map(labels.cards.map(c => [c.rel, c.kinds]));
  const out = [];
  for (const c of cards(ctx)) {
    const md = readFileSync(c.abs, 'utf8');
    const kinds = new Map((byRel.get(c.rel) || []).map(k => [k.n, k]));
    const sorted = bullets(md).map(b => ({ ...b, kind: kinds.get(b.n)?.kind ?? null, expires: kinds.get(b.n)?.expires ?? null, by: kinds.get(b.n)?.by ?? null }));
    out.push({ ...c, md, sorted });
  }
  const byKey = new Map(labels.routines.map(r => [r.key, r.kinds]));
  const routines = [];
  for (const u of unparsedRoutines(ctx)) {
    const kinds = new Map((byKey.get(u.key) || []).map(k => [k.n, k]));
    routines.push({ ...u, sorted: bullets(u.md).map(b => ({ ...b, kind: kinds.get(b.n)?.kind ?? null })) });
  }
  const resort = labels.resort.map(r => ({ scope: r.scope, labels: r.labels }));
  ctx.progress?.(1, 1, 'Using the sorted plan');
  return { cards: out, routines, resort };
}

function planOf(all) {
  const actions = [];
  let toLedger = 0, dropped = 0, moved = 0, kept = 0;
  for (const r of all.resort || []) {
    actions.push({ op: 'resort', path: r.scope, detail: `${r.total} migrated note(s): ${r.kept} stay as facts${r.unsorted ? ` (${r.unsorted} could not be sorted and stay as they are)` : ''}, ${r.superseded} marked superseded, ${r.dropped} leave the views (specs, logs, the old wiki's notes to itself)` });
  }
  for (const c of all.cards) {
    const counts = {};
    for (const b of c.sorted) {
      const d = destFor(c, b);
      const k = d === null ? 'ledger' : d === 'drop' ? 'dropped' : d === c.card ? 'kept' : `→ ${d}`;
      counts[k] = (counts[k] || 0) + 1;
      if (d === null) toLedger++; else if (d === 'drop') dropped++; else if (d === c.card) kept++; else moved++;
    }
    const failed = c.failures?.length ? `; ${c.failures.length} batch(es) could not be sorted — their lines stay on the card` : '';
    actions.push({ op: 'sort', path: c.rel, detail: Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') + failed });
  }
  for (const r of all.routines) {
    let facts = 0, duties = 0, untitled = 0;
    for (const b of r.sorted) {
      const d = destinationOf(b.kind, 'RESPONSIBILITIES');
      if (d === null) facts++;
      else if (d === 'drop') continue;
      // Only a line in the duty grammar can become a routine by itself; one
      // without a title waits for the owner to give it one on the Routines screen.
      else if (parseLegacyCard(`## Responsibilities\n- ${b.text}`).routines[0]) duties++;
      else untitled++;
    }
    actions.push({ op: 'sort', path: `.team/users/${r.key}/routines.json`, detail: `${r.sorted.length} unparsed line(s): ${facts} → ledger, ${duties} routine(s), ${untitled} still need a title` });
  }
  return { actions, toLedger, dropped, moved, kept };
}

export default {
  id: '0006-cards-v4',
  title: 'The cards are sorted: profile and preferences stay, facts and projects move to memory',
  kind: 'content',
  enabled: (ctx) => ctx.flag !== 'off' && existsSync(join(ctx.memoryDir, '_engine', '.v4-migrated')),
  paths: () => ['memory'],
  inputs: (ctx) => [...cards(ctx).map(c => c.rel), ...people(ctx).map(s => relative(ctx.projectDir, routinesPath(ctx.teamMode ? s : 'default'))).filter(r => existsSync(join(ctx.projectDir, r)))],
  check: (ctx) => {
    if (existsSync(join(ctx.memoryDir, STAMP))) return { needed: false, summary: 'already sorted' };
    const n = cards(ctx).reduce((s, c) => s + bullets(readFileSync(c.abs, 'utf8')).length, 0);
    return { needed: n > 0, summary: n ? `${n} card line(s) to sort` : 'no card lines' };
  },
  plan: async (ctx) => {
    const all = await sortAll(ctx, ctx.runner);
    const p = planOf(all);
    // The labels ride along so apply does not sort everything a second time.
    const labels = { cards: all.cards.map(c => ({ rel: c.rel, kinds: c.sorted.map(b => ({ n: b.n, kind: b.kind, expires: b.expires, by: b.by })) })), routines: all.routines.map(r => ({ key: r.key, kinds: r.sorted.map(b => ({ n: b.n, kind: b.kind })) })), resort: all.resort.map(r => ({ scope: r.scope, labels: r.labels })) };
    return { summary: `${p.kept} line(s) stay on their card, ${p.toLedger} become dated memory records, ${p.moved} move to another card, ${p.dropped} duplicate(s) dropped`, actions: p.actions, ...p, labels };
  },
  apply: async (ctx, plan) => {
    // Records that exist before this apply are the move's (0005); the ones this
    // apply appends were just judged and must not be re-sorted afterwards.
    const before = new Set(ledger.read({ scopes: ledger.allScopes(), includeHidden: true }).map(r => r.id));
    const all = plan?.labels ? reuseLabels(ctx, plan.labels) : await sortAll(ctx, ctx.runner);
    let appended = 0, rewritten = 0;
    const today = new Date().toISOString().slice(0, 10);
    // Lines moving to another card are appended only after EVERY card has
    // been rebuilt: a card is rebuilt from the snapshot read before the apply,
    // and an append made before its rebuild was lost with the snapshot (a
    // profile line moved to the preferences vanished that way on the canary).
    const pending = [];
    for (const c of all.cards) {
      const keep = [], moves = new Map();
      // A line that states no date was on the card by the time the card last
      // changed: that is its record's date, marked undated ("known by"), never
      // today — the card is read before it is rewritten below.
      let knownBy = `${today}T12:00:00.000Z`;
      try { knownBy = statSync(c.abs).mtime.toISOString(); } catch { /* the stamp above */ }
      for (const b of c.sorted) {
        const d = destFor(c, b);
        if (d === c.card) { keep.push(b); continue; }
        if (d === 'drop') continue;
        if (d === null) {
          // The card line was markdown ("**Beacon** — see [[beacon]]"); a note
          // is plain text, shown as it is. The bold name still names the project.
          const text = plainText(b.text);
          const notes = [{ text, kind: b.kind === 'status' ? 'status' : 'fact', expires: b.expires || null, evidence: text, ...(b.date ? {} : { undated: true }) }];
          const tags = b.kind === 'project' ? { entities: [{ name: b.text.match(/\*\*([^*]+)\*\*/)?.[1] || text.split(/[—–:(]/)[0].trim().slice(0, 60), kind: 'project' }] } : {};
          const r = await ledger.append({ scope: c.scope, source: 'migration', ts: b.date ? `${b.date}T12:00:00.000Z` : knownBy, conv: `migration:${c.rel}`, text, notes, tags });
          if (r.ok) appended++;
          continue;
        }
        if (!moves.has(d)) moves.set(d, []);
        moves.get(d).push(b.line);
      }
      for (const [dest, lines] of moves) {
        const abs = dest === 'AGENT_TOOLS' || dest === 'RULES' ? join(ctx.memoryDir, `${dest}.md`) : join(c.abs, '..', `${dest}.md`);
        pending.push({ abs, section: `From ${c.card} (sorted ${today})`, lines });
      }
      atomicWrite(c.abs, rebuild(c.md, keep));
      rewritten++;
    }
    for (const p of pending) appendToCard(p.abs, p.section, p.lines);
    for (const r of all.routines) {
      const stillUnparsed = [], duties = [];
      for (const b of r.sorted) {
        const d = destinationOf(b.kind, 'RESPONSIBILITIES');
        if (d === null) {
          const text = plainText(b.text);
          const rr = await ledger.append({ scope: `user:${r.slug}`, source: 'migration', ts: `${today}T12:00:00.000Z`, conv: 'migration:routines-unparsed', text, notes: [{ text, kind: 'fact', evidence: text }] });
          if (rr.ok) appended++;
        } else if (d === 'drop') {
          continue;
        } else {
          const parsed = parseLegacyCard(`## Responsibilities\n- ${b.text}`).routines[0];
          if (parsed) duties.push({ ...parsed, source: 'card' }); else stillUnparsed.push(b.line);
        }
      }
      writeRoutines(r.key, { routines: [...r.store.routines, ...duties], unparsed: stillUnparsed });
    }
    // The move (0005) turned every page bullet into a note and every page title
    // into an entity, with no judgement — 351 of 352 notes on the canary's Facts
    // tab came from there, most of them specs, contact lines and diary entries.
    // Each migrated record's notes go through the same sorter: facts and
    // statuses stay as notes, a project stays as a topic, the rest leaves the
    // Facts tab. The record's text is untouched — retrieval still finds it.
    ctx.progress?.(0, 1, 'Rewriting the cards');
    const resorted = await resortMigrated(ctx, all, before);
    // The Facts tab folds a closed topic's facts away using the digest, which
    // is rendered nightly: render it now for each person, so the sort shows
    // its effect today. A failure here costs nothing — the night redoes it.
    let digests = 0;
    for (const slug of people(ctx)) {
      try { await updateDigest(`user:${slug}`, ledger.readableScopes({ actor: slug, memberGroups: memberGroupsOf(slug) })); digests++; }
      catch (e) { ctx.log(`digest for ${slug} after the sort: ${e.message}`); }
    }
    mkdirSync(join(ctx.memoryDir, '_engine'), { recursive: true });
    writeFileSync(join(ctx.memoryDir, STAMP), JSON.stringify({ at: new Date().toISOString(), appended, rewritten, resorted, digests }) + '\n');
    return { changed: rewritten + resorted, appended, rewritten, resorted, digests };
  },
  verify: (ctx) => {
    const problems = [];
    if (!existsSync(join(ctx.memoryDir, STAMP))) problems.push('stamp missing');
    for (const c of cards(ctx)) {
      const md = readFileSync(c.abs, 'utf8');
      if (!/^#\s/m.test(md)) problems.push(`${c.rel}: lost its title`);
    }
    return { ok: problems.length === 0, problems };
  },
};
