#!/usr/bin/env node
/**
 * One-time migration: Tasks.md (the old Markdown board) → .tasks.json (the
 * structured store the workspace board + tasks MCP now read/write).
 *
 * Idempotent and safe to run on every boot:
 *   - no Tasks.md            → nothing to do, exit.
 *   - .tasks.json already has tasks → already migrated, exit.
 * On success it writes .tasks.json and renames Tasks.md → .Tasks.md.migrated
 * (a hidden backup, out of the file tree) so the board doesn't show a stale
 * Markdown file next to the live board.
 *
 * Parses the same format the old UI rendered:
 *   ## Column            → status (In Progress / Backlog / Done, fuzzy-matched)
 *   ### Title            → a task
 *   **Owner:** … · **Priority:** … · **Deadline:** … · **Completed:** …
 *   anything else        → the task's description
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';
const TASKS_MD   = join(PROJECT_DIR, 'Tasks.md');
const TASKS_JSON = join(PROJECT_DIR, '.tasks.json');

const hasTasks = (p) => {
  try { const a = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(a) && a.length > 0; }
  catch { return false; }
};

if (!existsSync(TASKS_MD)) process.exit(0);                       // nothing to migrate
if (existsSync(TASKS_JSON) && hasTasks(TASKS_JSON)) process.exit(0);  // already migrated

const PRIORITIES = new Set(['high', 'medium', 'low']);

function statusOf(name) {
  const n = name.toLowerCase();
  if (/progress|doing|active|wip/.test(n)) return 'in_progress';
  if (/done|complete|shipped|archived?/.test(n)) return 'done';
  return 'backlog';
}

// Parse "**Owner:** X · **Priority:** High · **Deadline:** 2026-05-02".
function parseMeta(line) {
  if (!/\*\*[A-Za-z]+:\*\*/.test(line)) return null;
  const out = {};
  let any = false;
  const re = /\*\*([A-Za-z]+):\*\*\s*([^*·]+?)(?=\s*(?:·|\*\*|$))/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (['owner', 'priority', 'deadline', 'completed'].includes(key) && val) { out[key] = val; any = true; }
  }
  return any ? out : null;
}

const md = readFileSync(TASKS_MD, 'utf8');
const tasks = [];
const orderByStatus = {};
let status = null, card = null, desc = [];

const flush = () => {
  if (card) { card.description = desc.join('\n').replace(/^\s+|\s+$/g, ''); desc = []; }
};

for (const raw of md.split('\n')) {
  const line = raw.replace(/\s+$/, '');

  const col = /^##\s+(.+)/.exec(line);
  if (col) { flush(); card = null; status = statusOf(col[1].trim()); continue; }
  if (!status) continue;

  const c = /^###\s+(.+)/.exec(line);
  if (c) {
    flush();
    const order = (orderByStatus[status] = (orderByStatus[status] ?? 0));
    orderByStatus[status] = order + 1;
    card = {
      id: 't_' + randomUUID().slice(0, 8),
      title: c[1].trim(),
      description: '',
      status,
      owner: null,
      priority: null,
      deadline: null,
      completed: null,
      order,
      createdAt: new Date().toISOString(),
      createdBy: null,
    };
    tasks.push(card);
    continue;
  }
  if (!card) continue;

  const meta = parseMeta(line);
  if (meta) {
    if (meta.owner) card.owner = meta.owner.trim();
    if (meta.priority && PRIORITIES.has(meta.priority.toLowerCase())) card.priority = meta.priority.toLowerCase();
    if (meta.deadline && !/^tbd$/i.test(meta.deadline.trim())) card.deadline = meta.deadline.trim();
    if (meta.completed) card.completed = meta.completed.trim();
    continue;
  }

  if (line === '' && desc.length === 0) continue;   // skip leading blank lines
  desc.push(line);
}
flush();

const today = new Date().toISOString().slice(0, 10);
for (const t of tasks) if (t.status === 'done' && !t.completed) t.completed = today;

const tmp = TASKS_JSON + '.tmp';
writeFileSync(tmp, JSON.stringify(tasks, null, 2));
renameSync(tmp, TASKS_JSON);                          // atomic swap

try { renameSync(TASKS_MD, join(PROJECT_DIR, '.Tasks.md.migrated')); } catch { /* best-effort backup */ }

process.stderr.write(`[migrate-tasks] migrated ${tasks.length} task(s): Tasks.md → .tasks.json\n`);
