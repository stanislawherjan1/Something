#!/usr/bin/env node
/**
 * Tasks MCP — the structured task board stored in ~/project/.tasks.json.
 * Tools: list_tasks, add_task, update_task, move_task.
 *
 * The board moved off Tasks.md to structured JSON so the UI can mutate it
 * (drag-drop, check→done, assignment) without a lossy Markdown round-trip. This
 * MCP is how YOU (the bot) read and change it — do NOT Read/Write Tasks.md (it
 * no longer exists). The workspace board (/api/tasks) reads/writes the same file.
 *
 * Shape per task:
 *   { id, title, description, status, owner, priority, deadline, completed,
 *     order, createdAt, createdBy }
 *   status ∈ backlog | in_progress | done   priority ∈ high | medium | low | null
 *   owner  = a team roster slug (resolved to a profile in the UI), or null.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const TASKS_FILE =
  process.env.TASKS_FILE ||
  path.join(process.env.HOME || '/home/coder', 'project', '.tasks.json');
const WSAPI_PORT = process.env.WORKSPACE_API_PORT || '3001';

const STATUSES = ['backlog', 'in_progress', 'done'];
const PRIORITIES = ['high', 'medium', 'low'];
const STATUS_LABEL = { backlog: 'Backlog', in_progress: 'In Progress', done: 'Done' };
const SELF_WORDS = new Set(['me', 'myself', 'self', 'siebie', 'mnie', 'sobie']);

async function readTasks() {
  try { return JSON.parse(await fs.readFile(TASKS_FILE, 'utf8')); }
  catch { return []; }
}
async function writeTasks(tasks) {
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  const tmp = TASKS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2));
  await fs.rename(tmp, TASKS_FILE);   // atomic swap — prevents corruption on crash
}
const todayISO = () => new Date().toISOString().slice(0, 10);
const cleanDeadline = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return (!s || s.toUpperCase() === 'TBD') ? null : s;
};
const normPriority = (p) => {
  if (p == null || p === '') return null;
  const s = String(p).trim().toLowerCase();
  return PRIORITIES.includes(s) ? s : null;
};

function actorSlug() { const s = (process.env.IDE_ACTOR_SLUG || '').trim(); return /^[a-z0-9-]+$/.test(s) ? s : ''; }

// Roster for owner name→slug resolution (separate process, no in-proc team.js).
async function fetchRoster() {
  try {
    const r = await fetch(`http://127.0.0.1:${WSAPI_PORT}/api/internal/roster`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.members) ? j.members : null;
  } catch { return null; }
}

// Resolve an owner arg (slug | name | "me" | null) → { owner } slug/string/null,
// or { error } when a named teammate can't be matched. Solo (no roster / no
// actor) keeps a free-text name. "me" → the current actor's slug.
async function resolveOwner(raw) {
  if (raw == null || raw === '') return { owner: null };
  const tok = String(raw).trim();
  const low = tok.toLowerCase();
  const setter = actorSlug();
  if (SELF_WORDS.has(low)) return { owner: setter || tok };
  const roster = await fetchRoster();
  if (!roster || !roster.length) return { owner: tok };   // solo / roster down → keep as given
  if (/^[a-z0-9-]+$/.test(low) && roster.some(m => m.slug === low)) return { owner: low };
  const byName = roster.find(m => {
    const dn = String(m.displayName || '').toLowerCase();
    return dn === low || dn.split(/\s+/)[0] === low;
  });
  if (byName) return { owner: byName.slug };
  return { error: `I don't recognise "${tok}" as a teammate — who do you mean? (use their roster slug, a name, or "me")` };
}

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

function renderBoard(tasks) {
  if (!tasks.length) return 'The board is empty — no tasks yet.';
  const lines = [];
  for (const status of STATUSES) {
    const inCol = tasks.filter(t => t.status === status).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!inCol.length) continue;
    lines.push(`\n## ${STATUS_LABEL[status]} (${inCol.length})`);
    for (const t of inCol) {
      const meta = [t.owner ? `owner: ${t.owner}` : null, t.priority ? `priority: ${t.priority}` : null, t.deadline ? `deadline: ${t.deadline}` : null]
        .filter(Boolean).join(' · ');
      lines.push(`- [${t.id}] ${t.title}${meta ? `  (${meta})` : ''}`);
    }
  }
  return lines.join('\n').trim();
}

const server = new Server(
  { name: 'tasks-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_tasks',
      description:
        'List the whole task board grouped by status (Backlog / In Progress / Done) with each task id. ' +
        'Read this before adding or changing tasks — check for an existing one to update instead of duplicating.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_task',
      description:
        'Add a task to the board. Defaults to the Backlog. Set `owner` to a teammate so it shows under their name. ' +
        'A task is a unit of work to track — NOT a timed alert (use set_reminder for "remind me at <time>").',
      inputSchema: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short imperative heading, e.g. "Send Q3 report to acme".' },
          description: { type: 'string', description: 'Optional context — why it matters, what is needed, blockers, file paths.' },
          status:      { type: 'string', enum: STATUSES, description: 'Column. Default "backlog"; "in_progress" if work has already started.' },
          owner:       { type: 'string', description: 'WHO is responsible. A teammate roster SLUG (resolved by name too), or "me" for the asker. Omit if unassigned. Team mode only — assigning does NOT notify them.' },
          priority:    { type: 'string', enum: PRIORITIES, description: 'high / medium / low. Omit if unknown.' },
          deadline:    { type: 'string', description: 'Due date as YYYY-MM-DD, or omit/"TBD" if none.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_task',
      description:
        'Update fields of an existing task (get its id from list_tasks). Pass only the fields that change. ' +
        'To move it between columns use `status` (or move_task). Setting status to "done" stamps the completion date; moving it back clears it.',
      inputSchema: {
        type: 'object',
        properties: {
          id:          { type: 'string', description: 'Task id, e.g. "t_a1b2c3d4".' },
          title:       { type: 'string' },
          description: { type: 'string' },
          status:      { type: 'string', enum: STATUSES },
          owner:       { type: 'string', description: 'Reassign: a teammate slug/name, "me", or empty string to clear the owner.' },
          priority:    { type: 'string', enum: PRIORITIES },
          deadline:    { type: 'string', description: 'YYYY-MM-DD, or "TBD"/empty to clear.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'move_task',
      description: 'Move a task to a different column (status). Shortcut for update_task with just `status`.',
      inputSchema: {
        type: 'object',
        properties: {
          id:     { type: 'string', description: 'Task id from list_tasks.' },
          status: { type: 'string', enum: STATUSES, description: 'Target column.' },
        },
        required: ['id', 'status'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'list_tasks') {
    return ok(renderBoard(await readTasks()));
  }

  if (name === 'add_task') {
    if (!args.title || !String(args.title).trim()) return fail('A task needs a title.');
    const status = STATUSES.includes(args.status) ? args.status : 'backlog';
    const resolved = await resolveOwner(args.owner);
    if (resolved.error) return fail(resolved.error);
    const tasks = await readTasks();
    const task = {
      id: 't_' + randomUUID().slice(0, 8),
      title: String(args.title).trim().slice(0, 200),
      description: String(args.description || ''),
      status,
      owner: resolved.owner,
      priority: normPriority(args.priority),
      deadline: cleanDeadline(args.deadline),
      completed: status === 'done' ? todayISO() : null,
      order: tasks.filter(t => t.status === status).length,
      createdAt: new Date().toISOString(),
      createdBy: actorSlug() || null,
    };
    tasks.push(task);
    await writeTasks(tasks);
    const who = task.owner ? ` (owner: ${task.owner})` : '';
    return ok(`Added "${task.title}" to ${STATUS_LABEL[status]}${who}. id: ${task.id}`);
  }

  if (name === 'update_task' || name === 'move_task') {
    if (!args.id) return fail('Which task? Pass the id from list_tasks.');
    const tasks = await readTasks();
    const t = tasks.find(x => x.id === args.id);
    if (!t) return fail(`No task with id ${args.id} — run list_tasks to see current ids.`);

    if (typeof args.title === 'string')       t.title = args.title.trim().slice(0, 200);
    if (typeof args.description === 'string')  t.description = args.description;
    if ('owner' in args) {
      const resolved = await resolveOwner(args.owner);
      if (resolved.error) return fail(resolved.error);
      t.owner = resolved.owner;
    }
    if ('priority' in args) t.priority = normPriority(args.priority);
    if ('deadline' in args) t.deadline = cleanDeadline(args.deadline);
    if (STATUSES.includes(args.status)) {
      t.status = args.status;
      // Re-stamp order to the end of the destination column.
      t.order = tasks.filter(x => x.status === args.status && x !== t).length;
      if (args.status === 'done') { if (!t.completed) t.completed = todayISO(); }
      else t.completed = null;
    }

    await writeTasks(tasks);
    return ok(`Updated "${t.title}" → ${STATUS_LABEL[t.status]}${t.owner ? `, owner: ${t.owner}` : ''}. id: ${t.id}`);
  }

  return fail(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
