/**
 * memory-migrate — one-shot, idempotent move from the retired reflect pipeline
 * to the memory engine. Runs at wsapi boot; a no-op once the marker exists.
 *
 * Two jobs:
 *
 *  1. ARCHIVE the pipeline's files out of the project tree. `_reflect/` verdict
 *     cards, `_drafts/` (pending proposals nobody could approve any more, plus
 *     the promotion queue), `LINT.md`, and the knowledge-graph JSONL stores are
 *     no longer read by anything. They are tarred to /var/wsapi-store — NOT to
 *     memory/ — because in team mode those drafts contain every teammate's
 *     private facts, and anything left under the project tree is readable by
 *     the whole team.
 *
 *  2. CLEAN the old doctrine off the cards. "Strike, never delete" left the
 *     error in the file: `## Retired` sections, `~~struck~~` claims, and
 *     `[was: …]` tails. That furniture sits in the always-loaded prompt, so the
 *     wrong version stayed as present as the right one — the failure the engine
 *     exists to end. What is removed here is preserved in the archive.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { USERS_DIR } from './scope-rule.js';
import { atomicWrite } from './atomic-write.js';
import { reindexAll } from './memory-engine.js';

const SLUG_RE = /^[a-z0-9-]+$/;
const ARCHIVE_DIR = process.env.WSAPI_STORE_DIR || '/var/wsapi-store';

function projectDir() { return process.env.PROJECT_DIR || PROJECT_DIR; }
function memoryDir() { return join(projectDir(), 'memory'); }
function markerPath() { return join(memoryDir(), '_engine', '.migrated-v3'); }

/** Everything the retired pipeline owned, project-relative. */
function legacyPaths() {
  const mem = memoryDir();
  const out = [];
  const add = (p) => { if (existsSync(p)) out.push(p); };
  add(join(mem, '_reflect'));
  add(join(mem, '_drafts'));
  add(join(mem, 'LINT.md'));
  add(join(projectDir(), '.claude', 'memory.jsonl'));
  const usersRoot = join(mem, USERS_DIR);
  if (existsSync(usersRoot)) {
    for (const e of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      add(join(usersRoot, e.name, '_reflect'));
      add(join(usersRoot, e.name, 'kg.jsonl'));
    }
  }
  return out;
}

/**
 * Strip the retired "leave a trace of the mistake" furniture from one card or
 * page. Returns the cleaned text, or null when nothing changed.
 */
export function stripLegacyDoctrine(text) {
  const original = String(text || '');
  let out = original;

  // A `## Retired` section is a graveyard of struck rules sitting in the prompt.
  out = out.replace(/^##\s+Retired\b[^\n]*\n(?:(?!^##\s)[\s\S])*/gim, '');

  const kept = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    // A struck claim is a retired one that was never removed.
    if (/^[-*+]\s*~~/.test(t)) continue;
    // `[was: X, since Y]` kept the old value inline, next to the new one.
    kept.push(line.replace(/\s*\[was:[^\]]*\]/gi, ''));
  }
  out = kept.join('\n').replace(/\n{3,}/g, '\n\n');

  // The page contract itself told the model to leave the trace.
  out = out.replace(
    /^(purpose:.*?)(?:One atomic, cited claim per line;?\s*strike superseded claims,? never delete\.?)/gim,
    '$1One atomic, cited claim per line. A correction REPLACES the claim it corrects — the previous wording lives in the engine log, never on this page.',
  );
  out = out.replace(/^conflict:.*\[was:.*$/gim,
    'conflict: a new fact REPLACES the old one — call supersede; never write both.');
  out = out.replace(/^(write_how:.*?)Never silently delete a rule — strike-through with date if retired/gim,
    '$1A retired rule is removed — the engine log keeps it');

  return out === original ? null : out;
}

function cleanCards() {
  const mem = memoryDir();
  const dirs = [mem, join(mem, 'concepts'), join(mem, 'topics')];
  const usersRoot = join(mem, USERS_DIR);
  if (existsSync(usersRoot)) {
    for (const e of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      dirs.push(join(usersRoot, e.name), join(usersRoot, e.name, 'concepts'), join(usersRoot, e.name, 'topics'));
    }
  }
  let cleaned = 0;
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const abs = join(dir, e.name);
      let body;
      try { body = readFileSync(abs, 'utf8'); } catch { continue; }
      const next = stripLegacyDoctrine(body);
      if (next != null) { atomicWrite(abs, next); cleaned++; }
    }
  }
  return cleaned;
}

/**
 * Run the migration once. Returns { migrated, summary } — `migrated:false` when
 * it has already run (the marker exists) or there was nothing to do.
 */
export function migrateToEngine() {
  if (existsSync(markerPath())) return { migrated: false, summary: 'already migrated' };

  const legacy = legacyPaths();
  let archived = null;
  if (legacy.length) {
    try {
      mkdirSync(ARCHIVE_DIR, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      archived = join(ARCHIVE_DIR, `memory-v2-archive-${stamp}.tar.gz`);
      // Relative to PROJECT_DIR so the archive unpacks somewhere sane.
      const rel = legacy.map(p => p.slice(projectDir().length + 1));
      execFileSync('tar', ['-czf', archived, '-C', projectDir(), ...rel], { stdio: 'ignore' });
      execFileSync('rm', ['-rf', ...legacy], { stdio: 'ignore' });
    } catch (err) {
      // A failed archive must not delete anything — bail and try again next boot.
      return { migrated: false, summary: `archive failed, nothing removed: ${err.message}` };
    }
  }

  const cleaned = cleanCards();
  const scopes = reindexAll();

  try {
    mkdirSync(join(memoryDir(), '_engine'), { recursive: true });
    writeFileSync(markerPath(), `${new Date().toISOString()}\n`);
  } catch { /* the marker is an optimisation; a repeat run is idempotent anyway */ }

  return {
    migrated: true,
    summary: `archived ${legacy.length} legacy path(s)${archived ? ` → ${archived}` : ''}; `
           + `cleaned ${cleaned} card(s) of retired-claim furniture; reindexed ${scopes} scope(s)`,
  };
}
