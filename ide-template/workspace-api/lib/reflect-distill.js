/**
 * reflect-distill — the missing third step: read recent thread VERDICT cards,
 * draw the DURABLE conclusions, and propose them to the 7 memory cards (via the
 * existing _drafts → /memory approve flow). This is what turns the verdict
 * archive into the bot's working memory.
 *
 *   transcript ──reflect-summary──▶ verdict cards (decisions, entities, conf)
 *                                        │
 *                                        ▼  reflect-distill (THIS)
 *                          read recent verdicts → keep only durable signal →
 *                          claude -p proposes 7-card updates →
 *                          reflect-apply.py ingest → memory/_drafts/ → /memory review
 *
 * Ephemeral one-offs (a folder created once, conf 0.50, no entities) yield
 * nothing; only durable facts/preferences/people/rules reach the cards — and even
 * then, behind operator approval (never an autonomous write to a canonical card).
 *
 * The SYSTEM prompt mirrors skills/default/reflect-learnings/SKILL.md's contract
 * (same 7 cards, decision tree, output schema) — fed verdicts instead of RECENT_*.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_BIN, PROJECT_DIR } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';
import { computeConceptHeat } from './memory-graph.js';
import { autoPromoteOwners } from './team.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
// Consolidation quality gates what the whole wiki learns — worth Sonnet over
// Haiku at 2 calls/day (operator decision 2026-07-03). Lint stays on Haiku.
const MODEL          = process.env.REFLECT_DISTILL_MODEL || 'claude-sonnet-5';
const WINDOW_MS      = num('REFLECT_DISTILL_WINDOW_DAYS', 2) * 86400 * 1000;   // verdicts modified within this window
let   MIN_CONF       = num('REFLECT_DISTILL_MIN_CONF', 0.6);
if (MIN_CONF > 1) MIN_CONF /= 100;                                            // tolerate 60 or 0.6
const MAX_VERDICTS   = num('REFLECT_DISTILL_MAX', 20);
const INTERVAL_MS    = num('REFLECT_DISTILL_INTERVAL_HOURS', 12) * 3600 * 1000;
const TIMEOUT        = num('REFLECT_DISTILL_TIMEOUT_MS', 90000);
const REFLECT_APPLY  = process.env.REFLECT_APPLY_PY || '/opt/ide/hooks/reflect-apply.py';
// Concept emergence: a slug must recur across ≥ CONCEPT_HEAT distinct verdict
// threads to earn a concept page (squeeze-point). CONCEPT_MAX caps how many new
// claims one distill cycle proposes, so a chatty week can't flood /memory review.
// Mirrors CONCEPT_HEAT in lib/memory-graph.js — keep in sync.
const CONCEPT_HEAT   = Math.max(1, num('REFLECT_CONCEPT_HEAT', 2));
// A brand-NEW concept page needs MORE heat than accreting to an existing one:
// existing pages take priority and a one-off entity shouldn't spawn its own
// page. Existing pages still accrete at CONCEPT_HEAT.
const CONCEPT_HEAT_NEW = Math.max(CONCEPT_HEAT, num('REFLECT_CONCEPT_HEAT_NEW', 3));
const CONCEPT_MAX    = Math.max(1, num('REFLECT_CONCEPT_MAX', 12));
// Per-cycle cap on how many DISTINCT owners get a private concept pass (each is
// its own isolated LLM call), so a big team can't fan out into dozens of calls
// in one tick. Owners beyond the cap are picked up on the next cycle.
const CONCEPT_OWNERS_MAX = Math.max(1, num('REFLECT_CONCEPT_OWNERS_MAX', 4));
// Concepts see a WIDER window than cards. A card is a recent fact (2-day window);
// a concept is accumulated knowledge about a recurring entity, so it should draw
// on that entity's history — not wait for the entity to happen to be mentioned in
// the last 2 days. Without this, on a bot with bursty usage the accumulated hot
// entities never get a page. Separate, larger window + verdict cap for the
// concept passes only.
const CONCEPT_WINDOW_MS   = num('REFLECT_CONCEPT_WINDOW_DAYS', 30) * 86400 * 1000;
const CONCEPT_MAX_VERDICTS = Math.max(MAX_VERDICTS, num('REFLECT_CONCEPT_MAX_VERDICTS', 40));

let _distilling = false;

// Card distillation prompt (pass 1). Runs over the FULL verdict digest (shared +
// each teammate's private verdicts) because a private USER_* card legitimately
// needs the owner's private threads. Outputs ONLY the `proposals` bucket.
const SYSTEM_CARDS = [
  'You consolidate a team\'s LONG-TERM memory. INPUT: recent conversation-thread VERDICTS (already summarised + tagged with entities/decisions). OUTPUT: a JSON list of proposed additions to the 7 memory cards — ONLY durable facts worth keeping forever. Ephemeral one-offs (a single folder created, a transient task, a one-time lookup) yield NOTHING — skip them. Under-propose: an empty list is the common, correct answer.',
  '',
  'Output ONE JSON object and NOTHING else (no preamble, no fences):',
  '{"proposals":[{"card":"USER_PROFILE","section":"Identity","action":"append","content":"- Lives in: Warsaw","rationale":"thread [3]: Stan said he is based in Warsaw","confidence":0.95,"scope":"private","owner":"stan"}]}',
  '',
  'The 7 cards — walk in order, STOP at the first match:',
  '1. Hard rule ("always"/"never"/"must"/"from now on") → RULES (shared). Section: Never or Always.',
  '2. Stable user fact (role, location, languages, schedule, big-picture focus) → USER_PROFILE (private). Section: Identity/Background/Currently focused on/Schedule.',
  '3. Soft preference (tone, format, channel, working style — e.g. "writes in Polish", "prefers terse") → USER_PREFERENCES (private, ALWAYS).',
  '4. A person with recurring context → USER_RELATIONSHIPS (private). New section "## Name (Role)".',
  '5. Self-introspection the user shared about himself → USER_REFLECTIONS (private). Dated section.',
  '6. Tool/integration gotcha ("use X not Y") → AGENT_TOOLS (shared).',
  '7. Agent voice/character shift the user asked for → AGENT_IDENTITY (shared).',
  'Anything that does not fit one of these — do NOT propose. The cards are not a catch-all.',
  '',
  'actions: "append" (floor 0.7, default), "update_field" (0.85, needs section+field), "replace_section" (0.9). Use the LEAST destructive. Propose HIGH-confidence only; cite the thread number in rationale.',
  'GROUND EVERYTHING — invent NOTHING. Every proposed fact must be stated in the verdicts. Do NOT infer a job title, employer, role, or company from a location or an unrelated detail (e.g. "moved to Gdańsk" is a LOCATION, never a new job). If it is not in the verdicts verbatim or by clear paraphrase, do not propose it.',
  'AVOID DUPLICATES — the card likely already holds facts about this topic. Propose ONLY genuinely new information; a fact already implied by the card is a NOOP (skip it). Do not re-state the same project/person in slightly different words across multiple bullets.',
  'scope/owner (TEAM MODE): every USER_* proposal MUST carry "scope":"private" + "owner":"<slug>" — use the verdict\'s stated owner. Shared cards (RULES/AGENT_*) → "scope":"shared" or omit. If you cannot attribute a fact to a specific person, SKIP it — never guess an owner.',
  '',
  'Most verdicts yield nothing durable. {"proposals":[]} is correct most of the time. Quality over quantity.',
].join('\n');

// Concept distillation prompt (pass 2). Runs over a SHARED-ONLY digest (private
// verdicts are NEVER in its context) so a team-visible concept page can never be
// sourced from a teammate's private thread. Outputs ONLY `concept_proposals`.
const SYSTEM_CONCEPTS = [
  'You maintain CONCEPT PAGES — accreting, team-SHARED notes about recurring entities (a project, client, or recurring topic). INPUT: recent SHARED conversation-thread verdicts + a CONCEPTS IN PLAY list (the eligible slugs + each one\'s EXISTING claims). OUTPUT: a JSON list of new atomic claims.',
  '',
  'Output ONE JSON object and NOTHING else (no preamble, no fences):',
  '{"concept_proposals":[{"slug":"acme","claim":"Renews its contract annually in Q3","confidence":0.85,"rationale":"threads [2],[4]"}]}',
  '',
  'Rules: (a) ONLY use a slug that appears verbatim in CONCEPTS IN PLAY — NEVER invent one. (b) Propose one claim per NEW, distinct durable fact about the slug (up to 5 per slug this cycle) — skip any fact already covered by an existing claim (NOOP restatements). A rich conversation about an entity SHOULD yield several claims at once. (c) Atomic: one self-contained fact per claim, durable (true beyond this week); no transient task state, no leading dash. (d) confidence ≥ 0.7 or skip. (e) The page is TEAM-SHARED and read by EVERY teammate — never put a private, sensitive, or personal detail in a claim; if a fact feels personal to one person, it does NOT belong here. (f) No code fences or backticks in a claim.',
  '',
  'Most cycles yield nothing. {"concept_proposals":[]} is correct most of the time. Quality over quantity.',
].join('\n');

// Private concept prompt (per-owner pass). Runs over ONE person's OWN verdicts
// only (never shared, never another teammate's) → a page ONLY that person sees,
// at memory/users/<owner>/concepts/. Personal detail about the entity is fine
// here (it's private), unlike the shared prompt above.
const SYSTEM_CONCEPTS_PRIVATE = [
  "You maintain a PRIVATE concept page for ONE person about a recurring entity in THEIR world (a person they deal with, a project, a client). ONLY that person ever sees this page. INPUT: THAT PERSON'S OWN recent thread verdicts + a CONCEPTS IN PLAY list (eligible slugs + each one's EXISTING claims). OUTPUT: a JSON list of new atomic claims.",
  '',
  'Output ONE JSON object and NOTHING else (no preamble, no fences):',
  '{"concept_proposals":[{"slug":"sam","claim":"Prefers async written updates over calls","confidence":0.85,"rationale":"threads [1],[3]"}]}',
  '',
  "Rules: (a) ONLY use a slug that appears verbatim in CONCEPTS IN PLAY — NEVER invent one. (b) One claim per NEW, distinct durable fact about the slug (up to 5 per slug this cycle) — skip facts already covered (NOOP restatements). A rich conversation SHOULD yield several claims at once. (c) Atomic: one self-contained, durable fact per claim (true beyond this week); no transient task state, no leading dash. (d) confidence ≥ 0.7 or skip. (e) The page is PRIVATE to this one person, so personal/sensitive detail ABOUT THE ENTITY is fine — but derive every claim ONLY from the verdicts shown here (this person's own threads); never invent, never guess. (f) No code fences or backticks in a claim.",
  '',
  'Most cycles yield nothing. {"concept_proposals":[]} is correct most of the time. Quality over quantity.',
].join('\n');

// Promotion scout prompt (pass 2c, reflect v2 scope routing). Runs over ONE
// owner's PRIVATE verdicts (same isolation as the private concept pass — never
// shared, never another teammate's) and finds ORG facts trapped under the DM
// privacy ceiling that are safe to surface to the whole team. The privacy
// boundary is only ever crossed by an individual, sanitized, consented claim —
// this pass EMITS candidates; whether they auto-apply depends on the owner's
// autoPromote pre-consent (decided by the caller, in code, not the model).
const SYSTEM_PROMOTION = [
  'You are the SCOPE ROUTER for a team AI coworker. INPUT: durable facts from ONE person\'s PRIVATE 1:1 conversations. Most belong in their private memory. Your job: find the few that are ORGANISATION knowledge the whole team should have, and are SAFE to make team-visible. Output ONE JSON object and NOTHING else.',
  '',
  '{"promotions":[{"slug":"linear","shared_text":"The team is switching to Linear for issue tracking (decided 2026-07).","confidence":0.9,"rationale":"verdict [2]"}]}',
  '',
  'A fact is PROMOTABLE only if ALL hold:',
  '- SUBJECT = organisation: a decision, process, project/client/vendor fact, tool choice, team rule. NOT the person\'s own preference/taste/schedule/identity (those stay private). NOT a fact about another named person unless it is roster-grade professional (role, assignment, business contact).',
  '- SENSITIVITY = none: NEVER promote anything strategic (internal margins, automation a client must not learn about, negotiation posture), personal (health, family, finance, emotion), a confidence ("between us"), or gossip. When unsure whether something is sensitive, DO NOT promote it.',
  '- It is durable (true + useful in 3 months).',
  'slug: a kebab-case concept/topic slug for the shared page it belongs on (reuse a KNOWN SLUG when given). shared_text: the exact sentence to publish to team memory — self-contained, no "I"/DM context, no who-said-it unless that IS the fact, nothing sensitive. confidence 0..1.',
  '',
  'Bias hard toward NOT promoting. {"promotions":[]} is the right answer most of the time — over-privatising costs nothing, over-sharing is a leak.',
].join('\n');

// Parse a verdict card (YAML frontmatter + ## Outcome / ## Decisions made body).
function parseVerdict(text, owner) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null;
  const fmEnd = text.indexOf('\n---', 3);
  if (fmEnd === -1) return null;
  const fm = text.slice(3, fmEnd);
  const body = text.slice(fmEnd + 4);
  const fmGet = (k) => { const m = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
  const title = fmGet('title').replace(/^["']|["']$/g, '');
  const confidence = Number(fmGet('confidence')) || 0;
  let entities = [];
  const em = fmGet('entities').match(/\[(.*)\]/);
  if (em) entities = em[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  // Body sections.
  const sec = (name) => {
    const m = body.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, 'i'));
    return m ? m[1].trim() : '';
  };
  const summary = sec('Outcome').replace(/\s+/g, ' ').trim();
  const decisions = sec('Decisions made').split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(d => d && !/^_\(none/.test(d));
  // Reflect v2: the durable-fact block is the richest signal — strip the
  // machine tag `[slug·kind·conf]` and keep the fact text for the digest.
  const durableFacts = sec('Durable facts').split('\n')
    .map(l => l.replace(/^\s*[-*]\s*(?:\[[^\]]*\]\s*)?/, '').trim())
    .filter(d => d && !/^_\(none/.test(d));
  if (!title) return null;
  return { title, summary, entities, decisions, durableFacts, confidence, owner };
}

function readRecentDurableVerdicts(windowMs = WINDOW_MS, maxVerdicts = MAX_VERDICTS) {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  const now = Date.now();
  const dirs = [{ dir: join(base, 'memory', '_reflect', 'threads'), owner: null }];
  try {
    for (const u of readdirSync(join(base, 'memory', 'users'), { withFileTypes: true })) {
      if (u.isDirectory()) dirs.push({ dir: join(base, 'memory', 'users', u.name, '_reflect', 'threads'), owner: u.name });
    }
  } catch { /* no per-user threads */ }

  const out = [];
  for (const { dir, owner } of dirs) {
    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const abs = join(dir, f);
      let st; try { st = statSync(abs); } catch { continue; }
      if (now - st.mtimeMs > windowMs) continue;              // outside the window
      let v; try { v = parseVerdict(readFileSync(abs, 'utf8'), owner); } catch { v = null; }
      if (!v) continue;
      // Cheap durability pre-filter: drop the obvious noise (low confidence AND no
      // entities AND no decisions AND no durable facts — e.g. the "create folder"
      // one-off). The LLM does the real judgement on what survives.
      if (v.confidence < MIN_CONF && v.entities.length === 0 && v.decisions.length === 0 && !(v.durableFacts && v.durableFacts.length)) continue;
      out.push({ ...v, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, maxVerdicts);
}

function renderDigest(verdicts) {
  return verdicts.map((v, i) => {
    const lines = [`[${i + 1}] ${v.title}${v.owner ? ` (owner: ${v.owner})` : ''} — confidence ${v.confidence}`];
    if (v.summary) lines.push(`    summary: ${v.summary}`);
    if (v.entities.length) lines.push(`    entities: ${v.entities.join(', ')}`);
    if (v.decisions.length) lines.push(`    decisions: ${v.decisions.join(' | ')}`);
    if (v.durableFacts && v.durableFacts.length) lines.push(`    durable facts: ${v.durableFacts.join(' | ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function parseDistillOutput(text) {
  if (!text) return null;
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o || typeof o !== 'object') return null;
    const proposals = Array.isArray(o.proposals) ? o.proposals : [];
    const conceptProposals = Array.isArray(o.concept_proposals) ? o.concept_proposals : [];
    const promotions = Array.isArray(o.promotions) ? o.promotions : [];
    // At least one recognised key must be present, else treat as unparseable
    // (an LLM that "replied" to the transcript instead of emitting the schema).
    if (!('proposals' in o) && !('concept_proposals' in o) && !('promotions' in o)) return null;
    return { proposals, conceptProposals, promotions };
  } catch { /* unparseable */ }
  return null;
}

const CONCEPT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// A concept slug must also clear a noise floor (mirrors MIN_BARE_NAME_LEN in
// memory-graph.js): ≥ 2 chars and not purely numeric, so a stray entity like
// 'a' or '42' is never promoted to a first-class concept page.
function isConceptSlug(s) {
  return CONCEPT_SLUG_RE.test(s) && s.length >= 2 && !/^\d+$/.test(s);
}

// Read the current `## Claims` body of a concept page (for the dedup-hint +
// to confirm whether the page already exists). owner=null → the shared page
// memory/concepts/<slug>.md; owner=<slug> → that person's private page
// memory/users/<owner>/concepts/<slug>.md. '' when absent.
function readConceptClaims(slug, owner = null) {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  const abs = owner
    ? join(base, 'memory', 'users', owner, 'concepts', `${slug}.md`)
    : join(base, 'memory', 'concepts', `${slug}.md`);
  try {
    const body = readFileSync(abs, 'utf8');
    const parts = body.split(/\n##\s+/);
    const sec = parts.find(x => /^Claims\b/i.test(x.trimStart()));
    return sec ? sec.split('\n').slice(1).join('\n').trim() : '';
  } catch { return ''; }
}

// True when a slug already has a SHARED page (memory/concepts/ or a graduated
// memory/topics/). Cross-scope guard: clients/processes live in the shared
// scope, so a PRIVATE pass must NOT mint a parallel private page for them —
// private is for prefs + small personal projects. A genuinely personal entity
// never has a shared page, so it stays eligible for its own private page.
function hasSharedPage(slug) {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  return existsSync(join(base, 'memory', 'concepts', `${slug}.md`))
      || existsSync(join(base, 'memory', 'topics', `${slug}.md`));
}

// Which recurring slugs are eligible for a concept claim THIS cycle for a given
// scope: present in this scope's recent window AND hot enough (≥ CONCEPT_HEAT
// distinct threads in this scope). owner=null → SHARED (heat over memory/threads,
// entities from shared verdicts). owner=<slug> → that person's PRIVATE scope
// (heat over memory/users/<owner>/threads, entities from THEIR verdicts only).
// The scope isolation is what keeps a private concept from ever being seeded by
// another user's / shared threads.
function eligibleConceptsFor(verdicts, owner = null) {
  const heat = computeConceptHeat(owner);                 // owner=null → shared; slug → that user's threads
  const inWindow = new Set();
  for (const v of verdicts) {
    if (owner ? v.owner !== owner : !!v.owner) continue;  // this scope's verdicts only
    for (const e of v.entities) {
      const s = String(e).toLowerCase().trim();
      if (isConceptSlug(s)) inWindow.add(s);
    }
  }
  // computeConceptHeat returns DECAYED heat (reflect v2): N fresh verdicts sum
  // to just UNDER N (exp(-ε)<1), so a strict `>= CONCEPT_HEAT` would never fire
  // for exactly-N same-day threads. Same epsilon as memory-graph's emergence gate.
  let out = [...inWindow]
    .filter(s => (heat[s] || 0) >= CONCEPT_HEAT - 0.05)
    .map(s => ({ slug: s, heat: Math.round((heat[s] || 0) * 10) / 10, claims: readConceptClaims(s, owner) }))
    // Existing pages accrete at CONCEPT_HEAT; a brand-NEW page (no claims yet)
    // must clear the higher CONCEPT_HEAT_NEW bar — bias toward existing topics,
    // don't spawn a page for a one-off entity.
    .filter(c => c.claims ? true : (heat[c.slug] || 0) >= CONCEPT_HEAT_NEW - 0.05);
  // Cross-scope dedup (PRIVATE pass only): never create/accrete a private page
  // for a slug that already lives in SHARED — a client/process stays shared-only.
  // Personal entities (prefs, small private projects) have no shared page, so
  // they pass through untouched.
  if (owner) out = out.filter(c => !hasSharedPage(c.slug));
  return out;
}

// Render the CONCEPTS IN PLAY block the LLM dedups against. '' → no concepts.
function renderConceptBlock(eligible) {
  if (!eligible.length) return '';
  const lines = eligible.map(c => {
    const head = `- ${c.slug} (in ${c.heat} threads)`;
    const claims = c.claims
      ? '\n    existing claims:\n' + c.claims.split('\n').map(l => `      ${l.trim()}`).join('\n')
      : '\n    existing claims: (none yet — new page)';
    return head + claims;
  });
  return `\nCONCEPTS IN PLAY (propose at most one NEW atomic claim each, only if not already covered):\n${lines.join('\n')}\n`
    + `\nPREFER EXISTING PAGES: attach a claim to a slug that already has claims whenever the fact fits there. A '(new page)' slug is a last resort — claim it only when the entity is clearly its OWN recurring subject; a fact about a person or detail WITHIN an existing entity's world (a client's staff member, a sub-topic) belongs on that existing entity's page, not a new one.\n`;
}

// Convert one LLM concept_proposal into the standard proposal shape consumed by
// reflect-apply.py (kind:"concept" → a concept page, append a claim). owner=null
// → SHARED page memory/concepts/<slug>.md. owner=<slug> → that person's PRIVATE
// page memory/users/<owner>/concepts/<slug>.md (reflect-apply validates both slug
// + owner with SLUG_RE and confines the path to memory/). Returns null for a
// malformed/ineligible item.
function conceptToProposal(cp, eligibleSlugs, owner = null) {
  const slug = String(cp && cp.slug || '').toLowerCase().trim();
  if (!isConceptSlug(slug) || !eligibleSlugs.has(slug)) return null;
  // Neutralise code fences/backticks (they'd corrupt the draft ``` content block
  // on re-parse) and cap length.
  const claim = String(cp.claim || '')
    .trim().replace(/^[-*]\s+/, '').replace(/`+/g, "'").replace(/\s+/g, ' ').slice(0, 280);
  if (!claim) return null;
  const date = new Date().toISOString().slice(0, 10);
  // Provenance written into the page is STRUCTURED — never the model's free text.
  // The model's rationale stays in the proposal's rationale field (review-only).
  const src = String(cp.rationale || '').replace(/`+/g, "'").replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    kind: 'concept',
    card: slug,                       // the slug; reflect-apply validates with SLUG_RE
    section: 'Claims',
    action: 'append',
    content: `- ${claim}  [Source: distilled ${date}]`,
    confidence: Number(cp.confidence) || 0,
    scope: owner ? 'private' : 'shared',
    owner: owner || '',
    rationale: `concept ${slug}${owner ? ` (→${owner})` : ''}${src ? `: ${src}` : ''}`,
  };
}

// Run ONE concept pass (shared or a single owner's private) and return the
// converted proposals. The digest passed in is ALREADY scope-filtered by the
// caller — this function never widens it, so a private pass can only ever see
// its own owner's verdicts.
async function runConceptPass({ eligible, digest, system, owner }) {
  if (!eligible.length) return [];
  const eligibleSlugs = new Set(eligible.map(c => c.slug));
  const scopeLabel = owner ? "THIS PERSON'S OWN" : 'SHARED';
  const res = await runLLM(system,
    `${scopeLabel} THREAD VERDICTS:\n----\n${digest}\n----\n${renderConceptBlock(eligible)}\nPropose new concept claims (or {"concept_proposals":[]} if nothing is durable).`);
  if (!res.ok) { process.stderr.write(`[reflect-distill] concept LLM (${owner || 'shared'}) failed: ${res.error}\n`); return []; }
  return (res.conceptProposals || []).map(cp => conceptToProposal(cp, eligibleSlugs, owner)).filter(Boolean);
}

// Promotion scout (pass 2c). Classify ONE owner's private org facts; return
// SHARED concept proposals for the promotable ones. The digest is the owner's
// OWN verdicts only (isolation preserved). `autoPromote` decides the fate in the
// CALLER: true → proposals join the auto-apply stream; false → they're written
// to a promotions queue for a later consent ping (never auto-applied).
async function runPromotionScout({ owner, digest, knownSlugs }) {
  const res = await runLLM(SYSTEM_PROMOTION,
    `${owner}'S PRIVATE THREAD VERDICTS:\n----\n${digest}\n----\n`
    + (knownSlugs.length ? `\nKNOWN SLUGS (reuse for the same referent): ${knownSlugs.join(', ')}\n` : '')
    + `\nFind ORG facts safe to share with the whole team (or {"promotions":[]}).`);
  if (!res.ok) { process.stderr.write(`[reflect-distill] promotion scout (${owner}) failed: ${res.error}\n`); return []; }
  const date = new Date().toISOString().slice(0, 10);
  return (res.promotions || []).map((pr) => {
    const slug = String(pr && pr.slug || '').toLowerCase().trim();
    if (!isConceptSlug(slug)) return null;
    const text = String(pr.shared_text || '').trim().replace(/`+/g, "'").replace(/\s+/g, ' ').slice(0, 280);
    if (!text) return null;
    if (Number(pr.confidence) < 0.8) return null;   // promotion floor — leaks are unretractable
    return {
      kind: 'concept',
      card: slug,                    // SHARED concept page (no owner)
      section: 'Claims',
      action: 'append',
      content: `- ${text}  [Source: promoted from ${owner}'s DM, ${date}]`,
      confidence: Number(pr.confidence) || 0,
      scope: 'shared',
      owner: '',
      rationale: `promotion ${slug} (${owner} → shared): ${String(pr.rationale || '').replace(/`+/g, "'").slice(0, 60)}`,
      _promotedFrom: owner,
    };
  }).filter(Boolean);
}

// Queue promotion candidates for owners WITHOUT autoPromote — a later consent
// ping asks the speaker before anything reaches shared memory. Append-only file
// under _drafts (out of the graph); never auto-applied.
function queuePromotionCandidates(candidates) {
  if (!candidates.length) return;
  const dir = join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts');
  const file = join(dir, `promotions-${new Date().toISOString().slice(0, 10)}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    const blocks = candidates.map(c =>
      `## promotion — ${c._promotedFrom} → ${c.card}\n**shared_text:** ${c.content.replace(/^- /, '').replace(/\s*\[Source:.*$/, '')}\n**confidence:** ${c.confidence}\n**status:** awaiting-consent\n\n---\n`).join('\n');
    const head = existsSync(file) ? '' : `# Promotion candidates — awaiting speaker consent\n\n`;
    writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : head) + blocks, { flag: 'w' });
  } catch (err) { process.stderr.write(`[reflect-distill] queue promotions failed: ${err.message}\n`); }
}

function runLLM(system, userMessage) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
      try { env.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); }
      catch (err) { process.stderr.write(`[reflect-distill] token decrypt failed: ${err.message}\n`); }
    }
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, [
        '-p', '--dangerously-skip-permissions', '--strict-mcp-config', '--no-session-persistence',
        '--model', MODEL, '--append-system-prompt', system, '--output-format', 'text',
      ], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: tmpdir() });
    } catch (err) { return resolve({ ok: false, error: `spawn: ${err.message}` }); }
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TIMEOUT);
    proc.stdin.write(userMessage);
    proc.stdin.end();
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => process.stderr.write(`[reflect-distill/llm] ${c.toString('utf8')}`));
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `exit ${code}` });
      const parsed = parseDistillOutput(out);
      if (!parsed) return finish({ ok: false, error: 'unparseable output' });
      finish({ ok: true, proposals: parsed.proposals, conceptProposals: parsed.conceptProposals, promotions: parsed.promotions });
    });
  });
}

// Pipe the proposals through reflect-apply.py. Reflect v2: `ingest --auto`
// APPLIES the safe envelope (concept/topic page ops + high-confidence non-RULES
// card appends) immediately and queues the rest for /memory review — breaking
// the dead-drafts deadlock. REFLECT_AUTO_APPLY=0 makes the script queue
// everything (its own env kill switch), so we can always pass --auto here.
function ingestProposals(proposals) {
  return new Promise((resolve) => {
    if (!existsSync(REFLECT_APPLY)) return resolve({ ok: false, error: `apply script missing: ${REFLECT_APPLY}` });
    const base = process.env.PROJECT_DIR || PROJECT_DIR;
    const tmp = join(tmpdir(), `distill-${Date.now()}.json`);
    try { writeFileSync(tmp, JSON.stringify({ proposals })); } catch (err) { return resolve({ ok: false, error: err.message }); }
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    let proc;
    try { proc = spawn('python3', [REFLECT_APPLY, 'ingest', '--auto', tmp], { env: { ...process.env, PROJECT_DIR: base }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return finish({ ok: false, error: `spawn python3: ${err.message}` }); }
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => process.stderr.write(`[reflect-distill/apply] ${c.toString('utf8')}`));
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => finish({ ok: code === 0, out: out.trim(), code }));
  });
}

function rateLimited() {
  const marker = join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts', '.last-distill');
  try {
    const last = Number(readFileSync(marker, 'utf8').trim());
    if (Number.isFinite(last) && Date.now() - last < INTERVAL_MS) return true;
  } catch { /* no marker yet → not rate-limited */ }
  return false;
}
function stampDistill() {
  try {
    const dir = join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.last-distill'), String(Date.now()));
  } catch { /* best-effort */ }
}

/**
 * Read recent durable verdicts → propose 7-card updates → _drafts (operator review).
 * Single-flight + rate-limited (default ~12h) so the monitor can call it every tick.
 * `force:true` bypasses the rate-limit (manual/testing). Returns
 *   { ok, verdicts, proposals, ingest } or { ok:false, error }.
 */
export async function distillVerdicts({ force = false } = {}) {
  if (_distilling) return { ok: true, skipped: 'in-progress' };
  if (!force && rateLimited()) return { ok: true, skipped: 'rate-limited' };
  _distilling = true;
  try {
    // Cards see the RECENT window (fresh facts); concepts see a WIDER window
    // (accumulated entity knowledge). Reading both is cheap (memory is small).
    const verdicts = readRecentDurableVerdicts();                                    // cards: 2-day window
    const conceptVerdicts = readRecentDurableVerdicts(CONCEPT_WINDOW_MS, CONCEPT_MAX_VERDICTS); // concepts: 30-day
    stampDistill();   // stamp even on empty, so we don't re-scan every tick
    if (!verdicts.length && !conceptVerdicts.length) return { ok: true, verdicts: 0, proposals: 0, concepts: 0 };

    // PASS 1 — the 7 cards. Runs over the RECENT digest (private verdicts included,
    // because a private USER_* card legitimately needs its owner's threads). Skipped
    // when there's nothing fresh in the card window (concepts may still fire below).
    let cardProposals = [];
    if (verdicts.length) {
      const cardRes = await runLLM(SYSTEM_CARDS,
        `RECENT THREAD VERDICTS:\n----\n${renderDigest(verdicts)}\n----\nPropose durable 7-card additions (or {"proposals":[]} if nothing is durable).`);
      if (!cardRes.ok) { process.stderr.write(`[reflect-distill] card LLM failed: ${cardRes.error}\n`); return { ok: false, error: cardRes.error }; }
      // `kind` is SERVER-controlled: strip any model-set kind so a card-bucket item
      // can NEVER masquerade as a concept proposal and bypass the heat gate below.
      cardProposals = (cardRes.proposals || []).map(({ kind, ...rest }) => rest);
    }

    // PASS 2a — SHARED concept pages. Runs over a SHARED-ONLY digest (private
    // verdict bodies are NEVER in its context) so a team-visible page can never
    // be sourced from a teammate's private thread. Uses the WIDER concept window.
    let conceptProposals = await runConceptPass({
      eligible: eligibleConceptsFor(conceptVerdicts, null),
      digest: renderDigest(conceptVerdicts.filter(v => !v.owner)),
      system: SYSTEM_CONCEPTS, owner: null,
    });

    // PASS 2b — PRIVATE concept pages, ONE isolated pass per owner. Each owner's
    // pass sees ONLY that owner's own verdicts (renderDigest filtered to
    // v.owner === owner — never shared, never another teammate's) so a private
    // fact can never leak across users, and lands at memory/users/<owner>/concepts/.
    // This is what lets concepts actually emerge on a team-mode bot where all
    // conversations are private 1:1s. Bounded to CONCEPT_OWNERS_MAX owners/cycle.
    const ownerCandidates = [...new Set(conceptVerdicts.filter(v => v.owner).map(v => v.owner))]
      .map(o => ({ owner: o, eligible: eligibleConceptsFor(conceptVerdicts, o) }))
      .filter(x => x.eligible.length);
    if (ownerCandidates.length > CONCEPT_OWNERS_MAX) {
      process.stderr.write(`[reflect-distill] ${ownerCandidates.length} owners with hot concepts — capping to ${CONCEPT_OWNERS_MAX} this cycle (rest next cycle)\n`);
    }
    let privateConceptCount = 0;
    for (const { owner, eligible } of ownerCandidates.slice(0, CONCEPT_OWNERS_MAX)) {
      const privProps = await runConceptPass({
        eligible,
        digest: renderDigest(conceptVerdicts.filter(v => v.owner === owner)),   // ISOLATION: this owner only
        system: SYSTEM_CONCEPTS_PRIVATE, owner,
      });
      privateConceptCount += privProps.length;
      conceptProposals.push(...privProps);
    }
    conceptProposals = conceptProposals.slice(0, CONCEPT_MAX);

    // PASS 2c — PROMOTION SCOUT (reflect v2 scope routing). For each owner, find
    // ORG facts trapped under their DM privacy ceiling that are safe to share.
    // Isolation preserved (each scout sees ONLY that owner's verdicts — same as
    // the private concept pass; pass 2a's shared context is NEVER widened). An
    // owner who pre-consented (autoPromote) → their promotions join the auto-apply
    // stream; everyone else → a consent-queue file the operator/ping resolves.
    let promotionProposals = [];
    try {
      const autoOwners = new Set(autoPromoteOwners());
      const ownersWithVerdicts = [...new Set(conceptVerdicts.filter(v => v.owner).map(v => v.owner))];
      const queued = [];
      for (const owner of ownersWithVerdicts.slice(0, CONCEPT_OWNERS_MAX)) {
        const ownerVerdicts = conceptVerdicts.filter(v => v.owner === owner);
        // Only bother when the owner's private threads carry org-shaped signal.
        if (!ownerVerdicts.some(v => (v.durableFacts && v.durableFacts.length) || v.decisions.length)) continue;
        const cands = await runPromotionScout({
          owner,
          digest: renderDigest(ownerVerdicts),                 // ISOLATION: this owner only
          knownSlugs: eligibleConceptsFor(conceptVerdicts, null).map(c => c.slug),
        });
        if (!cands.length) continue;
        if (autoOwners.has(owner)) promotionProposals.push(...cands);   // pre-consented → auto-apply
        else queued.push(...cands);                                     // needs consent → queue
      }
      queuePromotionCandidates(queued);
      if (queued.length) process.stderr.write(`[reflect-distill] ${queued.length} promotion candidate(s) queued for consent\n`);
    } catch (err) { process.stderr.write(`[reflect-distill] promotion scout error: ${err.message}\n`); }

    const proposals = [...cardProposals, ...conceptProposals, ...promotionProposals];
    if (!proposals.length) { process.stderr.write(`[reflect-distill] ${verdicts.length} card-window + ${conceptVerdicts.length} concept-window verdict(s) → 0 durable proposals\n`); return { ok: true, verdicts: verdicts.length, conceptVerdicts: conceptVerdicts.length, proposals: 0, concepts: 0 }; }

    const ing = await ingestProposals(proposals);
    const sharedConceptCount = conceptProposals.length - privateConceptCount;
    process.stderr.write(`[reflect-distill] ${verdicts.length} card-window + ${conceptVerdicts.length} concept-window verdict(s) → ${cardProposals.length} card + ${conceptProposals.length} concept (${Math.max(0, sharedConceptCount)} shared, ${privateConceptCount} private) → _drafts (${ing.ok ? ing.out : 'ingest FAILED: ' + ing.error})\n`);
    return { ok: true, verdicts: verdicts.length, conceptVerdicts: conceptVerdicts.length, proposals: proposals.length, concepts: conceptProposals.length, conceptsPrivate: privateConceptCount, ingest: ing.ok ? ing.out : ing.error };
  } finally {
    _distilling = false;
  }
}
