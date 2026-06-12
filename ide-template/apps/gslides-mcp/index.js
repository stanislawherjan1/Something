/**
 * Google Slides MCP Server
 *
 * Reuses Google Docs OAuth (catalog `credentialsFrom: "gdocs"`). Refresh
 * token must include `https://www.googleapis.com/auth/presentations` and
 * `https://www.googleapis.com/auth/drive` scopes (drive is needed for
 * list_presentations via Drive search).
 *
 * Env vars (set by workspace-api at spawn time):
 *   GDOCS_CLIENT_ID
 *   GDOCS_CLIENT_SECRET
 *   GDOCS_REFRESH_TOKEN
 *   GWORKSPACE_ALLOW_WRITE  — gates create_presentation / add_slide /
 *                              delete_slide / replace_text.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_presentations   — Drive search by name + mimeType
 *   get_presentation     — full presentation tree (title, slides, page elements)
 *   read_slide           — single page by objectId
 *   create_presentation  — new deck with default tab
 *   add_slide            — batchUpdate { createSlide }
 *   delete_slide         — batchUpdate { deleteObject } on a slide objectId
 *   replace_text         — batchUpdate { replaceAllText } across whole deck
 * ─────────────────────────────────────────────
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleApiClient } from '../_shared/google-oauth.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GDOCS_CLIENT_ID;
const CLIENT_SECRET = process.env.GDOCS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GDOCS_REFRESH_TOKEN;
const WRITES_OK     = String(process.env.GWORKSPACE_ALLOW_WRITE || '').toLowerCase() === 'yes';

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3';
const SLIDES_BASE = 'https://slides.googleapis.com/v1';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';

const PREDEFINED_LAYOUTS = [
  'BLANK', 'CAPTION_ONLY', 'TITLE', 'TITLE_AND_BODY',
  'TITLE_AND_TWO_COLUMNS', 'TITLE_ONLY', 'SECTION_HEADER',
  'SECTION_TITLE_AND_DESCRIPTION', 'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER',
];

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gslides-mcp] Missing OAuth config. Activate Google Workspace first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Slides write access is disabled in this workspace. ' +
      'Open Integrations → Google Workspace → Settings (gear) and set ' +
      '"Allow bot to modify your Google Workspace data" to Yes.',
    );
  }
}

// Walk a Slides Page → flat plain text. Mirrors what a viewer sees.
function pageText(page) {
  if (!page) return '';
  const lines = [];
  for (const el of page.pageElements || []) {
    if (el.shape?.text?.textElements) {
      for (const te of el.shape.text.textElements) {
        if (te.textRun?.content) lines.push(te.textRun.content);
      }
      lines.push('\n');
    } else if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells || []) {
          for (const te of cell.text?.textElements || []) {
            if (te.textRun?.content) lines.push(te.textRun.content);
          }
          lines.push('\t');
        }
        lines.push('\n');
      }
    }
  }
  return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function compactPage(page) {
  if (!page) return null;
  return {
    object_id:  page.objectId,
    page_type:  page.pageType,
    text:       pageText(page),
    element_count: (page.pageElements || []).length,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_presentations',
    description: 'Search the user\'s Google Slides decks by name (case-insensitive substring). Returns id, name, modifiedTime, url. Omit `query` for most-recent listing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'get_presentation',
    description: 'Fetch a full presentation by id. Returns title + slides[] (each with object_id, plain text, element count). Use read_slide for the raw page tree.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id'],
      properties: {
        presentation_id: { type: 'string' },
      },
    },
  },
  {
    name: 'read_slide',
    description: 'Fetch one slide by its objectId. Returns the raw Page resource with full pageElements tree.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'page_object_id'],
      properties: {
        presentation_id: { type: 'string' },
        page_object_id:  { type: 'string', description: 'Slide objectId from get_presentation.' },
      },
    },
  },
  {
    name: 'create_presentation',
    description: 'Create a new Slides deck with a default empty slide. Returns id + url. Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    },
  },
  {
    name: 'add_slide',
    description:
      'Add a new slide. Optionally specify a predefined layout and an insertion index (0-based; omit to append). ' +
      'Returns the new slide\'s objectId. Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['presentation_id'],
      properties: {
        presentation_id: { type: 'string' },
        layout: {
          type: 'string',
          enum: PREDEFINED_LAYOUTS,
          default: 'BLANK',
          description: 'Slide layout. BLANK is empty; TITLE_AND_BODY adds a title and body placeholder; etc.',
        },
        insertion_index: {
          type: 'number',
          description: '0-based position. Omit to append at the end.',
        },
      },
    },
  },
  {
    name: 'delete_slide',
    description: 'Delete a slide by its objectId. Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'page_object_id'],
      properties: {
        presentation_id: { type: 'string' },
        page_object_id:  { type: 'string' },
      },
    },
  },
  {
    name: 'replace_text',
    description:
      'Find every occurrence of a string across the deck and replace it. Returns the number of replacements. ' +
      'Idempotent — returns 0 if not found. Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'find', 'replace'],
      properties: {
        presentation_id: { type: 'string' },
        find:            { type: 'string' },
        replace:         { type: 'string' },
        match_case:      { type: 'boolean', default: true },
        page_object_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to specific slides. Omit to apply to all.',
        },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleListPresentations({ query, limit = 20 } = {}) {
  let q = `mimeType='${SLIDES_MIME}' and trashed=false`;
  if (query && String(query).trim()) {
    const safe = String(query).replace(/'/g, "\\'");
    q += ` and name contains '${safe}'`;
  }
  const data = await api.get(`${DRIVE_BASE}/files`, {
    query: {
      q,
      pageSize: Math.min(Number(limit) || 20, 1000),
      fields:   'files(id,name,modifiedTime,webViewLink)',
      orderBy:  'modifiedTime desc',
    },
  });
  return (data.files || []).map(f => ({
    id:          f.id,
    name:        f.name,
    modified_at: f.modifiedTime,
    url:         f.webViewLink,
  }));
}

async function handleGetPresentation({ presentation_id }) {
  const p = await api.get(`${SLIDES_BASE}/presentations/${encodeURIComponent(presentation_id)}`);
  return {
    id:        p.presentationId,
    title:     p.title,
    locale:    p.locale,
    url:       `https://docs.google.com/presentation/d/${p.presentationId}/edit`,
    page_size: p.pageSize,
    slides:    (p.slides || []).map(compactPage),
  };
}

async function handleReadSlide({ presentation_id, page_object_id }) {
  const page = await api.get(
    `${SLIDES_BASE}/presentations/${encodeURIComponent(presentation_id)}/pages/${encodeURIComponent(page_object_id)}`,
  );
  return page;
}

async function handleCreatePresentation({ title }) {
  requireWrite();
  const created = await api.post(`${SLIDES_BASE}/presentations`, { title });
  return {
    id:    created.presentationId,
    title: created.title,
    url:   `https://docs.google.com/presentation/d/${created.presentationId}/edit`,
  };
}

async function batchUpdate(presentationId, requests) {
  return api.post(
    `${SLIDES_BASE}/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
    { requests },
  );
}

async function handleAddSlide({ presentation_id, layout = 'BLANK', insertion_index }) {
  requireWrite();
  const req = {
    createSlide: {
      slideLayoutReference: { predefinedLayout: layout },
    },
  };
  if (typeof insertion_index === 'number') {
    req.createSlide.insertionIndex = insertion_index;
  }
  const data = await batchUpdate(presentation_id, [req]);
  // The reply to createSlide carries the assigned objectId.
  const objectId = data.replies?.[0]?.createSlide?.objectId;
  return { presentation_id, slide_object_id: objectId };
}

async function handleDeleteSlide({ presentation_id, page_object_id }) {
  requireWrite();
  await batchUpdate(presentation_id, [
    { deleteObject: { objectId: page_object_id } },
  ]);
  return { presentation_id, deleted: page_object_id };
}

async function handleReplaceText({ presentation_id, find, replace, match_case = true, page_object_ids }) {
  requireWrite();
  const req = {
    replaceAllText: {
      containsText: { text: find, matchCase: !!match_case },
      replaceText:  replace,
    },
  };
  if (Array.isArray(page_object_ids) && page_object_ids.length > 0) {
    req.replaceAllText.pageObjectIds = page_object_ids;
  }
  const data = await batchUpdate(presentation_id, [req]);
  return {
    presentation_id,
    occurrences: data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0,
  };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gslides-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_presentations':  result = await handleListPresentations(args || {}); break;
      case 'get_presentation':    result = await handleGetPresentation(args);         break;
      case 'read_slide':          result = await handleReadSlide(args);               break;
      case 'create_presentation': result = await handleCreatePresentation(args);      break;
      case 'add_slide':           result = await handleAddSlide(args);                break;
      case 'delete_slide':        result = await handleDeleteSlide(args);             break;
      case 'replace_text':        result = await handleReplaceText(args);             break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[gslides-mcp] Ready\n');
