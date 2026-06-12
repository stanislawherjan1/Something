/**
 * Nano Banana — Google Gemini Image Generation MCP Server
 *
 * Two models:
 *   Imagen 3  — best quality text-to-image (no image input)
 *   Gemini 2.0 Flash — conversational image generation + editing (accepts image input)
 *
 * Env vars:
 *   GEMINI_API_KEY           — required. From console.cloud.google.com → API Keys (or aistudio.google.com)
 *   GEMINI_T2I_MODEL         — Imagen model (default: imagen-3.0-generate-002)
 *   GEMINI_EDIT_MODEL        — Gemini edit model (default: gemini-2.0-flash-preview-image-generation)
 *   NANO_BANANA_OUTPUT_DIR   — where to save images (default: /home/coder/project/generated)
 *
 * Tools:
 *   generate_image   — text → image via Imagen 3 (highest quality, no image input)
 *   edit_image       — image + instruction → edited image via Gemini 2.0 Flash
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }  from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI }           from '@google/genai';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve }         from 'path';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY     = process.env.GEMINI_API_KEY;
const MODEL_T2I   = process.env.GEMINI_T2I_MODEL   || 'imagen-3.0-generate-002';
const MODEL_EDIT  = process.env.GEMINI_EDIT_MODEL  || 'gemini-2.0-flash-preview-image-generation';
const OUTPUT_DIR  = resolve(process.env.NANO_BANANA_OUTPUT_DIR ?? '/home/coder/project/generated');

if (!API_KEY) {
  console.error('[nano-banana-mcp] Missing GEMINI_API_KEY');
  process.exit(1);
}

mkdirSync(OUTPUT_DIR, { recursive: true });

const ai = new GoogleGenAI({ apiKey: API_KEY });

// ─── Helpers ───────────────────────────────────────────────────────────────

function saveBase64(b64, prefix, ext) {
  const path = join(OUTPUT_DIR, `${prefix}_${Date.now()}.${ext}`);
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

// Read a local file as base64 + mimeType for Gemini inline data
function readLocalImage(filePath) {
  const buf  = readFileSync(resolve(filePath));
  const ext  = filePath.split('.').pop()?.toLowerCase() ?? 'jpeg';
  const mime = ext === 'png'  ? 'image/png'
             : ext === 'webp' ? 'image/webp'
             : ext === 'gif'  ? 'image/gif'
             :                  'image/jpeg';
  return { mimeType: mime, data: buf.toString('base64') };
}

// Fetch a remote image as base64 + mimeType
async function fetchRemoteImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${url}`);
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString('base64') };
}

async function toInlineData(source) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return fetchRemoteImage(source);
  }
  return readLocalImage(source);
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [

  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt using Google Imagen 3 — highest quality text-to-image model. Does not accept image input. Returns saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed text description of the image. Include subject, style, lighting, mood, composition. Be specific for best results.',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          description: 'Output aspect ratio (default: 1:1).',
        },
        n: {
          type: 'number',
          description: 'Number of images to generate (1–4, default: 1).',
        },
        negative_prompt: {
          type: 'string',
          description: 'Things to exclude from the image, e.g. "blurry, low quality, text, watermark".',
        },
        person_generation: {
          type: 'string',
          enum: ['dont_allow', 'allow_adult'],
          description: 'Whether to allow generating people (default: allow_adult).',
        },
      },
      required: ['prompt'],
    },
  },

  {
    name: 'edit_image',
    description: 'Edit an existing image using a text instruction via Gemini 2.0 Flash. Supports style transfer, object replacement, background changes, color edits, etc. Accepts local file path or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Source image — local file path or HTTPS URL.',
        },
        prompt: {
          type: 'string',
          description: 'Editing instruction, e.g. "change the background to a beach at sunset", "make it look like an oil painting", "add snow to the scene".',
        },
      },
      required: ['image', 'prompt'],
    },
  },

];

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name, args) {

  // ── generate_image ────────────────────────────────────────────────────────
  if (name === 'generate_image') {
    const {
      prompt,
      aspect_ratio = '1:1',
      n = 1,
      negative_prompt,
      person_generation = 'allow_adult',
    } = args;

    const config = {
      numberOfImages:   Math.min(Math.max(n, 1), 4),
      aspectRatio:      aspect_ratio,
      outputMimeType:   'image/jpeg',
      personGeneration: person_generation,
    };
    if (negative_prompt) config.negativePrompt = negative_prompt;

    const response = await ai.models.generateImages({
      model:  MODEL_T2I,
      prompt,
      config,
    });

    const images = response.generatedImages ?? [];
    if (images.length === 0) return 'No images returned by Imagen 3.';

    const paths = images.map((img, i) => {
      const bytes = img.image?.imageBytes;
      if (!bytes) throw new Error(`Image ${i} has no imageBytes`);
      // imageBytes can be Buffer or base64 string depending on SDK version
      const b64 = Buffer.isBuffer(bytes)
        ? bytes.toString('base64')
        : typeof bytes === 'string' ? bytes
        : Buffer.from(bytes).toString('base64');
      return saveBase64(b64, `imagen_${i}`, 'jpeg');
    });

    return paths.length === 1
      ? `Image saved: ${paths[0]}`
      : `${paths.length} images saved:\n${paths.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`;
  }

  // ── edit_image ────────────────────────────────────────────────────────────
  if (name === 'edit_image') {
    const { image, prompt } = args;

    const inlineData = await toInlineData(image);

    const response = await ai.models.generateContent({
      model:    MODEL_EDIT,
      contents: [{
        role:  'user',
        parts: [
          { text: prompt },
          { inlineData },
        ],
      }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const imgPart = parts.find(p => p.inlineData);

    if (!imgPart) {
      // Model returned only text — probably refused or explained
      const text = parts.find(p => p.text)?.text ?? 'No image returned.';
      return `No image generated. Model response: ${text}`;
    }

    const ext  = imgPart.inlineData.mimeType === 'image/png' ? 'png' : 'jpeg';
    const path = saveBase64(imgPart.inlineData.data, 'gemini_edit', ext);
    return `Edited image saved: ${path}`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'nano-banana-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await handleTool(name, args ?? {});
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[nano-banana-mcp] Ready — t2i: ${MODEL_T2I} | edit: ${MODEL_EDIT} | out: ${OUTPUT_DIR}`);
