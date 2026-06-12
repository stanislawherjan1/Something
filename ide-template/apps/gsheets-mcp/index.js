/**
 * Google Sheets MCP Server
 *
 * Reuses Google Docs OAuth credentials (the catalog entry has
 * `credentialsFrom: "gdocs"`), so all auth env vars share the GDOCS_ prefix.
 * Make sure the user's refresh token was generated with the
 * `https://www.googleapis.com/auth/spreadsheets` scope — without it every
 * Sheets call returns 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT.
 *
 * Env vars (set by workspace-api at spawn time):
 *   GDOCS_CLIENT_ID
 *   GDOCS_CLIENT_SECRET
 *   GDOCS_REFRESH_TOKEN
 *   GWORKSPACE_ALLOW_WRITE  — "yes" | "no" (default no). Gates append_rows,
 *                              update_range, create_spreadsheet. Toggleable
 *                              from the Settings cog on the Google Docs tile.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_spreadsheets   — Drive search, mimeType filter pre-applied
 *   read_range          — values.get for an A1 range or whole sheet
 *   read_sheet          — read every cell of one tab (uses spreadsheets.get
 *                          to discover the tab list when sheet_name omitted)
 *   append_rows         — values.append with INSERT_ROWS + USER_ENTERED
 *   update_range        — values.update with USER_ENTERED
 *   create_spreadsheet  — spreadsheets.create with optional tab list
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
const SHEETS_BASE = 'https://sheets.googleapis.com/v4';
const SHEET_MIME  = 'application/vnd.google-apps.spreadsheet';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gsheets-mcp] Missing OAuth config (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN). Activate Google Workspace first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

// Quote a sheet/tab name for A1 ranges. The Sheets API requires single-quoting
// any name with spaces, punctuation, or a leading digit; doubled `'` escapes
// an embedded apostrophe.
function quoteA1(name) {
  if (!name) return '';
  return `'${String(name).replace(/'/g, "''")}'`;
}

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Sheets write access is disabled in this workspace. ' +
      'Open Integrations → Google Workspace → Settings (gear) and set ' +
      '"Allow bot to modify your Google Workspace data" to Yes.',
    );
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_spreadsheets',
    description:
      'Search the user\'s Google Sheets by name (case-insensitive substring). ' +
      'Returns id, name, modifiedTime, url. Omit `query` to get the most-recently-modified sheets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match in spreadsheet names. Omit for most-recent listing.' },
        limit: { type: 'number', default: 20, description: 'Max results (max 1000).' },
      },
    },
  },
  {
    name: 'read_range',
    description:
      'Read a range of cells from a spreadsheet using A1 notation. ' +
      'Range examples: `Sheet1!A1:C10`, `\'My Sheet\'!A:B`, or just `Sheet1` to read the whole tab. ' +
      'Returns a 2D array of values. Empty trailing cells are omitted by Google.',
    inputSchema: {
      type: 'object',
      required: ['spreadsheet_id', 'range'],
      properties: {
        spreadsheet_id: { type: 'string', description: 'From list_spreadsheets or a docs.google.com/spreadsheets URL.' },
        range:          { type: 'string', description: 'A1 notation. Wrap sheet names containing spaces/punctuation in single quotes.' },
        value_render: {
          type: 'string',
          enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
          default: 'FORMATTED_VALUE',
          description: 'FORMATTED_VALUE = strings as user sees; UNFORMATTED_VALUE = typed JSON; FORMULA = original formula text.',
        },
      },
    },
  },
  {
    name: 'read_sheet',
    description:
      'Read every cell of one tab. If `sheet_name` is omitted, reads the first tab. ' +
      'Returns the tab title, dimensions (rowCount × columnCount), and a 2D array of values.',
    inputSchema: {
      type: 'object',
      required: ['spreadsheet_id'],
      properties: {
        spreadsheet_id: { type: 'string' },
        sheet_name:     { type: 'string', description: 'Tab title. Omit to use the first tab.' },
        value_render: {
          type: 'string',
          enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
          default: 'FORMATTED_VALUE',
        },
      },
    },
  },
  {
    name: 'append_rows',
    description:
      'Append rows after the last non-empty row of a tab. Uses INSERT_ROWS so existing data below the table is never overwritten, ' +
      'and USER_ENTERED parsing so `=SUM(A:A)` becomes a formula and `2026-05-08` becomes a date. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['spreadsheet_id', 'range', 'values'],
      properties: {
        spreadsheet_id: { type: 'string' },
        range: {
          type: 'string',
          description: 'Sheet/range to search for the table — usually just the sheet name like `Sheet1`. Sheets finds the existing table inside this range and appends after its last row.',
        },
        values: {
          type: 'array',
          description: '2D array of rows. Each row is an array of cell values.',
          items: { type: 'array', items: {} },
        },
      },
    },
  },
  {
    name: 'update_range',
    description:
      'Write values to a specific A1 range, overwriting whatever was there. Uses USER_ENTERED parsing. ' +
      'The `values` 2D array must match the dimensions of the range. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['spreadsheet_id', 'range', 'values'],
      properties: {
        spreadsheet_id: { type: 'string' },
        range:          { type: 'string', description: 'A1 notation. Must specify rows + columns explicitly (e.g. `Sheet1!A1:C3`).' },
        values: {
          type: 'array',
          description: '2D array of cell values matching the range\'s dimensions.',
          items: { type: 'array', items: {} },
        },
      },
    },
  },
  {
    name: 'create_spreadsheet',
    description:
      'Create a new Google Spreadsheet. Optionally specify tab names; default is a single "Sheet1". ' +
      'Returns id + url. Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        sheet_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tab names to create. If omitted, the spreadsheet starts with a single default tab.',
        },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleListSpreadsheets({ query, limit = 20 } = {}) {
  let q = `mimeType='${SHEET_MIME}' and trashed=false`;
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
  return (data.files || []).map((f) => ({
    id:          f.id,
    name:        f.name,
    modified_at: f.modifiedTime,
    url:         f.webViewLink,
  }));
}

async function handleReadRange({ spreadsheet_id, range, value_render = 'FORMATTED_VALUE' }) {
  const url = `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}`;
  const data = await api.get(url, { query: { valueRenderOption: value_render } });
  return {
    range:  data.range,
    values: data.values || [],
    rows:   (data.values || []).length,
  };
}

async function handleReadSheet({ spreadsheet_id, sheet_name, value_render = 'FORMATTED_VALUE' }) {
  // Fetch tab list to resolve the default + dimensions.
  const meta = await api.get(`${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheet_id)}`, {
    query: {
      includeGridData: 'false',
      fields: 'spreadsheetId,properties(title),sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))',
    },
  });
  const tabs = (meta.sheets || []).map(s => s.properties);
  if (tabs.length === 0) throw new Error('Spreadsheet has no sheets.');
  const tab = sheet_name
    ? tabs.find(t => t.title === sheet_name)
    : tabs[0];
  if (!tab) throw new Error(`No tab named "${sheet_name}". Available: ${tabs.map(t => t.title).join(', ')}.`);

  const range = quoteA1(tab.title);
  const data = await api.get(
    `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}`,
    { query: { valueRenderOption: value_render } },
  );
  return {
    spreadsheet_title: meta.properties?.title,
    sheet_title:       tab.title,
    sheet_id:          tab.sheetId,
    row_count:         tab.gridProperties?.rowCount,
    column_count:      tab.gridProperties?.columnCount,
    range:             data.range,
    values:            data.values || [],
  };
}

async function handleAppendRows({ spreadsheet_id, range, values }) {
  requireWrite();
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('`values` must be a non-empty 2D array.');
  }
  const url = `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}:append`;
  const data = await api.post(url, { values, majorDimension: 'ROWS' }, {
    query: {
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
    },
  });
  return {
    spreadsheet_id,
    table_range:    data.tableRange,
    updated_range:  data.updates?.updatedRange,
    rows_added:     data.updates?.updatedRows,
    cells_written:  data.updates?.updatedCells,
  };
}

async function handleUpdateRange({ spreadsheet_id, range, values }) {
  requireWrite();
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('`values` must be a non-empty 2D array.');
  }
  const url = `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}`;
  const data = await api.put(url, { values, majorDimension: 'ROWS' }, {
    query: { valueInputOption: 'USER_ENTERED' },
  });
  return {
    spreadsheet_id,
    updated_range:  data.updatedRange,
    updated_rows:   data.updatedRows,
    updated_cols:   data.updatedColumns,
    cells_written:  data.updatedCells,
  };
}

async function handleCreateSpreadsheet({ title, sheet_names }) {
  requireWrite();
  const body = { properties: { title } };
  if (Array.isArray(sheet_names) && sheet_names.length > 0) {
    body.sheets = sheet_names.map(n => ({ properties: { title: n } }));
  }
  const created = await api.post(`${SHEETS_BASE}/spreadsheets`, body);
  return {
    id:    created.spreadsheetId,
    title: created.properties?.title,
    url:   created.spreadsheetUrl,
    sheets: (created.sheets || []).map(s => ({
      sheet_id: s.properties?.sheetId,
      title:    s.properties?.title,
    })),
  };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gsheets-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_spreadsheets':  result = await handleListSpreadsheets(args || {}); break;
      case 'read_range':         result = await handleReadRange(args);              break;
      case 'read_sheet':         result = await handleReadSheet(args);              break;
      case 'append_rows':        result = await handleAppendRows(args);             break;
      case 'update_range':       result = await handleUpdateRange(args);            break;
      case 'create_spreadsheet': result = await handleCreateSpreadsheet(args);      break;
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
process.stderr.write('[gsheets-mcp] Ready\n');
