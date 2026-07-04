/**
 * reflect-curate — the gardener (reflect v2, phase 2b).
 *
 * The distiller (reflect-distill) APPENDS atomic claims to a page's `## Claims`
 * buffer. Left alone, a page degrades into an append-only log — the opposite of
 * a tight, hand-curated topic page. The curate
 * pass periodically REWRITES a whole page in place: folds the buffer into
 * curated prose sections, merges duplicates, supersedes stale facts, and empties
 * the buffer — so pages stay evergreen.
 *
 *   distill ──append claim──▶ page `## Claims` buffer
 *                                     │  (buffer full OR stale)
 *                                     ▼  reflect-curate (THIS, Sonnet)
 *                 full-page rewrite + conservation manifest → reflect-apply
 *                 `curate` action (guarded: frontmatter frozen, do_not_write_here
 *                 untouched, >40% non-buffer loss → gated draft, undo snapshot)
 *
 * Safety is mechanical, not trust: every pre-existing claim must be accounted
 * for (kept / folded / dropped), the frontmatter must survive byte-identical,
 * protected sections are inviolable, and two reverts on a page freeze it
 * (`hand-curated: true`) so the pipeline stops touching what a human owns.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_BIN, PROJECT_DIR } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const MODEL         = process.env.REFLECT_CURATE_MODEL || 'claude-sonnet-5';
const TIMEOUT       = num('REFLECT_CURATE_TIMEOUT_MS', 120000);
const CURATE_MAX    = Math.max(1, num('REFLECT_CURATE_MAX', 2));          // pages rewritten per cycle
const BUFFER_TRIGGER = Math.max(3, num('REFLECT_CURATE_MIN_CLAIMS', 5));  // claims that trigger a curate
const STALE_MS      = num('REFLECT_CURATE_STALE_DAYS', 14) * 86400 * 1000;
const INTERVAL_MS   = num('REFLECT_CURATE_INTERVAL_HOURS', 12) * 3600 * 1000;
const REFLECT_APPLY = process.env.REFLECT_APPLY_PY || '/opt/ide/hooks/reflect-apply.py';

let _curating = false;

const SYSTEM = [
  'You are the GARDENER of one evergreen memory page. You receive the FULL current page and rewrite it so it stays tight, current, and well-organised — like a hand-maintained wiki page, NOT an append-only log. Output ONE JSON object and NOTHING else (no preamble, no fences).',
  '',
  'Output shape:',
  '{"page":"<the complete rewritten markdown, including the unchanged frontmatter>","manifest":{"kept":["<claim text kept as-is>"],"folded":["<claim text folded into prose>"],"dropped":["<claim text intentionally dropped, verbatim>"]},"confidence":0.9}',
  '',
  'HOUSE STYLE (mirror the workspace exemplars):',
  '- Frontmatter stays FIRST and BYTE-IDENTICAL — do not touch a single character of the --- ... --- block. Copy it verbatim into "page".',
  '- Open with a 2-3 sentence `## Summary` that doubles as the page tooltip.',
  '- Group facts into tight, typed sections (a person page: Role / How to work with them / Current threads; a project page: Goal / Current state / Decisions / Open loops / Pointers). Prefer a small table over a bullet sprawl.',
  '- Supersede in place: when a new fact overrides an old one, REWRITE it and add one dated line to a capped `## Log` (max 10 lines, drop the oldest) — never keep strikethrough graveyards.',
  '- EMPTY the `## Claims` buffer: every claim there must be folded into a curated section or explicitly dropped. The rewritten page must NOT contain a `## Claims` section with leftover bullets.',
  '- Link known entities as [[slug]] when a KNOWN SLUGS list is given.',
  '- Keep it dense: aim under ~120 lines. Cut redundancy, keep specifics (names, dates, IDs, numbers).',
  '',
  'INVIOLABLE:',
  '- Obey the page\'s own `write_how` and NEVER alter any section named in its `do_not_write_here` — copy those sections through verbatim.',
  '- CONSERVATION: every pre-existing claim/fact must appear in the manifest as kept, folded, or dropped. Only drop a fact that is a duplicate, superseded, or pure task-noise — and list it verbatim in "dropped". When unsure, KEEP it. Losing a real fact is the one unacceptable failure.',
  '- Invent nothing. Every sentence must trace to content already on the page.',
].join('\n');

// ── Page discovery ───────────────────────────────────────────────────────────
// A page is a curate candidate when its `## Claims` buffer is big enough OR it
// has claims and hasn't been curated recently. `hand-curated: true` in the
// frontmatter freezes a page (the circuit breaker — see the revert logic in
// reflect-apply). Returns [{ absPath, relPath, slug, scope, owner, claims, mtimeMs }].
function pageDirs() {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  const dirs = [
    { dir: join(base, 'memory', 'concepts'), owner: null },
    { dir: join(base, 'memory', 'topics'),   owner: null },
  ];
  try {
    for (const u of readdirSync(join(base, 'memory', 'users'), { withFileTypes: true })) {
      if (!u.isDirectory()) continue;
      dirs.push({ dir: join(base, 'memory', 'users', u.name, 'concepts'), owner: u.name });
      dirs.push({ dir: join(base, 'memory', 'users', u.name, 'topics'),   owner: u.name });
    }
  } catch { /* no users tree */ }
  return dirs;
}

function claimLines(body) {
  // Split on `## ` headings and pull the Claims section. A regex with a
  // non-greedy capture + multiline `$` truncates at the first line end, so it
  // would report only ONE claim — split-on-heading avoids that entirely.
  const parts = String(body).split(/\n##\s+/);
  const sec = parts.find(p => /^Claims\b/i.test(p.trimStart()));
  if (!sec) return [];
  return sec.split('\n').slice(1).map(l => l.trim()).filter(l => l.startsWith('-'));
}

function frozen(body) {
  return /^hand-curated:\s*true\s*$/im.test(body.slice(0, body.indexOf('\n---', 3) + 4 || 400));
}

function curateCandidates() {
  const now = Date.now();
  const out = [];
  for (const { dir, owner } of pageDirs()) {
    let files;
    try { files = readdirSync(dir).filter(f => /\.md$/i.test(f) && f.toLowerCase() !== 'about.md'); } catch { continue; }
    for (const f of files) {
      const abs = join(dir, f);
      let body, st;
      try { body = readFileSync(abs, 'utf8'); st = statSync(abs); } catch { continue; }
      if (frozen(body)) continue;
      const claims = claimLines(body);
      if (!claims.length) continue;
      const stale = now - st.mtimeMs > STALE_MS;
      if (claims.length < BUFFER_TRIGGER && !stale) continue;
      out.push({
        absPath: abs,
        relPath: abs.slice((process.env.PROJECT_DIR || PROJECT_DIR).length + 1),
        slug: f.replace(/\.md$/i, ''),
        scope: owner ? 'private' : 'shared', owner,
        claims, mtimeMs: st.mtimeMs,
        priority: (stale ? 1e13 : 0) + claims.length,   // stale first, then fullest buffer
      });
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}

// Frozen frontmatter block (must survive byte-identical through a rewrite).
function frontmatter(body) {
  if (!body.startsWith('---')) return '';
  const end = body.indexOf('\n---', 3);
  return end === -1 ? '' : body.slice(0, end + 4);
}
function frontmatterValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}
function knownSlugsFor(owner) {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  const slugs = new Set();
  const scan = (d) => { try { for (const f of readdirSync(d)) { const m = f.match(/^([a-z0-9][a-z0-9-]*)\.md$/i); if (m && m[1].toLowerCase() !== 'about') slugs.add(m[1].toLowerCase()); } } catch { /* skip */ } };
  scan(join(base, 'memory', 'concepts')); scan(join(base, 'memory', 'topics'));
  if (owner) { scan(join(base, 'memory', 'users', owner, 'concepts')); scan(join(base, 'memory', 'users', owner, 'topics')); }
  return [...slugs].sort().slice(0, 60);
}

function parseCurateOutput(text) {
  if (!text) return null;
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const o = JSON.parse(s.slice(start, i + 1));
        if (o && typeof o.page === 'string' && o.page.trim()) return o;
      } catch { /* unparseable */ }
      return null;
    }
  }
  return null;
}

function runLLM(userMessage) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
      try { env.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); } catch { /* fall through */ }
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
    proc.stdin.write(userMessage); proc.stdin.end();
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => process.stderr.write(`[reflect-curate/llm] ${c.toString('utf8')}`));
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `exit ${code}` });
      const parsed = parseCurateOutput(out);
      finish(parsed ? { ok: true, parsed } : { ok: false, error: 'unparseable output' });
    });
  });
}

// ── Mechanical guards (reject before write) ──────────────────────────────────
// These run in JS BEFORE handing the rewrite to reflect-apply. Anything a guard
// rejects is skipped (logged), never written — the page keeps its buffer and the
// operator/live-agent can handle it. This is the trust infrastructure that lets
// a full-page LLM rewrite auto-apply safely.
function guardRewrite(before, after, cand) {
  const fmBefore = frontmatter(before);
  const fmAfter  = frontmatter(after);
  if (!fmAfter || fmAfter !== fmBefore) return 'frontmatter not byte-identical';

  // do_not_write_here sections must pass through verbatim.
  const dnw = frontmatterValue(fmBefore, 'do_not_write_here');
  if (dnw) {
    for (const raw of dnw.split(/[;,]/)) {
      const name = raw.trim().replace(/\(.*?\)/g, '').trim();
      if (name.length < 3) continue;
      const secRe = new RegExp(`^##\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'im');
      const b = before.match(secRe), a = after.match(secRe);
      if (b && (!a || a[1].trim() !== b[1].trim())) return `protected section "${name}" was altered`;
    }
  }

  // The Claims buffer must be emptied (folded), not left dangling.
  if (claimLines(after).length > 0) return 'Claims buffer not emptied by the rewrite';

  // Conservation: every pre-existing claim must be accounted for in the manifest.
  const man = cand.manifest || {};
  const accounted = new Set([...(man.kept || []), ...(man.folded || []), ...(man.dropped || [])]
    .map(s => String(s).replace(/\s*\[Source:[^\]]*\]/gi, '').replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase()));
  for (const claim of cand.claims) {
    const norm = claim.replace(/\s*\[Source:[^\]]*\]/gi, '').replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm && !accounted.has(norm)) return `claim not accounted for in manifest: "${claim.slice(0, 60)}"`;
  }

  // Catastrophic-loss guard: the curated body (minus the emptied buffer) must
  // not lose >40% of its non-buffer lines — a rewrite that deletes half the page
  // is a hallucination, not curation.
  const nonBuffer = (t) => t.replace(/^##\s*Claims\s*\n[\s\S]*?(?=\n##\s|$)/im, '').split('\n').filter(l => l.trim()).length;
  const b = nonBuffer(before), a = nonBuffer(after);
  if (b > 8 && a < b * 0.6) return `rewrite dropped >40% of non-buffer content (${b} → ${a} lines)`;
  return null;
}

function ingestCurate(relPath, newPage) {
  return new Promise((resolve) => {
    if (!existsSync(REFLECT_APPLY)) return resolve({ ok: false, error: `apply script missing: ${REFLECT_APPLY}` });
    const base = process.env.PROJECT_DIR || PROJECT_DIR;
    const tmp = join(tmpdir(), `curate-${Date.now()}.json`);
    try { writeFileSync(tmp, JSON.stringify({ target: relPath, page: newPage })); }
    catch (err) { return resolve({ ok: false, error: err.message }); }
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    let proc;
    try { proc = spawn('python3', [REFLECT_APPLY, 'curate', tmp], { env: { ...process.env, PROJECT_DIR: base }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return finish({ ok: false, error: `spawn python3: ${err.message}` }); }
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => process.stderr.write(`[reflect-curate/apply] ${c.toString('utf8')}`));
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => finish({ ok: code === 0, out: out.trim(), code }));
  });
}

// A curated concept has "grown up" into a topic when it's no longer a bare
// claim list but a structured page: a Summary plus at least a couple of typed
// sections, and enough substance. Below this bar it stays a concept and keeps
// accreting. Tunable via env for the demo / different fleets.
const GRADUATE_MIN_SECTIONS = Math.max(2, num('REFLECT_GRADUATE_MIN_SECTIONS', 3));
const GRADUATE_MIN_LINES    = Math.max(3, num('REFLECT_GRADUATE_MIN_LINES', 6));
function isMatureTopic(pageText) {
  const body = pageText.replace(/^---[\s\S]*?\n---\n/, '');
  const sections = (body.match(/^##\s+/gm) || [])
    .filter(() => true).length;
  const hasSummary = /^##\s*Summary/im.test(body);
  const contentLines = body.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
  return hasSummary && sections >= GRADUATE_MIN_SECTIONS && contentLines >= GRADUATE_MIN_LINES;
}

function graduateConcept(relPath) {
  return new Promise((resolve) => {
    if (!existsSync(REFLECT_APPLY)) return resolve({ ok: false, error: 'apply script missing' });
    const base = process.env.PROJECT_DIR || PROJECT_DIR;
    let proc;
    try { proc = spawn('python3', [REFLECT_APPLY, 'graduate', relPath], { env: { ...process.env, PROJECT_DIR: base }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return resolve({ ok: false, error: err.message }); }
    let out = ''; proc.stdout.on('data', c => { out += c.toString('utf8'); });
    proc.stderr.on('data', c => process.stderr.write(`[reflect-curate/graduate] ${c.toString('utf8')}`));
    proc.on('error', err => resolve({ ok: false, error: err.message }));
    proc.on('close', code => resolve({ ok: code === 0, out: out.trim() }));
  });
}

function rateLimited() {
  const marker = join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts', '.last-curate');
  try { const last = Number(readFileSync(marker, 'utf8').trim()); if (Number.isFinite(last) && Date.now() - last < INTERVAL_MS) return true; } catch { /* none */ }
  return false;
}
function stampCurate() {
  try { writeFileSync(join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory', '_drafts', '.last-curate'), String(Date.now())); } catch { /* best-effort */ }
}

/**
 * Curate up to CURATE_MAX pages whose Claims buffer is full or stale. Single-
 * flight + rate-limited so the monitor can call it every tick. `force:true`
 * bypasses the rate limit. Returns { ok, curated, skipped }.
 */
export async function curatePages({ force = false } = {}) {
  if (_curating) return { ok: true, skipped: 'in-progress' };
  if (!force && rateLimited()) return { ok: true, skipped: 'rate-limited' };
  _curating = true;
  try {
    const cands = curateCandidates();
    stampCurate();
    if (!cands.length) { const graduated = await graduateMaturePages(); return { ok: true, curated: 0, graduated }; }
    let curated = 0, skipped = 0;
    for (const cand of cands.slice(0, CURATE_MAX)) {
      let before;
      try { before = readFileSync(cand.absPath, 'utf8'); } catch { continue; }
      const known = knownSlugsFor(cand.owner);
      const res = await runLLM(
        `PAGE (rewrite the whole thing, keep the frontmatter byte-identical):\n----\n${before}\n----\n`
        + (known.length ? `\nKNOWN SLUGS (link as [[slug]] when mentioned): ${known.join(', ')}\n` : '')
        + `\nFold the ## Claims buffer into curated sections, empty it, and return {"page":..., "manifest":{kept,folded,dropped}, "confidence":...}.`);
      if (!res.ok) { process.stderr.write(`[reflect-curate] ${cand.relPath}: LLM ${res.error}\n`); skipped++; continue; }
      const after = res.parsed.page;
      cand.manifest = res.parsed.manifest || {};
      const bad = guardRewrite(before, after, cand);
      if (bad) { process.stderr.write(`[reflect-curate] ${cand.relPath}: GUARD rejected — ${bad}\n`); skipped++; continue; }
      const ing = await ingestCurate(cand.relPath, after);
      if (ing.ok) {
        curated++; process.stderr.write(`[reflect-curate] tended ${cand.relPath} (${cand.claims.length} claims folded)\n`);
        // Reflect v2 lifecycle: a concept that curate has folded into a rich,
        // multi-section page has outgrown "accreting entity notes" and becomes a
        // proper long-form TOPIC. Move concepts/<slug>.md → topics/<slug>.md.
        if (cand.relPath.includes('/concepts/') && isMatureTopic(after)) {
          const g = await graduateConcept(cand.relPath);
          if (g.ok) process.stderr.write(`[reflect-curate] graduated ${cand.relPath} → topic\n`);
        }
      }
      else { skipped++; process.stderr.write(`[reflect-curate] ${cand.relPath}: apply failed — ${ing.error}\n`); }
    }
    const graduated = await graduateMaturePages();
    return { ok: true, curated, skipped, graduated, candidates: cands.length };
  } finally {
    _curating = false;
  }
}

// Graduate any concept page that has matured into a topic-shaped page, even if
// it was folded in an earlier cycle (empty buffer → not a curate candidate).
// This is what makes a concept visibly BECOME a topic once it's rich enough.
async function graduateMaturePages() {
  let n = 0;
  for (const { dir, owner } of pageDirs()) {
    if (!dir.includes('/concepts')) continue;
    let files;
    try { files = readdirSync(dir).filter(f => /\.md$/i.test(f) && f.toLowerCase() !== 'about.md'); } catch { continue; }
    for (const f of files) {
      const abs = join(dir, f);
      let body; try { body = readFileSync(abs, 'utf8'); } catch { continue; }
      if (frozen(body) || !isMatureTopic(body)) continue;
      const rel = abs.slice((process.env.PROJECT_DIR || PROJECT_DIR).length + 1);
      const g = await graduateConcept(rel);
      if (g.ok) { n++; process.stderr.write(`[reflect-curate] graduated ${rel} → topic\n`); }
    }
  }
  return n;
}
