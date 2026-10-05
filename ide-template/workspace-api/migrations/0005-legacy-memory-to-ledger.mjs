/**
 * 0005 — the old memory moves into the v4 ledger, and leaves memory/.
 *
 * Every page (topics/, concepts/, and any other folder of notes) and the private
 * cards that are not loaded any more (USER_RELATIONSHIPS, USER_REFLECTIONS)
 * become ledger records in the scope they were in: the shared tree → shared,
 * memory/users/<slug>/ → that person. One record per page section (at most five
 * claims each), dated by the newest "[Source: …, YYYY-MM-DD]" stamp in it (else
 * the file's mtime), the claims kept as its notes. Generated files (INDEX,
 * USER_INDEX, the RECENT tails) go without a record — they were only views.
 * RESPONSIBILITIES goes once that person has routines.json (0004).
 *
 * The cards v4 still loads stay where they are (AGENT_IDENTITY, AGENT_TOOLS,
 * RULES, CHANNELS, USER_PROFILE, USER_PREFERENCES), and TEAM / MISSION too.
 *
 * Content migration: never automatic. Owner decision (2026-09-29): no legacy
 * period — the old files leave the product here; the person downloads a backup
 * of what they can read, and the operator keeps the full archive in the store for
 * 30 days (bin/migrate.mjs rollback). Applying it also switches the deployment to
 * v4 (the stamp below), unless MEMORY_V4=off.
 *
 * A seed template nobody edited (the cards and the two ABOUT pages the image
 * copies into a new workspace, byte for byte) is a view, not content: it goes
 * without a record. A workspace where nothing else would move — a fresh one —
 * has no old memory to review, so boot applies this by itself (`trivial`) and
 * the deployment starts on v4; the owner's decision is kept for workspaces
 * that hold something someone wrote.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ledger from '../lib/memory-ledger.js';
import { CARDS } from '../lib/memory-registry.js';
import { routinesPath } from '../lib/routines-store.js';
import { primaryAdminSlug } from '../lib/team.js';

export const STAMP = '_engine/.v4-migrated';

const KEEP = new Set(['AGENT_IDENTITY.md', 'AGENT_TOOLS.md', 'RULES.md', 'CHANNELS.md', 'USER_PROFILE.md', 'USER_PREFERENCES.md', 'TEAM.md', 'MISSION.md']);
const GENERATED = new Set(CARDS.filter(c => c.machine && !KEEP.has(c.file)).map(c => c.file));   // INDEX, RECENT_*
const V4_DIRS = new Set(['_engine', 'ledger', 'views', 'groups']);
const TEMPLATES_DIR = () => process.env.MEMORY_TEMPLATES_DIR || '/opt/ide/bootstrap/memory-cards-templates';

/** Is this legacy file the shipped template, untouched? (users/<slug>/X.md is seeded from X.md.) */
function untouchedTemplate(abs, rel, owner) {
  const inTree = owner ? rel.split(sep).slice(3).join(sep) : rel.split(sep).slice(1).join(sep);   // memory/[users/<slug>/]…
  const tpl = join(TEMPLATES_DIR(), inTree);
  try { return existsSync(tpl) && readFileSync(tpl).equals(readFileSync(abs)); } catch { return false; }
}
const CLAIMS_PER_RECORD = 5;
const DATE_RE = /\[Source:[^\]]*?(\d{4}-\d{2}-\d{2})[^\]]*\]/i;

/** Every legacy .md file with its fate: 'migrate' | 'drop' | 'keep'. */
function inventory(ctx) {
  const out = [];
  const walk = (dir, owner, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && e.name === 'users') {
          for (const u of readdirSync(abs, { withFileTypes: true })) {
            if (u.isDirectory() && /^[a-z0-9-]+$/.test(u.name) && u.name !== 'default') walk(join(abs, u.name), u.name, 1);
          }
          continue;
        }
        if (depth <= 1 && V4_DIRS.has(e.name)) continue;
        walk(abs, owner, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const top = depth === 0 || (owner && depth === 1);   // a card sits at the top of its tree
      let fate = 'migrate';
      if (top && KEEP.has(e.name)) fate = 'keep';
      else if (top && GENERATED.has(e.name)) fate = 'drop';
      else if (untouchedTemplate(abs, relative(ctx.projectDir, abs), owner)) fate = 'drop';
      else if (top && e.name === 'RESPONSIBILITIES.md') {
        // Duties leave only once they live in routines.json (0004); otherwise the card stays.
        const who = owner || (ctx.teamMode ? null : 'default');
        fate = who && existsSync(routinesPath(who)) ? 'drop' : 'keep';
      }
      out.push({ abs, rel: relative(ctx.projectDir, abs), owner, fate });
    }
  };
  walk(ctx.memoryDir, null, 0);
  return out;
}


/** A page → records: one per section, ≤ 5 claims each, dated by its newest stamp. */
export function pageRecords(md, { title, mtime }) {
  const body = md.replace(/^---[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  const fm = md.match(/^---[\s\S]*?\ntitle:\s*(.+)\n[\s\S]*?---\n/);
  const name = (fm?.[1] || title).trim();
  const sections = [];
  let cur = { heading: '', claims: [], prose: [] };
  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { if (cur.claims.length || cur.prose.length) sections.push(cur); cur = { heading: h[1].replace(/^#+\s*/, '').trim(), claims: [], prose: [] }; continue; }
    if (/^\s*[-*]\s+\S/.test(line)) cur.claims.push(line.replace(/^\s*[-*]\s+/, '').trim());
    else if (line.trim() && !/^~~.*~~$/.test(line.trim())) cur.prose.push(line.trim());
  }
  if (cur.claims.length || cur.prose.length) sections.push(cur);
  // A page with claims: the prose before its first heading is the page's intro
  // (the engine seeds one on every page), not a claim of its own.
  const hasClaims = sections.some(x => x.claims.length);
  const out = [];
  for (const s of sections.filter(x => !(hasClaims && !x.heading && !x.claims.length))) {
    const heading = s.heading && s.heading.toLowerCase() !== name.toLowerCase() ? `${name} — ${s.heading}` : name;
    const groups = [];
    for (let i = 0; i < s.claims.length; i += CLAIMS_PER_RECORD) groups.push(s.claims.slice(i, i + CLAIMS_PER_RECORD));
    if (!groups.length) groups.push([]);
    groups.forEach((claims, gi) => {
      const prose = gi === 0 ? s.prose.join('\n').slice(0, 1500) : '';
      const dates = claims.map(c => c.match(DATE_RE)?.[1]).filter(Boolean).sort();
      const clean = claims.map(c => c.replace(/\s*\[Source:[^\]]*\]\s*$/i, '').trim()).filter(Boolean);
      const text = [`${heading}`, prose, ...clean.map(c => `- ${c}`)].filter(Boolean).join('\n').slice(0, 11000);
      if (text.trim() === heading.trim()) return;
      out.push({
        ts: dates.length ? `${dates[dates.length - 1]}T12:00:00.000Z` : new Date(mtime).toISOString(),
        text,
        notes: clean.slice(0, 5).map(c => ({ text: c.slice(0, 300), kind: 'fact', evidence: c.slice(0, 300) })),
        section: s.heading || null,
      });
    });
  }
  return { name, records: out };
}

/**
 * Team mode: the shared tree was team-visible already → shared; a person's tree →
 * theirs. Solo: everything flat belonged to the one person → their own scope, so
 * switching team mode on later exposes nothing they never shared.
 */
function scopeOf(ctx, owner) {
  if (owner) return `user:${owner}`;
  if (ctx.teamMode) return 'shared';
  const admin = primaryAdminSlug();
  return admin && admin !== 'default' ? `user:${admin}` : 'shared';
}

function titleOf(rel) {
  const base = rel.split(sep).pop().replace(/\.md$/, '');
  return /^[A-Z_]+$/.test(base) ? base : base.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function planFor(ctx) {
  const inv = inventory(ctx);
  const actions = [];
  let records = 0;
  for (const f of inv) {
    if (f.fate === 'keep') continue;
    if (f.fate === 'drop') {
      const detail = untouchedTemplate(f.abs, f.rel, f.owner) ? 'untouched template' : /RESPONSIBILITIES\.md$/.test(f.rel) ? 'duties live in routines.json' : 'generated view';
      actions.push({ op: 'remove', path: f.rel, detail });
      continue;
    }
    const { records: recs } = pageRecords(readFileSync(f.abs, 'utf8'), { title: titleOf(f.rel), mtime: statSync(f.abs).mtimeMs });
    records += recs.length;
    actions.push({ op: 'move', path: f.rel, detail: `${recs.length} record(s) → ${scopeOf(ctx, f.owner)}` });
  }
  return { inv, actions, records };
}

export default {
  id: '0005-legacy-memory-to-ledger',
  title: 'The old memory moves into the new one',
  kind: 'content',
  enabled: (ctx) => ctx.flag !== 'off',
  // Nothing anyone wrote would move or go — a fresh workspace: only untouched
  // templates and generated views. Boot may apply it. A duties card someone
  // filled in is theirs to let go of, even with its routines already moved.
  trivial: (ctx) => !existsSync(join(ctx.memoryDir, STAMP)) && planFor(ctx).actions.every(a => a.op === 'remove' && a.detail !== 'duties live in routines.json'),
  // Everything under memory/: the legacy files leave it and the ledger grows.
  paths: () => ['memory'],
  inputs: (ctx) => planFor(ctx).inv.filter(f => f.fate !== 'keep').map(f => f.rel),
  check: (ctx) => {
    if (existsSync(join(ctx.memoryDir, STAMP))) return { needed: false, summary: 'already moved' };
    const p = planFor(ctx);
    const moving = p.actions.filter(a => a.op === 'move').length;
    return { needed: true, summary: moving ? `${moving} page(s) → ${p.records} record(s)` : 'nothing to move; switch to the new memory' };
  },
  plan: (ctx) => {
    const p = planFor(ctx);
    return {
      summary: `${p.actions.filter(a => a.op === 'move').length} page(s) become ${p.records} ledger record(s); ${p.actions.filter(a => a.op === 'remove').length} generated file(s) removed`,
      records: p.records,
      actions: p.actions,
    };
  },
  apply: async (ctx) => {
    const p = planFor(ctx);
    let appended = 0, removed = 0;
    for (const f of p.inv) {
      if (f.fate === 'keep') continue;
      if (f.fate === 'migrate') {
        const { name, records } = pageRecords(readFileSync(f.abs, 'utf8'), { title: titleOf(f.rel), mtime: statSync(f.abs).mtimeMs });
        const scope = scopeOf(ctx, f.owner);
        for (const r of records) {
          const out = await ledger.append({
            scope, source: 'migration', ts: r.ts, conv: `migration:${f.rel}${r.section ? `#${r.section}` : ''}`,
            text: r.text, notes: r.notes,
            tags: { page: f.rel, entities: /^[A-Z_]+$/.test(name) ? [] : [{ name }] },   // kind unknown: it does not vote
          });
          if (out.ok) appended++;
        }
      }
      rmSync(f.abs, { force: true });
      removed++;
    }
    mkdirSync(join(ctx.memoryDir, '_engine'), { recursive: true });
    writeFileSync(join(ctx.memoryDir, STAMP), JSON.stringify({ at: new Date().toISOString(), appended, removed }) + '\n');
    return { changed: removed, appended, removed };
  },
  verify: (ctx) => {
    const problems = [];
    if (!existsSync(join(ctx.memoryDir, STAMP))) problems.push('stamp missing');
    const left = inventory(ctx).filter(f => f.fate !== 'keep');
    if (left.length) problems.push(`${left.length} legacy file(s) left: ${left.slice(0, 5).map(f => f.rel).join(', ')}`);
    for (const f of inventory(ctx).filter(x => x.fate === 'keep')) {
      if (!existsSync(f.abs)) problems.push(`kept card missing: ${f.rel}`);
    }
    return { ok: problems.length === 0, problems };
  },
};
