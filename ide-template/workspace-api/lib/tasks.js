/**
 * Task store — the board, in two kinds of file.
 *
 * Tasks used to live in Tasks.md and the UI just rendered the Markdown. Once the
 * board became interactive (drag-drop between columns, check→done, assignment)
 * a lossy Markdown round-trip risked clobbering hand-written content, so the
 * canonical store moved to structured JSON. The AI mutates it through the
 * tasks API; the UI through /api/tasks; both read/write the same files.
 *
 * A task has a scope, like a memory fact:
 *   shared        the team board        PROJECT_DIR/.tasks.json
 *   user:<slug>   one person's own list PROJECT_DIR/.team/users/<slug>/tasks.json
 *
 * The board at the root was the only store for a long time and "no per-user
 * scoping" was the rule: a task said to the bot in a private chat landed in
 * front of the whole team. Now a task is private by default when a person
 * makes it in their own chat, shared when it comes from a room, is assigned to
 * someone else or is wanted on the team board (routes/tasks.js decides). A
 * private list is a file in the person's own tree, so the same kernel and
 * API fences that keep their chats and memory private keep it private too —
 * a flag inside the shared file would not, every turn with a shell reads it.
 * The private file is only ever written into a tree priv-tree already owns
 * (lib/private-tree.js). Solo mode has one person and uses the root board only.
 *
 * Shape — an array of:
 *   { id, title, description, status, owner, priority, deadline, completed,
 *     order, createdAt, createdBy, updatedAt, scope }
 *   status ∈ backlog | in_progress | done   priority ∈ high | medium | low | null
 *   owner = a team roster slug (or null / a plain name in solo); a private
 *   task's owner is its scope's person.
 *
 * Atomic writes (tmp + rename) mirror reminder-mcp so a crash mid-write can't
 * corrupt a file. `order` is per column per file; the UI shows the two lists
 * as separate sections, so the sequences never need to interleave.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';
import { assertPrivateTree } from './private-tree.js';

export const TASKS_FILE = join(process.env.PROJECT_DIR || '/home/coder/project', '.tasks.json');

export const TASK_STATUSES   = ['backlog', 'in_progress', 'done'];
export const TASK_PRIORITIES = ['high', 'medium', 'low'];

const USER_SCOPE_RE = /^user:([a-z0-9-]+)$/;
export const isUserScope = (scope) => USER_SCOPE_RE.test(String(scope || ''));
export const slugOfScope = (scope) => USER_SCOPE_RE.exec(String(scope || ''))?.[1] || null;

/** The file a scope's tasks live in. Throws on a scope that has no board. */
export function tasksFile(scope = 'shared') {
  if (!scope || scope === 'shared') return TASKS_FILE;
  const slug = slugOfScope(scope);
  if (!slug) throw new Error(`no task list for scope ${JSON.stringify(scope)}`);
  return join(process.env.PROJECT_DIR || '/home/coder/project', '.team', 'users', slug, 'tasks.json');
}

function parseList(path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) {
    // Absent is an empty list. Broken is too, but said: a person's own file is
    // theirs to break from a shell, and the board must still answer.
    if (err?.code !== 'ENOENT') process.stderr.write(`[tasks] ${path}: unreadable, reading as empty: ${err.message}\n`);
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(t => t && typeof t === 'object') : [];
}

/** One scope's tasks, each stamped with its scope (the path is the truth, not the field). */
export function readScope(scope = 'shared') {
  const s = scope || 'shared';
  return parseList(tasksFile(s)).map(t => ({ ...t, scope: s }));
}

/**
 * Write one scope's tasks. A private list goes only into a tree that is the
 * person's already (PrivateTreeNotReady otherwise — never a directory of our
 * own making, see private-tree.js), with mode 0660 so the setgid directory's
 * group, their priv-* group, is who may read it besides us.
 */
export function writeScope(scope, tasks) {
  const s = scope || 'shared';
  const path = tasksFile(s);
  const slug = slugOfScope(s);
  if (slug) assertPrivateTree(slug);
  const body = JSON.stringify(tasks.map(t => ({ ...t, scope: s })), null, 2);
  // In the container "ready" means the directory exists and is the person's,
  // so ensureDir makes nothing there; it only makes the tree outside the
  // container (dev, tests), where no tree is ever owned.
  atomicWrite(path, body, slug ? { mode: 0o660, ensureDir: true } : { ensureDir: true });
}

/**
 * The tasks a viewer sees: the scopes they may read, merged. A task that a
 * crashed move left in two files (append to the target, then remove from the
 * source) shows once, the newest copy — the next write of either file settles
 * it.
 */
export function readFor(scopes = ['shared']) {
  const byId = new Map();
  for (const s of scopes || []) {
    if (s !== 'shared' && !isUserScope(s)) continue;
    for (const t of readScope(s)) {
      const have = byId.get(t.id);
      if (!have || String(t.updatedAt || t.createdAt || '') > String(have.updatedAt || have.createdAt || '')) byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}

const renumber = (list) => {
  for (const status of TASK_STATUSES) list.filter(t => t.status === status).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach((t, n) => { t.order = n; });
};

/**
 * Collaboration switched on: the solo board was one person's, so it becomes
 * the owner's own list (the way the owner's memory moves), and the team starts
 * with an empty board. Writes the own list first — refused (PrivateTreeNotReady)
 * when the owner's tree is not theirs yet, and then nothing moved: the board
 * stays shared, which is the old rule, not a leak. Returns how many moved.
 */
export function soloBoardToOwner(slug) {
  if (!isUserScope(`user:${slug || ''}`)) return { moved: 0 };
  const board = readScope('shared');
  if (!board.length) return { moved: 0 };
  const own = `user:${slug}`;
  const list = readScope(own);
  const have = new Set(list.map(t => t.id));
  const now = new Date().toISOString();
  const moving = board.filter(t => !have.has(t.id)).map(t => ({ ...t, owner: slug, updatedAt: now }));
  const merged = [...list, ...moving];
  renumber(merged);
  writeScope(own, merged);
  writeScope('shared', []);
  return { moved: moving.length };
}

/** Collaboration switched off: the owner is alone again, and their own list rejoins the board. */
export function ownerListToSolo(slug) {
  if (!isUserScope(`user:${slug || ''}`)) return { moved: 0 };
  const own = `user:${slug}`;
  const list = readScope(own);
  if (!list.length) return { moved: 0 };
  const board = readScope('shared');
  const have = new Set(board.map(t => t.id));
  const now = new Date().toISOString();
  const moving = list.filter(t => !have.has(t.id)).map(t => ({ ...t, updatedAt: now }));
  const merged = [...board, ...moving];
  renumber(merged);
  writeScope('shared', merged);
  writeScope(own, []);
  return { moved: moving.length };
}

/** True when a private list exists for this person (a file, maybe empty). */
export function hasPrivateList(slug) {
  try { return existsSync(tasksFile(`user:${slug}`)); } catch { return false; }
}

// The shared board alone — what the watcher carve-out, the cleanup scripts and
// the one-time Tasks.md migration mean by "the board".
export function readTasks() { return readScope('shared'); }
export function writeTasks(tasks) { writeScope('shared', tasks); }

export const todayISO = () => new Date().toISOString().slice(0, 10);

// `deadline` is a YYYY-MM-DD string, or null. "TBD"/empty → null; otherwise kept
// verbatim (lenient — the AI may pass a near-date the UI still renders).
export function cleanDeadline(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === 'TBD') return null;
  return s;
}
