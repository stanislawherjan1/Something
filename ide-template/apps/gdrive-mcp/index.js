/**
 * Google Drive MCP Server
 *
 * Reuses Google Docs OAuth (catalog `credentialsFrom: "gdocs"`). Refresh
 * token must include `https://www.googleapis.com/auth/drive` scope (already
 * part of the standard gdocs setup; no extra step needed).
 *
 * Env vars (set by workspace-api at spawn time):
 *   GDOCS_CLIENT_ID
 *   GDOCS_CLIENT_SECRET
 *   GDOCS_REFRESH_TOKEN
 *   GWORKSPACE_ALLOW_WRITE  — gates upload_file / move_file / share_file /
 *                              trash_file / reply_comment / resolve_comment /
 *                              delete_comment. Reads + downloads are always allowed.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   search_files          — Drive `q` syntax, returns id/name/mime/modified/parents
 *   list_recent           — most-recently-modified files, any mime
 *   get_file_metadata     — single file resource with full fields
 *   download_file         — bytes for non-Google-native files (saved to /tmp)
 *   export_doc_file       — Google-native files (Docs/Sheets/Slides) → PDF/DOCX/etc
 *   upload_file           — multipart upload of a local file to Drive
 *   move_file             — change parents (reads current first to remove cleanly)
 *   share_file            — grant a permission (user/group/domain/anyone)
 *   trash_file            — soft delete (recoverable for ~30 days)
 *   list_comments         — all comments on a file (id, quoted_text, replies, resolved)
 *   reply_comment         — post a reply to a comment thread
 *   resolve_comment       — mark a comment thread resolved (UI "Resolve")
 *   delete_comment        — delete a comment thread (destructive)
 *
 * Comment anchoring note: adding a comment anchored to a specific text RANGE
 * is the one comment op the Drive API can't do — that lives in the separate
 * `docs-comments` (Playwright) MCP. Everything else about a comment's lifecycle
 * (list/reply/resolve/delete) is done here over the API. See
 * skills/optional/docs-comments/SKILL.md.
 * ─────────────────────────────────────────────
 *
 * Key gotcha: download_file vs export_doc_file. Native Google files
 * (mimeType starting with `application/vnd.google-apps.`, except `folder`
 * and `shortcut`) refuse `?alt=media` and need explicit export. The
 * download_file tool detects this and returns an error pointing to
 * export_doc_file rather than silently failing.
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
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
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

const FILE_FIELDS =
  'id,name,mimeType,modifiedTime,createdTime,parents,owners(emailAddress,displayName),' +
  'webViewLink,webContentLink,size,iconLink,trashed,capabilities';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gdrive-mcp] Missing OAuth config. Activate Google Workspace first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Drive write access is disabled in this workspace. ' +
      'Open Integrations → Google Workspace → Settings (gear) and set ' +
      '"Allow bot to modify your Google Workspace data" to Yes.',
    );
  }
}

function isGoogleNative(mime) {
  return typeof mime === 'string'
    && mime.startsWith('application/vnd.google-apps.')
    && !mime.endsWith('.folder')
    && !mime.endsWith('.shortcut');
}

function compactFile(f) {
  if (!f) return null;
  return {
    id:           f.id,
    name:         f.name,
    mime_type:    f.mimeType,
    modified_at:  f.modifiedTime,
    created_at:   f.createdTime,
    parents:      f.parents,
    owner:        f.owners?.[0]?.emailAddress,
    url:          f.webViewLink,
    download_url: f.webContentLink,
    size:         f.size ? Number(f.size) : undefined,
    trashed:      f.trashed,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_files',
    description:
      'Search Drive with the API\'s native query syntax. Common patterns:\n' +
      '  - `name contains "report"` — name match\n' +
      '  - `mimeType = "application/pdf"` — by mime\n' +
      '  - `"<folderId>" in parents` — files in a folder\n' +
      '  - `modifiedTime > "2026-05-01T00:00:00"` — recent\n' +
      '  - combine with `and` / `or` / `not`\n' +
      '`trashed = false` is auto-appended to keep results clean. Returns id, name, mime, modified, parents, owner, url.',
    inputSchema: {
      type: 'object',
      properties: {
        q:     { type: 'string', description: 'Drive query expression. Omitted → most-recent across the whole drive.' },
        limit: { type: 'number', default: 50, description: 'Max results (max 1000).' },
      },
    },
  },
  {
    name: 'list_recent',
    description: 'List the user\'s most recently modified files, any type. Excludes trashed by default. Returns id, name, mime, modified, parents.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 25, description: 'Max files (max 1000).' },
      },
    },
  },
  {
    name: 'get_file_metadata',
    description: 'Fetch a file\'s metadata: id, name, mime, size, parents, modified, owner, url, capabilities.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: { type: 'string' },
      },
    },
  },
  {
    name: 'download_file',
    description:
      'Download a non-Google-native file (PDF, image, zip, etc.) to a temp path. Returns the local path + size + mime. ' +
      'For Google-native files (Docs/Sheets/Slides), use export_doc_file instead — this tool will refuse them.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: { type: 'string' },
      },
    },
  },
  {
    name: 'export_doc_file',
    description:
      'Export a Google-native file to a downloadable format. Common targets:\n' +
      '  - Docs:   application/pdf | text/plain | text/markdown |\n' +
      '            application/vnd.openxmlformats-officedocument.wordprocessingml.document\n' +
      '  - Sheets: application/pdf | text/csv (first tab only) |\n' +
      '            application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\n' +
      '  - Slides: application/pdf | text/plain |\n' +
      '            application/vnd.openxmlformats-officedocument.presentationml.presentation\n' +
      'Returns the local temp path. 10 MB cap (Drive limit).',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'mime_type'],
      properties: {
        file_id:   { type: 'string' },
        mime_type: { type: 'string', description: 'Target MIME type for the export.' },
      },
    },
  },
  {
    name: 'export_doc_revision',
    description:
      'Export a specific historical revision of a Google-native file to a downloadable format. ' +
      'Same mime_type options as export_doc_file. Revision IDs come from list_doc_revisions. ' +
      'Drive prunes revision-level export bytes after ~30 days unless keep_forever was set on ' +
      'the revision; in that case this tool returns an explicit "revision may be too old" error.',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'revision_id', 'mime_type'],
      properties: {
        file_id:     { type: 'string' },
        revision_id: { type: 'string', description: 'Revision ID from list_doc_revisions.' },
        mime_type:   { type: 'string', description: 'Target MIME type. Typical: application/vnd.openxmlformats-officedocument.wordprocessingml.document (DOCX).' },
      },
    },
  },
  {
    name: 'upload_file',
    description:
      'Upload a local file to Drive (multipart). Reads from `local_path`, sets metadata.name = `name` (default basename of local_path), ' +
      'optionally places under `parent_id` (default Drive root). Returns the created file resource. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['local_path'],
      properties: {
        local_path: { type: 'string', description: 'Absolute path on the bot\'s filesystem (e.g. /tmp/...).' },
        name:       { type: 'string', description: 'File name in Drive. Default: basename of local_path.' },
        parent_id:  { type: 'string', description: 'Drive folder ID. Omit to upload to "My Drive" root.' },
        mime_type:  { type: 'string', description: 'MIME type. Default: inferred from extension or application/octet-stream.' },
      },
    },
  },
  {
    name: 'move_file',
    description:
      'Move a file to a different folder. Reads its current parents, removes them, and adds the new one. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'new_parent_id'],
      properties: {
        file_id:       { type: 'string' },
        new_parent_id: { type: 'string', description: 'Destination folder id.' },
      },
    },
  },
  {
    name: 'share_file',
    description:
      'Grant a permission on a file. Default: writer access for the given email, no notification email sent. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'email'],
      properties: {
        file_id: { type: 'string' },
        email:   { type: 'string', description: 'Recipient email address.' },
        role: {
          type: 'string',
          enum: ['reader', 'commenter', 'writer'],
          default: 'writer',
        },
        send_notification: {
          type: 'boolean',
          default: false,
          description: 'Email the recipient. Default false to keep shares quiet.',
        },
      },
    },
  },
  {
    name: 'trash_file',
    description:
      'Move a file to Trash. Recoverable from Drive\'s trash for ~30 days. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: { type: 'string' },
      },
    },
  },
  {
    name: 'list_comments',
    description:
      'List all comments on a Drive file (typically a Google Doc). Returns ' +
      'author display name, the comment content, the anchored text fragment ' +
      '(quoted_text — what was highlighted in the doc when the comment was ' +
      'added), creation/modification timestamps, resolved/deleted status, and ' +
      'reply count. Read-only. Use this to pull review comments from a doc ' +
      'in one shot rather than scraping the UI. By default includes deleted/' +
      'resolved comments so you see the full history; set include_deleted=false ' +
      'to skip them.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: {
          type:        'string',
          description: 'Drive file ID (e.g. the long id from a docs.google.com URL).',
        },
        include_deleted: {
          type:        'boolean',
          description: 'Include comments marked deleted by their author. Default true.',
        },
        page_size: {
          type:        'integer',
          description: 'Max comments to return per page (Drive API caps at 100). Default 100.',
        },
      },
    },
  },
  {
    name: 'reply_comment',
    description:
      'Post a reply to an existing comment thread on a Drive file (Google Doc). ' +
      'Get comment_id from list_comments first. Requires write access. Returns the ' +
      "created reply's id. If the file or comment doesn't exist, returns " +
      '{ ok:false, reason:"not_found" } rather than erroring.',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'comment_id', 'text'],
      properties: {
        file_id:    { type: 'string', description: 'Drive file ID.' },
        comment_id: { type: 'string', description: 'The comment thread to reply to (from list_comments).' },
        text:       { type: 'string', description: 'The reply body. Plain text.' },
      },
    },
  },
  {
    name: 'resolve_comment',
    description:
      'Mark a comment thread resolved on a Drive file — it leaves the open-comments ' +
      'list (same as the Docs UI "Resolve" button). Optionally include a closing ' +
      'reply. Get comment_id from list_comments first. Requires write access. ' +
      'Returns { ok:false, reason:"not_found" } if the file/comment is gone.',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'comment_id'],
      properties: {
        file_id:    { type: 'string', description: 'Drive file ID.' },
        comment_id: { type: 'string', description: 'The comment thread to resolve (from list_comments).' },
        text:       { type: 'string', description: 'Optional closing reply posted alongside the resolution.' },
      },
    },
  },
  {
    name: 'delete_comment',
    description:
      'Delete a comment thread from a Drive file. Destructive and not recoverable ' +
      'through this tool — prefer resolve_comment unless you really mean to remove it. ' +
      'Requires write access. Returns { ok:false, reason:"not_found" } if already gone.',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'comment_id'],
      properties: {
        file_id:    { type: 'string', description: 'Drive file ID.' },
        comment_id: { type: 'string', description: 'The comment thread to delete (from list_comments).' },
      },
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function tmpPath(name) {
  const dir = join(tmpdir(), 'gdrive-mcp');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomBytes(6).toString('hex')}-${name}`);
}

const EXT_TO_MIME = {
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.csv':  'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip':  'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function inferMime(name, fallback) {
  return EXT_TO_MIME[extname(name).toLowerCase()] || fallback || 'application/octet-stream';
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleSearchFiles({ q, limit = 50 } = {}) {
  // Always exclude trashed unless the caller explicitly opts in via their query.
  const query = q && /trashed\s*=/.test(q) ? q : (q ? `(${q}) and trashed=false` : 'trashed=false');
  const data = await api.get(`${DRIVE_BASE}/files`, {
    query: {
      q: query,
      pageSize: Math.min(Number(limit) || 50, 1000),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'modifiedTime desc',
      supportsAllDrives:           'true',
      includeItemsFromAllDrives:   'true',
    },
  });
  return (data.files || []).map(compactFile);
}

async function handleListRecent({ limit = 25 } = {}) {
  return handleSearchFiles({ q: 'trashed=false', limit });
}

async function handleGetFileMetadata({ file_id }) {
  const f = await api.get(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`, {
    query: { fields: FILE_FIELDS, supportsAllDrives: 'true' },
  });
  return compactFile(f);
}

async function handleDownloadFile({ file_id }) {
  // Look up the file first so we can refuse Google-native types with a
  // clear message, and so the local filename matches the Drive name.
  const meta = await api.get(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`, {
    query: { fields: 'id,name,mimeType,size', supportsAllDrives: 'true' },
  });
  if (isGoogleNative(meta.mimeType)) {
    throw new Error(
      `"${meta.name}" is a Google-native file (${meta.mimeType}). ` +
      `Use export_doc_file with a target mime_type like application/pdf instead.`,
    );
  }
  const buf = await api.getRaw(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`, {
    query: { alt: 'media', supportsAllDrives: 'true' },
  });
  const path = tmpPath(meta.name);
  writeFileSync(path, buf);
  return {
    file_id,
    name:      meta.name,
    mime_type: meta.mimeType,
    size:      buf.length,
    local_path: path,
  };
}

async function handleExportDocFile({ file_id, mime_type }) {
  const meta = await api.get(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`, {
    query: { fields: 'id,name,mimeType', supportsAllDrives: 'true' },
  });
  if (!isGoogleNative(meta.mimeType)) {
    throw new Error(
      `"${meta.name}" is not a Google-native file (it's ${meta.mimeType}). ` +
      `Use download_file instead.`,
    );
  }
  const buf = await api.getRaw(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/export`, {
    query: { mimeType: mime_type },
  });
  const ext = mime_type === 'application/pdf' ? '.pdf'
    : mime_type === 'text/csv' ? '.csv'
    : mime_type === 'text/plain' ? '.txt'
    : mime_type === 'text/markdown' ? '.md'
    : mime_type.endsWith('wordprocessingml.document') ? '.docx'
    : mime_type.endsWith('spreadsheetml.sheet') ? '.xlsx'
    : mime_type.endsWith('presentationml.presentation') ? '.pptx'
    : '';
  const path = tmpPath(meta.name + ext);
  writeFileSync(path, buf);
  return {
    file_id,
    name:        meta.name,
    source_mime: meta.mimeType,
    target_mime: mime_type,
    size:        buf.length,
    local_path:  path,
  };
}

async function handleExportDocRevision({ file_id, revision_id, mime_type }) {
  if (!file_id)     throw new Error('file_id is required');
  if (!revision_id) throw new Error('revision_id is required');
  if (!mime_type)   throw new Error('mime_type is required');

  const meta = await api.get(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`, {
    query: { fields: 'id,name,mimeType', supportsAllDrives: 'true' },
  });
  if (!isGoogleNative(meta.mimeType)) {
    throw new Error(
      `"${meta.name}" is not a Google-native file (it's ${meta.mimeType}). ` +
      `Revision exports are only available for Docs/Sheets/Slides.`,
    );
  }

  let revision;
  try {
    revision = await api.get(
      `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/revisions/${encodeURIComponent(revision_id)}`,
      { query: { fields: 'id,modifiedTime,keepForever,exportLinks' } },
    );
  } catch (err) {
    if (/→\s*404/.test(err.message)) {
      throw new Error(
        `Revision ${revision_id} not found for file ${file_id}. ` +
        `It may have been pruned (Drive keeps revisions ~30 days unless keep_forever=true), ` +
        `or the ID is wrong. Use list_doc_revisions to enumerate available revisions.`,
      );
    }
    throw err;
  }

  const exportLinks = revision.exportLinks || {};
  const url = exportLinks[mime_type];
  if (!url) {
    const available = Object.keys(exportLinks);
    if (available.length === 0) {
      throw new Error(
        `Revision ${revision_id} has no export links — revision may be too old ` +
        `(Drive prunes per-revision export bytes after ~30 days unless keep_forever=true). ` +
        `keep_forever on this revision: ${revision.keepForever ? 'true' : 'false'}.`,
      );
    }
    throw new Error(
      `Revision ${revision_id} cannot be exported to ${mime_type}. ` +
      `Available export formats for this revision: ${available.join(', ')}.`,
    );
  }

  const buf = await api.getRaw(url);
  const ext = mime_type === 'application/pdf' ? '.pdf'
    : mime_type === 'text/csv' ? '.csv'
    : mime_type === 'text/plain' ? '.txt'
    : mime_type === 'text/markdown' ? '.md'
    : mime_type.endsWith('wordprocessingml.document') ? '.docx'
    : mime_type.endsWith('spreadsheetml.sheet') ? '.xlsx'
    : mime_type.endsWith('presentationml.presentation') ? '.pptx'
    : '';
  // r-suffix in the filename keeps side-by-side exports of multiple revisions
  // of the same doc distinguishable on disk (the canonical reviewer use case).
  const path = tmpPath(`${meta.name}.r${revision_id.slice(0, 8)}${ext}`);
  writeFileSync(path, buf);

  return {
    file_id,
    revision_id,
    name:                  meta.name,
    source_mime:           meta.mimeType,
    target_mime:           mime_type,
    revision_modified_at:  revision.modifiedTime || null,
    keep_forever:          !!revision.keepForever,
    size:                  buf.length,
    local_path:            path,
  };
}

async function handleUploadFile({ local_path, name, parent_id, mime_type }) {
  requireWrite();
  let st;
  try { st = statSync(local_path); }
  catch (err) { throw new Error(`Cannot read ${local_path}: ${err.message}`); }
  if (!st.isFile()) throw new Error(`${local_path} is not a regular file.`);

  const fileBytes = readFileSync(local_path);
  const finalName = name || basename(local_path);
  const finalMime = mime_type || inferMime(finalName);

  // Multipart/related body — metadata JSON part + media bytes part. The
  // boundary string in the header must match the `--BOUNDARY` separators;
  // the final boundary closes with `--`. Random suffix avoids any
  // collision with the file's own bytes.
  const boundary = `==boundary_${randomBytes(8).toString('hex')}==`;
  const metadata = { name: finalName };
  if (parent_id) metadata.parents = [parent_id];

  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${finalMime}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([head, fileBytes, tail]);

  const created = await api.post(
    `${UPLOAD_BASE}/files`,
    body,
    {
      query: { uploadType: 'multipart', supportsAllDrives: 'true', fields: FILE_FIELDS },
      headers: {
        'Content-Type':   `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
    },
  );
  return compactFile(created);
}

async function handleMoveFile({ file_id, new_parent_id }) {
  requireWrite();
  const current = await api.get(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`, {
    query: { fields: 'parents', supportsAllDrives: 'true' },
  });
  const oldParents = (current.parents || []).join(',');
  const updated = await api.patch(
    `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`,
    {},
    {
      query: {
        addParents:    new_parent_id,
        removeParents: oldParents,
        supportsAllDrives: 'true',
        fields: FILE_FIELDS,
      },
    },
  );
  return compactFile(updated);
}

async function handleShareFile({ file_id, email, role = 'writer', send_notification = false }) {
  requireWrite();
  const data = await api.post(
    `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/permissions`,
    { type: 'user', role, emailAddress: email },
    {
      query: {
        sendNotificationEmail: send_notification ? 'true' : 'false',
        supportsAllDrives: 'true',
      },
    },
  );
  return {
    file_id,
    permission_id: data.id,
    role:          data.role,
    email,
  };
}

async function handleTrashFile({ file_id }) {
  requireWrite();
  const updated = await api.patch(
    `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}`,
    { trashed: true },
    { query: { supportsAllDrives: 'true', fields: 'id,name,trashed' } },
  );
  return compactFile(updated);
}

// Compact shape for one Drive Comment resource. Drops envelope fields the
// caller never needs (kind, htmlContent — markdown content is sufficient),
// hoists author.displayName into a flat author string, and surfaces
// quotedFileContent.value as `quoted_text` so the agent doesn't have to
// hunt for the highlighted fragment.
function compactComment(c) {
  return {
    id:             c.id,
    author:         c.author?.displayName || null,
    author_is_me:   !!c.author?.me,
    content:        c.content || null,
    quoted_text:    c.quotedFileContent?.value || null,
    anchor:         c.anchor || null,
    created_time:   c.createdTime || null,
    modified_time:  c.modifiedTime || null,
    resolved:       !!c.resolved,
    deleted:        !!c.deleted,
    reply_count:    Array.isArray(c.replies) ? c.replies.length : 0,
    replies:        Array.isArray(c.replies) ? c.replies.map(r => ({
      id:            r.id,
      author:        r.author?.displayName || null,
      author_is_me:  !!r.author?.me,
      content:       r.content || null,
      created_time:  r.createdTime || null,
      modified_time: r.modifiedTime || null,
      action:        r.action || null,   // 'resolve' | 'reopen' | null
      deleted:       !!r.deleted,
    })) : [],
  };
}

async function handleListComments({ file_id, include_deleted = true, page_size = 100 } = {}) {
  if (!file_id) throw new Error('file_id is required');
  // Drive Comments API caps pageSize at 100; we paginate on top of that
  // so an unbounded doc still returns everything in one MCP call.
  const all = [];
  let pageToken = null;
  do {
    const query = {
      // Drive API field masks need EXPLICIT nested-object expansion —
      // `fields=*` only returns top-level fields with default expansion,
      // and `quotedFileContent.value` (the highlighted-text snapshot)
      // is NOT in the default set. Listing the nested path makes Drive
      // serialise it; without it we silently get null even when the
      // comment WAS anchored to text.
      fields:          'nextPageToken,comments(id,kind,anchor,content,htmlContent,createdTime,modifiedTime,resolved,deleted,author(displayName,me,emailAddress),quotedFileContent(mimeType,value),replies(id,kind,action,content,createdTime,modifiedTime,deleted,author(displayName,me,emailAddress)))',
      pageSize:        String(Math.min(Math.max(Number(page_size) || 100, 1), 100)),
      includeDeleted:  include_deleted ? 'true' : 'false',
    };
    if (pageToken) query.pageToken = pageToken;
    const data = await api.get(
      `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/comments`,
      { query },
    );
    for (const c of (data.comments || [])) all.push(compactComment(c));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return { file_id, total: all.length, comments: all };
}

// `fields` is REQUIRED on Drive replies endpoints — omitting it returns a 400
// "The 'fields' parameter is required for this method."
const REPLY_FIELDS = 'id,content,createdTime,modifiedTime,action,author(displayName,me)';

// Drive returns 404 for both an unknown file and an unknown comment. Callers
// want a graceful { ok:false, reason:'not_found' } instead of a thrown error;
// any other failure rethrows. (createGoogleApiClient attaches err.status.)
async function notFoundSafe(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status === 404) return { ok: false, reason: 'not_found' };
    throw err;
  }
}

async function handleReplyComment({ file_id, comment_id, text } = {}) {
  if (!file_id)    throw new Error('file_id is required');
  if (!comment_id) throw new Error('comment_id is required');
  if (typeof text !== 'string' || !text.trim()) throw new Error('text (reply body) is required');
  requireWrite();
  return notFoundSafe(async () => {
    const reply = await api.post(
      `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/comments/${encodeURIComponent(comment_id)}/replies`,
      { content: text },
      { query: { fields: REPLY_FIELDS } },
    );
    return { ok: true, file_id, comment_id, reply_id: reply?.id || null };
  });
}

async function handleResolveComment({ file_id, comment_id, text } = {}) {
  if (!file_id)    throw new Error('file_id is required');
  if (!comment_id) throw new Error('comment_id is required');
  requireWrite();
  // You can't PATCH a comment's `resolved` flag directly (read-only) — you
  // resolve by posting a reply with action:'resolve'. An optional closing
  // message rides along as the reply content.
  const body = { action: 'resolve' };
  if (typeof text === 'string' && text.trim()) body.content = text;
  return notFoundSafe(async () => {
    const reply = await api.post(
      `${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/comments/${encodeURIComponent(comment_id)}/replies`,
      body,
      { query: { fields: REPLY_FIELDS } },
    );
    return { ok: true, file_id, comment_id, resolved: true, reply_id: reply?.id || null };
  });
}

async function handleDeleteComment({ file_id, comment_id } = {}) {
  if (!file_id)    throw new Error('file_id is required');
  if (!comment_id) throw new Error('comment_id is required');
  requireWrite();
  return notFoundSafe(async () => {
    // 204 No Content on success.
    await api.delete(`${DRIVE_BASE}/files/${encodeURIComponent(file_id)}/comments/${encodeURIComponent(comment_id)}`);
    return { ok: true, file_id, comment_id, deleted: true };
  });
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gdrive-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'search_files':       result = await handleSearchFiles(args || {});  break;
      case 'list_recent':        result = await handleListRecent(args || {});   break;
      case 'get_file_metadata':  result = await handleGetFileMetadata(args);    break;
      case 'download_file':      result = await handleDownloadFile(args);       break;
      case 'export_doc_file':    result = await handleExportDocFile(args);      break;
      case 'export_doc_revision': result = await handleExportDocRevision(args); break;
      case 'upload_file':        result = await handleUploadFile(args);         break;
      case 'move_file':          result = await handleMoveFile(args);           break;
      case 'share_file':         result = await handleShareFile(args);          break;
      case 'trash_file':         result = await handleTrashFile(args);          break;
      case 'list_comments':      result = await handleListComments(args);       break;
      case 'reply_comment':      result = await handleReplyComment(args);        break;
      case 'resolve_comment':    result = await handleResolveComment(args);      break;
      case 'delete_comment':     result = await handleDeleteComment(args);       break;
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
process.stderr.write('[gdrive-mcp] Ready\n');
