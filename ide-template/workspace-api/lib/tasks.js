/**
 * Task store — the structured board backing `.tasks.json` at the project root.
 *
 * Tasks used to live in Tasks.md and the UI just rendered the Markdown. Once the
 * board became interactive (drag-drop between columns, check→done, assignment)
 * a lossy Markdown round-trip risked clobbering hand-written content, so the
 * canonical store moved to structured JSON. The AI mutates it through the
 * tasks MCP; the UI through /api/tasks; both read/write this same file.
 *
 * Shape — an array of:
 *   { id, title, description, status, owner, priority, deadline, completed,
 *     order, createdAt, createdBy }
 *   status ∈ backlog | in_progress | done   priority ∈ high | medium | low | null
 *   owner = a team roster slug (or null / a plain name in solo).
 *
 * Atomic writes (tmp + rename) mirror reminder-mcp so a crash mid-write can't
 * corrupt the file. Shared across the team — no per-user scoping (the board is
 * common work); auth on /api/* already gates who can touch it.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const TASKS_FILE = join(process.env.PROJECT_DIR || '/home/coder/project', '.tasks.json');

export const TASK_STATUSES   = ['backlog', 'in_progress', 'done'];
export const TASK_PRIORITIES = ['high', 'medium', 'low'];

export function readTasks() {
  try {
    const parsed = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(t => t && typeof t === 'object') : [];
  } catch {
    return [];
  }
}

export function writeTasks(tasks) {
  mkdirSync(dirname(TASKS_FILE), { recursive: true });
  const tmp = TASKS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  renameSync(tmp, TASKS_FILE);   // atomic swap — prevents corruption on crash
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

// `deadline` is a YYYY-MM-DD string, or null. "TBD"/empty → null; otherwise kept
// verbatim (lenient — the AI may pass a near-date the UI still renders).
export function cleanDeadline(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === 'TBD') return null;
  return s;
}
