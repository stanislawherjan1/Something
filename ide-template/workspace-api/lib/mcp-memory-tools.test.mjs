/**
 * The bot's memory tools, end to end through the real MCP server: every field
 * a tool's schema declares must reach workspace-api. memory_note once required
 * `said` in its schema while the handler sent only `text` — every note the bot
 * wrote was refused, and no test crossed that line.
 *
 * Starts apps/workspace-api-mcp over stdio against a fake workspace-api that
 * records what it receives.
 * Run: node lib/mcp-memory-tools.test.mjs   (wired into `npm test`)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
// The MCP app's only dependency is the MCP SDK, which workspace-api has too:
// run a copy of its index.js next to workspace-api's node_modules, so the test
// needs no install of its own (the image installs the app's deps at build).
const TMP = mkdtempSync(join(tmpdir(), 'mcp-tools-'));
copyFileSync(join(HERE, '..', '..', 'apps', 'workspace-api-mcp', 'index.js'), join(TMP, 'index.js'));
writeFileSync(join(TMP, 'package.json'), JSON.stringify({ type: 'module' }));
symlinkSync(join(HERE, '..', 'node_modules'), join(TMP, 'node_modules'));
const MCP = join(TMP, 'index.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${n}${x !== undefined ? `\n        ${JSON.stringify(x).slice(0, 600)}` : ''}`); } };

// The fake workspace-api: records every request, answers like the real one.
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed = null; try { parsed = JSON.parse(body || 'null'); } catch { /* not JSON */ }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
    res.setHeader('Content-Type', 'application/json');
    if (/\/note$/.test(req.url)) return res.end(JSON.stringify(parsed?.said ? { ok: true, id: 'f1', scope: 'private', replaced: [], saved: 'A title' } : { ok: false, error: 'said required' }));
    if (/\/forget$/.test(req.url)) return res.end(JSON.stringify({ ok: true, hidden: parsed?.ids || [], refused: [] }));
    if (/\/import$/.test(req.url)) return res.end(JSON.stringify(parsed?.item ? { ok: true, records: 2, titles: ['Pilot starts 4 November'], updated: [], superseded: [] } : { ok: false, error: 'item required' }));
    return res.end(JSON.stringify({ ok: true, text: 'fine' }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const proc = spawn(process.execPath, [MCP], { env: { ...process.env, WORKSPACE_API_URL: url, IDE_TURN_ID: 'turn-for-tests', MEMORY_V4: 'on' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiting = new Map();
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { /* a log line */ }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  waiting.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`${method}: no answer`)); } }, 15000);
});

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  const tools = new Map((list.result?.tools || []).map(t => [t.name, t]));
  const note = tools.get('memory_note');
  ok('memory_note is offered', !!note, [...tools.keys()]);

  // Every property the schema declares reaches workspace-api.
  const args = { text: 'Ola meets Marek on 15 October at 13:00.', said: 'lunch with Marek on the 15th at 1pm', share: false, confirmNames: ['Bistro'] };
  for (const k of Object.keys(note?.inputSchema?.properties || {})) ok(`memory_note: the schema's "${k}" is something the test sends`, k in args, k);
  seen.length = 0;
  let r = await rpc('tools/call', { name: 'memory_note', arguments: args });
  const sent = seen.find(s => /\/note$/.test(s.url));
  ok('memory_note reaches workspace-api', !!sent, seen.map(s => s.url));
  for (const k of Object.keys(args)) ok(`memory_note sends "${k}"`, sent && JSON.stringify(sent.body[k]) === JSON.stringify(args[k]), sent?.body);
  ok('memory_note carries the turn token', sent?.headers?.['x-ide-turn'] === 'turn-for-tests', sent?.headers);
  ok('memory_note reports what happened', !r.result?.isError && /Saved/.test(r.result?.content?.[0]?.text || ''), r.result);

  // A refusal comes back to the model as an error it can read.
  r = await rpc('tools/call', { name: 'memory_note', arguments: { text: 'x' } });
  ok('a refused note is an error with the reason', r.result?.isError === true && /said/.test(r.result?.content?.[0]?.text || ''), r.result);

  // memory_import: every field of its schema reaches workspace-api, verbatim.
  const imp = tools.get('memory_import');
  ok('memory_import is offered', !!imp, [...tools.keys()]);
  const impArgs = { integration: 'granola', item: 'g-1', title: 'Kick-off', at: '2026-10-05T09:00:00Z', participants: ['Marta Zielak'], url: 'https://example.test/m/g-1', summary: 'Pilot starts 4 November.', transcript: 'Ola: hello\nMarta Zielak: hi' };
  for (const k of Object.keys(imp?.inputSchema?.properties || {})) ok(`memory_import: the schema's "${k}" is something the test sends`, k in impArgs, k);
  seen.length = 0;
  r = await rpc('tools/call', { name: 'memory_import', arguments: impArgs });
  const si = seen.find(s => /\/import$/.test(s.url));
  ok('memory_import reaches workspace-api', !!si, seen.map(s => s.url));
  for (const k of Object.keys(impArgs)) ok(`memory_import sends "${k}"`, si && JSON.stringify(si.body[k]) === JSON.stringify(impArgs[k]), si?.body);
  ok('memory_import reports what happened', !r.result?.isError && /Imported: 2 records, 1 fact/.test(r.result?.content?.[0]?.text || ''), r.result);

  seen.length = 0;
  r = await rpc('tools/call', { name: 'memory_forget', arguments: { ids: ['a1', 'b2'] } });
  const fg = seen.find(s => /\/forget$/.test(s.url));
  ok('memory_forget sends its ids', JSON.stringify(fg?.body?.ids) === '["a1","b2"]', fg?.body);
} catch (e) {
  ok('the MCP server answered', false, String(e.message));
} finally {
  proc.kill();
  server.close();
}
console.log(`mcp-memory-tools: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
