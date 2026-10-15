/**
 * 0008 — what the older memory still left in memory/ after the move goes.
 *
 * 0007 took the wiki trees, but the processes that wrote the rest kept running
 * after the move and brought back what it removed: the RECENT_* tails (rewritten
 * every few minutes, read by nothing once v4 renders the tail on demand), the
 * TEAM roster card, the INDEX maps, the relationships / reflections templates
 * (seeded on every boot, never loaded) and the duties card (routines.json holds
 * the duties now). Those writers stop at the move; this removes what they left.
 *
 * Structural, automatic once a workspace has moved (at boot, or right after
 * the move from the upgrade banner): everything goes into one tar.gz in the
 * migrations store (kept 30 days like the other backups), then is deleted. A
 * duties card with duties on it is left alone while its person has no
 * routines.json yet — 0004 carries it over first; the bare template just goes. Nothing that v4 reads is touched.
 */
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { routinesPath, parseLegacyCard, readRoutines } from '../lib/routines-store.js';

const CARDS = ['INDEX.md', 'RECENT_WEB.md', 'RECENT_TELEGRAM.md', 'USER_RELATIONSHIPS.md', 'USER_REFLECTIONS.md'];
const TREES = ['topics', 'concepts', 'patterns'];
const SHARED = [...CARDS, ...TREES, 'TEAM.md', '.dedupe-report.json', '_engine/.swept.json'];
const PER_USER = [...CARDS, ...TREES];

const hasRoutines = (slug) => { try { return existsSync(routinesPath(slug)); } catch { return false; } };
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Every duty on the card is in the person's routines already (0004 skips a
// person who had a routines.json before the move, so "routines exist" alone
// does not mean the card was carried over).
const carried = (path, slug) => {
  try {
    const duties = parseLegacyCard(readFileSync(path, 'utf8')).routines.map(d => norm(d.title)).filter(Boolean);
    if (!duties.length) return false;
    const have = new Set((readRoutines(slug).routines || []).map(r => norm(r.title)));
    return duties.every(t => have.has(t));
  } catch { return false; }
};
// The seeded template: no duty and nothing else written on it (its examples sit
// in a comment), so there is nothing for 0004 to carry over.
const isTemplate = (path) => {
  try { const p = parseLegacyCard(readFileSync(path, 'utf8')); return !p.routines.length && !(p.unparsed || []).some(l => String(l).trim()); }
  catch { return false; }
};

function leftovers(ctx) {
  const out = [];
  for (const r of SHARED) if (existsSync(join(ctx.memoryDir, r))) out.push(r);
  // The flat duties card is solo's ('default'), or the owner's from before team mode.
  const flat = join(ctx.memoryDir, 'RESPONSIBILITIES.md');
  if (existsSync(flat) && (isTemplate(flat) || carried(flat, 'default') || ctx.roster.some(s => carried(flat, s)))) out.push('RESPONSIBILITIES.md');
  const users = join(ctx.memoryDir, 'users');
  if (existsSync(users)) {
    for (const e of readdirSync(users, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[a-z0-9-]+$/.test(e.name)) continue;
      for (const r of PER_USER) if (existsSync(join(users, e.name, r))) out.push(`users/${e.name}/${r}`);
      const card = join(users, e.name, 'RESPONSIBILITIES.md');
      if (existsSync(card) && (isTemplate(card) || carried(card, e.name))) out.push(`users/${e.name}/RESPONSIBILITIES.md`);
    }
  }
  return out;
}

function storeDir() { return join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'migrations'); }

export default {
  id: '0008-retire-v3-leftovers',
  title: 'What the older memory left behind is archived and removed',
  kind: 'structural',
  enabled: (ctx) => ctx.flag !== 'off' && existsSync(join(ctx.memoryDir, '_engine', '.v4-migrated')),
  paths: (ctx) => leftovers(ctx).map(r => relative(ctx.projectDir, join(ctx.memoryDir, r))),
  check: (ctx) => {
    const r = leftovers(ctx);
    return { needed: r.length > 0, summary: r.length ? `${r.length} leftover(s): ${r.join(', ')}` : 'nothing left of the older memory' };
  },
  plan: (ctx) => ({
    summary: 'archive each leftover into the migrations store, then remove it from memory/',
    actions: leftovers(ctx).map(r => ({ op: 'archive+remove', path: `memory/${r}`, detail: 'kept 30 days in the store' })),
  }),
  apply: (ctx) => {
    const list = leftovers(ctx);
    if (!list.length) return { changed: 0 };
    mkdirSync(storeDir(), { recursive: true });
    const archive = join(storeDir(), `0008-v3-leftovers-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
    execFileSync('tar', ['czf', archive, '-C', ctx.memoryDir, ...list], { stdio: 'ignore' });
    for (const r of list) rmSync(join(ctx.memoryDir, r), { recursive: true, force: true });
    ctx.log(`0008: ${list.length} leftover(s) archived to ${archive}`);
    return { changed: list.length, archive };
  },
  verify: (ctx) => {
    const left = leftovers(ctx);
    return { ok: left.length === 0, problems: left.map(r => `${r} still there`) };
  },
};
