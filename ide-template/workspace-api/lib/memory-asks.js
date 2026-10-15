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

export function addAsk(slug, { text, question, conv = null, ts, source, fact = null, reason = null, key = null }) {
  const id = `a_${randomBytes(6).toString('hex')}`;
  write(slug, { op: 'add', id, ts: ts || new Date().toISOString(), text: String(text).slice(0, 4000), question: String(question || '').slice(0, 300), conv, source,
    ...(fact ? { fact } : {}), ...(reason ? { reason: String(reason).slice(0, 120) } : {}), ...(key ? { key: String(key).slice(0, 160) } : {}) });
  return id;
}

/** A standing answer for a subject: "always share facts about X" / "never". */
export function addRule(slug, subject, decision) {
  const s = String(subject || '').trim().slice(0, 80);
  if (!s || (decision !== 'share' && decision !== 'keep')) return null;
  write(slug, { op: 'rule', subject: s, decision });
  return s;
}
export function listRules(slug) {
  const by = new Map();
  for (const e of events(slug)) if (e.op === 'rule') { if (e.decision === 'clear') by.delete(e.subject.toLowerCase()); else by.set(e.subject.toLowerCase(), { subject: e.subject, decision: e.decision, at: e.at }); }
  return [...by.values()];
}
export function clearRule(slug, subject) { write(slug, { op: 'rule', subject: String(subject || '').slice(0, 80), decision: 'clear' }); }

/** Earlier answers by fact key, so the same fact is not asked twice. */
export function decisions(slug) {
  const keys = new Map(), out = new Map();
  for (const e of events(slug)) {
    if (e.op === 'add' && e.key) keys.set(e.id, e.key);
    else if (e.op === 'resolve' && keys.has(e.id)) out.set(keys.get(e.id), e.decision === 'share' ? 'share' : 'keep');
  }
  return out;
}

/** The bot is told once a day that questions wait; this is when it was last told, or null. */
export function mentionedAt(slug) {
  let at = null;
  for (const e of events(slug)) if (e.op === 'mentioned') at = e.at;
  return at;
}
export function markMentioned(slug, count) { write(slug, { op: 'mentioned', count }); }

/** Asks with their current status: pending | shared | kept. */
export function listAsks(slug, { status = null } = {}) {
  const byId = new Map();
  for (const e of events(slug)) {
    if (e.op === 'add') byId.set(e.id, { id: e.id, ts: e.ts, text: e.text, question: e.question, conv: e.conv, source: e.source, fact: e.fact || null, reason: e.reason || null, key: e.key || null, status: 'pending' });
    else if (e.op === 'resolve' && byId.has(e.id)) byId.get(e.id).status = e.decision === 'share' ? 'shared' : 'kept';
  }
  const all = [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return status ? all.filter(a => a.status === status) : all;
}

/**
 * The owner decides. 'share' copies the excerpt into shared memory (with its
 * origin, so the owner is not shown it twice); 'keep' just closes the question.
 */
export async function resolveAsk(slug, id, decision, by, { rememberSubject = false, name = null } = {}) {
  const ask = listAsks(slug).find(a => a.id === id);
  if (!ask) return { ok: false, error: 'not found' };
  if (ask.status !== 'pending') return { ok: false, error: `already ${ask.status}` };
  if (decision !== 'share' && decision !== 'keep') return { ok: false, error: 'decision must be share or keep' };
  let recordId = null;
  if (decision === 'share') {
    if (ask.fact) {
      // The fact, in the person's name — never the excerpt (lib/memory-sharing.js).
      const { fileTeamFact } = await import('./memory-sharing.js');
      const out = await fileTeamFact(slug, ask.fact, { ts: ask.ts, conv: ask.conv, source: ask.source || 'note', name, by: 'share' });
      recordId = out.recordId;
    } else {
      // A question filed before facts were asked about: the excerpt, as before.
      const r = await ledger.append({ scope: 'shared', source: ask.source || 'note', ts: ask.ts, conv: ask.conv, text: ask.text, origin: `user:${slug}` });
      recordId = r.id || null;
    }
  }
  if (rememberSubject && ask.fact?.subject) addRule(slug, ask.fact.subject, decision);
  write(slug, { op: 'resolve', id, decision, by: by || slug, recordId });
  ledger.logEvent({ op: decision === 'share' ? 'share' : 'keep_private', scope: `user:${slug}`, ids: recordId ? [recordId] : [], by: by || slug, ask: id });
  return { ok: true, recordId };
}
