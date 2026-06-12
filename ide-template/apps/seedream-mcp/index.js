/**
 * BytePlus ModelArk — Seedream Image Generation MCP Server
 *
 * Docs: docs.byteplus.com/en/docs/ModelArk/1824121
 * API:  POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations
 *       (single endpoint for text-to-image AND image-to-image)
 *
 * Env vars:
 *   BYTEPLUS_API_KEY       — required. API key from console.byteplus.com → ModelArk → API Keys
 *   BYTEPLUS_MODEL_ID      — text-to-image model (default: seedream-4-5-251128)
 *   BYTEPLUS_EDIT_MODEL_ID — image editing model, PNG output (default: seedream-5-0-260128)
 *   SEEDREAM_OUTPUT_DIR    — where to save images (default: /home/coder/project/generated)
 *   BYTEPLUS_REGION        — ap-southeast-1 (default) or eu-west-1
 *
 * Model IDs:
 *   seedream-4-5-251128     (seedream 4.5 — JPEG output, 2K/4K)
 *   seedream-5-0-260128     (seedream 5.0 lite — PNG/JPEG output, 2K/3K)
 *   seedream-4-0-250828     (seedream 4.0 — JPEG output, 1K/2K/4K)
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   generate_image      — text → image (optional reference images)
 *   edit_image          — image + prompt → edited image
 *   remove_background   — image → transparent PNG (uses seedream-5-0-260128)
 * ─────────────────────────────────────────────
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }  from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdirSync, readFileSync }        from 'fs';
import { join, resolve }                                  from 'path';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY    = process.env.BYTEPLUS_API_KEY;
const MODEL_T2I  = process.env.BYTEPLUS_MODEL_ID      ?? 'seedream-4-5-251128';
const MODEL_EDIT = process.env.BYTEPLUS_EDIT_MODEL_ID ?? 'seedream-5-0-260128';
const OUTPUT_DIR = resolve(process.env.SEEDREAM_OUTPUT_DIR ?? './generated');
const REGION     = process.env.BYTEPLUS_REGION ?? 'ap-southeast-1';
const BASE_URL   = REGION === 'eu-west-1'
  ? 'https://ark.eu-west.bytepluses.com/api/v3'
  : 'https://ark.ap-southeast.bytepluses.com/api/v3';

if (!API_KEY) {
  console.error('[seedream-mcp] Missing BYTEPLUS_API_KEY');
  process.exit(1);
}

mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Helpers ───────────────────────────────────────────────────────────────

// Convert local file path → base64 data string accepted by the API.
// HTTPS URLs are passed through as-is.
async function toImageInput(source) {
  if (source.startsWith('https://') || source.startsWith('http://')) {
    return source;
  }
  const buf  = readFileSync(resolve(source));
  const ext  = source.split('.').pop()?.toLowerCase() ?? 'jpeg';
  const mime = ext === 'png'  ? 'image/png'
             : ext === 'webp' ? 'image/webp'
             : ext === 'gif'  ? 'image/gif'
             : ext === 'bmp'  ? 'image/bmp'
             :                  'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Save image data (b64_json string or URL) to OUTPUT_DIR, return file path.
async function saveImage(data, prefix = 'img', ext = 'jpeg') {
  const ts   = Date.now();
  const name = `${prefix}_${ts}.${ext}`;
  const path = join(OUTPUT_DIR, name);

  if (data.startsWith('http://') || data.startsWith('https://')) {
    // response_format=url — download then save
    const res = await fetch(data);
    if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, buf);
  } else {
    // response_format=b64_json — strip optional header
    const raw = data.replace(/^data:image\/\w+;base64,/, '');
    writeFileSync(path, Buffer.from(raw, 'base64'));
  }

  return path;
}

// Post to the images/generations endpoint.
async function generateImages(body) {
  const res = await fetch(`${BASE_URL}/images/generations`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`BytePlus API ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [

  {
    name: 'generate_image',
    description: `Generate one or more images from a text prompt using Seedream 4.5. Optionally pass reference images (up to 14) for style/subject consistency. Returns saved file path(s).`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image. Be detailed — subject, action, environment, style, lighting, composition. Max ~600 words.',
        },
        size: {
          type: 'string',
          description: 'Output size. Named presets: "2K" (default, 2048x2048), "4K" (4096x4096), "1K". Aspect ratio shortcuts: "16:9", "9:16", "4:3", "3:4", "1:1", "2:3", "3:2", "21:9". Or explicit pixels: "2848x1600".',
        },
        reference_images: {
          type: 'array',
          description: 'Optional reference images (URLs or local file paths) to guide generation. Up to 14. In the prompt, refer to them as "image 1", "image 2", etc.',
          items: { type: 'string' },
        },
        n: {
          type: 'number',
          description: 'Number of images to generate (default: 1). For batch output, the model generates related images sequentially.',
        },
        watermark: {
          type: 'boolean',
          description: 'Add "AI generated" watermark to output (default: false).',
        },
      },
      required: ['prompt'],
    },
  },

  {
    name: 'edit_image',
    description: 'Edit an existing image using a text instruction — change style, colors, background, elements, texture, etc. Accepts local file path or HTTPS URL. Returns saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Source image — local file path or HTTPS URL.',
        },
        prompt: {
          type: 'string',
          description: 'Editing instruction, e.g. "change the sky to a dramatic sunset", "make it look like a watercolor painting", "replace the background with a forest".',
        },
        size: {
          type: 'string',
          description: 'Output size. Same options as generate_image. Defaults to "2K".',
        },
        watermark: {
          type: 'boolean',
          description: 'Add watermark (default: false).',
        },
      },
      required: ['image', 'prompt'],
    },
  },

  {
    name: 'remove_background',
    description: 'Remove the background from an image. Output is a PNG file (transparent background). Uses Seedream 5.0 which supports PNG output. Accepts local file path or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Source image — local file path or HTTPS URL.',
        },
        size: {
          type: 'string',
          description: 'Output size (default: "2K").',
        },
      },
      required: ['image'],
    },
  },

];

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name, args) {

  // ── generate_image ─────────────────────────────────────────────────────
  if (name === 'generate_image') {
    const { prompt, size = '2K', reference_images, n = 1, watermark = false } = args;

    const body = {
      model:           MODEL_T2I,
      prompt,
      size,
      watermark,
      response_format: 'b64_json',
    };

    // Single reference image → string; multiple → array
    if (reference_images?.length === 1) {
      body.image = await toImageInput(reference_images[0]);
    } else if (reference_images?.length > 1) {
      body.image = await Promise.all(reference_images.slice(0, 14).map(toImageInput));
      body.sequential_image_generation = 'disabled';
    }

    // Batch output
    if (n > 1) {
      body.sequential_image_generation = 'auto';
      body.sequential_image_generation_options = { max_images: Math.min(n, 10) };
    }

    const result = await generateImages(body);
    const images = result.data ?? [];
    if (images.length === 0) return 'No images returned by the API.';

    const paths = await Promise.all(
      images.map((img, i) => saveImage(img.b64_json ?? img.url, `gen_${i}`, 'jpeg'))
    );

    return paths.length === 1
      ? `Image saved: ${paths[0]}`
      : `${paths.length} images saved:\n${paths.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`;
  }

  // ── edit_image ─────────────────────────────────────────────────────────
  if (name === 'edit_image') {
    const { image, prompt, size = '2K', watermark = false } = args;

    const body = {
      model:           MODEL_T2I,
      prompt,
      image:           await toImageInput(image),
      size,
      watermark,
      response_format: 'b64_json',
    };

    const result = await generateImages(body);
    const images = result.data ?? [];
    if (images.length === 0) return 'No images returned by the API.';

    const path = await saveImage(images[0].b64_json ?? images[0].url, 'edit', 'jpeg');
    return `Edited image saved: ${path}`;
  }

  // ── remove_background ──────────────────────────────────────────────────
  if (name === 'remove_background') {
    const { image, size = '2K' } = args;

    // Uses seedream-5-0-260128 — the only model that supports PNG output (transparency).
    const body = {
      model:           MODEL_EDIT,
      prompt:          'Remove the background completely. Make the background fully transparent. Keep the subject perfectly intact with clean, precise edges.',
      image:           await toImageInput(image),
      size,
      output_format:   'png',
      watermark:       false,
      response_format: 'b64_json',
    };

    const result = await generateImages(body);
    const images = result.data ?? [];
    if (images.length === 0) return 'No images returned by the API.';

    const path = await saveImage(images[0].b64_json ?? images[0].url, 'nobg', 'png');
    return `Background removed. Saved: ${path}`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'seedream-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await handleTool(name, args ?? {});
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[seedream-mcp] Ready — t2i: ${MODEL_T2I} | edit: ${MODEL_EDIT} | out: ${OUTPUT_DIR}`);
