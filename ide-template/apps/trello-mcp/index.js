/**
 * Trello MCP Server
 *
 * Auth: API key + token, both passed as query params on every request.
 * Env vars:
 *   TRELLO_API_KEY  — from https://trello.com/power-ups/admin (per-power-up)
 *                     or https://trello.com/app-key (legacy)
 *   TRELLO_TOKEN    — user-authorised token (scope: read,write)
 *   TRELLO_BOARDS   — optional; comma-separated default boards. Each entry can be:
 *                       a Trello URL:     https://trello.com/b/BFqnhhsY/test-board
 *                       a board ID:       BFqnhhsY  (or full 24-char hex)
 *                       a name → ref:     acme:https://trello.com/b/BFqnhhsY/test-board
 *                                         acme:BFqnhhsY
 *                     Tools accept board_id as a friendly name, a Trello URL,
 *                     a short ID, or a full 24-char hex.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_boards    — every board the token can see
 *   list_lists     — columns on a board (each list = column in Trello)
 *   list_cards     — cards in one list (compact: id, name, labels, due, idList)
 *   get_card       — full card incl. desc, checklists, comments, attachments
 *   list_card_actions — full activity history (moves, labels, members, attachments, comments)
 *   add_comment    — append a comment to a card
 *   edit_comment   — edit the text of an existing comment (needs idAction from get_card)
 *   delete_comment — delete an existing comment (needs idAction; token owner's own only)
 *   add_label      — attach a label by name (auto-creates on the board if missing)
 *   remove_label   — detach a label by name
 *   move_card      — move a card to another column (by list name on the same board)
 *   add_attachment      — upload a local file (e.g. a screenshot) or attach a URL to a card
 *   download_attachment — download an uploaded attachment to a local file (token is
 *                         broker-held, so this MCP is the only thing that can authorise it)
 * ─────────────────────────────────────────────
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY     = process.env.TRELLO_API_KEY;
const TOKEN       = process.env.TRELLO_TOKEN;
const BOARDS_RAW  = process.env.TRELLO_BOARDS || '';
const BASE_URL    = 'https://api.trello.com/1';

if (!API_KEY || !TOKEN) {
  process.stderr.write('[trello-mcp] Missing TRELLO_API_KEY or TRELLO_TOKEN\n');
  process.exit(1);
}

// Pull the short ID out of "https://trello.com/b/BFqnhhsY/anything"; pass
// other inputs through unchanged.
function extractBoardRef(s) {
  if (!s) return s;
  const trimmed = String(s).trim();
  const m = trimmed.match(/trello\.com\/b\/([A-Za-z0-9]+)/i);
  return m ? m[1] : trimmed;
}

// Parse "name:ref,name:ref" or a single bare "ref" into { byName, single }.
// `ref` may be a URL, a short ID, or a 24-char hex — normalised here.
function parseBoards(raw) {
  const byName = {};
  let single = null;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    // Find separator `:` that is NOT part of `://` (URL scheme).
    const protoIx   = entry.indexOf('://');
    const headLimit = protoIx === -1 ? entry.length : protoIx;
    const ix        = entry.slice(0, headLimit).indexOf(':');
    let name, ref;
    if (ix === -1) {
      name = '';
      ref  = entry;
    } else {
      name = entry.slice(0, ix).trim().toLowerCase();
      ref  = entry.slice(ix + 1).trim();
    }
    ref = extractBoardRef(ref);
    if (!ref) continue;
    if (name) byName[name] = ref;
    else single = ref; // last bare entry wins
  }
  // If any named entries exist, ignore a stray bare ref — it's ambiguous.
  return { byName, single: Object.keys(byName).length === 0 ? single : null };
}

const BOARDS = parseBoards(BOARDS_RAW);

// ─── HTTP helper ───────────────────────────────────────────────────────────

async function api(method, path, query = {}, body = null) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const opts = {
    method,
    headers: { Accept: 'application/json' },
  };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trello API ${method} ${path} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ─── Attachment helpers ──────────────────────────────────────────────────────

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.zip': 'application/zip', '.md': 'text/markdown',
};

function guessMime(name) {
  return MIME_BY_EXT[extname(name || '').toLowerCase()] || 'application/octet-stream';
}

function tmpPath(name) {
  const dir = join(tmpdir(), 'trello-mcp');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomBytes(6).toString('hex')}-${name}`);
}

// Multipart POST for file uploads. The JSON `api()` helper can't do this —
// Trello's attachment endpoint wants multipart/form-data with a `file` part.
// key+token stay as query params (Trello accepts them there for uploads).
// Node 20's global FormData/Blob/fetch (undici) cover this with no extra deps.
async function apiUpload(path, { buffer, fileName, mimeType, fields = {} }) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  const res = await fetch(url.toString(), { method: 'POST', headers: { Accept: 'application/json' }, body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trello upload POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Download an uploaded attachment's bytes. Trello requires the OAuth
// Authorization header for the file download — the key/token query params that
// authorise every other call do NOT authorise the binary download of a private
// card's attachment. The endpoint then 302-redirects to a pre-signed storage
// URL, which must be fetched WITHOUT the Authorization header (the signature is
// already in the URL; re-sending OAuth makes storage reject it). So follow the
// redirect manually.
async function fetchAttachmentBinary(downloadUrl) {
  const authHeader = `OAuth oauth_consumer_key="${API_KEY}", oauth_token="${TOKEN}"`;
  let res = await fetch(downloadUrl, { headers: { Authorization: authHeader }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error('Trello attachment redirect missing Location header');
    res = await fetch(loc); // pre-signed storage URL — no auth header
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trello attachment download → ${res.status}: ${text.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function resolveBoardId(arg) {
  if (arg) {
    const trimmed = String(arg).trim();
    // 1) Friendly-name lookup wins over auto-detection (a short alphanum like
    //    "personal" could collide with the Trello short-ID regex).
    const fromMap = BOARDS.byName[trimmed.toLowerCase()];
    if (fromMap) return fromMap;
    // 2) Trello URL → short ID, or pass a bare ID through.
    const ref = extractBoardRef(trimmed);
    // Accept short IDs (~8 char) and full 24-char hex.
    if (/^[A-Za-z0-9]{8,24}$/.test(ref)) return ref;
    const known = Object.keys(BOARDS.byName);
    throw new Error(
      `Board "${arg}" not recognised. ` +
      (known.length ? `Known names: ${known.join(', ')}. ` : '') +
      'Pass a board URL, ID, or a configured name.'
    );
  }
  if (BOARDS.single) return BOARDS.single;
  const names = Object.keys(BOARDS.byName);
  if (names.length === 1) return BOARDS.byName[names[0]];
  if (names.length === 0) {
    throw new Error(
      'No board specified. Set TRELLO_BOARDS or pass board_id explicitly. ' +
      'Use list_boards to discover IDs.'
    );
  }
  throw new Error(
    `No board specified. Configured boards: ${names.join(', ')}. Pass board_id with one of these names.`
  );
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

async function findListByName(boardId, listName) {
  const lists = await api('GET', `/boards/${boardId}/lists`);
  const target = lists.find((l) => norm(l.name) === norm(listName));
  if (!target) {
    const available = lists.map((l) => l.name).join(', ') || '(none)';
    throw new Error(`No list named "${listName}" on board. Available: ${available}`);
  }
  return target;
}

async function findOrCreateLabel(boardId, labelName, color) {
  const labels = await api('GET', `/boards/${boardId}/labels`, { limit: 1000 });
  const found = labels.find((l) => norm(l.name) === norm(labelName));
  if (found) return found;
  return api('POST', '/labels', {}, {
    name: labelName,
    color: color || null,
    idBoard: boardId,
  });
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_boards',
    description: 'List every Trello board the token can access. Returns id, name, url, closed.',
    inputSchema: {
      type: 'object',
      properties: {
        include_closed: {
          type: 'boolean',
          default: false,
          description: 'Include archived boards.',
        },
      },
    },
  },
  {
    name: 'list_lists',
    description:
      'List columns (Trello calls them "lists") on a board, in display order. ' +
      'Use this to discover column names before move_card.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'string',
          description:
            'Board ID (24-char hex) or a friendly name from TRELLO_BOARDS. ' +
            'Optional when only one board is configured.',
        },
      },
    },
  },
  {
    name: 'list_cards',
    description:
      'List cards in one column. Compact view (id, name, label names, due, list id). ' +
      'Use get_card afterwards for description / comments / checklists.',
    inputSchema: {
      type: 'object',
      required: ['list_id'],
      properties: {
        list_id: { type: 'string', description: 'List (column) ID from list_lists.' },
      },
    },
  },
  {
    name: 'get_card',
    description:
      'Fetch one card with description, labels, checklists, members, attachments, and recent comments.',
    inputSchema: {
      type: 'object',
      required: ['card_id'],
      properties: {
        card_id:        { type: 'string', description: 'Card ID or short link.' },
        comment_limit:  { type: 'number', default: 20, description: 'Max comments to include.' },
      },
    },
  },
  {
    name: 'add_comment',
    description: 'Post a comment on a card. Comment is attributed to the token owner.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'text'],
      properties: {
        card_id: { type: 'string' },
        text:    { type: 'string', description: 'Comment body. Markdown is supported.' },
      },
    },
  },
  {
    name: 'add_label',
    description:
      'Attach a label to a card by name. If the label does not exist on the board, it is created. ' +
      'Idempotent — re-adding the same label is a no-op.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'label_name'],
      properties: {
        card_id:    { type: 'string' },
        label_name: { type: 'string', description: 'Label name, case-insensitive lookup.' },
        board_id:   {
          type: 'string',
          description: 'Optional. Board the card lives on (only needed when label must be created).',
        },
        color: {
          type: 'string',
          enum: ['yellow', 'purple', 'blue', 'red', 'green', 'orange', 'black', 'sky', 'pink', 'lime', 'null'],
          description: 'Color used only when creating a new label. Use "null" for no color.',
        },
      },
    },
  },
  {
    name: 'remove_label',
    description: 'Detach a label from a card by name. No-op if the card does not have that label.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'label_name'],
      properties: {
        card_id:    { type: 'string' },
        label_name: { type: 'string' },
      },
    },
  },
  {
    name: 'move_card',
    description:
      'Move a card to another column on the same board, identified by list NAME (case-insensitive). ' +
      'Falls back to the single configured board in TRELLO_BOARDS when board_id is omitted.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'list_name'],
      properties: {
        card_id:   { type: 'string' },
        list_name: { type: 'string', description: 'Target column name, e.g. "Done".' },
        board_id:  {
          type: 'string',
          description:
            'Board the target list lives on. ID (24-char hex) or friendly name from TRELLO_BOARDS. ' +
            'Optional when only one board is configured.',
        },
        position: {
          type: 'string',
          enum: ['top', 'bottom'],
          default: 'top',
          description: 'Where in the target column to drop the card.',
        },
      },
    },
  },
  {
    name: 'add_attachment',
    description:
      'Attach a file or a URL to a card. Two modes: pass file_path to upload a ' +
      'LOCAL file (e.g. a screenshot the bot just captured) as a real attachment, ' +
      'or pass url to attach an external link. Exactly one of file_path / url is ' +
      'required. The local file must be readable by the MCP process.',
    inputSchema: {
      type: 'object',
      required: ['card_id'],
      properties: {
        card_id:   { type: 'string' },
        file_path: { type: 'string', description: 'Absolute path to a local file to upload. Use this for screenshots/binaries.' },
        url:       { type: 'string', description: 'External URL to attach instead of a file (no upload).' },
        name:      { type: 'string', description: 'Optional display name for the attachment. Defaults to the file name (or the URL).' },
        mime_type: { type: 'string', description: 'Optional MIME type for an uploaded file; inferred from the extension when omitted.' },
      },
    },
  },
  {
    name: 'edit_comment',
    description:
      'Edit the text of an existing comment on a card. Get comment_id (Trello calls ' +
      'it idAction) from get_card\'s comments[].id. Only the token owner\'s own ' +
      'comments can be edited. Replaces the whole comment body.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'comment_id', 'text'],
      properties: {
        card_id:    { type: 'string' },
        comment_id: { type: 'string', description: 'The comment action id (idAction) from get_card.' },
        text:       { type: 'string', description: 'New comment body. Replaces the old text. Markdown supported.' },
      },
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download an uploaded attachment from a card to a local file and return its ' +
      'path. Get card_id + attachment_id from get_card (attachments[].id; only ' +
      'is_upload=true ones are real files — for is_upload=false the url field is the ' +
      'external link, no download needed). Routes through the MCP so the API token ' +
      '(broker-held) authorises the binary download — curl/Playwright can\'t.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'attachment_id'],
      properties: {
        card_id:       { type: 'string' },
        attachment_id: { type: 'string', description: 'The attachment id (idAttachment) from get_card.' },
      },
    },
  },
  {
    name: 'delete_comment',
    description:
      'Delete a comment from a card. Get comment_id (idAction) from get_card\'s ' +
      'comments[].id. Only the token owner\'s own comments can be deleted (or by a ' +
      'board admin). Destructive and not recoverable — prefer edit_comment to fix a ' +
      'comment rather than delete + re-add.',
    inputSchema: {
      type: 'object',
      required: ['card_id', 'comment_id'],
      properties: {
        card_id:    { type: 'string' },
        comment_id: { type: 'string', description: 'The comment action id (idAction) from get_card.' },
      },
    },
  },
  {
    name: 'list_card_actions',
    description:
      'Full activity history of a card — moves between columns, label add/remove, ' +
      'member changes, attachments, checklist updates, comments, archive/unarchive, ' +
      'rename. Use this for "what happened to this card / who moved it when". ' +
      'get_card only returns comments; this returns the whole Trello action log. ' +
      'Each entry has id, type, date, who, and a human-readable summary. Newest first.',
    inputSchema: {
      type: 'object',
      required: ['card_id'],
      properties: {
        card_id: { type: 'string' },
        limit:   { type: 'number', default: 50, description: 'Max actions to return (Trello caps a page at 1000).' },
        filter:  { type: 'string', description: 'Optional Trello action-type filter, e.g. "updateCard:idList" for column moves only, or "addLabelToCard,removeLabelFromCard". Default: all action types.' },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleListBoards({ include_closed = false } = {}) {
  const boards = await api('GET', '/members/me/boards', {
    fields: 'name,url,closed',
    filter: include_closed ? 'all' : 'open',
  });
  return boards.map(({ id, name, url, closed }) => ({ id, name, url, closed }));
}

async function handleListLists({ board_id } = {}) {
  const id = resolveBoardId(board_id);
  const lists = await api('GET', `/boards/${id}/lists`, { fields: 'name,pos,closed' });
  return lists.map(({ id, name, pos, closed }) => ({ id, name, pos, closed }));
}

async function handleListCards({ list_id }) {
  const cards = await api('GET', `/lists/${list_id}/cards`, {
    fields: 'name,due,idList,idLabels,shortUrl,closed',
  });
  // hydrate label names with one extra fetch per board (cards on the same list = same board)
  let labelMap = {};
  if (cards.length > 0) {
    const list  = await api('GET', `/lists/${list_id}`, { fields: 'idBoard' });
    const labels = await api('GET', `/boards/${list.idBoard}/labels`, { limit: 1000 });
    labelMap = Object.fromEntries(labels.map((l) => [l.id, l.name || `(${l.color || 'unnamed'})`]));
  }
  return cards.map((c) => ({
    id:        c.id,
    name:      c.name,
    due:       c.due,
    list_id:   c.idList,
    short_url: c.shortUrl,
    labels:    (c.idLabels || []).map((id) => labelMap[id] ?? id),
    closed:    c.closed,
  }));
}

async function handleGetCard({ card_id, comment_limit = 20 }) {
  const card = await api('GET', `/cards/${card_id}`, {
    // `fields` is a restrictive whitelist — even though `labels=true` enables
    // the expanded labels array, it gets stripped from the response unless
    // `labels` is also in the fields list. idLabels is the bare id-only
    // version; `labels` is the populated objects (name + color). We want
    // both (idLabels for diffing, labels for display).
    fields:        'name,desc,due,idList,idBoard,idLabels,labels,shortUrl,closed',
    members:       'true',
    member_fields: 'fullName,username',
    checklists:    'all',
    attachments:   'true',
    labels:        'true',
  });
  const actions = await api('GET', `/cards/${card_id}/actions`, {
    filter: 'commentCard',
    limit:  Math.min(comment_limit, 1000),
  });
  return {
    id:      card.id,
    name:    card.name,
    desc:    card.desc,
    due:     card.due,
    closed:  card.closed,
    list_id: card.idList,
    board_id: card.idBoard,
    short_url: card.shortUrl,
    labels: (card.labels || []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    members: (card.members || []).map((m) => ({ username: m.username, name: m.fullName })),
    checklists: (card.checklists || []).map((cl) => ({
      name: cl.name,
      items: (cl.checkItems || []).map((it) => ({ text: it.name, state: it.state })),
    })),
    attachments: (card.attachments || []).map((a) => ({
      id:        a.id,
      name:      a.name,
      url:       a.url,
      mime:      a.mimeType || null,
      bytes:     a.bytes ?? null,
      is_upload: !!a.isUpload,   // true → downloadable via download_attachment; false → external URL
    })),
    comments: actions.map((a) => ({
      id:   a.id,   // idAction — pass to edit_comment
      by:   a.memberCreator?.fullName || a.memberCreator?.username,
      at:   a.date,
      text: a.data?.text,
    })),
  };
}

async function handleAddComment({ card_id, text }) {
  const result = await api('POST', `/cards/${card_id}/actions/comments`, { text });
  return { id: result.id, posted_at: result.date, text: result.data?.text };
}

async function handleAddLabel({ card_id, label_name, board_id, color }) {
  // Need the board ID to look up / create labels. Try arg → configured map → ask the card.
  let boardId;
  try {
    if (board_id) boardId = resolveBoardId(board_id);
  } catch {
    boardId = undefined;
  }
  if (!boardId) {
    const card = await api('GET', `/cards/${card_id}`, { fields: 'idBoard' });
    boardId = card.idBoard;
  }
  const label = await findOrCreateLabel(boardId, label_name, color === 'null' ? null : color);

  // Trello returns 400 if label is already on the card. Treat that as success.
  try {
    await api('POST', `/cards/${card_id}/idLabels`, {}, { value: label.id });
  } catch (err) {
    if (!/already/i.test(err.message)) throw err;
  }
  return { card_id, label: { id: label.id, name: label.name, color: label.color } };
}

async function handleRemoveLabel({ card_id, label_name }) {
  const card = await api('GET', `/cards/${card_id}`, { fields: 'idBoard,idLabels' });
  const labels = await api('GET', `/boards/${card.idBoard}/labels`, { limit: 1000 });
  const target = labels.find((l) => norm(l.name) === norm(label_name));
  if (!target) {
    return { card_id, removed: false, reason: `No label named "${label_name}" on board` };
  }
  if (!card.idLabels.includes(target.id)) {
    return { card_id, removed: false, reason: 'Label was not on the card' };
  }
  await api('DELETE', `/cards/${card_id}/idLabels/${target.id}`);
  return { card_id, removed: true, label: { id: target.id, name: target.name } };
}

async function handleMoveCard({ card_id, list_name, board_id, position = 'top' }) {
  const boardId = resolveBoardId(board_id);
  const list = await findListByName(boardId, list_name);
  await api('PUT', `/cards/${card_id}`, {}, { idList: list.id, pos: position });
  return { card_id, moved_to: { list_id: list.id, list_name: list.name }, position };
}

async function handleAddAttachment({ card_id, file_path, url, name, mime_type } = {}) {
  if (!card_id) throw new Error('card_id is required');
  if (!file_path && !url) throw new Error('provide either file_path (local file to upload) or url (external link)');
  if (file_path && url)   throw new Error('provide only one of file_path or url, not both');

  let result;
  if (file_path) {
    if (!existsSync(file_path))       throw new Error(`file not found: ${file_path}`);
    if (!statSync(file_path).isFile()) throw new Error(`not a file: ${file_path}`);
    const buffer   = readFileSync(file_path);
    const fileName = name || basename(file_path);
    const mimeType = mime_type || guessMime(fileName);
    result = await apiUpload(`/cards/${encodeURIComponent(card_id)}/attachments`, {
      buffer, fileName, mimeType,
      fields: { name: fileName, mimeType },
    });
  } else {
    // External-URL attachment — no upload; key/token query auth is sufficient.
    result = await api('POST', `/cards/${encodeURIComponent(card_id)}/attachments`, { url, name: name || url });
  }
  return {
    card_id,
    attachment: {
      id:        result.id,
      name:      result.name,
      url:       result.url,
      mime:      result.mimeType || null,
      bytes:     result.bytes ?? null,
      is_upload: !!result.isUpload,
    },
  };
}

async function handleEditComment({ card_id, comment_id, text } = {}) {
  if (!card_id)    throw new Error('card_id is required');
  if (!comment_id) throw new Error('comment_id (idAction from get_card) is required');
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
  // Trello takes the new body as the `text` query param (same as add_comment).
  const result = await api('PUT', `/cards/${encodeURIComponent(card_id)}/actions/${encodeURIComponent(comment_id)}/comments`, { text });
  return { id: result.id, edited_at: result.date, text: result.data?.text };
}

async function handleDeleteComment({ card_id, comment_id } = {}) {
  if (!card_id)    throw new Error('card_id is required');
  if (!comment_id) throw new Error('comment_id (idAction from get_card) is required');
  await api('DELETE', `/cards/${encodeURIComponent(card_id)}/actions/${encodeURIComponent(comment_id)}/comments`);
  return { card_id, comment_id, deleted: true };
}

async function handleDownloadAttachment({ card_id, attachment_id } = {}) {
  if (!card_id)       throw new Error('card_id is required');
  if (!attachment_id) throw new Error('attachment_id (idAttachment from get_card) is required');
  // Metadata via the normal key/token query auth.
  const meta = await api('GET', `/cards/${encodeURIComponent(card_id)}/attachments/${encodeURIComponent(attachment_id)}`, {
    fields: 'id,name,url,bytes,mimeType,isUpload,fileName',
  });
  if (meta.isUpload === false) {
    // External-link attachment — no binary to fetch; the url IS the resource.
    return {
      card_id, attachment_id, is_upload: false, url: meta.url,
      note: 'External link attachment — not an uploaded file; use the url directly.',
    };
  }
  const fileName = meta.fileName || meta.name || String(attachment_id);
  // Canonical download endpoint (more reliable than meta.url, whose form
  // varies between legacy S3 links and the API redirect endpoint).
  const dlUrl = `${BASE_URL}/cards/${encodeURIComponent(card_id)}/attachments/${encodeURIComponent(attachment_id)}/download/${encodeURIComponent(fileName)}`;
  const buffer = await fetchAttachmentBinary(dlUrl);
  const safeName = fileName.replace(/[\/\\]/g, '_');
  const outPath = tmpPath(safeName);
  writeFileSync(outPath, buffer);
  return {
    card_id,
    attachment_id,
    is_upload: true,
    name:      meta.name,
    file_name: fileName,
    mime:      meta.mimeType || guessMime(safeName),
    bytes:     buffer.length,
    path:      outPath,
  };
}

// Human-readable one-liner for a Trello card action. Covers the common types;
// falls back to the raw type string for anything unmapped.
function summariseAction(a) {
  const d = a.data || {};
  switch (a.type) {
    case 'createCard':              return `created in "${d.list?.name || '?'}"`;
    case 'commentCard':             return `commented: ${(d.text || '').slice(0, 160)}`;
    case 'updateComment':           return `edited a comment`;
    case 'deleteComment':           return `deleted a comment`;
    case 'updateCard':
      if (d.listBefore && d.listAfter) return `moved "${d.listBefore.name}" → "${d.listAfter.name}"`;
      if (d.old && 'closed' in d.old)  return d.card?.closed ? 'archived' : 'unarchived';
      if (d.old && 'name'   in d.old)  return `renamed to "${d.card?.name || ''}"`;
      if (d.old && 'due'    in d.old)  return `changed due date`;
      if (d.old && 'desc'   in d.old)  return `edited description`;
      if (d.old && 'pos'    in d.old)  return `reordered`;
      return 'updated';
    case 'addLabelToCard':          return `added label ${d.label?.name || d.label?.color || ''}`.trim();
    case 'removeLabelFromCard':     return `removed label ${d.label?.name || d.label?.color || ''}`.trim();
    case 'addMemberToCard':         return `added member ${d.member?.name || d.member?.username || ''}`.trim();
    case 'removeMemberFromCard':    return `removed member ${d.member?.name || d.member?.username || ''}`.trim();
    case 'addAttachmentToCard':     return `attached "${d.attachment?.name || ''}"`;
    case 'deleteAttachmentFromCard':return `removed attachment "${d.attachment?.name || ''}"`;
    case 'addChecklistToCard':      return `added checklist "${d.checklist?.name || ''}"`;
    case 'updateCheckItemStateOnCard': return `${d.checkItem?.state === 'complete' ? 'checked' : 'unchecked'}: ${d.checkItem?.name || ''}`;
    case 'copyCard':                return 'copied';
    case 'moveCardToBoard':         return `moved to board "${d.board?.name || ''}"`;
    case 'moveCardFromBoard':       return `moved from board "${d.boardSource?.name || ''}"`;
    default:                        return a.type;
  }
}

async function handleListCardActions({ card_id, limit = 50, filter } = {}) {
  if (!card_id) throw new Error('card_id is required');
  const actions = await api('GET', `/cards/${encodeURIComponent(card_id)}/actions`, {
    filter: filter || 'all',          // 'all' = every action type Trello exposes for the card
    limit:  Math.min(Math.max(Number(limit) || 50, 1), 1000),
  });
  return {
    card_id,
    count: Array.isArray(actions) ? actions.length : 0,
    actions: (actions || []).map((a) => ({
      id:      a.id,
      type:    a.type,
      date:    a.date,
      by:      a.memberCreator?.fullName || a.memberCreator?.username || null,
      summary: summariseAction(a),
    })),
  };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'trello-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_boards':  result = await handleListBoards(args || {});  break;
      case 'list_lists':   result = await handleListLists(args || {});   break;
      case 'list_cards':   result = await handleListCards(args);         break;
      case 'get_card':     result = await handleGetCard(args);           break;
      case 'add_comment':  result = await handleAddComment(args);        break;
      case 'add_label':    result = await handleAddLabel(args);          break;
      case 'remove_label': result = await handleRemoveLabel(args);       break;
      case 'move_card':    result = await handleMoveCard(args);          break;
      case 'add_attachment':      result = await handleAddAttachment(args);      break;
      case 'edit_comment':        result = await handleEditComment(args);        break;
      case 'delete_comment':      result = await handleDeleteComment(args);      break;
      case 'list_card_actions':   result = await handleListCardActions(args);     break;
      case 'download_attachment': result = await handleDownloadAttachment(args);  break;
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
process.stderr.write('[trello-mcp] Ready\n');
