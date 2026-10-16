/**
 * The starter plan: at most three integrations to connect first and three
 * routines, each with one line on why, for one person.
 *
 * - Only integrations that connect in one click are offered (an official remote
 *   MCP server with OAuth, or one with nothing to fill in). Anything that needs
 *   keys or a developer console is left for later, from Integrations.
 * - Evidence comes first and is code, not a model: tools the website gives away.
 * - A model then ranks the remaining candidates against what the person said,
 *   and code checks the answer: an id that isn't a candidate is dropped, and a
 *   routine stays only if it will work with what is connected or offered here.
 * - Nothing the person dismissed is offered again.
 */
import * as integrations from '../integrations/catalog.js';
import * as routinesCatalog from '../routines-catalog.js';
import { runStructured, DECIDE_MODEL } from '../memory-llm.js';

export const MAX_INTEGRATIONS = 3;
export const MAX_ROUTINES = 3;
export const DEFAULT_ROUTINE = 'morning-brief';

/** Connects in one click: a remote MCP server signed into with OAuth, or one with nothing to fill in. */
export function isOneClick(entry) {
  if (!entry?.mcp?.url) return false;
  const fields = entry.fields || [];
  return fields.every((f) => f.type === 'remote-mcp-oauth');
}

/**
 * The integrations that may be offered: one click, not connected, not dismissed,
 * and — for a person connecting for themselves — ones a person may connect.
 * `extraOneClick`: ids made one-click some other way (Google through the
 * deployment's own sign-in client, once that ships).
 */
export function integrationCandidates({ connected = new Set(), dismissed = new Set(), personal = false, extraOneClick = new Set() } = {}) {
  // One of a kind is enough: with a notetaker (or a booking tool…) connected, no other is offered.
  const haveKinds = new Set(integrations.listAll().filter((e) => connected.has(e.id) && e.kind).map((e) => e.kind));
  return integrations.listAll().filter((e) =>
    (isOneClick(e) || extraOneClick.has(e.id))
    && !connected.has(e.id) && !dismissed.has(e.id)
    && !(e.kind && haveKinds.has(e.kind))
    && (!personal || e.personal !== false));
}

/** Routines that will work once the given integrations are connected; Everyday ones always. */
export function routineCandidates({ usable, dismissed = new Set(), added = new Set() }) {
  return routinesCatalog.listAll().filter((r) =>
    !dismissed.has(r.id) && !added.has(r.id) && routinesCatalog.unlockedBy(r, (id) => usable.has(id)) !== null);
}

const SCHEMA = {
  type: 'object',
  properties: {
    integrations: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
    routines: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
  },
  required: ['integrations', 'routines'],
};

const SYSTEM = `You pick a short starter plan for a new user of an AI coworker: which tools to connect first and which routines to switch on.

Pick at most ${MAX_INTEGRATIONS} integrations and ${MAX_ROUTINES} routines, only from the candidate lists, by id. Prefer what fits what the person said they need help with, then their role, then what the company does. Tools found on the company's website are strong evidence. If you know little about the company, go by the role and their own words.
A routine must work with what is connected or with the integrations you pick: each routine lists what it needs.
Tools found on the company's website are already in the plan: always include them in your answer, each with its reason.
Integrations: pick 2 or 3. First those that clearly help with what they described; if fewer than two clearly do, add the ones most useful to someone in this role at this kind of company (a notetaker for someone on calls all day, a calendar for someone booking meetings, a task or issue tracker for someone running a team). Never one that doesn't fit their work at all.
Routines: pick only those that clearly help; a routine that fits only by a stretch is left out.
Pick at most one tool of each kind (one notetaker, one booking tool…).
For each pick write one short sentence to the person ("you"), pointing at something they said or the website showed. When a tool has others of its kind among the candidates, word the reason by what it does, not by its brand ("your call notes…", not "Granola…") — the person may pick another of that kind. No marketing words, no promises the tool cannot keep.
Write in the language of the person's own answers. Don't assume their gender: in languages that mark it, choose wording that doesn't.`;

/**
 * Build a plan. `profile`: { company: { name, sentence, facts[] }, person: { role,
 * help, facts[] }, spotted: [{ id, seen }] }. `connected`: ids already usable
 * (the workspace's and the person's own). Returns { integrations, routines }.
 */
export async function buildPlan({ profile = {}, connected = new Set(), dismissed = new Set(), added = new Set(), personal = false, extraOneClick = new Set() } = {}) {
  const cands = integrationCandidates({ connected, dismissed, personal, extraOneClick });
  const candIds = new Set(cands.map((e) => e.id));
  // Evidence first: tools the website gives away, in the order found.
  const evidence = (profile.spotted || []).filter((t) => candIds.has(t.id)).slice(0, MAX_INTEGRATIONS);

  // Routines that could work with what is connected plus any candidate.
  const reachable = new Set([...connected, ...candIds]);
  const rCands = routineCandidates({ usable: reachable, dismissed, added });

  let picked = { integrations: [], routines: [] };
  try {
    picked = await runStructured({ system: SYSTEM, user: describe({ profile, cands, evidence, rCands, connected }), schema: SCHEMA, model: DECIDE_MODEL });
  } catch { /* no model: evidence and the default routine still make a plan */ }

  const why = new Map((picked?.integrations || []).map((p) => [p.id, clean(p.why)]));
  const chosen = [];
  for (const t of evidence) chosen.push({ id: t.id, why: why.get(t.id) || t.seen, evidence: t.seen });
  for (const p of picked?.integrations || []) {
    if (chosen.length >= MAX_INTEGRATIONS) break;
    if (candIds.has(p.id) && !chosen.some((c) => c.id === p.id) && clean(p.why)) chosen.push({ id: p.id, why: clean(p.why) });
  }
  // Alternatives: the other candidates of the same kind (a notetaker, a booking
  // tool…), so the person can pick the one they use. Not for a tool the website
  // showed — that one we know.
  const inPlan = new Set(chosen.map((c) => c.id));
  const integrationsOut = chosen.map((c) => {
    const e = integrations.get(c.id);
    const alternatives = c.evidence || !e.kind ? [] : cands
      .filter((x) => x.kind === e.kind && x.id !== c.id && !inPlan.has(x.id))
      .map((x) => ({ id: x.id, label: x.label, logo: x.logo }));
    return { id: c.id, label: e.label, logo: e.logo, why: c.why, ...(e.kind ? { kind: e.kind } : {}), ...(c.evidence ? { evidence: c.evidence } : {}), ...(alternatives.length ? { alternatives } : {}) };
  });

  // A routine stays only if it works with what is connected or picked above.
  const usableNow = new Set([...connected, ...integrationsOut.map((i) => i.id)]);
  const rIds = new Set(rCands.map((r) => r.id));
  const routinesOut = [];
  for (const p of picked?.routines || []) {
    if (routinesOut.length >= MAX_ROUTINES) break;
    if (!rIds.has(p.id) || routinesOut.some((r) => r.id === p.id) || !clean(p.why)) continue;
    const entry = routinesCatalog.get(p.id);
    const via = routinesCatalog.unlockedBy(entry, (id) => usableNow.has(id));
    if (via === null) continue;
    routinesOut.push(routineView(entry, clean(p.why), via && !connected.has(via) ? via : null));
  }
  // Always one the person can add right away, needing no app at all: the
  // model's own pick when it chose one, else the default, else any.
  const free = (r) => !(r.requires || []).length && !(r.requiresAll || []).length;
  if (!routinesOut.some((r) => free(routinesCatalog.get(r.id)))) {
    const pick = (rIds.has(DEFAULT_ROUTINE) ? routinesCatalog.get(DEFAULT_ROUTINE) : null)
      || rCands.find((r) => free(r) && !routinesOut.some((o) => o.id === r.id));
    if (pick) {
      const v = routineView(pick, null, null);
      if (routinesOut.length >= MAX_ROUTINES) routinesOut[routinesOut.length - 1] = v;
      else routinesOut.push(v);
    }
  }
  // The one(s) that need no app lead: they can be added before anything is connected.
  const ordered = [...routinesOut.filter((r) => !r.requires.length && !r.requiresAll.length), ...routinesOut.filter((r) => r.requires.length || r.requiresAll.length)];
  return { integrations: integrationsOut, routines: ordered };
}

// How a routine's need reads: by kind when the routine takes any tool of that
// kind ("a notetaker"), by name when it needs that one tool.
const KIND_NEED = { notetaker: 'a notetaker', booking: 'a calendar', tasks: 'a task app', docs: 'a workspace', issues: 'a tracker', payments: 'a payments tool', newsletter: 'a newsletter tool', site: 'a site builder' };

function routineView(entry, why, needs) {
  let needsLabel = null;
  if (needs) {
    const kind = integrations.get(needs)?.kind;
    const sameKind = kind ? (entry.requires || []).filter((id) => integrations.get(id)?.kind === kind).length : 0;
    needsLabel = sameKind > 1 && KIND_NEED[kind] ? KIND_NEED[kind] : (integrations.get(needs)?.label || needs);
  }
  return {
    id: entry.id, title: entry.title, summary: entry.summary, icon: entry.icon,
    why: why || entry.summary,
    ...(needs ? { needs, needsLabel } : {}),
    // What it takes to run: any one of `requires`, and all of `requiresAll`.
    // The wizard keeps Add off until those are connected.
    requires: entry.requires || [], requiresAll: entry.requiresAll || [],
  };
}

function clean(s) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 160 ? '' : t; }

function describe({ profile, cands, evidence, rCands, connected }) {
  const c = profile.company || {}, p = profile.person || {};
  const lines = [
    'About the company:',
    `- Name: ${c.name || '(unknown)'}`,
    `- In the owner's words: ${c.sentence || '(nothing)'}`,
    ...(c.facts || []).map((f) => `- ${f.text || f}`),
    '',
    'About the person:',
    `- Role: ${p.role || '(not given)'}`,
    `- What they need help with, in their words: ${p.help || '(not given)'}`,
    ...(p.facts || []).map((f) => `- ${f.text || f}`),
    '',
    `Already connected: ${[...connected].join(', ') || 'nothing'}`,
    `Found on the company's website: ${evidence.map((t) => `${t.id} (${t.seen})`).join(', ') || 'nothing'}`,
    '',
    'Candidate integrations (id — what it is):',
    ...cands.map((e) => `- ${e.id} — ${e.label}${e.kind ? ` [${e.kind}]` : ''}: ${e.tagline || e.description || ''}`),
    '',
    'Candidate routines (id — what it does — needs any of):',
    ...rCands.map((r) => `- ${r.id} — ${r.title}: ${r.summary}${(r.requires || []).length ? ` — needs ${r.requires.join(' or ')}` : ''}${(r.requiresAll || []).length ? ` — needs all of ${r.requiresAll.join(', ')}` : ''}`),
  ];
  return lines.join('\n');
}
