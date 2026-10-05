/**
 * The routines marketplace: ready-made routines a person adds in one click.
 *
 * routines.catalog.json ships with the image (like integrations.catalog.json);
 * an optional, gitignored routines.catalog.local.json merges on top for one
 * client. An entry with `requires` (any-of integration ids) is offered only
 * while one of those integrations is connected and usable; without it, it is an
 * Everyday routine. Adding one writes an ordinary routine (source 'catalog',
 * catalogId) — the planner runs it like any other, so cadence lives in the
 * description's prose, never as a schedule in code.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as integrations from './integrations/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN  = join(__dirname, '..', 'routines.catalog.json');
const LOCAL = join(__dirname, '..', 'routines.catalog.local.json');
const ID_RE = /^[a-z0-9-]{2,60}$/;
// Marketplace filters. Order is the order the filter list shows them in.
export const CATEGORIES = [
  ['life', 'Everyday life'], ['planning', 'Planning'], ['email', 'Email'], ['calendar', 'Calendar & meetings'],
  ['sales', 'Sales & clients'], ['shop', 'Shop'], ['money', 'Money'],
  ['marketing', 'Marketing & ads'], ['content', 'Content & social'],
  ['dev', 'Dev & ops'], ['team', 'Team'], ['research', 'Research'],
];
const CATEGORY_IDS = new Set(CATEGORIES.map(([id]) => id));

let cached = null;

function validate(r, known) {
  if (!r || !ID_RE.test(r.id || '')) throw new Error(`routine catalog: bad id ${JSON.stringify(r?.id)}`);
  if (!String(r.title || '').trim()) throw new Error(`routine catalog: ${r.id} has no title`);
  if (!String(r.description || '').trim()) throw new Error(`routine catalog: ${r.id} has no description`);
  if (!String(r.summary || '').trim()) throw new Error(`routine catalog: ${r.id} has no summary`);
  if (r.recommended != null && typeof r.recommended !== 'boolean') throw new Error(`routine catalog: ${r.id} recommended must be true/false`);
  if (!CATEGORY_IDS.has(r.category)) throw new Error(`routine catalog: ${r.id} has unknown category ${JSON.stringify(r.category)}`);
  if (r.requires != null && !Array.isArray(r.requires)) throw new Error(`routine catalog: ${r.id} requires must be a list`);
  if (r.requiresAll != null && !Array.isArray(r.requiresAll)) throw new Error(`routine catalog: ${r.id} requiresAll must be a list`);
  for (const i of [...(r.requires || []), ...(r.requiresAll || [])]) {
    if (!known.has(i)) throw new Error(`routine catalog: ${r.id} requires unknown integration ${i}`);
  }
}

function read(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed?.routines)) throw new Error(`${path}: missing "routines" array`);
  return parsed.routines;
}

/** Every catalog entry (validated, ids unique), in declaration order. */
export function listAll() {
  if (cached) return cached;
  const known = new Set(integrations.listAll().map(i => i.id));
  let list = read(MAIN);
  if (existsSync(LOCAL)) {
    try {
      const local = read(LOCAL);
      const ids = new Set(local.map(r => r.id));
      list = [...list.filter(r => !ids.has(r.id)), ...local];
    } catch (err) {
      process.stderr.write(`[routines-catalog] local catalog ignored: ${err.message}\n`);
    }
  }
  const seen = new Set();
  for (const r of list) {
    validate(r, known);
    if (seen.has(r.id)) throw new Error(`routine catalog: duplicate id ${r.id}`);
    seen.add(r.id);
  }
  cached = list;
  return cached;
}

export function get(id) {
  return listAll().find(r => r.id === id) || null;
}

/**
 * The connected integration that unlocks this entry — '' for Everyday, null when
 * it can't be used yet. `requires` is any-of; `requiresAll` must all be connected.
 */
export function unlockedBy(entry, isUsable) {
  if ((entry.requiresAll || []).some(id => !isUsable(id))) return null;
  const req = entry.requires || [];
  if (!req.length) return entry.requiresAll?.[0] || '';
  return req.find(id => isUsable(id)) || null;
}

/**
 * The Marketplace for one person, grouped: Everyday first, then each connected
 * integration's routines, then the integrations not connected yet — shown, but
 * `available: false`, so the catalog doubles as a reason to connect one.
 * An entry sits under the first connected integration it accepts, else under the
 * first one it names. `added` = a live routine of theirs came from it.
 */
export function offer({ isUsable, routines }) {
  const live = new Set((routines || []).filter(r => !r.retired && r.catalogId).map(r => r.catalogId));
  const groups = new Map();
  for (const entry of listAll()) {
    const via = unlockedBy(entry, isUsable);
    const key = via === null ? (entry.requires?.[0] || entry.requiresAll[0]) : via;
    if (!groups.has(key)) {
      const integ = key ? integrations.get(key) : null;
      groups.set(key, { id: key || 'everyday', label: integ ? integ.label : 'Everyday', logo: integ?.logo || null, connected: key ? !!isUsable(key) : true, routines: [] });
    }
    const { requires, requiresAll, ...pub } = entry;
    // Every integration it works with (any of `requires`, plus all of
    // `requiresAll`), so it shows under each one's filter, not just the first.
    const works = [...(requires || []), ...(requiresAll || [])];
    groups.get(key).routines.push({ ...pub, integrations: works, added: live.has(entry.id), available: via !== null });
  }
  const all = [...groups.values()];
  const rank = (g) => (g.id === 'everyday' ? 0 : g.connected ? 1 : 2);
  return all.sort((a, b) => rank(a) - rank(b));   // stable: catalog order within a rank
}

/** Every integration the catalog mentions, for the filter list: connected first, then catalog order. */
export function integrationsInCatalog(isUsable) {
  const ids = [];
  for (const e of listAll()) for (const id of [...(e.requires || []), ...(e.requiresAll || [])]) if (!ids.includes(id)) ids.push(id);
  const list = ids.map((id) => { const i = integrations.get(id); return { id, label: i?.label || id, logo: i?.logo || null, connected: !!isUsable(id) }; });
  return [...list.filter(i => i.connected), ...list.filter(i => !i.connected)];
}

/** For tests: forget the cached catalog. */
export function _reset() { cached = null; }
