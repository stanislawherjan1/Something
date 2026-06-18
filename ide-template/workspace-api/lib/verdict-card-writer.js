/**
 * verdict-card-writer — write `memory/threads/<thread-id>.md` after a
 * reflect-summary run (P4 Track B of SAUNA_NEXT §2.4 + §3).
 *
 * Verdict cards are MemGPT/Letta-style memory blocks: discrete,
 * structured, agent-written summaries with explicit invalidation. The
 * overseer (P0.7) reads across them cheaply — 100 verdicts in <10k
 * tokens beats reading 100 transcripts.
 *
 * Pure function (atomic file write, no other side effects). Reflect-
 * summary calls it after the existing thread-metadata update; failures
 * here are logged + swallowed so they never break the primary summary
 * pipeline.
 *
 * Frontmatter shape matches `docs/SAUNA_NEXT.md` §2.4 spec verbatim:
 *   ---
 *   title: string
 *   date: YYYY-MM-DD
 *   thread_id: string
 *   status: 'done' | 'junked' | 'active'
 *   source: 'reflect-summary'              # never user-authored
 *   confidence: number 0..1                # self-estimate from the LLM
 *   written_at: ISO timestamp
 *   entities: string[]                     # wiki-link targets
 *   supersedes: string | null              # path to prior verdict
 *   ---
 *
 * Body shape:
 *   # <title>
 *
 *   ## Outcome
 *   <summary, 2-3 sentences>
 *
 *   ## Decisions made
 *   - <decision 1>
 *   - <decision 2>
 *
 *   ## Open items
 *   - <open 1>
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { atomicWrite } from './atomic-write.js';

const SOURCE = 'reflect-summary';

// A valid owner slug becomes a path segment, so every entry point that accepts
// `owner` sanitizes it here — a malformed value falls back to the shared dir,
// never an escaped path. (writeVerdictCard only sets owner when scope==='private',
// but hasVerdictCard/verdictCardPath are exported and could be called directly.)
const OWNER_SLUG = /^[a-z0-9-]+$/;
const safeOwner = (owner) => (typeof owner === 'string' && OWNER_SLUG.test(owner) ? owner : null);

/**
 * Resolve the threads directory for verdict cards. Lazy + env-aware so
 * tests can override PROJECT_DIR without re-importing the module.
 */
function threadsDir(owner) {
  const base = process.env.PROJECT_DIR || PROJECT_DIR;
  const o = safeOwner(owner);
  // Team mode: a PRIVATE thread (one teammate's 1:1 — personal/sensitive) lives
  // in that user's own memory, not the shared memory/threads/ every teammate can
  // read.
  return o
    ? join(base, 'memory', 'users', o, 'threads')
    : join(base, 'memory', 'threads');
}

/**
 * Build the canonical verdict-card path for a thread. Relative to
 * PROJECT_DIR so callers can report it back without leaking absolute
 * paths into the dashboard / logs. `owner` (a validated slug) routes the
 * card into that teammate's private memory in team mode.
 */
export function verdictCardPath(threadId, owner) {
  const o = safeOwner(owner);
  return o
    ? join('memory', 'users', o, 'threads', `${threadId}.md`)
    : join('memory', 'threads', `${threadId}.md`);
}

/**
 * Returns true when a verdict card already exists for this thread.
 * Used by reflect-summary on `force: true` to set `supersedes`.
 */
export function hasVerdictCard(threadId, owner) {
  return existsSync(join(threadsDir(owner), `${threadId}.md`));
}

/**
 * Build the rendered markdown for a verdict card. Pure — same inputs
 * always produce the same bytes. Exported for testability without a
 * filesystem.
 *
 * @param {object} args
 * @param {string} args.threadId
 * @param {object} args.threadMeta      thread record (state, createdAt, …)
 * @param {object} args.parsedSummary   what reflect-summary returned
 * @param {string|null} [args.supersedes] prior verdict-card path
 * @param {Date|string} [args.writtenAt] override write timestamp (tests)
 */
export function renderVerdictCard({ threadId, threadMeta, parsedSummary, supersedes = null, writtenAt }) {
  const writtenAtIso = writtenAt
    ? (writtenAt instanceof Date ? writtenAt.toISOString() : String(writtenAt))
    : new Date().toISOString();
  const date = writtenAtIso.slice(0, 10);

  const title    = String(parsedSummary?.title    || 'Untitled thread').trim();
  const summary  = String(parsedSummary?.summary  || '').trim();
  const entities = Array.isArray(parsedSummary?.entities)
    ? parsedSummary.entities.filter(e => typeof e === 'string' && e.trim().length > 0).slice(0, 8)
    : [];
  const decisions = Array.isArray(parsedSummary?.decisions)
    ? parsedSummary.decisions.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 20)
    : [];
  const openItems = Array.isArray(parsedSummary?.open_items)
    ? parsedSummary.open_items.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 20)
    : [];
  const confidence = Number.isFinite(parsedSummary?.confidence)
    ? Math.max(0, Math.min(1, parsedSummary.confidence))
    : 0.5;

  // Status comes from the thread record. Junked threads still get a
  // verdict so the overseer can see "this was deliberately dropped";
  // active means a forced re-summarise mid-thread (rare).
  const rawState = String(threadMeta?.state || 'done').trim();
  const status = ['done', 'junked', 'active'].includes(rawState) ? rawState : 'done';

  // YAML scalar quoting — keep it conservative. The title may contain
  // colons or quotes; wrap in double quotes and escape backslashes +
  // quotes. Entity slugs are restricted to safe chars (the SKILL teaches
  // lowercase kebab-case ASCII) so a flow array works without quoting.
  const yamlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const yamlList   = (arr) => `[${arr.map(yamlString).join(', ')}]`;

  const frontmatterLines = [
    '---',
    `title: ${yamlString(title)}`,
    `date: ${date}`,
    `thread_id: ${yamlString(threadId)}`,
    `status: ${status}`,
    `source: ${SOURCE}`,
    `confidence: ${confidence.toFixed(2)}`,
    `written_at: ${writtenAtIso}`,
    `entities: ${yamlList(entities)}`,
    `supersedes: ${supersedes ? yamlString(supersedes) : 'null'}`,
    '---',
  ];

  const bodyLines = [
    '',
    `# ${title}`,
    '',
    '## Outcome',
    '',
    summary || '(no summary produced)',
    '',
    '## Decisions made',
    '',
    decisions.length === 0
      ? '_(none recorded)_'
      : decisions.map(d => `- ${d}`).join('\n'),
    '',
    '## Open items',
    '',
    openItems.length === 0
      ? '_(none recorded)_'
      : openItems.map(o => `- ${o}`).join('\n'),
    '',
  ];

  return frontmatterLines.join('\n') + '\n' + bodyLines.join('\n');
}

/**
 * Write the verdict card to disk atomically. Returns
 *   { path: relativePath, bytes, supersedes }
 * on success. Throws on filesystem errors so callers can decide to log
 * + swallow (the wired-in caller in reflect-summary does exactly that —
 * a verdict-write failure must not break the primary summary update).
 */
export function writeVerdictCard(args) {
  const { threadId } = args;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('verdict-card-writer: threadId is required');
  }
  // Defensive: don't let a hostile threadId escape the threads dir.
  // The thread id format is `t_<uuid-slice>` per lib/threads.js, but
  // verify to be safe.
  if (/[\\/]|\.\./.test(threadId)) {
    throw new Error(`verdict-card-writer: refusing unsafe threadId "${threadId}"`);
  }

  // Team mode: a private thread (args.scope === 'private') belongs to one
  // teammate — write it to memory/users/<owner>/threads/, never the shared dir.
  // safeOwner() rejects a missing/malformed slug (→ shared, never an escaped path).
  //
  // COMPANION CHANGE REQUIRED before any caller passes scope:'private': the
  // reader side (verdict-card-reader.js threadsDir / listVerdictCards, and
  // memory-graph.js) only enumerates memory/threads/ today, so private cards
  // would be written but never surfaced — and a naive broadening of its glob
  // would leak other teammates' private verdicts. Make the reader owner-aware
  // AND gate it with scope-rule.js pathInScope(actor) when that wiring lands.
  const owner = args.scope === 'private' ? safeOwner(args.owner) : null;

  const dir = threadsDir(owner);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const abs = join(dir, `${threadId}.md`);
  const body = renderVerdictCard(args);
  atomicWrite(abs, body, { ensureDir: false });

  let bytes = body.length;
  try { bytes = statSync(abs).size; } catch { /* fine */ }

  return {
    path: verdictCardPath(threadId, owner),
    bytes,
    supersedes: args.supersedes || null,
  };
}
