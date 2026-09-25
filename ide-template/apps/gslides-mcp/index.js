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
 *   list_text_boxes      — every writable shape on a slide, with its text
 *   set_text             — replace ONE shape's text (the empty-placeholder case)
 *   insert_text          — insert at an index without clearing what's there
 *   create_textbox       — a new box when the layout offers no placeholder
 *
 * The four above exist because the deck-building path was broken without them:
 * a slide added from a layout arrives with EMPTY placeholders, and replaceAllText
 * can only swap text that is already present. So a new deck could be created and
 * structured and then never filled — which reads as "the Slides API can't insert
 * text", and it can: batchUpdate.insertText writes into any shape, placeholder or
 * not. It was this server that couldn't.
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
      'Idempotent: returns 0 if not found. Requires write permission (workspace-level toggle).',
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
  {
    name: 'list_text_boxes',
    description:
      'Every shape on a slide that can hold text, with its objectId, placeholder role and current text. ' +
      'Call this BEFORE set_text: a slide built from a layout has empty placeholders whose ids are the ' +
      'only way to address them, and an empty placeholder is invisible to replace_text. Omit slide_object_id for the whole deck.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id'],
      properties: {
        presentation_id:  { type: 'string' },
        slide_object_id:  { type: 'string', description: 'Limit to one slide. Omit for all.' },
      },
    },
  },
  {
    name: 'set_text',
    description:
      'Replace ALL text in one shape, addressed by objectId from list_text_boxes. Works on an empty ' +
      'placeholder, which is what makes filling a freshly added slide possible. Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'object_id', 'text'],
      properties: {
        presentation_id: { type: 'string' },
        object_id:       { type: 'string', description: 'From list_text_boxes.' },
        text:            { type: 'string', description: 'Newlines start new paragraphs.' },
      },
    },
  },
  {
    name: 'insert_text',
    description:
      'Insert text into a shape without clearing what is already there. Use set_text to replace, this to append ' +
      'or splice. Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'object_id', 'text'],
      properties: {
        presentation_id: { type: 'string' },
        object_id:       { type: 'string' },
        text:            { type: 'string' },
        insertion_index: { type: 'number', description: 'Character offset. Omit to append at the end.' },
      },
    },
  },
  {
    name: 'create_textbox',
    description:
      'Add a new text box to a slide and put text in it — for a layout that offers no placeholder, or for ' +
      'anything beyond title and body. Position and size are in points, from the top-left of the slide. ' +
      'Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'slide_object_id', 'text'],
      properties: {
        presentation_id: { type: 'string' },
        slide_object_id: { type: 'string' },
        text:            { type: 'string' },
        x:      { type: 'number', default: 50,  description: 'points from the left' },
        y:      { type: 'number', default: 50,  description: 'points from the top' },
        width:  { type: 'number', default: 620, description: 'points (a 16:9 slide is 720 wide)' },
        height: { type: 'number', default: 120, description: 'points' },
      },
    },
  },
  {
    name: 'style_text',
    description:
      'Colour, bold, italic, underline, size or font for a range of text in a shape. Omit start/end to style ' +
      'the whole shape. Colour is a hex string like "#1A1A1A". Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'object_id'],
      properties: {
        presentation_id: { type: 'string' },
        object_id:       { type: 'string', description: 'From list_text_boxes.' },
        start:           { type: 'number', description: 'Character offset. Omit for the whole shape.' },
        end:             { type: 'number' },
        color:           { type: 'string', description: 'Text colour, e.g. "#1A1A1A".' },
        font_size:       { type: 'number', description: 'Points.' },
        font_family:     { type: 'string', description: 'e.g. "Inter", "Georgia".' },
        bold:            { type: 'boolean' },
        italic:          { type: 'boolean' },
        underline:       { type: 'boolean' },
        alignment:       { type: 'string', enum: ['START', 'CENTER', 'END', 'JUSTIFIED'] },
      },
    },
  },
  {
    name: 'create_image',
    description:
      'Put an image on a slide from a public URL. Google fetches the URL itself, so it must be reachable ' +
      'without auth and under 50MB. Position and size in points. Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'slide_object_id', 'image_url'],
      properties: {
        presentation_id: { type: 'string' },
        slide_object_id: { type: 'string' },
        image_url:       { type: 'string' },
        x:      { type: 'number', default: 50 },
        y:      { type: 'number', default: 50 },
        width:  { type: 'number', default: 300 },
        height: { type: 'number', default: 200 },
      },
    },
  },
  {
    name: 'set_slide_background',
    description: 'Solid background colour for one slide, as a hex string. Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'slide_object_id', 'color'],
      properties: {
        presentation_id: { type: 'string' },
        slide_object_id: { type: 'string' },
        color:           { type: 'string', description: 'e.g. "#FBFAF9".' },
      },
    },
  },
  {
    name: 'batch_update',
    description:
      'Send raw Slides API requests. This is the whole API — tables, lines, grouping, z-order, bullets, ' +
      'transforms, duplication, slide reordering, chart embeds — anything the wrapper tools above do not cover. ' +
      'Each item is one Request object exactly as the REST reference defines it, e.g. ' +
      '{"createTable":{"objectId":"t1","elementProperties":{"pageObjectId":"p1"},"rows":3,"columns":2}}. ' +
      'Requests apply in order and the whole batch fails as one. Prefer a wrapper tool when one fits — it is ' +
      'harder to get wrong. Requires write permission.',
    inputSchema: {
      type: 'object',
      required: ['presentation_id', 'requests'],
      properties: {
        presentation_id: { type: 'string' },
        requests: {
          type: 'array',
          description: 'Slides API Request objects, applied in order.',
          items: { type: 'object' },
        },
      },
    },
  },
];// ─── Handlers ──────────────────────────────────────────────────────────────

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

// ─── Helpers for the editing tools ──────────────────────────────────────────

/** Slides accepts PT directly in size/transform, so no EMU arithmetic here. */
const pt = (n) => ({ magnitude: Number(n), unit: 'PT' });

/** "#1A1A1A" → { red, green, blue } in 0..1, which is what the API wants. */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) throw new Error(`colour must be a 6-digit hex like "#1A1A1A", got "${hex}"`);
  const n = parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function elementProperties(pageObjectId, { x = 50, y = 50, width = 620, height = 120 }) {
  return {
    pageObjectId,
    size: { width: pt(width), height: pt(height) },
    transform: { scaleX: 1, scaleY: 1, translateX: Number(x), translateY: Number(y), unit: 'PT' },
  };
}

const getDeck = (id) => api.get(`${SLIDES_BASE}/presentations/${encodeURIComponent(id)}`);

/** Concatenated text of a shape, '' when the placeholder is still empty. */
function textOf(shape) {
  return (shape?.text?.textElements || []).map(e => e.textRun?.content || '').join('');
}

/** Every text-capable shape in the deck, with the slide it sits on. */
function* eachShape(deck) {
  for (const slide of deck.slides || []) {
    for (const el of slide.pageElements || []) {
      if (el.shape) yield { slideId: slide.objectId, el };
    }
  }
}

async function findShape(presentationId, objectId) {
  const deck = await getDeck(presentationId);
  for (const { slideId, el } of eachShape(deck)) {
    if (el.objectId === objectId) return { slideId, el };
  }
  throw new Error(`no shape "${objectId}" in this presentation — call list_text_boxes for valid ids`);
}

// ─── Editing tools ──────────────────────────────────────────────────────────

async function handleListTextBoxes({ presentation_id, slide_object_id }) {
  const deck = await getDeck(presentation_id);
  const out = [];
  for (const { slideId, el } of eachShape(deck)) {
    if (slide_object_id && slideId !== slide_object_id) continue;
    const ph = el.shape.placeholder;
    const text = textOf(el.shape);
    out.push({
      slide_object_id: slideId,
      object_id:       el.objectId,
      placeholder:     ph ? `${ph.type}${ph.index ? `#${ph.index}` : ''}` : null,
      shape_type:      el.shape.shapeType || null,
      text_length:     text.length,
      text:            text.length > 300 ? `${text.slice(0, 300)}…` : text,
    });
  }
  return { presentation_id, count: out.length, shapes: out };
}

async function handleSetText({ presentation_id, object_id, text }) {
  requireWrite();
  const { el } = await findShape(presentation_id, object_id);
  const requests = [];
  // deleteText on a shape with no text is an error, so only clear what exists.
  if (textOf(el.shape).length > 0) {
    requests.push({ deleteText: { objectId: object_id, textRange: { type: 'ALL' } } });
  }
  requests.push({ insertText: { objectId: object_id, text: String(text), insertionIndex: 0 } });
  await batchUpdate(presentation_id, requests);
  return { presentation_id, object_id, characters: String(text).length };
}

async function handleInsertText({ presentation_id, object_id, text, insertion_index }) {
  requireWrite();
  const req = { insertText: { objectId: object_id, text: String(text) } };
  if (Number.isFinite(insertion_index)) req.insertText.insertionIndex = insertion_index;
  await batchUpdate(presentation_id, [req]);
  return { presentation_id, object_id, characters: String(text).length };
}

async function handleCreateTextbox({ presentation_id, slide_object_id, text, x, y, width, height }) {
  requireWrite();
  const objectId = newId('tb');
  await batchUpdate(presentation_id, [
    {
      createShape: {
        objectId,
        shapeType: 'TEXT_BOX',
        elementProperties: elementProperties(slide_object_id, { x, y, width, height }),
      },
    },
    { insertText: { objectId, text: String(text), insertionIndex: 0 } },
  ]);
  return { presentation_id, slide_object_id, object_id: objectId };
}

async function handleStyleText(a) {
  requireWrite();
  const { presentation_id, object_id, start, end } = a;
  const range = Number.isFinite(start) && Number.isFinite(end)
    ? { type: 'FIXED_RANGE', startIndex: start, endIndex: end }
    : { type: 'ALL' };

  const style = {};
  const fields = [];
  if (a.color)       { style.foregroundColor = { opaqueColor: { rgbColor: hexToRgb(a.color) } }; fields.push('foregroundColor'); }
  if (a.font_size)   { style.fontSize = pt(a.font_size);        fields.push('fontSize'); }
  if (a.font_family) { style.fontFamily = String(a.font_family); fields.push('fontFamily'); }
  if (a.bold      !== undefined) { style.bold = !!a.bold;           fields.push('bold'); }
  if (a.italic    !== undefined) { style.italic = !!a.italic;       fields.push('italic'); }
  if (a.underline !== undefined) { style.underline = !!a.underline; fields.push('underline'); }

  const requests = [];
  if (fields.length) {
    requests.push({ updateTextStyle: { objectId: object_id, textRange: range, style, fields: fields.join(',') } });
  }
  if (a.alignment) {
    requests.push({
      updateParagraphStyle: {
        objectId: object_id, textRange: range,
        style: { alignment: a.alignment }, fields: 'alignment',
      },
    });
  }
  if (!requests.length) throw new Error('nothing to change — pass at least one of colour, size, font, bold, italic, underline, alignment');
  await batchUpdate(presentation_id, requests);
  return { presentation_id, object_id, applied: fields.concat(a.alignment ? ['alignment'] : []) };
}

async function handleCreateImage({ presentation_id, slide_object_id, image_url, x, y, width, height }) {
  requireWrite();
  const objectId = newId('img');
  await batchUpdate(presentation_id, [
    {
      createImage: {
        objectId,
        url: String(image_url),
        elementProperties: elementProperties(slide_object_id, { x, y, width: width ?? 300, height: height ?? 200 }),
      },
    },
  ]);
  return { presentation_id, slide_object_id, object_id: objectId };
}

async function handleSetSlideBackground({ presentation_id, slide_object_id, color }) {
  requireWrite();
  await batchUpdate(presentation_id, [
    {
      updatePageProperties: {
        objectId: slide_object_id,
        pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: hexToRgb(color) } } } },
        fields: 'pageBackgroundFill.solidFill.color',
      },
    },
  ]);
  return { presentation_id, slide_object_id, color };
}

async function handleBatchUpdateRaw({ presentation_id, requests }) {
  requireWrite();
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('requests must be a non-empty array of Slides API Request objects');
  }
  const data = await batchUpdate(presentation_id, requests);
  return { presentation_id, applied: requests.length, replies: data.replies || [] };
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
      case 'list_text_boxes':     result = await handleListTextBoxes(args);           break;
      case 'set_text':            result = await handleSetText(args);                 break;
      case 'insert_text':         result = await handleInsertText(args);              break;
      case 'create_textbox':      result = await handleCreateTextbox(args);           break;
      case 'style_text':          result = await handleStyleText(args);               break;
      case 'create_image':        result = await handleCreateImage(args);             break;
      case 'set_slide_background': result = await handleSetSlideBackground(args);     break;
      case 'batch_update':        result = await handleBatchUpdateRaw(args);          break;
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
