/**
 * SignWell E-Signature MCP Server
 *
 * Auth: API key via X-Api-Key header.
 * Env vars: SIGNWELL_API_KEY
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   send_document         — upload a PDF (base64) and create a draft + send for signing
 *   get_document          — get status and details of a document
 *   list_documents        — list documents with optional status/search filter
 *   send_reminder         — send a signing reminder to pending recipients
 *   get_completed_pdf     — download the signed PDF (returns URL or base64)
 * ─────────────────────────────────────────────
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


// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY  = process.env.SIGNWELL_API_KEY;
const BASE_URL = 'https://www.signwell.com/api/v1';

if (!API_KEY) {
  process.stderr.write('[signwell-mcp] Missing SIGNWELL_API_KEY\n');
  process.exit(1);
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

async function api(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'X-Api-Key': API_KEY,
      'Accept':    'application/json',
    },
  };

  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, opts);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SignWell API error ${res.status}: ${text}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

async function apiBuffer(path, query = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(query).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': API_KEY, 'Accept': 'application/pdf' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SignWell API error ${res.status}: ${text}`);
  }

  return res.arrayBuffer();
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'send_document',
    description: `Upload a PDF (as base64) and send it for e-signature via SignWell.

The document is always created as a draft first. Set send_now: true to also send it immediately, or leave false to review in the SignWell editor first.

The response includes:
- id: document ID for status checks
- editor_url: link to the SignWell editor to review / place fields before sending

When the user provides a PDF file in chat, read it as base64 and pass it in file_base64.

EXAMPLE:
{
  "name": "Service Agreement",
  "file_name": "agreement.pdf",
  "file_base64": "<base64 content>",
  "recipients": [
    { "id": "1", "name": "Alice Smith", "email": "alice@example.com" }
  ],
  "subject": "Please sign the agreement",
  "send_now": true
}`,
    inputSchema: {
      type: 'object',
      required: ['name', 'file_name', 'file_base64', 'recipients'],
      properties: {
        name: {
          type: 'string',
          description: 'Document name shown in SignWell.',
        },
        file_name: {
          type: 'string',
          description: 'File name including extension, e.g. "contract.pdf".',
        },
        file_base64: {
          type: 'string',
          description: 'Base64-encoded file content. Supported: pdf, doc, docx, jpg, png and more.',
        },
        recipients: {
          type: 'array',
          description: 'Signers. Each must have id (string "1","2",...), email, and optionally name.',
          items: {
            type: 'object',
            required: ['id', 'email'],
            properties: {
              id:    { type: 'string' },
              email: { type: 'string' },
              name:  { type: 'string' },
            },
          },
        },
        subject: {
          type: 'string',
          description: 'Email subject line the recipients see.',
        },
        message: {
          type: 'string',
          description: 'Email body message the recipients see.',
        },
        send_now: {
          type: 'boolean',
          description: 'If true, send the draft immediately after creation. Default: false (stay as draft for review).',
          default: false,
        },
        apply_signing_order: {
          type: 'boolean',
          description: 'When true, recipients sign sequentially in the order of the recipients array.',
          default: false,
        },
        text_tags: {
          type: 'boolean',
          description: 'Set true if the document contains SignWell text tags like {{signature:1:y}} for automatic field placement.',
          default: false,
        },
        expires_in: {
          type: 'integer',
          description: 'Days before the signature request expires (1–365).',
        },
        reminders: {
          type: 'boolean',
          description: 'Send automatic signing reminders (day 3, 6, 10). Default: true.',
          default: true,
        },
      },
    },
  },
  {
    name: 'get_document',
    description: 'Get the current status and details of a SignWell document by its ID.',
    inputSchema: {
      type: 'object',
      required: ['document_id'],
      properties: {
        document_id: { type: 'string', description: 'The document ID returned by send_document.' },
      },
    },
  },
  {
    name: 'list_documents',
    description: 'List SignWell documents with optional filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: pending, completed, declined, expired, draft.',
        },
        search: {
          type: 'string',
          description: 'Search by document name or recipient email.',
        },
        page:     { type: 'integer', default: 1 },
        per_page: { type: 'integer', default: 25, description: 'Results per page (max 100).' },
      },
    },
  },
  {
    name: 'send_reminder',
    description: 'Send a signing reminder email for a document. Optionally target a specific recipient.',
    inputSchema: {
      type: 'object',
      required: ['document_id'],
      properties: {
        document_id: { type: 'string' },
        recipient_email: {
          type: 'string',
          description: 'Send reminder only to this email. Omit to remind all pending signers.',
        },
        message: {
          type: 'string',
          description: 'Optional custom message in the reminder.',
        },
      },
    },
  },
  {
    name: 'get_completed_pdf',
    description: `Download the signed PDF for a completed document.

Returns either a direct download URL (default) or the PDF as base64.
Use mode "url" to get a shareable link. Use mode "base64" to embed in chat.`,
    inputSchema: {
      type: 'object',
      required: ['document_id'],
      properties: {
        document_id: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['url', 'base64'],
          default: 'url',
          description: '"url" returns a download link. "base64" returns the raw PDF encoded as base64.',
        },
        include_audit_page: {
          type: 'boolean',
          default: true,
          description: 'Include the audit trail page in the PDF.',
        },
      },
    },
  },
];

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleSendDocument(args) {
  const { name, file_name, file_base64, recipients, subject, message,
          send_now = false, apply_signing_order = false, text_tags = false,
          expires_in, reminders = true } = args;

  const payload = {
    name,
    draft: true,
    files: [{ name: file_name, file_base64 }],
    recipients,
    ...(subject            && { subject }),
    ...(message            && { message }),
    ...(apply_signing_order && { apply_signing_order: true }),
    ...(text_tags          && { text_tags: true }),
    ...(expires_in         && { expires_in }),
    reminders,
  };

  const doc = await api('POST', '/documents', payload);
  const editor_url = doc.id ? `https://www.signwell.com/app/builder/${doc.id}` : undefined;

  if (send_now && doc.id) {
    await api('POST', `/documents/${doc.id}/send`, {});
    return {
      ...doc,
      editor_url,
      _status: 'sent',
      _note: 'Document sent for signing. Recipients will receive email shortly.',
    };
  }

  return {
    ...doc,
    editor_url,
    _status: 'draft',
    _note: editor_url
      ? 'Document created as draft. Review and place fields at editor_url, then send from there or call send_document again with send_now: true.'
      : 'Document created as draft.',
  };
}

async function handleGetDocument({ document_id }) {
  return api('GET', `/documents/${document_id}`);
}

async function handleListDocuments({ status, search, page = 1, per_page = 25 }) {
  const q = new URLSearchParams({ page: String(page), per_page: String(per_page) });
  if (status) q.set('status', status);
  if (search)  q.set('search', search);
  return api('GET', `/documents?${q}`);
}

async function handleSendReminder({ document_id, recipient_email, message }) {
  const body = {};
  if (recipient_email) body.recipient_email = recipient_email;
  if (message)         body.message = message;
  return api('POST', `/documents/${document_id}/remind`, body);
}

async function handleGetCompletedPdf({ document_id, mode = 'url', include_audit_page = true }) {
  if (mode === 'url') {
    const q = new URLSearchParams({ url_only: 'true', audit_page: String(include_audit_page) });
    const data = await api('GET', `/documents/${document_id}/completed_pdf?${q}`);
    return { pdf_url: data.file_url ?? data, _note: 'Open pdf_url in browser to download the signed PDF.' };
  }

  // base64 mode
  const q = new URLSearchParams({ url_only: 'false', audit_page: String(include_audit_page) });
  const buffer = await apiBuffer(`/documents/${document_id}/completed_pdf`, {
    url_only: 'false',
    audit_page: String(include_audit_page),
  });
  const b64 = Buffer.from(buffer).toString('base64');
  return {
    pdf_base64: b64,
    _note: 'Embed in chat: <iframe src="data:application/pdf;base64,{pdf_base64}" width="100%" height="600px"></iframe>',
  };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'signwell-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    let result;
    switch (name) {
      case 'send_document':       result = await handleSendDocument(args);           break;
      case 'get_document':        result = await handleGetDocument(args);            break;
      case 'list_documents':      result = await handleListDocuments(args);          break;
      case 'send_reminder':       result = await handleSendReminder(args);           break;
      case 'get_completed_pdf':   result = await handleGetCompletedPdf(args);        break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[signwell-mcp] Ready\n');
