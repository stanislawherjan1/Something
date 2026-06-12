/**
 * Google Docs MCP Server
 *
 * Auth: OAuth 2.0 with refresh token. Access token is fetched + cached
 * in-memory (~1 h lifetime), refreshed automatically on 401.
 *
 * Env vars (all set by workspace-api from the encrypted store on activation):
 *   GDOCS_CLIENT_ID      — user's own OAuth client (per-integration)
 *   GDOCS_CLIENT_SECRET  — paired secret
 *   GDOCS_REFRESH_TOKEN  — refresh token issued via OAuth Playground
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   search_docs       — find Google Docs by name (substring, case-insensitive)
 *   list_recent_docs  — most-recently-modified Docs across the user's Drive
 *   read_doc          — full doc content as plain text + structure metadata
 *   create_doc        — create a new doc with optional initial body
 *   append_to_doc     — append text to the end of a doc
 *   replace_in_doc    — find/replace across the whole doc (idempotent if no match)
 *   list_doc_revisions — edit history: who modified when (Drive `revisions` endpoint)
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

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DOCS_BASE  = 'https://docs.googleapis.com/v1';
const DOC_MIME   = 'application/vnd.google-apps.document';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gdocs-mcp] Missing OAuth config (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)\n');
  process.exit(1);
}

const client = createGoogleApiClient({
  clientId:     CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  refreshToken: REFRESH_TOKEN,
});

// Thin compat shim — keep the existing api(method, url, { query, body }) shape
// so the handlers below don't need rewriting.
async function api(method, url, { query, body } = {}) {
  switch (method) {
    case 'GET':    return client.get(url,    { query });
    case 'POST':   return client.post(url, body, { query });
    case 'PUT':    return client.put(url,  body, { query });
    case 'PATCH':  return client.patch(url, body, { query });
    case 'DELETE': return client.delete(url, { query });
    default:       throw new Error(`Unsupported method: ${method}`);
  }
}

// ─── Doc structure helpers ─────────────────────────────────────────────────

// Walk Docs API body.content → markdown-flavoured plain text. Mirrors what a
// human sees in the Docs UI, but encodes structure (headings, lists) as
// markdown so the agent reading this doc can tell H1 from H2 from a bullet.
//
// What we render:
//   - HEADING_1..HEADING_6 → "# " .. "###### " prefix on the paragraph
//   - TITLE                → "# "  (Docs title style; degrades to H1)
//   - SUBTITLE             → "## " (Docs subtitle style; degrades to H2)
//   - bullet list items    → "  ".repeat(nestingLevel) + "- "
//   - numbered list items  → "  ".repeat(nestingLevel) + "1. " (Docs API doesn't
//                            give the rendered number; "1." is the markdown idiom
//                            and most renderers/agents auto-number from it)
//   - tables               → tab-separated rows, one row per line
//   - tableOfContents      → walked recursively (its body is plain paragraphs)
//
// What we still skip: inlineObjects (images, drawings), equations, footnotes,
// per-run formatting (bold/italic/code). The agent gets the doc's skeleton
// and prose, which is what reasoning over content needs.
function extractPlainText(body) {
  if (!body?.content) return '';
  const out = [];
  walk(body.content, out);
  // Collapse runs of 3+ blank lines that arise from empty paragraphs between
  // headings — Docs likes to leave those, markdown readers don't.
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Docs `namedStyleType` → markdown heading hashes. TITLE/SUBTITLE degrade
// to H1/H2 since markdown has no equivalent of "title".
const HEADING_PREFIX = {
  TITLE:     '# ',
  SUBTITLE:  '## ',
  HEADING_1: '# ',
  HEADING_2: '## ',
  HEADING_3: '### ',
  HEADING_4: '#### ',
  HEADING_5: '##### ',
  HEADING_6: '###### ',
};

function renderParagraph(p, out) {
  // Concatenate textRuns into the raw paragraph text. The trailing newline
  // is part of the last textRun's content (Docs API convention), so we
  // capture text-with-newline first, then split prefix from body.
  let text = '';
  for (const e of p.elements || []) {
    if (e.textRun?.content) text += e.textRun.content;
  }
  if (!text) {
    // Empty paragraph — preserve as a single newline so we don't fuse
    // adjacent content blocks. The final \n{3,}→\n\n collapses runs.
    out.push('\n');
    return;
  }

  // The paragraph text always ends with the newline from the last textRun.
  // Detach it so we can prepend bullet/heading markers without breaking
  // the trailing line break.
  const trailingNewline = text.endsWith('\n') ? '\n' : '';
  const body = trailingNewline ? text.slice(0, -1) : text;

  // Bullet/numbering takes precedence over heading on the same paragraph
  // (a "heading inside a list" is unusual in Docs — when it happens, treat
  // the bullet as primary, since that's the visual layout).
  if (p.bullet) {
    const nesting = p.bullet.nestingLevel || 0;
    const indent = '  '.repeat(nesting);
    // Docs API doesn't tell us "bullet" vs "numbered" directly — it gives
    // the glyph type via listId → list properties → nestingLevel glyph.
    // We can't resolve that without the document's `lists` map (not passed
    // into walk()). Heuristic: paragraphs using NUMBERED_DECIMAL preset
    // have `glyphSymbol` empty and `glyphFormat` like "%0." — but we
    // don't have that here either. Compromise: render every list item as
    // "- " (markdown unordered), which is unambiguous and doesn't lie
    // about an ordering the agent shouldn't infer. If we ever pass the
    // document's `lists` field through, swap to "1. " when ordered.
    out.push(`${indent}- ${body}${trailingNewline}`);
    return;
  }

  const styleType = p.paragraphStyle?.namedStyleType;
  const prefix = styleType ? HEADING_PREFIX[styleType] : '';
  out.push(`${prefix}${body}${trailingNewline}`);
}

function walk(elements, out) {
  for (const el of elements || []) {
    if (el.paragraph) {
      renderParagraph(el.paragraph, out);
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          walk(cell.content, out);
          out.push('\t');
        }
        out.push('\n');
      }
    } else if (el.tableOfContents) {
      walk(el.tableOfContents.content, out);
    }
  }
}

// End-of-doc index for append. Trailing newline is non-insertable, so we
// insert one position before the final endIndex.
function endOfDocIndex(body) {
  const last = body?.content?.[body.content.length - 1];
  const ix = last?.endIndex ?? 1;
  return Math.max(1, ix - 1);
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_docs',
    description:
      'Search the user\'s Google Docs by name (case-insensitive substring). ' +
      'Returns id, name, modifiedTime. Use read_doc afterwards for content.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Substring to match in document names.' },
        limit: { type: 'number', default: 20, description: 'Max results (Drive caps at 1000).' },
      },
    },
  },
  {
    name: 'list_recent_docs',
    description: 'List the user\'s most recently modified Google Docs across all of Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'read_doc',
    description:
      'Fetch a Google Doc by ID. Returns plain text body + minimal metadata ' +
      '(title, length). Use this to read content; structure walks paragraphs and tables.',
    inputSchema: {
      type: 'object',
      required: ['doc_id'],
      properties: {
        doc_id: { type: 'string', description: 'Google Docs document ID (from search_docs or a docs.google.com URL).' },
      },
    },
  },
  {
    name: 'create_doc',
    description: 'Create a new Google Doc with the given title and optional initial body text.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title:   { type: 'string', description: 'Document title.' },
        content: { type: 'string', description: 'Optional initial body text. Inserted at the start.' },
      },
    },
  },
  {
    name: 'append_to_doc',
    description: 'Append text to the end of an existing Google Doc.',
    inputSchema: {
      type: 'object',
      required: ['doc_id', 'text'],
      properties: {
        doc_id: { type: 'string' },
        text:   { type: 'string', description: 'Text to append. A leading newline is added if the doc is non-empty.' },
      },
    },
  },
  {
    name: 'replace_in_doc',
    description:
      'Find every occurrence of a string and replace it. Idempotent — returns 0 replacements ' +
      'if the string is not found. Case-sensitive by default.',
    inputSchema: {
      type: 'object',
      required: ['doc_id', 'find', 'replace'],
      properties: {
        doc_id:     { type: 'string' },
        find:       { type: 'string' },
        replace:    { type: 'string' },
        match_case: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'list_doc_revisions',
    description:
      'List the edit history of a Google Doc — each entry has revision_id, modified_at, ' +
      'and who made the edit (display name + email). Google retains revisions for ~30 days ' +
      'by default unless keep_forever is true on the revision. Use this for "who edited X" ' +
      'or "when did this doc last change". Returns newest first.',
    inputSchema: {
      type: 'object',
      required: ['doc_id'],
      properties: {
        doc_id: { type: 'string', description: 'Google Docs document ID.' },
        limit:  { type: 'number', default: 50, description: 'Max revisions returned (Drive paginates server-side; this is a client-side cap).' },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleSearchDocs({ query, limit = 20 }) {
  const safe = String(query).replace(/'/g, "\\'");
  const q = `mimeType='${DOC_MIME}' and name contains '${safe}' and trashed=false`;
  const data = await api('GET', `${DRIVE_BASE}/files`, {
    query: {
      q,
      pageSize: Math.min(Number(limit) || 20, 1000),
      fields:   'files(id,name,modifiedTime,webViewLink)',
      orderBy:  'modifiedTime desc',
    },
  });
  return (data.files || []).map((f) => ({
    id:           f.id,
    name:         f.name,
    modified_at:  f.modifiedTime,
    url:          f.webViewLink,
  }));
}

async function handleListRecentDocs({ limit = 20 }) {
  const data = await api('GET', `${DRIVE_BASE}/files`, {
    query: {
      q:        `mimeType='${DOC_MIME}' and trashed=false`,
      pageSize: Math.min(Number(limit) || 20, 1000),
      fields:   'files(id,name,modifiedTime,webViewLink)',
      orderBy:  'modifiedTime desc',
    },
  });
  return (data.files || []).map((f) => ({
    id:           f.id,
    name:         f.name,
    modified_at:  f.modifiedTime,
    url:          f.webViewLink,
  }));
}

async function handleReadDoc({ doc_id }) {
  const doc = await api('GET', `${DOCS_BASE}/documents/${encodeURIComponent(doc_id)}`);
  const text = extractPlainText(doc.body);
  return {
    id:    doc.documentId,
    title: doc.title,
    url:   `https://docs.google.com/document/d/${doc.documentId}/edit`,
    length_chars: text.length,
    text,
  };
}

async function handleCreateDoc({ title, content }) {
  const created = await api('POST', `${DOCS_BASE}/documents`, { body: { title } });
  if (content && content.length > 0) {
    await api('POST', `${DOCS_BASE}/documents/${created.documentId}:batchUpdate`, {
      body: {
        requests: [{ insertText: { location: { index: 1 }, text: content } }],
      },
    });
  }
  return {
    id:    created.documentId,
    title: created.title,
    url:   `https://docs.google.com/document/d/${created.documentId}/edit`,
  };
}

async function handleAppendToDoc({ doc_id, text }) {
  const doc = await api('GET', `${DOCS_BASE}/documents/${encodeURIComponent(doc_id)}`, {
    query: { fields: 'body(content(endIndex))' },
  });
  const ix = endOfDocIndex(doc.body);
  // Prepend a newline if we're appending past existing content (ix > 1).
  const insert = ix > 1 ? `\n${text}` : text;
  await api('POST', `${DOCS_BASE}/documents/${encodeURIComponent(doc_id)}:batchUpdate`, {
    body: {
      requests: [{ insertText: { location: { index: ix }, text: insert } }],
    },
  });
  return {
    id:           doc_id,
    appended_at:  ix,
    chars_added:  insert.length,
  };
}

async function handleReplaceInDoc({ doc_id, find, replace, match_case = true }) {
  const data = await api('POST', `${DOCS_BASE}/documents/${encodeURIComponent(doc_id)}:batchUpdate`, {
    body: {
      requests: [{
        replaceAllText: {
          containsText: { text: find, matchCase: !!match_case },
          replaceText:  replace,
        },
      }],
    },
  });
  const reply = data.replies?.[0]?.replaceAllText;
  return {
    id:           doc_id,
    occurrences:  reply?.occurrencesChanged || 0,
  };
}

async function handleListDocRevisions({ doc_id, limit = 50 }) {
  // Drive revisions endpoint — newest-last by default; we reverse for
  // newest-first which matches what the operator means by "edit history".
  // `keepForever` flags revisions pinned by a user (Docs UI's "Make a copy
  // of this version" creates one). Google auto-prunes the rest after ~30
  // days regardless of how many edits happened.
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const data = await api('GET', `${DRIVE_BASE}/files/${encodeURIComponent(doc_id)}/revisions`, {
    query: {
      fields:   'revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),size,keepForever)',
      pageSize: cap,
    },
  });
  const revs = (data.revisions || []).slice().reverse().slice(0, cap);
  return revs.map((r) => ({
    revision_id:        r.id,
    modified_at:        r.modifiedTime,
    modified_by_name:   r.lastModifyingUser?.displayName || null,
    modified_by_email:  r.lastModifyingUser?.emailAddress || null,
    size_bytes:         Number(r.size) || null,
    keep_forever:       !!r.keepForever,
  }));
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gdocs-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'search_docs':       result = await handleSearchDocs(args || {});      break;
      case 'list_recent_docs':  result = await handleListRecentDocs(args || {});  break;
      case 'read_doc':          result = await handleReadDoc(args);               break;
      case 'create_doc':        result = await handleCreateDoc(args);             break;
      case 'append_to_doc':     result = await handleAppendToDoc(args);           break;
      case 'replace_in_doc':    result = await handleReplaceInDoc(args);          break;
      case 'list_doc_revisions': result = await handleListDocRevisions(args);     break;
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
process.stderr.write('[gdocs-mcp] Ready\n');
