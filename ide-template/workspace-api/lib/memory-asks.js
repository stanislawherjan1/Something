/**
 * memory-asks — "should this be shared with the team?" questions, one list per person.
 *
 * The router files borderline business facts as private and proposes sharing
 * them. The proposal waits here, in the person's own tree, until they decide on
 * the Privacy screen: share (the excerpt is copied into shared memory verbatim)
 * or keep private. Nothing is shared by waiting. Append-only events, so the
 * history of a decision is kept.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as ledger from './memory-ledger.js';

const SLUG_RE = /^[a-z0-9-]+$/;

function asksPath(slug) {
  if (!SLUG_RE.test(slug || '') || slug === 'default') throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory', 'users', slug, 'asks.jsonl');
}

function events(slug) {
  const p = asksPath(slug);   // throws on an invalid slug — outside the try on purpose
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function write(slug, ev) {
  const p = asksPath(slug);
  mkdirSync(join(p, '..'), { recursive: true });
  appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n', { mode: 0o664 });
}

export function addAsk(slug, { text, question, conv = null, ts, source }) {
  const id = `a_${randomBytes(6).toString('hex')}`;
  write(slug, { op: 'add', id, ts: ts || new Date().toISOString(), text: String(text).slice(0, 4000), question: String(question || '').slice(0, 300), conv, source });
  return id;
}

/** Asks with their current status: pending | shared | kept. */
export function listAsks(slug, { status = null } = {}) {
  const byId = new Map();
  for (const e of events(slug)) {
    if (e.op === 'add') byId.set(e.id, { id: e.id, ts: e.ts, text: e.text, question: e.question, conv: e.conv, source: e.source, status: 'pending' });
    else if (e.op === 'resolve' && byId.has(e.id)) byId.get(e.id).status = e.decision === 'share' ? 'shared' : 'kept';
  }
  const all = [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return status ? all.filter(a => a.status === status) : all;
}

/**
 * The owner decides. 'share' copies the excerpt into shared memory (with its
 * origin, so the owner is not shown it twice); 'keep' just closes the question.
 */
export async function resolveAsk(slug, id, decision, by) {
  const ask = listAsks(slug).find(a => a.id === id);
  if (!ask) return { ok: false, error: 'not found' };
  if (ask.status !== 'pending') return { ok: false, error: `already ${ask.status}` };
  if (decision !== 'share' && decision !== 'keep') return { ok: false, error: 'decision must be share or keep' };
  let recordId = null;
  if (decision === 'share') {
    const r = await ledger.append({ scope: 'shared', source: ask.source || 'note', ts: ask.ts, conv: ask.conv, text: ask.text, origin: `user:${slug}` });
    recordId = r.id || null;
  }
  write(slug, { op: 'resolve', id, decision, by: by || slug, recordId });
  ledger.logEvent({ op: decision === 'share' ? 'share' : 'keep_private', scope: `user:${slug}`, ids: recordId ? [recordId] : [], by: by || slug, ask: id });
  return { ok: true, recordId };
}
