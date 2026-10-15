// The reminders file has several writers (the monitor, the reminder MCP, the
// cancel route, the planner schedule). Two of them must behave: the cancel
// route reads inside the shared lock, so the array it writes back is the one
// nobody else changed meanwhile; and the MCP refuses to write over a file it
// could not read, instead of replacing every reminder with the one being added.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'reminders-file-'));
process.env.PROJECT_DIR = ROOT;
const FILE = join(ROOT, '.reminders.json');
const read = () => JSON.parse(readFileSync(FILE, 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL', name, extra ?? ''); } };

// ── cancel route: read-modify-write under one hold ───────────────────────────
const { default: remindersRouter } = await import('../routes/reminders.js');
const app = express(); app.use('/api', remindersRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const cancel = async (id) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/reminders/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  return { status: r.status, body: await r.json() };
};

writeFileSync(FILE, JSON.stringify([
  { id: 'r_a', kind: 'user', title: 'Alpha', status: 'pending', due: '2030-01-01T00:00:00Z' },
  { id: 'r_b', kind: 'user', title: 'Beta', status: 'pending', due: '2030-01-01T00:00:00Z' },
  { id: 'r_sys', kind: 'system', title: 'Ritual', status: 'pending', due: '2030-01-01T00:00:00Z' },
]));
let r = await cancel('r_b');
ok('cancel removes the reminder', r.status === 200 && r.body.ok && !read().some(x => x.id === 'r_b'), r);
r = await cancel('r_sys');
ok('a system ritual is refused and untouched', r.status === 403 && read().some(x => x.id === 'r_sys'), r);
r = await cancel('r_nope');
ok('an unknown id is a 404', r.status === 404, r);
ok('no lock is left behind', !existsSync(FILE + '.lock'));

// Another writer holds the lock, settles something and lets go. The cancel
// must see the settled state (it read after acquiring the lock) and keep it,
// rather than write back the array it would have read before waiting.
writeFileSync(FILE + '.lock', '');
const holder = spawn(process.execPath, ['-e', `
  const fs = require('fs'); const [file] = process.argv.slice(1);
  setTimeout(() => {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    list.find(x => x.id === 'r_a').status = 'sent';
    list.push({ id: 'r_new', kind: 'user', title: 'Added while locked', status: 'pending', due: '2030-01-01T00:00:00Z' });
    fs.writeFileSync(file, JSON.stringify(list));
    fs.unlinkSync(file + '.lock');
  }, 400);`, FILE]);
const t0 = Date.now();
r = await cancel('r_sys');   // refused, but only after reading inside the lock
ok('the route waits for the lock holder', Date.now() - t0 >= 350, Date.now() - t0);
r = await cancel('r_new');
ok('what the holder wrote is seen and kept', r.status === 200 && read().find(x => x.id === 'r_a')?.status === 'sent', read());
holder.kill();
server.close();

// ── reminder MCP: no write over a file it could not read ─────────────────────
// Runs only where the tool's own dependencies are installed (CI installs the
// workspace-api's alone).
const MCP = join(dirname(fileURLToPath(import.meta.url)), '../../apps/reminder-mcp/index.js');
const mcpReady = existsSync(join(dirname(MCP), 'node_modules', '@modelcontextprotocol'));
if (!mcpReady) console.log('reminders-file: reminder-mcp deps not installed, tool checks skipped');
if (mcpReady) {
  const startMcp = (file) => {
    const child = spawn(process.execPath, [MCP], { env: { ...process.env, REMINDERS_FILE: file, HOME: ROOT }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = ''; const waiters = new Map(); let nid = 0;
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {} }
    });
    const rpc = (method, params) => new Promise((res) => { const id = ++nid; waiters.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
    const init = async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    };
    return { child, call, init };
  };

  const broken = '[{"id": "r_x", "status": "pending"';
  const mcpFile = join(ROOT, 'mcp', '.reminders.json');
  mkdirSync(dirname(mcpFile), { recursive: true });
  writeFileSync(mcpFile, broken);
  const mcp = startMcp(mcpFile);
  await mcp.init();

  let out = await mcp.call('set_reminder', { title: 'New one', due: '2030-01-01T10:00:00Z' });
  ok('tool: set_reminder on an unreadable file is an error', out.isError && /unavailable|not a readable/.test(out.content[0].text), out);
  ok('tool: ...and the file is left exactly as it was', readFileSync(mcpFile, 'utf8') === broken);
  ok('tool: ...with a copy kept for repair', existsSync(mcpFile + '.corrupt') && readFileSync(mcpFile + '.corrupt', 'utf8') === broken);
  ok('tool: ...and no lock left behind', !existsSync(mcpFile + '.lock'));
  out = await mcp.call('list_reminders', {});
  ok('tool: list_reminders says the file is unreadable rather than "no reminders"', out.isError, out);
  out = await mcp.call('cancel_reminder', { id: 'r_x' });
  ok('tool: cancel_reminder is an error too, nothing written', out.isError && readFileSync(mcpFile, 'utf8') === broken, out);

  unlinkSync(mcpFile);
  out = await mcp.call('set_reminder', { title: 'First', due: '2030-01-01T10:00:00Z' });
  const list = JSON.parse(readFileSync(mcpFile, 'utf8'));
  ok('tool: a missing file is still the empty list — the first reminder creates it', !out.isError && list.length === 1 && list[0].title === 'First', out);
  out = await mcp.call('set_reminder', { title: 'Second', due: '2030-01-01T11:00:00Z' });
  ok('tool: a readable file is appended to', !out.isError && JSON.parse(readFileSync(mcpFile, 'utf8')).length === 2, out);
  mcp.child.kill();
}

console.log(`reminders-file: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
