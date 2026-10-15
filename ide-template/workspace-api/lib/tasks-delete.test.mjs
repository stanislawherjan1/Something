// Deleting a task (DELETE /api/tasks/:id, which the bot calls over HTTP too)
// removes it for good and closes up the column it left.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'tasks-delete-'));
process.env.PROJECT_DIR = ROOT;
const FILE = join(ROOT, '.tasks.json');
const seed = () => writeFileSync(FILE, JSON.stringify([
  { id: 't_a', title: 'Alpha', status: 'backlog', order: 0 },
  { id: 't_b', title: 'Test',  status: 'backlog', order: 1 },
  { id: 't_c', title: 'Gamma', status: 'backlog', order: 2 },
  { id: 't_d', title: 'Done thing', status: 'done', order: 0 },
], null, 2));
const read = () => JSON.parse(readFileSync(FILE, 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL', name, extra ?? ''); } };

// ── API ──────────────────────────────────────────────────────────────────────
seed();
const { default: tasksRouter } = await import('../routes/tasks.js');
const app = express(); app.use('/api', tasksRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;

let r = await fetch(url('/tasks/t_b'), { method: 'DELETE' });
let body = await r.json();
ok('API: deletes the task', r.status === 200 && body.ok && !read().some(t => t.id === 't_b'), body);
ok('API: the column closes up (orders 0,1)', JSON.stringify(read().filter(t => t.status === 'backlog').map(t => [t.id, t.order])) === JSON.stringify([['t_a', 0], ['t_c', 1]]), read());
ok('API: other columns untouched', read().some(t => t.id === 't_d' && t.order === 0));
r = await fetch(url('/tasks/t_nope'), { method: 'DELETE' });
ok('API: unknown id → 404, nothing changes', r.status === 404 && read().length === 3);
server.close();

console.log(`tasks-delete: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
