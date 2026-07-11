#!/usr/bin/env node
/**
 * OpenAI MCP — query GPT models for second opinions, cross-checks, and
 * specialised tasks. Pairs naturally with the chat agent — the operator's
 * primary Claude wires `ask_gpt` when they want another model's take.
 *
 * Endpoints used:
 *   POST https://api.openai.com/v1/chat/completions
 *   GET  https://api.openai.com/v1/models
 *
 * Auth: Bearer OPENAI_API_KEY (Phase-2 broker delivers it on launch via
 *       mcp-runner uid 1002 — see _shared/broker-client.js).
 *
 * Env vars:
 *   OPENAI_API_KEY  — required
 *   OPENAI_MODEL    — default model when caller doesn't specify (default: gpt-5)
 *
 * Tools:
 *   ask_gpt          — single-turn completion with optional system prompt
 *   list_gpt_models  — fetch the current model catalogue from /v1/models
 *
 * NOT in this MVP: tool calling, streaming, multimodal (images/audio),
 * conversation history (single-turn only). Add if a real use case appears.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Fetch encrypted creds from the Phase-2 broker if we were launched via
// mcp-runner. No-op when run standalone — process.env reads keep working.
await loadCredentials();

const API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const BASE_URL = 'https://api.openai.com/v1';

if (!API_KEY) {
  process.stderr.write('[openai-mcp] Missing OPENAI_API_KEY\n');
  process.exit(1);
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ask_gpt',
    description:
      "Ask an OpenAI GPT model a single question. Use when you want a second " +
      "opinion from a different model family, want to cross-check a critical " +
      "answer, or need a specialised model (e.g. o-series reasoning for " +
      "math/logic, gpt-5 for general tasks). Returns the model's reply as " +
      "plain text. Single-turn only: for multi-turn, the operator's primary " +
      "agent (you) keeps the conversation; this tool is for one-shot queries.",
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'The question or instruction for the model.',
        },
        system: {
          type: 'string',
          description: 'Optional system prompt (tone, persona, output format).',
        },
        model: {
          type: 'string',
          description:
            'Model id. Common picks: "gpt-5" (default, general), "gpt-4.1" ' +
            '(faster, cheaper), "o3-mini" (reasoning). Call list_gpt_models ' +
            'for the live catalogue.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature 0–2. Default: 0.7. Reasoning models (o-*) ignore this.',
          minimum: 0,
          maximum: 2,
        },
        max_tokens: {
          type: 'integer',
          description: 'Max response length in tokens. Default: 2048.',
          minimum: 1,
          maximum: 16384,
        },
      },
    },
  },
  {
    name: 'list_gpt_models',
    description:
      "List OpenAI models available to this API key. Filtered to chat-capable " +
      "models (gpt-* and o-*). Useful before picking a non-default model for " +
      "ask_gpt: surfaces newly released models without needing this MCP to be " +
      "rebuilt.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── API calls ─────────────────────────────────────────────────────────────

async function chatCompletion({ prompt, system, model, temperature, max_tokens }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model: model || DEFAULT_MODEL,
    messages,
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof max_tokens  === 'number') body.max_tokens  = max_tokens;
  else body.max_tokens = 2048;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenAI API error: ${msg}`);
  }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error(`OpenAI returned no text content: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const usage = json?.usage
    ? ` [tokens: ${json.usage.prompt_tokens || '?'} in / ${json.usage.completion_tokens || '?'} out]`
    : '';
  return text + (usage ? `\n\n_${usage.trim()}_` : '');
}

async function listModels() {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenAI API error: ${msg}`);
  }
  // Filter to chat-capable model families. /v1/models also lists embeddings,
  // moderation, tts, image — none of which ask_gpt can use.
  const chatPrefixes = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-'];
  const ids = (json?.data || [])
    .map(m => m.id)
    .filter(id => chatPrefixes.some(p => id.startsWith(p)))
    .sort();
  if (ids.length === 0) return 'No chat-capable models returned. Check API key permissions.';
  return ids.join('\n');
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'openai-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'ask_gpt') {
      const text = await chatCompletion(args);
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'list_gpt_models') {
      const list = await listModels();
      return { content: [{ type: 'text', text: list }] };
    }
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err.message || String(err) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
