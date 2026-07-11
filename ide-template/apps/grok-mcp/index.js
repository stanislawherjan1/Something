/**
 * Grok MCP — ask xAI's Grok with live X (Twitter) and web search.
 *
 * Endpoint: POST https://api.x.ai/v1/responses
 * Auth:     Bearer XAI_API_KEY
 * Docs:     docs.x.ai/developers/tools/x-search
 *           docs.x.ai/developers/tools/web-search
 *
 * Env vars:
 *   XAI_API_KEY   — required
 *   XAI_MODEL     — default model (default: grok-4.3)
 *
 * Tools:
 *   ask_grok  — Q&A with optional live X search and/or web search
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();

const API_KEY  = process.env.XAI_API_KEY;
const MODEL    = process.env.XAI_MODEL || 'grok-3';
const BASE_URL = 'https://api.x.ai/v1';

if (!API_KEY) {
  process.stderr.write('[grok-mcp] Missing XAI_API_KEY\n');
  process.exit(1);
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ask_grok',
    description:
      "Ask xAI's Grok a question with optional real-time X (Twitter) and web search. " +
      "Use x_search: true to see what people are posting on X about a topic or account. " +
      "Use web_search: true for current news and web results. " +
      "Both can be combined. Returns the answer with source citations when search is on.",
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'The question or prompt to send to Grok.',
        },
        system: {
          type: 'string',
          description: 'Optional system instruction (tone, persona, format).',
        },
        model: {
          type: 'string',
          description: 'Model override. Default: grok-4.3',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature 0–2. Default: 0.7.',
          minimum: 0,
          maximum: 2,
        },
        max_tokens: {
          type: 'integer',
          description: 'Max response length. Default: 1024.',
          minimum: 1,
          maximum: 32768,
        },
        x_search: {
          type: 'boolean',
          description: 'Search live X (Twitter) posts. Great for "what are people saying about X", checking a specific account, or live reactions.',
        },
        web_search: {
          type: 'boolean',
          description: 'Search the web for current information.',
        },
        x_handles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit X search to specific handles (max 10), e.g. ["elonmusk", "xai"]. Only used when x_search is true.',
        },
        from_date: {
          type: 'string',
          description: 'Filter X results from this date (ISO8601, e.g. "2025-01-01"). Only used when x_search is true.',
        },
        to_date: {
          type: 'string',
          description: 'Filter X results up to this date (ISO8601). Only used when x_search is true.',
        },
      },
    },
  },
];

// ─── API call ──────────────────────────────────────────────────────────────

async function askGrok(args) {
  const {
    prompt, system, model, temperature, max_tokens,
    x_search, web_search, x_handles, from_date, to_date,
  } = args;

  // Build input array
  const input = [];
  if (system) input.push({ role: 'system', content: system });
  input.push({ role: 'user', content: prompt });

  // Build tools array
  const tools = [];
  if (x_search) {
    const xTool = { type: 'x_search' };
    if (Array.isArray(x_handles) && x_handles.length) xTool.allowed_x_handles = x_handles.slice(0, 10);
    if (from_date) xTool.from_date = from_date;
    if (to_date)   xTool.to_date   = to_date;
    tools.push(xTool);
  }
  if (web_search) {
    tools.push({ type: 'web_search' });
  }

  const body = {
    model:             model || MODEL,
    input,
    temperature:       typeof temperature === 'number' ? temperature : 0.7,
    max_output_tokens: typeof max_tokens  === 'number' ? max_tokens  : 1024,
  };
  if (tools.length) body.tools = tools;

  const resp = await fetch(`${BASE_URL}/responses`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = await resp.json();
      detail = errBody.error?.message || errBody.message || JSON.stringify(errBody);
    } catch { try { detail = await resp.text(); } catch {} }
    throw new Error(`xAI ${resp.status}: ${detail}`);
  }

  const data = await resp.json();
  return formatResponse(data);
}

// ─── Response parsing ──────────────────────────────────────────────────────

function formatResponse(data) {
  // Extract text from output array
  const items = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of items) {
    if (item?.type !== 'message') continue;
    for (const c of (item.content || [])) {
      if (c?.type === 'output_text' && c.text) parts.push(c.text);
    }
  }

  if (!parts.length) {
    throw new Error('Unexpected response from xAI: no output_text found.');
  }

  const text = parts.join('\n\n');

  // Collect citations from top-level citations array
  const citations = (data?.citations || [])
    .filter(Boolean)
    .map(c => (typeof c === 'string' ? c : (c.url || '')))
    .filter(Boolean);

  if (!citations.length) return text;
  return `${text}\n\nSources:\n${citations.map(u => `- ${u}`).join('\n')}`;
}

// ─── MCP wiring ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'grok', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== 'ask_grok') {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  if (!args?.prompt?.trim()) {
    return { isError: true, content: [{ type: 'text', text: '`prompt` is required.' }] };
  }
  try {
    const answer = await askGrok(args);
    return { content: [{ type: 'text', text: answer }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `grok error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[grok-mcp] ready\n');
