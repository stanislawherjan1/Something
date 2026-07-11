#!/usr/bin/env node
/**
 * Gemini MCP — query Google's Gemini chat models for second opinions,
 * cross-checks, and specialised tasks. Mirror of openai-mcp but for the
 * Google Gen AI side. Pairs with the chat agent — operator's primary
 * Claude calls `ask_gemini` when it wants Google's take.
 *
 * Endpoints used:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}
 *   GET  https://generativelanguage.googleapis.com/v1beta/models?key={key}
 *
 * Auth: GEMINI_API_KEY in query string. Phase-2 broker delivers it on
 *       launch via mcp-runner uid 1002 — see _shared/broker-client.js.
 *
 * NOTE: shares its API key naming with the existing `gemini-image`
 * integration (which spawns nano-banana-mcp for Imagen / image edits).
 * A single GEMINI_API_KEY from Google AI Studio works for both — users
 * who activate both integrations can paste the same key.
 *
 * Env vars:
 *   GEMINI_API_KEY  — required
 *   GEMINI_MODEL    — default model when caller doesn't specify (default: gemini-2.5-pro)
 *
 * Tools:
 *   ask_gemini           — single-turn completion with optional system prompt
 *   list_gemini_models   — fetch the current model catalogue
 *
 * NOT in this MVP: tool calling (Gemini function calling), streaming,
 * multimodal (Vision input — Gemini natively supports it), conversation
 * history. Add if a real use case appears.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

await loadCredentials();

const API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

if (!API_KEY) {
  process.stderr.write('[gemini-mcp] Missing GEMINI_API_KEY\n');
  process.exit(1);
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ask_gemini',
    description:
      "Ask a Google Gemini chat model a single question. Use when you want a " +
      "second opinion from outside the GPT/Claude families, want to leverage " +
      "Gemini's strong long-context handling, or specifically need Google's " +
      "search-grounded reasoning. Returns the model's reply as plain text. " +
      "Single-turn only: for multi-turn, the operator's primary agent (you) " +
      "keeps the conversation; this tool is for one-shot queries.",
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
          description: 'Optional system instruction (tone, persona, output format).',
        },
        model: {
          type: 'string',
          description:
            'Model id. Common picks: "gemini-2.5-pro" (default, top quality), ' +
            '"gemini-2.5-flash" (faster, cheaper, great default for cheap calls), ' +
            '"gemini-2.5-flash-lite" (cheapest). Call list_gemini_models for the ' +
            'live catalogue.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature 0–2. Default: 0.7.',
          minimum: 0,
          maximum: 2,
        },
        max_tokens: {
          type: 'integer',
          description: 'Max response length in tokens. Default: 2048. Gemini calls this maxOutputTokens internally.',
          minimum: 1,
          maximum: 32768,
        },
      },
    },
  },
  {
    name: 'list_gemini_models',
    description:
      "List Google Gemini models available to this API key. Filtered to " +
      "models that support generateContent (i.e. text/chat). Useful before " +
      "picking a non-default model for ask_gemini: surfaces newly released " +
      "models without rebuilding this MCP.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── API calls ─────────────────────────────────────────────────────────────

async function generateContent({ prompt, system, model, temperature, max_tokens }) {
  const useModel = model || DEFAULT_MODEL;
  // Gemini's REST API expects contents[] of {role, parts:[{text}]} pairs.
  // Single-turn maps to one user content; system instruction goes in its
  // own field (v1beta supports systemInstruction).
  const body = {
    contents: [
      { role: 'user', parts: [{ text: prompt }] },
    ],
    generationConfig: {
      maxOutputTokens: typeof max_tokens === 'number' ? max_tokens : 2048,
    },
  };
  if (typeof temperature === 'number') body.generationConfig.temperature = temperature;
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const url = `${BASE_URL}/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }
  // Response shape: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { ... } }
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    // Common cause: safety filter block. Surface the reason rather than fail silently.
    const blockReason = json?.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`Gemini blocked the prompt: ${blockReason}`);
    throw new Error(`Gemini returned no content: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned empty text');
  const usage = json?.usageMetadata
    ? ` [tokens: ${json.usageMetadata.promptTokenCount || '?'} in / ${json.usageMetadata.candidatesTokenCount || '?'} out]`
    : '';
  return text + (usage ? `\n\n_${usage.trim()}_` : '');
}

async function listModels() {
  const url = `${BASE_URL}/models?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }
  // Filter to models that actually support generateContent (i.e. chat/text).
  // Skip embedding / aqa / image-only models.
  const models = (json?.models || [])
    .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map(m => (m.name || '').replace(/^models\//, ''))
    .filter(id => id && !id.startsWith('embedding-'))
    .sort();
  if (models.length === 0) return 'No chat-capable models returned. Check API key permissions.';
  return models.join('\n');
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gemini-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'ask_gemini') {
      const text = await generateContent(args);
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'list_gemini_models') {
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
