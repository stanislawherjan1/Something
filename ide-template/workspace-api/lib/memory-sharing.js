/**
 * memory-sharing — what from a person's private conversation may reach the
 * team's memory, and how.
 *
 * Three answers for a fact the notes pass found in a private conversation:
 * TEAM (filed into the shared facts, in the person's name), ASK (a question
 * on the person's Sharing screen; nothing moves until they answer), PRIVATE
 * (stays theirs). The router's verdict on the conversation's lines is the
 * signal — it says which lines are team-relevant — and this module is the
 * gate that decides, in code, from three things:
 *
 *   - the person's MODE: "ask" (the default — nothing crosses without them),
 *     "auto" (team-relevant facts about the work cross by themselves) or
 *     "never" (nothing crosses by itself; they share by saying so);
 *   - WHOM the fact concerns: a fact about a person — the speaker, or a named
 *     human — never crosses by itself, whatever the router thought. Only a
 *     company, a project or the team's work may;
 *   - what the person decided before: a remembered answer for the same fact,
 *     and standing rules per subject ("always share facts about Vellmark").
 *
 * What crosses is the FACT (its title and sentence), never the excerpt of the
 * conversation it came from: the team learns what was concluded, not what was
 * said. The fact keeps its evidence quote, which is what grounds it.
 */
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import { list as teamList } from './team.js';

export const MODES = ['ask', 'auto', 'never'];
export const CONCERNS = ['the person themselves', 'another person', 'a company or project', "the team's work"];

/** The person's sharing mode, from the roster; "ask" when unset. */
export function modeOf(slug) {
  const e = teamList().find(m => m.slug === slug);
  return MODES.includes(e?.sharing) ? e.sharing : 'ask';
}

const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const nameKey = (s) => squash(s).replace(/[^\p{L}\p{N} ]+/gu, '');

/** Is the quote (the fact's evidence) inside the router's text for that verdict? */
function quotedIn(evidence, text) {
  const q = squash(evidence), t = squash(text);
  if (!q || !t) return false;
  if (t.includes(q)) return true;
  // The router cut mid-sentence at times; half the quote (its longer half) still places it.
  const half = q.slice(0, Math.max(24, Math.floor(q.length / 2)));
  return half.length >= 24 && t.includes(half);
}

/** A fact that is about a human — the speaker or a named person — or a personal preference. */
export function concernsAPerson(fact) {
  if (fact?.kind === 'preference') return true;
  const c = fact?.concerns;
  if (c === 'the person themselves' || c === 'another person') return true;
  if (!CONCERNS.includes(c)) return true;   // the model did not say: conservative
  const subj = nameKey(fact?.subject);
  if (subj) {
    const e = (fact.entities || []).find(x => nameKey(x.name) === subj);
    if (e && e.kind === 'person') return true;
  }
  return false;
}

/** A stable key for "the same fact, asked again": the facts store's key when it has one, else the title. */
export function factKey(fact) {
  return String(fact?.key || fact?.title || fact?.text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * The decision for one fact. `routed` is the router's verdict ({ shared, ask }
 * texts); `rules` is [{ subject, decision }] the person set; `decided` maps a
 * fact key to an earlier answer ('share' | 'keep').
 * Returns { outcome: 'team' | 'ask' | 'private', reason }.
 */
export function decide({ mode = 'ask', fact, routed, rules = [], decided = new Map() } = {}) {
  const signal = quotedIn(fact?.evidence, routed?.shared) ? 'team' : quotedIn(fact?.evidence, routed?.ask) ? 'ask' : 'private';
  if (signal === 'private') return { outcome: 'private', reason: 'not about the team' };
  const key = factKey(fact);
  const earlier = key ? decided.get(key) : null;
  if (earlier === 'keep') return { outcome: 'private', reason: 'you kept this private before' };
  if (earlier === 'share') return { outcome: 'team', reason: 'you shared this before' };
  const subj = nameKey(fact?.subject);
  const rule = subj ? rules.find(r => nameKey(r.subject) === subj) : null;
  if (rule?.decision === 'keep') return { outcome: 'private', reason: `your rule for ${fact.subject}` };
  if (mode === 'never') return { outcome: 'private', reason: 'you share by hand' };
  if (rule?.decision === 'share') return { outcome: 'team', reason: `your rule for ${fact.subject}` };
  if (concernsAPerson(fact)) {
    return { outcome: 'ask', reason: fact?.concerns === 'the person themselves' || !fact?.concerns ? 'about you' : fact?.concerns === 'another person' ? `about ${fact.subject || 'a person'}` : 'a personal preference' };
  }
  if (signal === 'ask' || mode === 'ask') return { outcome: 'ask', reason: fact?.subject ? `about ${fact.subject}` : 'about the work' };
  return { outcome: 'team', reason: fact?.subject ? `about ${fact.subject}` : 'about the work' };
}

/**
 * File a fact into the team's memory in the person's name: one shared record
 * carrying the fact's text (so "See source" for the team opens the fact, not
 * the conversation), with the fact remembered on it. Returns { recordId, ids }.
 */
export async function fileTeamFact(slug, fact, { ts, conv = null, source = 'note', name = null, by = null } = {}) {
  const text = [fact.title ? `${fact.title}.` : null, fact.text].filter(Boolean).join(' ');
  const r = await ledger.append({
    scope: 'shared', source, ts: ts || new Date().toISOString(), conv, speaker: name || slug, text,
    origin: `user:${slug}`, tags: { sharedFact: true, from: slug, ...(fact.entities?.length ? { entities: fact.entities } : {}) },
  });
  if (!r.ok) return { recordId: null, ids: [] };
  const note = { title: fact.title, text: fact.text, kind: fact.kind || 'fact', importance: fact.importance || 2,
    ...(fact.about ? { about: fact.about } : {}), ...(fact.when ? { when: fact.when, whenFrom: fact.whenFrom } : {}),
    expires: fact.expires || null, ...(fact.subject ? { subject: fact.subject } : {}), ...(fact.concerns ? { concerns: fact.concerns } : {}),
    ...(fact.entities?.length ? { entities: fact.entities } : {}), evidence: fact.evidence || '' };
  const got = await facts.remember('shared', [note], { record: r.id, ts: r.ts || ts, entities: fact.entities || [], by: by || source, standing: 'said', conv });
  return { recordId: r.id, ids: got.ids || [] };
}
