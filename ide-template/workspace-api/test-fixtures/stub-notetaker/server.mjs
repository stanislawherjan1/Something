#!/usr/bin/env node
/**
 * A stand-in meeting notetaker: a hosted-MCP look-alike over HTTP that answers
 * list_meetings / get_meeting / get_transcript from meetings.json, a different
 * set per bearer token — so an import test can prove that a workspace
 * connection and a member's own each reach their owner's scope only.
 *
 *   node server.mjs                      (PORT, FIXTURE, STUB_LOG from the environment)
 *   import { start } from './server.mjs'  (a test starts it on a free port)
 *
 * Every call is logged as "<token>\t<tool>\t<meeting id>" to STUB_LOG when set.
 * Synthetic data only; never a real service.
 */
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const here = dirname(fileURLToPath(import.meta.url));

const TOOLS = [
  { name: 'list_meetings', description: 'Meetings in a date range', inputSchema: { type: 'object', properties: { start_date: { type: 'string', format: 'date' }, end_date: { type: 'string', format: 'date' }, limit: { type: 'integer', maximum: 100 } } } },
  { name: 'get_meeting', description: 'One meeting with its summary', inputSchema: { type: 'object', properties: { meeting_id: { type: 'string' } }, required: ['meeting_id'] } },
  { name: 'get_transcript', description: 'A meeting transcript', inputSchema: { type: 'object', properties: { meeting_id: { type: 'string' } }, required: ['meeting_id'] } },
];

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });
const startOf = (m, now) => new Date(now - (m.daysAgo || 0) * 86400_000).toISOString();

export function start({ port = 0, fixture = join(here, 'meetings.json'), log = process.env.STUB_LOG || null, now = () => Date.now() } = {}) {
  const data = JSON.parse(readFileSync(fixture, 'utf8'));
  const note = (token, tool, id) => { if (log) appendFileSync(log, `${token}\t${tool}\t${id || ''}\n`); };
  const call = (token, name, a) => {
    const mine = data.tokens[token] || [];
    const t = now();
    if (name === 'list_meetings') {
      note(token, name, '');
      const lo = a.start_date ? Date.parse(a.start_date) : -Infinity, hi = a.end_date ? Date.parse(a.end_date) + 86400_000 : Infinity;
      const list = mine.filter(m => { const at = Date.parse(startOf(m, t)); return at >= lo && at <= hi; }).slice(0, a.limit || 50);
      return text({ meetings: list.map(m => ({ id: m.id, title: m.title, start_time: startOf(m, t), participants: m.participants })) });
    }
    const m = mine.find(x => x.id === a.meeting_id);
    note(token, name, a.meeting_id);
    if (!m) return { isError: true, content: [{ type: 'text', text: `no meeting ${a.meeting_id}` }] };
    if (name === 'get_meeting') return text({ id: m.id, title: m.title, start_time: startOf(m, t), participants: m.participants, summary: m.summary });
    if (name === 'get_transcript') return text(m.transcript);
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  };
  const http = createServer(async (req, res) => {
    if (!String(req.url).startsWith('/mcp')) { res.writeHead(404); res.end(); return; }
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // Stateless: one server and transport per request, as the SDK documents it.
    const server = new Server({ name: 'stub-notetaker', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => call(token, r.params.name, r.params.arguments || {}));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(e.message); } }
  });
  return new Promise((resolve) => http.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${http.address().port}/mcp`;
    resolve({ url, close: () => new Promise(r => http.close(() => r())) });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await start({ port: Number(process.env.PORT) || 7788, fixture: process.env.FIXTURE || undefined });
  process.stdout.write(`stub-notetaker listening at ${url}\n`);
}
