// Adding a ready-made routine (lib/routines-catalog.js) to a person's list —
// shared by the Marketplace, the bot and the onboarding plan.
//
// A routine whose integration isn't connected yet can be kept waiting
// (`later`): it goes to routines-waiting.json next to the person's
// routines.json and is added on its own once the integration is usable, so
// a routine picked during setup is never lost to the order of the clicks.
// Waiting entries never run: only routines.json does.

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from './atomic-write.js';
import { readRoutines, writeRoutines, routinesPath } from './routines-store.js';
import { routinesOwner } from './memory-v4-writes.js';
import * as routinesCatalog from './routines-catalog.js';
import { isUsable as integrationUsable, personalKey } from './integrations/store.js';

/** A service is usable for a person when the team's is connected or their own is. */
export const usableFor = (slug) => (id) => integrationUsable(id) || (!!slug && slug !== 'default' && integrationUsable(personalKey(id, slug)));

const waitingPath = (owner) => join(dirname(routinesPath(owner)), 'routines-waiting.json');

export function readWaiting(owner) {
  try {
    const list = JSON.parse(readFileSync(waitingPath(owner), 'utf8'));
    return Array.isArray(list) ? list.filter((w) => w && typeof w.id === 'string') : [];
  } catch { return []; }
}

function writeWaiting(owner, list) {
  const p = waitingPath(owner);
  if (!list.length) { try { unlinkSync(p); } catch { /* already gone */ } return; }
  atomicWrite(p, JSON.stringify(list, null, 2) + '\n');
}

function addNow(owner, entry) {
  const store = readRoutines(owner);
  const have = store.routines.find(r => !r.retired && r.catalogId === entry.id);
  if (have) return { routine: have, added: false };
  store.routines.push({ title: entry.title, summary: entry.summary, description: entry.description, icon: entry.icon || null, tags: entry.tags || [], source: 'catalog', catalogId: entry.id });
  const saved = writeRoutines(owner, store);
  return { routine: saved.routines[saved.routines.length - 1], added: true };
}

/** Add catalog routine `id` for `slug`; `later` keeps it waiting when its integration isn't connected. */
export function addFromCatalog(slug, id, { later = false } = {}) {
  const entry = routinesCatalog.get(id);
  if (!entry) return { status: 404, body: { ok: false, error: 'no such routine in the catalog' } };
  const owner = routinesOwner(slug);
  if (routinesCatalog.unlockedBy(entry, usableFor(slug)) === null) {
    if (!later) return { status: 409, body: { ok: false, error: 'connect its integration first' } };
    const list = readWaiting(owner);
    if (!list.some((w) => w.id === entry.id)) writeWaiting(owner, [...list, { id: entry.id, slug, at: new Date().toISOString() }]);
    return { status: 200, body: { ok: true, waiting: true } };
  }
  const r = addNow(owner, entry);
  const list = readWaiting(owner);
  if (list.some((w) => w.id === entry.id)) writeWaiting(owner, list.filter((w) => w.id !== entry.id));
  return { status: 200, body: { ok: true, ...r } };
}

/** Stop waiting for catalog routine `id` (the person removed it). Returns whether it was waiting. */
export function dropWaiting(owner, id) {
  const list = readWaiting(owner);
  if (!list.some((w) => w.id === id)) return false;
  writeWaiting(owner, list.filter((w) => w.id !== id));
  return true;
}

/** What waits, as the Routines screen shows it: the catalog entry and the apps it needs. */
export function waitingView(owner) {
  return readWaiting(owner).map((w) => {
    const e = routinesCatalog.get(w.id);
    return e && { catalogId: e.id, title: e.title, summary: e.summary || '', icon: e.icon || null, tags: e.tags || [], needs: [...(e.requires || []), ...(e.requiresAll || [])] };
  }).filter(Boolean);
}

/** Add whatever waits for one owner and is usable now. Returns how many were added. */
export function flushWaiting(owner) {
  const list = readWaiting(owner);
  if (!list.length) return 0;
  const left = [];
  let added = 0;
  for (const w of list) {
    const entry = routinesCatalog.get(w.id);
    if (!entry) continue;   // gone from the catalog: drop it
    if (routinesCatalog.unlockedBy(entry, usableFor(w.slug)) === null) { left.push(w); continue; }
    if (addNow(owner, entry).added) added++;
  }
  writeWaiting(owner, left);
  return added;
}

/** After an integration changed: every owner's waiting routines that it unlocked. */
export function flushAllWaiting() {
  let users;
  try { users = readdirSync(dirname(dirname(routinesPath('default')))); } catch { return 0; }
  let added = 0;
  for (const owner of users) {
    try { if (existsSync(waitingPath(owner))) added += flushWaiting(owner); }
    catch (err) { process.stderr.write(`[routines] waiting ${owner}: ${err.message}\n`); }
  }
  return added;
}
