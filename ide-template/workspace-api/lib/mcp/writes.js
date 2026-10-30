/**
 * What a coding agent may change, as the person — each write asked of the
 * person first by the client (the tools carry `requiresUserInteraction`), each
 * marked as the agent's, each refused when it carries a credential.
 *
 * Tasks and notes go through the very routes the person's own chat uses
 * (a loopback call with a turn token issued for the person, revoked after):
 * the own-list rules, the private-tree guard, the memory links, the note's
 * grounding in the person's words, the sharing gate — nothing re-implemented.
 * A file and a session record have paths of their own, below.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, extname } from 'node:path';
import { PORT, PROJECT_DIR } from '../config.js';
import { issueTurnToken, revokeTurnToken } from '../turn-identity.js';
import { resolveSafePath, writeTextFile, pathContainsHardHidden } from '../files.js';
import * as locks from '../locks.js';
import * as ledger from '../memory-ledger.js';
import * as facts from '../memory-facts.js';
import { atSentence, FACT_CHARS } from '../memory-text.js';
import { looksLikeSecret } from './context.js';

const selfBase = () => process.env.WSAPI_SELF_URL || `http://127.0.0.1:${PORT}`;
const clip = (s, n) => String(s || '').slice(0, n);

/** A request to this workspace-api as the person — the route decides everything. */
async function asPerson(slug, method, path, body) {
  const token = issueTurnToken({ actor: slug });
  try {
    const r = await fetch(`${selfBase()}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-ide-turn': token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { status: r.status, body: j || {} };
  } finally { revokeTurnToken(token); }
}

/** A refusal when something in the text is shaped like a credential. */
export function credentialIn(...texts) {
  return texts.some(t => looksLikeSecret(t)) ? 'That looks like a credential (a password, a code, a key). Keys belong in Integrations, never in tasks, notes or files.' : null;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export async function addTask(v, { title, description = '', board = false, owner, deadline, priority }) {
  const refused = credentialIn(title, description);
  if (refused) return { error: refused };
  const body = { title: clip(title, 200), description: clip(description, 4000) };
  if (board) body.scope = 'shared';
  if (owner) body.owner = owner;
  if (deadline) body.deadline = deadline;
  if (priority) body.priority = priority;
  const r = await asPerson(v.slug, 'POST', '/tasks', body);
  if (r.status === 503) return { error: 'The person\'s own list is not ready on the server yet; try the team board, or later.' };
  if (r.status !== 200 || !r.body.ok) return { error: r.body.error || `the board answered ${r.status}` };
  return { task: r.body.task };
}

const STATUSES = ['backlog', 'in_progress', 'done'];
export async function updateTask(v, id, patch) {
  const body = {};
  for (const k of ['title', 'description', 'deadline', 'priority']) if (patch[k] !== undefined) body[k] = patch[k];
  if (patch.status !== undefined) { if (!STATUSES.includes(patch.status)) return { error: `status is one of ${STATUSES.join(', ')}` }; body.status = patch.status; }
  if (!Object.keys(body).length) return { error: 'nothing to change' };
  const refused = credentialIn(body.title, body.description);
  if (refused) return { error: refused };
  const r = await asPerson(v.slug, 'PATCH', `/tasks/${encodeURIComponent(id)}`, body);
  if (r.status === 404) return { error: 'no such task on the board or the person\'s own list' };
  if (r.status !== 200 || !r.body.ok) return { error: r.body.error || `the board answered ${r.status}` };
  return { task: r.body.task };
}

// ── A note to memory ─────────────────────────────────────────────────────────
/**
 * The person's instruction relayed: `said` is what they told the agent, word
 * for word, and the note route holds the note to it (no detail they did not
 * say, the split per thing, the sharing gate). The agent's own conclusions are
 * not a note — they belong in a session record.
 */
export async function remember(v, { text, said }) {
  const refused = credentialIn(text, said);
  if (refused) return { error: refused };
  const r = await asPerson(v.slug, 'POST', '/internal/memory/v4/note', { text: clip(text, 2000), said: clip(said, 2000) });
  if (r.status !== 200 || !r.body.ok) return { error: r.body.error || `memory answered ${r.status}` };
  return { result: r.body };
}

// ── A session ────────────────────────────────────────────────────────────────
/**
 * One record per project per day, in the person's private scope, written by
 * the agent and marked so: "Context MCP: <project> (<day>)" with the summary as one
 * fact — the same conversation all day, so a later summary that day updates
 * the fact instead of adding another. It never becomes a rule, a preference or
 * a profile line (`by: agent:*` is held to plain facts in lib/memory-facts.js).
 */
export async function logSession(v, agent, { project, summary }) {
  const refused = credentialIn(project, summary);
  if (refused) return { error: refused };
  const name = clip(String(project || '').trim(), 80) || 'a project';
  const text = String(summary || '').trim();
  if (!text) return { error: 'summary required: what was done, what was decided, what is open' };
  const scope = v.own;
  const day = new Date().toISOString().slice(0, 10);
  const slugOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
  const by = `agent:${slugOf(agent.client)}`;
  const conv = `${by}:${slugOf(name)}:${day}`;
  const rec = await ledger.append({ scope, source: 'agent', conv, speaker: agent.client, text: `${agent.client} session: ${name}\n${clip(text, 6000)}`, tags: { agent: { client: agent.client, project: name, grant: agent.grant } } });
  if (!rec.ok) return { error: rec.skipped === 'tombstoned' ? 'this was erased by its owner and cannot be saved again' : 'not saved' };
  const dayLabel = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  // Which agent shows as the record's logo on Memory; the title says it came through Context MCP.
  const title = clip(`Context MCP: ${name} (${dayLabel})`, 120);
  // Today's session on this project already has its fact: the new summary
  // joins it (the same conversation, so the fact takes the fuller wording in
  // place) instead of standing beside it.
  const today = facts.all(scope).find(f => !f.hidden && !f.replacedBy && !f.retired && f.title === title && String(f.by || '') === by);
  const fact = { title, text: atSentence(today ? `${today.text} Later: ${text}` : `According to a ${agent.client} session: ${text}`, FACT_CHARS), kind: 'fact', evidence: null };
  const got = today
    ? await facts.apply(scope, [{ op: 'replace', target: today, fact }], { record: rec.id, by, standing: 'found', conv, convSince: `${day}T00:00:00.000Z`, single: true })
    : await facts.remember(scope, [fact], { record: rec.id, by, standing: 'found', conv, convSince: `${day}T00:00:00.000Z` });
  ledger.logEvent({ op: 'agent_write', scope, by: v.slug, client: agent.client, grant: agent.grant, tool: 'log_session', what: name, ids: [rec.id], ...(got.titles?.length ? { titles: got.titles } : {}) });
  return { record: rec.id, titles: got.titles || [], updated: got.updated || [] };
}

// ── A file ───────────────────────────────────────────────────────────────────
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml']);
const MAX_BYTES = 1024 * 1024;
const rel = (abs) => { const r = relative(resolve(PROJECT_DIR), abs); return !r || r === '.' ? '' : r.split(sep).join('/'); };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Write a text file: into the person's own folder by default, or a shared
 * folder that already exists. Never memory, the platform's dot-folders,
 * skills, anyone else's tree, a hidden or locked path. Overwriting needs
 * `overwrite` and the hash of what is there (so an agent never clobbers a
 * colleague's edit unseen); the previous version is kept under `.versions/`.
 */
export function writeFile(v, agent, { path, content, overwrite = false, expectedSha256 = null }) {
  const p = String(path || '').replace(/^\/+/, '');
  if (!p) return { error: 'path required, e.g. "users/<you>/notes/pricing.md" or "Sales/pricing.md"' };
  const refused = credentialIn(content);
  if (refused) return { error: refused };
  const ownRoot = `users/${v.slug}`;
  const target = p.includes('/') ? p : `${ownRoot}/${p}`;
  const abs = resolveSafePath(target);
  if (!abs) return { error: 'that is not a path in this workspace' };
  const r = rel(abs);
  const parts = r.split('/');
  if (!TEXT_EXT.has(extname(r).toLowerCase())) return { error: `only text files: ${[...TEXT_EXT].join(', ')}` };
  if (parts.some(x => x.startsWith('.'))) return { error: 'not a path an agent may write: hidden and platform folders are off limits' };
  if (parts[0] === 'memory') return { error: 'memory is written with remember or log_session, never as a file' };
  if (parts[0] === 'users' && parts[1] !== v.slug) return { error: 'not a path you can write' };
  if (parts[0] !== 'users' && !existsSync(join(PROJECT_DIR, parts[0]))) return { error: `"${parts[0]}" is not a shared folder; write into an existing one or into your own folder (${ownRoot}/)` };
  if (parts[0] !== 'users' && parts.length < 2) return { error: 'a shared file goes into a folder, e.g. "Sales/pricing.md"' };
  if (pathContainsHardHidden(abs)) return { error: 'not a path you can write' };
  if (locks.covering(r)) return { error: 'that file or folder is locked by an admin: read-only' };
  const size = Buffer.byteLength(String(content || ''), 'utf8');
  if (size > MAX_BYTES) return { error: `too large (${size} bytes, max ${MAX_BYTES})` };
  let previous = null;
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) return { error: 'that is a folder' };
    const cur = readFileSync(abs, 'utf8');
    if (!overwrite) return { error: `"${r}" exists. To replace it pass overwrite: true and expectedSha256: "${sha256(cur)}" (the hash of what is there now).` };
    if (expectedSha256 !== sha256(cur)) return { error: `"${r}" changed since it was read; read it again and pass the new hash ${sha256(cur)}` };
    // The previous version, kept beside the tree it lives in.
    const keepRoot = parts[0] === 'users' ? `${ownRoot}/.versions` : '.versions';
    const keep = join(PROJECT_DIR, keepRoot, `${parts[0] === 'users' ? parts.slice(2).join('/') : r}@${new Date().toISOString().replace(/[:.]/g, '-')}`);
    try { mkdirSync(dirname(keep), { recursive: true }); copyFileSync(abs, keep); previous = rel(keep); } catch (e) { return { error: `could not keep the previous version: ${e.message}` }; }
  } else {
    try { mkdirSync(dirname(abs), { recursive: true }); } catch (e) { return { error: e.message }; }
  }
  const w = writeTextFile(abs, String(content || ''));
  if (w.kind === 'error') return { error: w.error };
  ledger.logEvent({ op: 'agent_write', scope: v.own, by: v.slug, client: agent.client, grant: agent.grant, tool: 'write_file', what: r, ...(previous ? { previous } : {}) });
  return { path: r, size: w.size, sha256: sha256(String(content || '')), ...(previous ? { previous } : {}) };
}
