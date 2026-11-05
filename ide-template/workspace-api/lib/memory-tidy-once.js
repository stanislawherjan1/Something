/**
 * memory-tidy-once — put away what two earlier rules left in the facts.
 *
 * 1. A meeting read from a notetaker once filed, beside its summary, up to two
 *    "follow-ups": a sentence each, out of the call's context, at times advice
 *    rather than a fact. The summary is the one memory of a meeting now
 *    (lib/memory-router.js meeting); the follow-ups already filed are hidden.
 * 2. A fact that moved to the team kept a private copy, so its owner saw it
 *    twice. A fact has one home now (lib/memory-sharing.js); the private
 *    copies of facts already shared are hidden as moved.
 *
 * Runs at workspace-api boot, once: a marker in memory/_engine/ ends it. Every
 * hide is an ordinary hide — in Changes, with undo — nothing is erased.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import { privateTwin, WHY_SHARED } from './memory-sharing.js';

const MARKER = '.tidy-2026-11-03';
const SUMMARY_TITLE = /^(Call with |Call: |Voice note: )/;

function memoryDir() { return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory'); }
function markerPath() { return join(memoryDir(), '_engine', MARKER); }

/** The facts of a person's scope that a notetaker import filed beside the meeting's summary. */
export function importFollowUps(scope) {
  const recs = new Map(ledger.read({ scopes: [scope], includeHidden: true }).map(r => [r.id, r]));
  return facts.all(scope).filter(f => {
    if (f.hidden || f.retired || f.replacedBy) return false;
    const ids = [f.record, ...(f.sources || [])].filter(Boolean);
    if (!ids.length) return false;
    if (!ids.every(id => recs.get(id)?.tags?.import)) return false;
    return !SUMMARY_TITLE.test(String(f.title || ''));
  });
}

/** The private copies, still showing, of facts the person already shared. */
export function privateCopies() {
  const origin = new Map(ledger.read({ scopes: ['shared'] }).filter(r => r.origin?.startsWith('user:')).map(r => [r.id, r.origin.slice(5)]));
  const out = [];
  for (const f of facts.visible(['shared'])) {
    const slug = origin.get(f.record);
    if (!slug) continue;
    const twin = privateTwin(slug, f);
    if (twin) out.push({ slug, id: twin.id, shared: f.id });
  }
  return out;
}

export async function tidy({ by = 'tidy' } = {}) {
  const out = { followUps: 0, copies: 0 };
  if (ledger.v4Mode() === 'off') return out;
  for (const scope of ledger.allScopes().filter(s => s.startsWith('user:'))) {
    const ids = importFollowUps(scope).map(f => f.id);
    for (const id of ids) await facts.hide(scope, id, by, { why: 'import follow-up' });
    if (ids.length) { out.followUps += ids.length; ledger.logEvent({ op: 'hide', scope, by, facts: ids, why: 'import follow-up' }); }
  }
  const byScope = new Map();
  for (const c of privateCopies()) {
    await facts.hide(`user:${c.slug}`, c.id, by, { why: WHY_SHARED });
    (byScope.get(c.slug) || byScope.set(c.slug, []).get(c.slug)).push(c.id);
    out.copies++;
  }
  for (const [slug, ids] of byScope) ledger.logEvent({ op: 'hide', scope: `user:${slug}`, by, facts: ids, why: WHY_SHARED });
  return out;
}

/** Once per deployment. Returns { ran, summary }. */
export function tidyOnce() {
  if (existsSync(markerPath())) return { ran: false, summary: 'done before' };
  if (ledger.v4Mode() === 'off') return { ran: false, summary: 'memory v4 off' };
  // Synchronous facade for boot: the work is async; the marker is written
  // when it finishes, so a boot that died halfway runs it again (idempotent).
  tidy().then((r) => {
    mkdirSync(join(memoryDir(), '_engine'), { recursive: true });
    writeFileSync(markerPath(), `${new Date().toISOString()} follow-ups=${r.followUps} copies=${r.copies}\n`);
    if (r.followUps || r.copies) process.stdout.write(`[workspace-api] memory tidy: hid ${r.followUps} import follow-up(s), ${r.copies} private cop${r.copies === 1 ? 'y' : 'ies'} of shared facts\n`);
  }).catch(err => process.stderr.write(`[workspace-api] memory tidy failed: ${err.message}\n`));
  return { ran: true, summary: 'started' };
}
