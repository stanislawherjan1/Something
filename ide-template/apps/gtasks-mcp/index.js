/**
 * Google Tasks MCP Server
 *
 * Reuses Google Docs OAuth (catalog `credentialsFrom: "gdocs"`). Refresh
 * token must include `https://www.googleapis.com/auth/tasks` scope.
 *
 * Env vars (set by workspace-api at spawn time):
 *   GDOCS_CLIENT_ID
 *   GDOCS_CLIENT_SECRET
 *   GDOCS_REFRESH_TOKEN
 *   GWORKSPACE_ALLOW_WRITE  — gates create_task / update_task / delete_task.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_task_lists  — every list owned by the user
 *   list_tasks       — items in one list (default `@default`)
 *   create_task      — insert a new task (date-only `due`)
 *   update_task      — patch fields, supports completing/uncompleting
 *   delete_task      — permanent delete (Tasks API has no trash)
 * ─────────────────────────────────────────────
 *
 * Quirk worth knowing: Tasks API stores `due` as date-only. Even if you send
 * a full RFC 3339 timestamp with hours/minutes/timezone, Google silently
 * truncates it to the date in UTC and reads it back as `T00:00:00.000Z`.
 * No way to express "due at 3pm" — there is no due-time concept.
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleApiClient } from '../_shared/google-oauth.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GDOCS_CLIENT_ID;
const CLIENT_SECRET = process.env.GDOCS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GDOCS_REFRESH_TOKEN;
const WRITES_OK     = String(process.env.GWORKSPACE_ALLOW_WRITE || '').toLowerCase() === 'yes';

const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gtasks-mcp] Missing OAuth config. Activate Google Workspace first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Tasks write access is disabled in this workspace. ' +
      'Open Integrations → Google Workspace → Settings (gear) and set ' +
      '"Allow bot to modify your Google Workspace data" to Yes.',
    );
  }
}

function compactTask(t) {
  if (!t) return null;
  return {
    id:         t.id,
    title:      t.title,
    notes:      t.notes,
    status:     t.status,        // "needsAction" | "completed"
    due:        t.due,            // RFC 3339 date in UTC, time always 00:00
    completed:  t.completed,
    parent:     t.parent,         // subtask of this id, if set
    position:   t.position,
    updated:    t.updated,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_task_lists',
    description: 'List all of the user\'s task lists. Returns id (use as tasklist_id), title, updated time. The default list alias is "@default".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tasks',
    description: 'List items in a task list. Returns title, notes, status, due (date only), completed time, parent (if subtask).',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist_id:    { type: 'string', default: '@default', description: 'From list_task_lists, or "@default" for the user\'s default list.' },
        show_completed: { type: 'boolean', default: true,  description: 'Include completed tasks.' },
        show_hidden:    { type: 'boolean', default: false, description: 'Include hidden (archived) tasks.' },
        max_results:    { type: 'number',  default: 100, description: 'Max items (max 100).' },
      },
    },
  },
  {
    name: 'create_task',
    description:
      'Create a new task. `due` is date-only (YYYY-MM-DD); time is silently dropped by Google. ' +
      '`parent` makes the new task a subtask of an existing task. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        tasklist_id: { type: 'string', default: '@default' },
        title:       { type: 'string' },
        notes:       { type: 'string' },
        due:         { type: 'string', description: 'YYYY-MM-DD (or full RFC 3339 — time will be ignored).' },
        parent:      { type: 'string', description: 'Existing task id; new task becomes its subtask.' },
        previous:    { type: 'string', description: 'Existing task id; new task is inserted right after it (sibling order).' },
      },
    },
  },
  {
    name: 'update_task',
    description:
      'Patch fields on an existing task. Pass `status: "completed"` to mark done, `status: "needsAction"` to uncomplete. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        tasklist_id: { type: 'string', default: '@default' },
        task_id:     { type: 'string' },
        title:       { type: 'string' },
        notes:       { type: 'string' },
        due:         { type: 'string' },
        status: {
          type: 'string',
          enum: ['needsAction', 'completed'],
          description: 'Setting "completed" auto-stamps the completed time. Setting "needsAction" clears the completed flag.',
        },
      },
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task. Tasks API has no trash — this is irreversible. Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        tasklist_id: { type: 'string', default: '@default' },
        task_id:     { type: 'string' },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleListTaskLists() {
  const data = await api.get(`${TASKS_BASE}/users/@me/lists`);
  return (data.items || []).map(l => ({
    id:      l.id,
    title:   l.title,
    updated: l.updated,
  }));
}

async function handleListTasks({
  tasklist_id = '@default',
  show_completed = true,
  show_hidden = false,
  max_results = 100,
} = {}) {
  const data = await api.get(`${TASKS_BASE}/lists/${encodeURIComponent(tasklist_id)}/tasks`, {
    query: {
      showCompleted: show_completed ? 'true' : 'false',
      showHidden:    show_hidden ? 'true' : 'false',
      maxResults:    Math.min(Number(max_results) || 100, 100),
    },
  });
  return (data.items || []).map(compactTask);
}

function normaliseDue(due) {
  if (!due) return undefined;
  // Accept either YYYY-MM-DD or full RFC 3339; the API keeps only the date,
  // but it requires a full timestamp. Parse and re-emit at midnight UTC.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(due)
    ? new Date(`${due}T00:00:00.000Z`)
    : new Date(due);
  if (isNaN(d.getTime())) throw new Error(`Invalid due date "${due}". Use YYYY-MM-DD.`);
  return d.toISOString();
}

async function handleCreateTask({ tasklist_id = '@default', parent, previous, due, ...rest }) {
  requireWrite();
  const body = { ...rest };
  if (due !== undefined) body.due = normaliseDue(due);
  const query = {};
  if (parent)   query.parent   = parent;
  if (previous) query.previous = previous;
  const created = await api.post(
    `${TASKS_BASE}/lists/${encodeURIComponent(tasklist_id)}/tasks`,
    body,
    { query },
  );
  return compactTask(created);
}

async function handleUpdateTask({ tasklist_id = '@default', task_id, status, due, ...rest }) {
  requireWrite();
  const body = { ...rest };
  if (status) {
    body.status = status;
    // Uncompleting needs `completed` explicitly nulled — otherwise the
    // server keeps the old completed timestamp around, leaving the task
    // in a contradictory state.
    if (status === 'needsAction') body.completed = null;
  }
  if (due !== undefined) body.due = normaliseDue(due);
  const updated = await api.patch(
    `${TASKS_BASE}/lists/${encodeURIComponent(tasklist_id)}/tasks/${encodeURIComponent(task_id)}`,
    body,
  );
  return compactTask(updated);
}

async function handleDeleteTask({ tasklist_id = '@default', task_id }) {
  requireWrite();
  await api.delete(`${TASKS_BASE}/lists/${encodeURIComponent(tasklist_id)}/tasks/${encodeURIComponent(task_id)}`);
  return { id: task_id, deleted: true };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gtasks-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_task_lists': result = await handleListTaskLists();          break;
      case 'list_tasks':      result = await handleListTasks(args || {});    break;
      case 'create_task':     result = await handleCreateTask(args);         break;
      case 'update_task':     result = await handleUpdateTask(args);         break;
      case 'delete_task':     result = await handleDeleteTask(args);         break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[gtasks-mcp] Ready\n');
