/**
 * memory-lint — the wiki's periodic health-check (Karpathy-LLM-wiki LINT op).
 *
 * Reads the SHARED memory wiki (the 7 cards + INDEX + concept/topic pages + a
 * heat summary), asks a cheap model to spot HEALTH problems — contradictions,
 * stale claims, orphan pages, recurring slugs with no concept page, INDEX drift,
 * near-duplicate slugs — and routes each finding as an advisory `kind:"lint"`
 * proposal through the SAME operator-approval path as everything else:
 *
 *   shared wiki ──claude -p──▶ findings ──reflect-apply.py ingest──▶
 *                         memory/_drafts/ ──▶ /memory review ──▶ memory/LINT.md
 *
 * NON-DESTRUCTIVE by construction: a finding is an append-only advisory bullet
 * the operator acts on by hand. memory-lint NEVER mutates a fact, never touches
 * a card/concept body, and never reads another teammate's private tree (shared
 * surface only — no private data ever reaches a finding). Self-rate-limited
 * (~24h, the heaviest reflect call) + single-flight so the monitor can poke it
 * every tick cheaply.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_BIN, PROJECT_DIR } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';
import { computeConceptHeat } from './memory-graph.js';
import { CARDS } from './memory-registry.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const MODEL        = process.env.REFLECT_LINT_MODEL || 'claude-haiku-4-5';
const INTERVAL_MS  = num('REFLECT_LINT_INTERVAL_HOURS', 24) * 3600 * 1000;
const TIMEOUT      = num('REFLECT_LINT_TIMEOUT_MS', 90000);
const MAX_FINDINGS = Math.max(1, num('REFLECT_LINT_MAX', 8));
const CONCEPT_HEAT  = Math.max(1, num('REFLECT_CONCEPT_HEAT', 3));
const PER_FILE_CLAMP = 1600;     // chars per file in the digest
const DIGEST_CLAMP   = 14000;    // total digest chars (size guard → shards)
const REFLECT_APPLY  = process.env.REFLECT_APPLY_PY || '/opt/ide/hooks/reflect-apply.py';

let _linting = false;

const FINDING_TYPES = new Set(['contradiction', 'stale', 'orphan', 'missing_concept', 'index_drift', 'duplicate']);

const SYSTEM = [
  'You are a memory-wiki LINT bot. INPUT: a numbered digest of a small markdown knowledge base (role cards, an INDEX, concept pages, topic pages, plus a HOT SLUGS summary). Your ONLY job is to spot HEALTH problems — do NOT summarise content, do NOT propose new facts.',
  '',
  'Output ONE JSON object and NOTHING else (no preamble, no fences):',
  '{"findings":[{"type":"contradiction","detail":"RULES says never email cold but USER_PREFERENCES says prefers cold email","confidence":0.9}]}',
  '',
  'Allowed types: "contradiction" (two places disagree), "stale" (a claim that looks outdated/superseded), "orphan" (a concept/topic page nothing links to and not in INDEX), "missing_concept" (a HOT slug with no concept page), "index_drift" (a page exists with no INDEX entry, or an INDEX entry whose page is gone), "duplicate" (two near-duplicate slugs, e.g. acme vs acme-pricing).',
  '',
  'Rules: NAME the files/sections involved in each detail (≤ 200 chars) — describe the issue, do NOT quote card/page body text verbatim. NEVER invent a problem — under-report. An empty list {"findings":[]} is the common, correct answer. NEVER echo secrets, tokens, personal details, or full file bodies. Each finding must be independently actionable by a human.',
].join('\n');

// ---- read the SHARED wiki ----

function clamp(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}

function readShared(rel) {
  try { return readFileSync(join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', rel), 'utf8'); }
  catch { return ''; }
}

function listMd(subdir) {
  try {
    return readdirSync(join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', subdir))
      .filter(f => /\.md$/i.test(f) && f.toLowerCase() !== 'about.md');
  } catch { return []; }
}

// Root-level GENUINELY-SHARED cards worth linting — DERIVED from the card
// registry (tier === 'shared'), so the privacy rule is structural rather than a
// hand-list that has to be remembered. It excludes every USER_* card by
// construction: in team mode those are per-user PRIVATE (memory/users/<slug>/),
// and the flat memory/USER_*.md can still hold a legacy install's private
// profile — reading them here could echo a private detail into a SHARED lint
// finding. Lint never reads any per-user tree. The hand-list this replaces had
// also gone stale: it missed CHANNELS and MISSION.
const ROOT_CARDS = CARDS.filter(c => c.tier === 'shared').map(c => c.id);

function buildDigest() {
  const sections = [];
  let n = 0;
  const add = (label, body) => {
    const b = clamp(body, PER_FILE_CLAMP);
    if (b) sections.push(`[${++n}] ${label}\n${b}`);
  };

  for (const c of ROOT_CARDS) {
    const body = readShared(`${c}.md`);
    if (body) add(`CARD ${c}`, body);
  }
  for (const f of listMd('concepts')) add(`CONCEPT concepts/${f}`, readShared(`concepts/${f}`));
  for (const f of listMd('topics'))   add(`TOPIC topics/${f}`,     readShared(`topics/${f}`));

  // HOT SLUGS summary: which recurring entities have a page vs not (→ missing_concept).
  const heat = computeConceptHeat();
  const pages = new Set(listMd('concepts').map(f => f.replace(/\.md$/i, '').toLowerCase()));
  const hot = Object.entries(heat)
    .filter(([, c]) => c >= CONCEPT_HEAT)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, c]) => `${slug} (${c} threads)${pages.has(slug) ? ' [has page]' : ' [NO PAGE]'}`);
  if (hot.length) sections.push(`[${++n}] HOT SLUGS (heat ≥ ${CONCEPT_HEAT})\n${hot.join('\n')}`);

  let digest = sections.join('\n\n');
  // Size guard: if the wiki has ballooned, keep cards + concepts + hot summary,
  // drop the topic pages (least load-bearing for health checks).
  if (digest.length > DIGEST_CLAMP) {
    const kept = sections.filter(s => !/^\[\d+\] TOPIC /.test(s));
    digest = kept.join('\n\n');
  }
  return clamp(digest, DIGEST_CLAMP);
}

// ---- LLM ----

function parseFindings(text) {
  if (!text) return null;
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o || !Array.isArray(o.findings)) return null;
    return o.findings;
  } catch { return null; }
}

function runLintLLM(digest) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
      try { env.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); }
      catch (err) { process.stderr.write(`[memory-lint] token decrypt failed: ${err.message}\n`); }
    }
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, [
        '-p', '--dangerously-skip-permissions', '--strict-mcp-config', '--no-session-persistence',
        '--model', MODEL, '--append-system-prompt', SYSTEM, '--output-format', 'text',
      ], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: tmpdir() });
    } catch (err) { return resolve({ ok: false, error: `spawn: ${err.message}` }); }
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TIMEOUT);
    proc.stdin.write(`MEMORY WIKI DIGEST:\n----\n${digest}\n----\nReport health findings only (or {"findings":[]} if the wiki is healthy).`);
    proc.stdin.end();
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => process.stderr.write(`[memory-lint/llm] ${c.toString('utf8')}`));
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `exit ${code}` });
      const findings = parseFindings(out);
      if (!findings) return finish({ ok: false, error: 'unparseable findings' });
      finish({ ok: true, findings });
    });
  });
}

// ---- ingest (advisory lint proposals → _drafts) ----

function findingToProposal(f) {
  const type = String(f && f.type || '').trim();
  if (!FINDING_TYPES.has(type)) return null;
  const detail = String(f.detail || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!detail) return null;
  const date = new Date().toISOString().slice(0, 10);
  return {
    kind: 'lint',
    card: 'LINT',
    section: 'Findings',
    action: 'append',
    content: `- [${type}] ${detail}  (flagged ${date})`,
    confidence: Number(f.confidence) || 0.7,
    scope: 'shared',
    rationale: `lint: ${type}`,
  };
}

function ingestProposals(proposals) {
  return new Promise((resolve) => {
    if (!existsSync(REFLECT_APPLY)) return resolve({ ok: false, error: `apply script missing: ${REFLECT_APPLY}` });
    const base = process.env.PROJECT_DIR || PROJECT_DIR;
    const tmp = join(tmpdir(), `lint-${Date.now()}.json`);
    try { writeFileSync(tmp, JSON.stringify({ proposals })); } catch (err) { return resolve({ ok: false, error: err.message }); }
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    let proc;
    try { proc = spawn('python3', [REFLECT_APPLY, 'ingest', tmp], { env: { ...process.env, PROJECT_DIR: base }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return finish({ ok: false, error: `spawn python3: ${err.message}` }); }
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => process.stderr.write(`[memory-lint/apply] ${c.toString('utf8')}`));
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => finish({ ok: code === 0, out: out.trim(), code }));
  });
}

function markerPath() { return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts', '.last-lint'); }
function rateLimited() {
  try {
    const last = Number(readFileSync(markerPath(), 'utf8').trim());
    if (Number.isFinite(last) && Date.now() - last < INTERVAL_MS) return true;
  } catch { /* no marker → not limited */ }
  return false;
}
function stamp() {
  try {
    const dir = join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(), String(Date.now()));
  } catch { /* best-effort */ }
}

/**
 * Lint the shared wiki → advisory findings → _drafts (operator review).
 * Single-flight + rate-limited (~24h). `force:true` bypasses the rate-limit.
 * Returns { ok, findings, proposals, ingest } or { ok:false, error }.
 */
export async function lintMemory({ force = false } = {}) {
  if (_linting) return { ok: true, skipped: 'in-progress' };
  if (!force && rateLimited()) return { ok: true, skipped: 'rate-limited' };
  _linting = true;
  try {
    const digest = buildDigest();
    stamp();   // stamp even on empty, so we don't re-scan every tick
    if (!digest.trim()) return { ok: true, findings: 0, proposals: 0 };

    const res = await runLintLLM(digest);
    if (!res.ok) { process.stderr.write(`[memory-lint] LLM failed: ${res.error}\n`); return { ok: false, error: res.error }; }

    const proposals = res.findings.map(findingToProposal).filter(Boolean).slice(0, MAX_FINDINGS);
    if (!proposals.length) { process.stderr.write(`[memory-lint] wiki healthy → 0 findings\n`); return { ok: true, findings: 0, proposals: 0 }; }

    const ing = await ingestProposals(proposals);
    process.stderr.write(`[memory-lint] ${proposals.length} finding(s) → _drafts (${ing.ok ? ing.out : 'ingest FAILED: ' + ing.error})\n`);
    return { ok: true, findings: res.findings.length, proposals: proposals.length, ingest: ing.ok ? ing.out : ing.error };
  } finally {
    _linting = false;
  }
}
