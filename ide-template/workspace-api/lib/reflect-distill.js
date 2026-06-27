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

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const MODEL          = process.env.REFLECT_DISTILL_MODEL || 'claude-haiku-4-5';
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
const CONCEPT_HEAT   = Math.max(1, num('REFLECT_CONCEPT_HEAT', 3));
const CONCEPT_MAX    = Math.max(1, num('REFLECT_CONCEPT_MAX', 6));

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
  'Rules: (a) ONLY use a slug that appears verbatim in CONCEPTS IN PLAY — NEVER invent one. (b) Propose AT MOST ONE new claim per slug, and ONLY if the verdicts add something NOT already covered by its existing claims — NOOP a restatement (emit nothing). (c) Atomic: one self-contained fact per claim, durable (true beyond this week); no transient task state, no leading dash. (d) confidence ≥ 0.7 or skip. (e) The page is TEAM-SHARED and read by EVERY teammate — never put a private, sensitive, or personal detail in a claim; if a fact feels personal to one person, it does NOT belong here. (f) No code fences or backticks in a claim.',
  '',
  'Most cycles yield nothing. {"concept_proposals":[]} is correct most of the time. Quality over quantity.',
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
  if (!title) return null;
  return { title, summary, entities, decisions, confidence, owner };
}

function readRecentDurableVerdicts() {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  const now = Date.now();
  const dirs = [{ dir: join(base, 'memory', 'threads'), owner: null }];
  try {
    for (const u of readdirSync(join(base, 'memory', 'users'), { withFileTypes: true })) {
      if (u.isDirectory()) dirs.push({ dir: join(base, 'memory', 'users', u.name, 'threads'), owner: u.name });
    }
  } catch { /* no per-user threads */ }

  const out = [];
  for (const { dir, owner } of dirs) {
    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const abs = join(dir, f);
      let st; try { st = statSync(abs); } catch { continue; }
      if (now - st.mtimeMs > WINDOW_MS) continue;             // outside the window
      let v; try { v = parseVerdict(readFileSync(abs, 'utf8'), owner); } catch { v = null; }
      if (!v) continue;
      // Cheap durability pre-filter: drop the obvious noise (low confidence AND no
      // entities AND no decisions — e.g. the "create folder" one-off). The LLM does
      // the real judgement on what survives.
      if (v.confidence < MIN_CONF && v.entities.length === 0 && v.decisions.length === 0) continue;
      out.push({ ...v, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_VERDICTS);
}

function renderDigest(verdicts) {
  return verdicts.map((v, i) => {
    const lines = [`[${i + 1}] ${v.title}${v.owner ? ` (owner: ${v.owner})` : ''} — confidence ${v.confidence}`];
    if (v.summary) lines.push(`    summary: ${v.summary}`);
    if (v.entities.length) lines.push(`    entities: ${v.entities.join(', ')}`);
    if (v.decisions.length) lines.push(`    decisions: ${v.decisions.join(' | ')}`);
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
    // At least one recognised key must be present, else treat as unparseable
    // (an LLM that "replied" to the transcript instead of emitting the schema).
    if (!('proposals' in o) && !('concept_proposals' in o)) return null;
    return { proposals, conceptProposals };
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
// to confirm whether the page already exists). '' when absent.
function readConceptClaims(slug) {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  try {
    const body = readFileSync(join(base, 'memory', 'concepts', `${slug}.md`), 'utf8');
    const m = body.match(/^##\s*Claims\s*\n([\s\S]*?)(?:\n##\s|$)/im);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// Which recurring slugs are eligible for a concept claim THIS cycle: present in
// the recent SHARED window AND hot enough (≥ CONCEPT_HEAT distinct threads).
// v1 is SHARED-only — private-owner concepts are deferred (no leak path).
function eligibleConcepts(verdicts) {
  const heat = computeConceptHeat();                      // shared threads, all-time
  const inWindow = new Set();
  for (const v of verdicts) {
    if (v.owner) continue;                                // shared verdicts only
    for (const e of v.entities) {
      const s = String(e).toLowerCase().trim();
      if (isConceptSlug(s)) inWindow.add(s);
    }
  }
  return [...inWindow]
    .filter(s => (heat[s] || 0) >= CONCEPT_HEAT)
    .map(s => ({ slug: s, heat: heat[s], claims: readConceptClaims(s) }));
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
  return `\nCONCEPTS IN PLAY (propose at most one NEW atomic claim each, only if not already covered):\n${lines.join('\n')}\n`;
}

// Convert one LLM concept_proposal into the standard proposal shape consumed by
// reflect-apply.py (kind:"concept" → memory/concepts/<slug>.md, append a claim).
// Returns null for a malformed/ineligible item. v1: shared scope only.
function conceptToProposal(cp, eligibleSlugs) {
  const slug = String(cp && cp.slug || '').toLowerCase().trim();
  if (!isConceptSlug(slug) || !eligibleSlugs.has(slug)) return null;
  // The claim is durable, team-SHARED text. Neutralise code fences/backticks
  // (they'd corrupt the draft ``` content block on re-parse) and cap length.
  const claim = String(cp.claim || '')
    .trim().replace(/^[-*]\s+/, '').replace(/`+/g, "'").replace(/\s+/g, ' ').slice(0, 280);
  if (!claim) return null;
  const date = new Date().toISOString().slice(0, 10);
  // Provenance written into the page is STRUCTURED — never the model's free text
  // (which could echo a private/client detail into a shared page). The model's
  // rationale stays in the proposal's rationale field (operator-review only).
  const src = String(cp.rationale || '').replace(/`+/g, "'").replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    kind: 'concept',
    card: slug,                       // the slug; reflect-apply validates with SLUG_RE
    section: 'Claims',
    action: 'append',
    content: `- ${claim}  [Source: distilled ${date}]`,
    confidence: Number(cp.confidence) || 0,
    scope: 'shared',
    owner: '',
    rationale: `concept ${slug}${src ? `: ${src}` : ''}`,
  };
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
      finish({ ok: true, proposals: parsed.proposals, conceptProposals: parsed.conceptProposals });
    });
  });
}

// Pipe the proposals through the existing reflect-apply.py ingest path → _drafts.
function ingestProposals(proposals) {
  return new Promise((resolve) => {
    if (!existsSync(REFLECT_APPLY)) return resolve({ ok: false, error: `apply script missing: ${REFLECT_APPLY}` });
    const base = process.env.PROJECT_DIR || PROJECT_DIR;
    const tmp = join(tmpdir(), `distill-${Date.now()}.json`);
    try { writeFileSync(tmp, JSON.stringify({ proposals })); } catch (err) { return resolve({ ok: false, error: err.message }); }
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    let proc;
    try { proc = spawn('python3', [REFLECT_APPLY, 'ingest', tmp], { env: { ...process.env, PROJECT_DIR: base }, stdio: ['ignore', 'pipe', 'pipe'] }); }
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
    const verdicts = readRecentDurableVerdicts();
    stampDistill();   // stamp even on empty, so we don't re-scan every tick
    if (!verdicts.length) return { ok: true, verdicts: 0, proposals: 0, concepts: 0 };

    // PASS 1 — the 7 cards. Runs over the FULL digest (private verdicts included,
    // because a private USER_* card legitimately needs its owner's threads).
    const cardRes = await runLLM(SYSTEM_CARDS,
      `RECENT THREAD VERDICTS:\n----\n${renderDigest(verdicts)}\n----\nPropose durable 7-card additions (or {"proposals":[]} if nothing is durable).`);
    if (!cardRes.ok) { process.stderr.write(`[reflect-distill] card LLM failed: ${cardRes.error}\n`); return { ok: false, error: cardRes.error }; }
    // `kind` is SERVER-controlled: strip any model-set kind so a card-bucket item
    // can NEVER masquerade as a concept proposal and bypass the heat gate below.
    const cardProposals = (cardRes.proposals || []).map(({ kind, ...rest }) => rest);

    // PASS 2 — concept pages. Runs over a SHARED-ONLY digest (private verdict
    // bodies are NEVER in its context) so a team-visible concept page can never be
    // sourced from a teammate's private thread. Only fires when a slug is hot.
    const eligible = eligibleConcepts(verdicts);
    const eligibleSlugs = new Set(eligible.map(c => c.slug));
    let conceptProposals = [];
    if (eligible.length) {
      const sharedDigest = renderDigest(verdicts.filter(v => !v.owner));
      const cRes = await runLLM(SYSTEM_CONCEPTS,
        `SHARED THREAD VERDICTS:\n----\n${sharedDigest}\n----\n${renderConceptBlock(eligible)}\nPropose new concept claims (or {"concept_proposals":[]} if nothing is durable).`);
      if (!cRes.ok) { process.stderr.write(`[reflect-distill] concept LLM failed: ${cRes.error}\n`); }
      else {
        conceptProposals = (cRes.conceptProposals || [])
          .map(cp => conceptToProposal(cp, eligibleSlugs))
          .filter(Boolean)
          .slice(0, CONCEPT_MAX);
      }
    }

    const proposals = [...cardProposals, ...conceptProposals];
    if (!proposals.length) { process.stderr.write(`[reflect-distill] ${verdicts.length} verdict(s) → 0 durable proposals\n`); return { ok: true, verdicts: verdicts.length, proposals: 0, concepts: 0 }; }

    const ing = await ingestProposals(proposals);
    process.stderr.write(`[reflect-distill] ${verdicts.length} verdict(s) → ${cardProposals.length} card + ${conceptProposals.length} concept proposal(s) → _drafts (${ing.ok ? ing.out : 'ingest FAILED: ' + ing.error})\n`);
    return { ok: true, verdicts: verdicts.length, proposals: proposals.length, concepts: conceptProposals.length, ingest: ing.ok ? ing.out : ing.error };
  } finally {
    _distilling = false;
  }
}
