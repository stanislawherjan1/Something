// Deleting a task: the API (DELETE /api/tasks/:id) and the bot's delete_task
// tool both remove it for good and close up the column it left.
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

// ── bot tool (stdio MCP) ─────────────────────────────────────────────────────
// Runs only where the tool's own dependencies are installed (CI installs the
// workspace-api's alone); the API above is what the bot calls in practice.
const MCP = join(dirname(fileURLToPath(import.meta.url)), '../../apps/tasks-mcp/index.js');
const mcpReady = existsSync(join(dirname(MCP), 'node_modules', '@modelcontextprotocol'));
if (!mcpReady) console.log('tasks-delete: tasks-mcp deps not installed, tool checks skipped');
if (mcpReady) {
seed();
const child = spawn(process.execPath, [MCP], { env: { ...process.env, TASKS_FILE: FILE }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {} }
});
let nid = 0;
const rpc = (method, params) => new Promise((res) => { const id = ++nid; waiters.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
ok('tool: delete_task is offered', tools.includes('delete_task'), tools);
let out = await rpc('tools/call', { name: 'delete_task', arguments: { id: 't_b' } });
ok('tool: deletes and says what it deleted', !out.result.isError && /Deleted "Test"/.test(out.result.content[0].text) && !read().some(t => t.id === 't_b'), out.result);
ok('tool: the column closes up', JSON.stringify(read().filter(t => t.status === 'backlog').map(t => t.order)) === '[0,1]');
out = await rpc('tools/call', { name: 'delete_task', arguments: { id: 't_nope' } });
ok('tool: unknown id is an error, nothing changes', out.result.isError && read().length === 3);
child.kill();
}

console.log(`tasks-delete: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
