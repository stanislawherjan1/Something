/**
 * Email MCP Server — read-only multi-account IMAP.
 *
 * Supports Gmail (App Password) and any custom IMAP host. One process serves
 * all configured accounts; account routing is per-tool via the `account` arg.
 * `account: "*"` fans out across every account (parallel) and merges results.
 *
 * Hard read-only by exposure — no send/delete/move/flag tools exist. The bot
 * runs with --dangerously-skip-permissions, so every tool we expose runs
 * without confirmation. We never expose anything that mutates the mailbox.
 *
 * Config file (env: EMAIL_ACCOUNTS_FILE, default /home/coder/.email/accounts.json):
 *   [
 *     {"id":"press","label":"Press / PR","host":"imap.gmail.com","port":993,
 *      "user":"press@example.com","pass":"xxxx-xxxx-xxxx-xxxx"},
 *     {"id":"info", "label":"General",  "host":"imap.gmail.com","port":993,
 *      "user":"info@example.com", "pass":"yyyy-yyyy-yyyy-yyyy"}
 *   ]
 *
 * Connections are lazy: opened on first use, closed after IDLE_TIMEOUT_MS of
 * inactivity. Errors invalidate the cached client so the next call reconnects.
 *
 * Attachments are fetched lazily into /tmp/email-mcp/ — no persistent cache.
 * Each plugin start clears stale entries (>1h old).
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_accounts         — list configured accounts + their folders
 *   list_recent           — recent messages with metadata + 200-char snippet
 *   search                — Gmail-syntax (X-GM-RAW) or simple field search
 *   read_message          — full message: headers, body_text, body_html, attachment metadata
 *   download_attachment   — fetch one attachment to /tmp, return path
 * ─────────────────────────────────────────────
 */

import { Server }                                      from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }                         from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ImapFlow }                                     from 'imapflow';
import { simpleParser }                                 from 'mailparser';
import nodemailer                                        from 'nodemailer';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, appendFileSync } from 'fs';
import { join, resolve, basename }                      from 'path';
import { loadCredentials } from '../_shared/broker-client.js';
import { wrapUntrusted }   from '../_shared/wrap-untrusted.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const ACCOUNTS_FILE  = process.env.EMAIL_ACCOUNTS_FILE ?? '/home/coder/.email/accounts.json';
const TMP_DIR        = '/tmp/email-mcp';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min — close idle IMAP connections
const TMP_TTL_MS      = 60 * 60 * 1000;      // 1 h  — cleanup stale /tmp entries on boot

let accounts;
try {
  accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('accounts.json must be a non-empty array');
  }
  for (const a of accounts) {
    for (const k of ['id', 'host', 'port', 'user', 'pass']) {
      if (!a[k]) throw new Error(`account ${a.id ?? '<unknown>'}: missing field "${k}"`);
    }
  }
} catch (err) {
  console.error(`[email-mcp] Config error (${ACCOUNTS_FILE}): ${err.message}`);
  process.exit(1);
}

const accountsById = new Map(accounts.map(a => [a.id, a]));

// Cleanup stale /tmp entries (don't carry attachments across container restarts)
mkdirSync(TMP_DIR, { recursive: true });
try {
  const now = Date.now();
  for (const entry of readdirSync(TMP_DIR)) {
    const p = join(TMP_DIR, entry);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > TMP_TTL_MS) rmSync(p, { recursive: true, force: true });
    } catch {}
  }
} catch {}

// ─── Proxy routing ─────────────────────────────────────────────────────────
//
// Post-egress-pivot (2026-05-12), code-server lives on `bot-net` with
// `internal: true` — no direct route to the internet. Every outbound
// connection must go through the egress-proxy sidecar via HTTP CONNECT.
//
// Node fetch is taken care of in apps/_shared/broker-client.js (undici
// ProxyAgent set as global dispatcher). But IMAP (imapflow) and SMTP
// (nodemailer) both use raw `net.createConnection` under the hood, which
// bypasses undici entirely. Without explicit proxy config they dial
// imap.gmail.com:993 / smtp.gmail.com:587 directly and the kernel drops
// the packet at the bot-net bridge.
//
// Both libraries honour a `proxy: 'http://host:port'` URL and do the
// CONNECT handshake themselves. We resolve once at module load — if
// HTTPS_PROXY is unset (dev mode, or future architecture change) the
// proxy field is undefined and the libraries dial direct as before.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;

// ─── Connection pool ───────────────────────────────────────────────────────

/** Map<accountId, { client: ImapFlow, idleTimer: Timeout, openedAt: number }> */
const pool = new Map();

async function getClient(accountId) {
  const account = accountsById.get(accountId);
  if (!account) throw new Error(`unknown account: "${accountId}"`);

  const existing = pool.get(accountId);
  if (existing && existing.client.usable) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => closeClient(accountId), IDLE_TIMEOUT_MS);
    return existing.client;
  }
  if (existing) await closeClient(accountId);

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.port === 993 || account.tls === true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    proxy: PROXY_URL || undefined,
    // imapflow auto-reconnects internally, but we treat any error as terminal
    // for this client and recreate fresh on the next call.
  });

  client.on('error', (err) => {
    process.stderr.write(`[email-mcp] ${accountId}: ${err.message}\n`);
    closeClient(accountId).catch(() => {});
  });

  await client.connect();
  const idleTimer = setTimeout(() => closeClient(accountId), IDLE_TIMEOUT_MS);
  pool.set(accountId, { client, idleTimer, openedAt: Date.now() });
  return client;
}

// ─── SMTP transport pool ───────────────────────────────────────────────────
//
// Each account's IMAP credentials work for SMTP too (Gmail / Zoho / Microsoft
// 365 use a single app password across protocols). We auto-derive the SMTP
// host from the IMAP host (s/imap/smtp/) when the account doesn't declare
// `smtp_host` explicitly. Port defaults: 587 STARTTLS, 465 SSL.

const smtpPool = new Map();

function deriveSmtpConfig(account) {
  const host = account.smtp_host
    || (account.host?.startsWith('imap.') ? account.host.replace(/^imap\./, 'smtp.') : account.host);
  const port = account.smtp_port || 587;
  const secure = port === 465;
  return { host, port, secure };
}

function getSmtp(accountId) {
  const account = accountsById.get(accountId);
  if (!account) throw new Error(`unknown account: "${accountId}"`);
  if (smtpPool.has(accountId)) return smtpPool.get(accountId);
  const cfg = deriveSmtpConfig(account);
  const transporter = nodemailer.createTransport({
    host:    cfg.host,
    port:    cfg.port,
    secure:  cfg.secure,
    auth:    { user: account.user, pass: account.pass },
    requireTLS: !cfg.secure,
    proxy:   PROXY_URL || undefined,
  });
  smtpPool.set(accountId, transporter);
  return transporter;
}

// ─── Write audit log ───────────────────────────────────────────────────────
//
// Append-only JSONL of every write the MCP performs (send, reply, forward,
// move, archive, delete, mark). Lives in the project so the user has a
// durable receipt of what the bot did on their behalf. Skipping writes is
// preferable to losing the log — append errors are warned but never throw.

const AUDIT_FILE = process.env.EMAIL_AUDIT_FILE
  ?? '/home/coder/project/.email-audit.jsonl';

function audit(action, account, payload) {
  try {
    mkdirSync(join(AUDIT_FILE, '..'), { recursive: true });
    const line = JSON.stringify({
      ts:      new Date().toISOString(),
      action,
      account,
      ...payload,
    }) + '\n';
    appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[email-mcp] audit append failed: ${err.message}\n`);
  }
}

async function closeClient(accountId) {
  const entry = pool.get(accountId);
  if (!entry) return;
  pool.delete(accountId);
  clearTimeout(entry.idleTimer);
  try { await entry.client.logout(); } catch {}
}

// Map common folder aliases to RFC 6154 SPECIAL-USE flags. Lets the bot say
// `folder: "sent"` without knowing the server's actual name — Gmail localizes
// it ([Gmail]/Sent Mail vs [Gmail]/Wysłane), Zoho uses "Sent", custom IMAP
// varies. We list folders, pick the one with the matching specialUse flag.
const FOLDER_ALIASES = new Map([
  ['inbox',     '\\Inbox'],
  ['sent',      '\\Sent'],
  ['drafts',    '\\Drafts'],
  ['trash',     '\\Trash'],
  ['junk',      '\\Junk'],
  ['spam',      '\\Junk'],
  ['archive',   '\\Archive'],
  ['all',       '\\All'],
  ['important', '\\Important'],
  ['flagged',   '\\Flagged'],
  ['starred',   '\\Flagged'],
]);

async function resolveFolder(client, folder) {
  if (!folder) return 'INBOX';
  const lower = folder.toLowerCase();
  // INBOX is always exactly "INBOX" per RFC 3501 — no LIST roundtrip needed.
  if (lower === 'inbox') return 'INBOX';
  const flag = FOLDER_ALIASES.get(lower);
  if (!flag) return folder;  // Not an alias — pass server-native name through verbatim.
  const list = await client.list();
  const match = list.find(f => f.specialUse === flag && !f.flags?.has('\\Noselect'));
  // Fallback: if the server doesn't advertise SPECIAL-USE, pass through and let
  // the IMAP server reject it — the error surfaces back to the bot unchanged.
  return match?.path ?? folder;
}

async function withMailbox(client, folder, fn) {
  const resolved = await resolveFolder(client, folder);
  const lock = await client.getMailboxLock(resolved);
  try { return await fn(resolved); } finally { lock.release(); }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function snippet(text, len = 200) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, len);
}

function formatAddress(addr) {
  if (!addr) return null;
  if (Array.isArray(addr)) return addr.map(formatAddress).filter(Boolean);
  if (typeof addr === 'string') return addr;
  if (addr.address) {
    return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
  }
  return null;
}

function envelopeAddresses(env, key) {
  const arr = env?.[key];
  if (!Array.isArray(arr)) return [];
  return arr.map(a => a.name ? `${a.name} <${a.address}>` : a.address).filter(Boolean);
}

function isGmail(account) {
  return account.host === 'imap.gmail.com';
}

/**
 * Build IMAP search criteria.
 *
 * For Gmail (host=imap.gmail.com): pass `query` to X-GM-RAW (Gmail search
 * syntax — "from:bob has:attachment after:2026/01/01"). This is the most
 * powerful path and what users intuitively expect.
 *
 * For other IMAP servers: parse a small subset of "field:value" pairs into
 * native IMAP SEARCH criteria. Anything not recognized falls back to BODY.
 */
function buildSearchCriteria(account, query, since) {
  if (isGmail(account) && query) {
    const criteria = { gmraw: query };
    if (since) criteria.since = new Date(since);
    return criteria;
  }

  const criteria = {};
  if (since) criteria.since = new Date(since);
  if (!query) return criteria;

  // Naive parser: split on whitespace, recognize key:value tokens, bag the rest
  const tokens = query.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const free = [];
  for (const tok of tokens) {
    const m = tok.match(/^(from|to|cc|subject|body):(.+)$/i);
    if (!m) { free.push(tok.replace(/^["']|["']$/g, '')); continue; }
    const [, field, value] = m;
    const v = value.replace(/^["']|["']$/g, '');
    const k = field.toLowerCase();
    criteria[k === 'body' ? 'body' : k] = v;
  }
  if (free.length) criteria.body = (criteria.body ? criteria.body + ' ' : '') + free.join(' ');
  return criteria;
}

// Format one message's metadata + snippet for list/search results.
function shapeMessageRow(account, folder, msg) {
  const env = msg.envelope ?? {};
  let preview = '';
  try {
    // bodyParts keys are uppercased per imapflow docs
    const part = msg.bodyParts?.get?.('TEXT');
    if (part) preview = snippet(part.toString('utf8'), 200);
  } catch {}

  // Wrap the body snippet in <untrusted-content> like read_message does
  // — even 200 chars is enough room for a prompt-injection prologue, so
  // the agent must treat the preview as data. Metadata (subject,
  // addresses, dates) stays raw.
  const dateIso = env.date ? new Date(env.date).toISOString() : null;
  const wrapSource = `email:${env.messageId || `${account.id}/${msg.uid}`}`;
  const wrappedSnippet = preview
    ? wrapUntrusted(preview, { source: wrapSource, absorbedAt: dateIso || undefined })
    : '';

  return {
    account: account.id,
    folder,
    uid: msg.uid,
    seq: msg.seq,
    date: dateIso,
    subject: env.subject ?? '',
    from: envelopeAddresses(env, 'from')[0] ?? null,
    to: envelopeAddresses(env, 'to'),
    cc: envelopeAddresses(env, 'cc'),
    snippet: wrappedSnippet,
    has_attachments: bodyStructureHasAttachments(msg.bodyStructure),
    labels: msg.labels ? [...msg.labels] : undefined,
    thread_id: msg.threadId ?? undefined,
  };
}

// imapflow's `node.type` is the full Content-Type string ("text/plain",
// "multipart/mixed", "image/png"). There's no separate `subtype` field.
function isAttachmentNode(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  // Fall-through heuristic from the imapflow docs: any non-text, non-multipart
  // node with no explicit disposition is treated as an attachment.
  const top = (node.type ?? '').split('/')[0];
  if (node.dispositionParameters?.filename || node.parameters?.name) return true;
  return Boolean(node.type && top !== 'text' && top !== 'multipart' && !node.disposition);
}

function bodyStructureHasAttachments(bs) {
  if (!bs) return false;
  if (isAttachmentNode(bs)) return true;
  if (Array.isArray(bs.childNodes)) return bs.childNodes.some(bodyStructureHasAttachments);
  return false;
}

// Walk BODYSTRUCTURE and emit attachment descriptors. imapflow assigns a
// canonical `part` number to each node (e.g. "1.2") — use that, don't rebuild.
function collectAttachments(bs) {
  if (!bs) return [];
  const out = [];
  if (isAttachmentNode(bs)) {
    out.push({
      id: bs.part || '1',
      filename: bs.dispositionParameters?.filename
              ?? bs.parameters?.name
              ?? `attachment-${bs.part || '1'}`,
      size: bs.size ?? null,
      mime: bs.type ?? 'application/octet-stream',
    });
  }
  if (Array.isArray(bs.childNodes)) {
    for (const child of bs.childNodes) out.push(...collectAttachments(child));
  }
  return out;
}

function jsonReply(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorReply(msg) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}

// ─── Tool implementations ──────────────────────────────────────────────────

async function toolListAccounts() {
  const out = [];
  for (const a of accounts) {
    let folders = [];
    try {
      const client = await getClient(a.id);
      const list = await client.list();
      folders = list
        .filter(f => !f.flags?.has('\\Noselect'))
        .map(f => ({ name: f.path, specialUse: f.specialUse ?? null }));
    } catch (err) {
      out.push({ id: a.id, label: a.label ?? a.id, user: a.user, host: a.host, error: err.message });
      continue;
    }
    out.push({ id: a.id, label: a.label ?? a.id, user: a.user, host: a.host, folders });
  }
  return jsonReply({ accounts: out });
}

async function listRecentForAccount(accountId, { folder = 'INBOX', limit = 20, since } = {}) {
  const account = accountsById.get(accountId);
  if (!account) return { account: accountId, error: `unknown account: "${accountId}"` };

  // Default window: 7 days, prevents accidental full-mailbox scan
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 3600 * 1000);

  try {
    const client = await getClient(accountId);
    return await withMailbox(client, folder, async (resolved) => {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      // Newest first, take last `limit`
      const slice = uids.slice(-limit).reverse();
      if (slice.length === 0) return { account: accountId, folder: resolved, messages: [] };

      const messages = [];
      const fetchOpts = {
        envelope: true,
        bodyStructure: true,
        bodyParts: ['TEXT'],
        // Gmail extensions — silently ignored on non-Gmail
        ...(isGmail(account) ? { labels: true, threadId: true } : {}),
      };
      for await (const msg of client.fetch(slice, fetchOpts, { uid: true })) {
        messages.push(shapeMessageRow(account, resolved, msg));
      }
      // Sort newest-first
      messages.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      return { account: accountId, folder: resolved, messages };
    });
  } catch (err) {
    return { account: accountId, folder, error: err.message };
  }
}

async function toolListRecent({ account, folder, limit, since }) {
  if (!account || account === '*') {
    const results = await Promise.all(
      accounts.map(a => listRecentForAccount(a.id, { folder, limit, since }))
    );
    return jsonReply({ results });
  }
  return jsonReply(await listRecentForAccount(account, { folder, limit, since }));
}

async function searchForAccount(accountId, { folder = 'INBOX', query, limit = 30, since } = {}) {
  const account = accountsById.get(accountId);
  if (!account) return { account: accountId, error: `unknown account: "${accountId}"` };

  try {
    const client = await getClient(accountId);
    return await withMailbox(client, folder, async (resolved) => {
      const criteria = buildSearchCriteria(account, query, since);
      const uids = await client.search(criteria, { uid: true });
      const slice = uids.slice(-limit).reverse();
      if (slice.length === 0) return { account: accountId, folder: resolved, query, messages: [] };

      const messages = [];
      const fetchOpts = {
        envelope: true,
        bodyStructure: true,
        bodyParts: ['TEXT'],
        ...(isGmail(account) ? { labels: true, threadId: true } : {}),
      };
      for await (const msg of client.fetch(slice, fetchOpts, { uid: true })) {
        messages.push(shapeMessageRow(account, resolved, msg));
      }
      messages.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      return { account: accountId, folder: resolved, query, messages };
    });
  } catch (err) {
    return { account: accountId, folder, query, error: err.message };
  }
}

async function toolSearch({ account, folder, query, limit, since }) {
  if (!query || typeof query !== 'string') return errorReply('search: "query" is required');

  if (!account || account === '*') {
    const results = await Promise.all(
      accounts.map(a => searchForAccount(a.id, { folder, query, limit, since }))
    );
    return jsonReply({ results });
  }
  return jsonReply(await searchForAccount(account, { folder, query, limit, since }));
}

async function toolReadMessage({ account, uid, folder = 'INBOX' }) {
  if (!account)            return errorReply('read_message: "account" is required');
  if (uid == null)          return errorReply('read_message: "uid" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);

  try {
    const client = await getClient(account);
    return await withMailbox(client, folder, async (resolved) => {
      const msg = await client.fetchOne(uid, { source: true, envelope: true, bodyStructure: true,
        ...(isGmail(accountsById.get(account)) ? { labels: true, threadId: true } : {}),
      }, { uid: true });
      if (!msg) return jsonReply({ error: `message uid=${uid} not found in ${resolved}` });

      const parsed = await simpleParser(msg.source);
      const fromList = formatAddress(parsed.from?.value);

      // Wrap body content in <untrusted-content> spotlight delimiters so
      // the bot's security skill (loaded as system prompt addendum)
      // treats it as subject material, never instructions. Email bodies
      // are the highest-volume untrusted external content path we have —
      // anything an attacker can put in an email reaches the agent here.
      // Subject + addresses stay raw: they're metadata, length-bounded,
      // and the agent needs them as ordinary fields for routing decisions.
      const messageIdRaw = parsed.messageId ?? null;
      const wrapSource = `email:${messageIdRaw || `${account}/${msg.uid}`}`;
      const absorbedAt = (parsed.date ? parsed.date.toISOString() : null) ||
                        (msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null) ||
                        new Date().toISOString();
      const wrappedBodyText = parsed.text
        ? wrapUntrusted(parsed.text, { source: wrapSource, absorbedAt })
        : '';
      const rawHtml = parsed.html === false ? null : (parsed.html ?? null);
      const wrappedBodyHtml = rawHtml
        ? wrapUntrusted(rawHtml, { source: wrapSource, absorbedAt })
        : null;

      return jsonReply({
        account,
        folder: resolved,
        uid: msg.uid,
        date: parsed.date ? parsed.date.toISOString() :
              (msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null),
        from: Array.isArray(fromList) ? (fromList[0] ?? null) : (fromList ?? null),
        to: [].concat(formatAddress(parsed.to?.value) ?? []),
        cc: [].concat(formatAddress(parsed.cc?.value) ?? []),
        bcc: [].concat(formatAddress(parsed.bcc?.value) ?? []),
        subject: parsed.subject ?? '',
        message_id: messageIdRaw,
        in_reply_to: parsed.inReplyTo ?? null,
        body_text: wrappedBodyText,
        // mailparser returns `false` for "no html"; normalize to null
        body_html: wrappedBodyHtml,
        attachments: collectAttachments(msg.bodyStructure),
        labels: msg.labels ? [...msg.labels] : undefined,
        thread_id: msg.threadId ?? undefined,
      });
    });
  } catch (err) {
    return errorReply(`read_message: ${err.message}`);
  }
}

async function toolDownloadAttachment({ account, uid, attachment_id, folder = 'INBOX' }) {
  if (!account)        return errorReply('download_attachment: "account" is required');
  if (uid == null)     return errorReply('download_attachment: "uid" is required');
  if (!attachment_id)  return errorReply('download_attachment: "attachment_id" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);

  try {
    const client = await getClient(account);
    return await withMailbox(client, folder, async (resolved) => {
      // First, look up the attachment metadata so we know the filename
      const head = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
      if (!head) return errorReply(`message uid=${uid} not found in ${resolved}`);
      const meta = collectAttachments(head.bodyStructure).find(a => a.id === String(attachment_id));
      if (!meta) return errorReply(`attachment ${attachment_id} not found on uid=${uid}`);

      const part = await client.download(uid, attachment_id, { uid: true });
      if (!part?.content) return errorReply(`attachment ${attachment_id} returned no content`);

      const dir = join(TMP_DIR, account, String(uid));
      mkdirSync(dir, { recursive: true });
      // Sanitize filename: strip path separators
      const safeName = basename(meta.filename).replace(/[\x00-\x1f]/g, '_') || `attachment-${attachment_id}`;
      const path     = join(dir, safeName);

      const chunks = [];
      for await (const chunk of part.content) chunks.push(chunk);
      writeFileSync(path, Buffer.concat(chunks));

      return jsonReply({
        account, uid, folder: resolved,
        attachment_id,
        filename: safeName,
        size: meta.size,
        mime: meta.mime,
        saved_to: path,
      });
    });
  } catch (err) {
    return errorReply(`download_attachment: ${err.message}`);
  }
}

// ─── Write helpers ─────────────────────────────────────────────────────────

function normaliseAddrList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function snippetForAudit(s, n = 200) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// Send-tools gate. allow_send is per-account in storage but is a workspace-
// level trust call in spirit — the user opts every account in or out via the
// Integrations dashboard. When disabled, send/reply/forward refuse to fire
// and tell the user to flip the toggle (or use create_draft instead).
function checkSendAllowed(accountId, toolName) {
  const acc = accountsById.get(accountId);
  if (!acc) return null;
  if (acc.allow_send === true) return null;
  return errorReply(
    `${toolName}: sending is disabled for "${accountId}". ` +
    'Open Integrations → Email and switch "Allow bot to send" to Yes for this account, ' +
    'OR use create_draft to prepare a draft in your Drafts folder for manual review/send.',
  );
}

// Fetch a single message in a form usable for reply/forward. withMailbox
// already acquires the lock, so we just call fetchOne inside it.
async function fetchOriginal(client, folder, uid) {
  return await withMailbox(client, folder, async (resolved) => {
    const msg = await client.fetchOne(uid, { source: true, envelope: true, uid: true }, { uid: true });
    if (!msg) throw new Error(`message uid=${uid} not found in ${resolved}`);
    const parsed = await simpleParser(msg.source);
    return {
      envelope:  msg.envelope,
      messageId: msg.envelope?.messageId,
      subject:   parsed.subject || msg.envelope?.subject || '',
      from:      parsed.from?.text || formatAddress(msg.envelope?.from?.[0]),
      to:        (parsed.to?.value || []).map(formatAddress).filter(Boolean),
      cc:        (parsed.cc?.value || []).map(formatAddress).filter(Boolean),
      date:      parsed.date || msg.envelope?.date,
      text:      parsed.text || '',
      html:      parsed.html || '',
      rawSource: msg.source,
    };
  });
}

async function toolSendEmail({ account, to, cc, bcc, subject, body, html }) {
  if (!account)                   return errorReply('send_email: "account" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);
  const blocked = checkSendAllowed(account, 'send_email');
  if (blocked) return blocked;
  const recipients = normaliseAddrList(to);
  if (recipients.length === 0)    return errorReply('send_email: "to" must include at least one recipient');
  if (!subject)                   return errorReply('send_email: "subject" is required');
  if (!body)                      return errorReply('send_email: "body" is required');

  const acc = accountsById.get(account);
  const transporter = getSmtp(account);
  const fromAddr = acc.from || acc.user;

  const info = await transporter.sendMail({
    from:    fromAddr,
    to:      recipients,
    cc:      normaliseAddrList(cc),
    bcc:     normaliseAddrList(bcc),
    subject,
    text:    body,
    ...(html ? { html } : {}),
  });

  audit('send', account, {
    to: recipients,
    cc: normaliseAddrList(cc),
    bcc: normaliseAddrList(bcc),
    subject,
    snippet: snippetForAudit(body),
    message_id: info.messageId || null,
  });

  // Best-effort: file a copy in the Sent folder. Most providers handle this
  // server-side via SMTP-then-IMAP-append; if append fails we still consider
  // the send successful.
  try {
    const client = await getClient(account);
    const sentFolder = await resolveFolder(client, 'sent');
    if (info.message) await client.append(sentFolder, info.message, ['\\Seen']);
  } catch (err) {
    process.stderr.write(`[email-mcp] sent-copy append failed: ${err.message}\n`);
  }

  return jsonReply({
    sent: true,
    account,
    from: fromAddr,
    to: recipients,
    subject,
    message_id: info.messageId || null,
  });
}

async function toolReply({ account, uid, folder = 'INBOX', body, html, reply_all = false }) {
  if (!account)                   return errorReply('reply: "account" is required');
  if (uid == null)                return errorReply('reply: "uid" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);
  const blocked = checkSendAllowed(account, 'reply');
  if (blocked) return blocked;
  if (!body)                      return errorReply('reply: "body" is required');

  const client = await getClient(account);
  const original = await fetchOriginal(client, folder, uid);
  const acc = accountsById.get(account);
  const fromAddr = acc.from || acc.user;

  const replyTo = original.envelope?.replyTo?.[0]
    ? formatAddress(original.envelope.replyTo[0])
    : original.from;
  const recipients = [replyTo].filter(Boolean);
  // reply_all: include original cc, exclude self
  const allCc = reply_all
    ? original.cc.filter(a => a && !a.toLowerCase().includes(fromAddr.toLowerCase()))
    : [];

  const subjectLine = original.subject?.toLowerCase().startsWith('re:')
    ? original.subject
    : `Re: ${original.subject || '(no subject)'}`;

  const transporter = getSmtp(account);
  const info = await transporter.sendMail({
    from:       fromAddr,
    to:         recipients,
    cc:         allCc,
    subject:    subjectLine,
    text:       body,
    ...(html ? { html } : {}),
    inReplyTo:  original.messageId,
    references: original.messageId,
  });

  audit('reply', account, {
    uid,
    in_reply_to: original.messageId,
    to: recipients,
    cc: allCc,
    subject: subjectLine,
    snippet: snippetForAudit(body),
    message_id: info.messageId || null,
  });

  try {
    const sentFolder = await resolveFolder(client, 'sent');
    if (info.message) await client.append(sentFolder, info.message, ['\\Seen']);
  } catch (err) {
    process.stderr.write(`[email-mcp] sent-copy append failed: ${err.message}\n`);
  }

  return jsonReply({
    sent: true, account, to: recipients, cc: allCc, subject: subjectLine,
    message_id: info.messageId || null,
    in_reply_to: original.messageId,
  });
}

async function toolForward({ account, uid, folder = 'INBOX', to, cc, intro }) {
  if (!account)                   return errorReply('forward: "account" is required');
  if (uid == null)                return errorReply('forward: "uid" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);
  const blocked = checkSendAllowed(account, 'forward');
  if (blocked) return blocked;
  const recipients = normaliseAddrList(to);
  if (recipients.length === 0)    return errorReply('forward: "to" must include at least one recipient');

  const client = await getClient(account);
  const original = await fetchOriginal(client, folder, uid);
  const acc = accountsById.get(account);
  const fromAddr = acc.from || acc.user;

  const subjectLine = original.subject?.toLowerCase().startsWith('fwd:')
    ? original.subject
    : `Fwd: ${original.subject || '(no subject)'}`;

  const header = [
    intro ? `${intro}\n\n` : '',
    '---------- Forwarded message ----------\n',
    original.from ? `From: ${original.from}\n` : '',
    original.date ? `Date: ${original.date}\n` : '',
    `Subject: ${original.subject || '(no subject)'}\n`,
    original.to.length ? `To: ${original.to.join(', ')}\n` : '',
    '\n',
  ].join('');
  const composedText = header + (original.text || '');

  const transporter = getSmtp(account);
  const info = await transporter.sendMail({
    from:    fromAddr,
    to:      recipients,
    cc:      normaliseAddrList(cc),
    subject: subjectLine,
    text:    composedText,
  });

  audit('forward', account, {
    uid,
    to: recipients,
    cc: normaliseAddrList(cc),
    subject: subjectLine,
    snippet: snippetForAudit(composedText),
    message_id: info.messageId || null,
  });

  try {
    const sentFolder = await resolveFolder(client, 'sent');
    if (info.message) await client.append(sentFolder, info.message, ['\\Seen']);
  } catch (err) {
    process.stderr.write(`[email-mcp] sent-copy append failed: ${err.message}\n`);
  }

  return jsonReply({
    sent: true, account, to: recipients, subject: subjectLine,
    message_id: info.messageId || null,
  });
}

async function toolCreateDraft({ account, to, cc, subject, body, html, in_reply_to_uid, in_reply_to_folder = 'INBOX' }) {
  if (!account)                   return errorReply('create_draft: "account" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);
  const recipients = normaliseAddrList(to);
  if (recipients.length === 0)    return errorReply('create_draft: "to" must include at least one recipient');
  if (!subject)                   return errorReply('create_draft: "subject" is required');
  if (!body)                      return errorReply('create_draft: "body" is required');

  const client = await getClient(account);
  const acc = accountsById.get(account);
  const fromAddr = acc.from || acc.user;

  let inReplyTo = null;
  let references = null;
  if (in_reply_to_uid != null) {
    const original = await fetchOriginal(client, in_reply_to_folder, in_reply_to_uid);
    inReplyTo = original.messageId;
    references = original.messageId;
  }

  // Build the rfc822 source via nodemailer without actually sending — using
  // its compose+stream API. Easier than hand-rolling MIME for HTML/text.
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transporter.sendMail({
    from:    fromAddr,
    to:      recipients,
    cc:      normaliseAddrList(cc),
    subject,
    text:    body,
    ...(html ? { html } : {}),
    ...(inReplyTo ? { inReplyTo, references } : {}),
  });

  const draftsFolder = await resolveFolder(client, 'drafts');
  await client.append(draftsFolder, info.message, ['\\Draft']);

  audit('draft', account, {
    to: recipients,
    cc: normaliseAddrList(cc),
    subject,
    snippet: snippetForAudit(body),
    in_reply_to: inReplyTo,
  });

  return jsonReply({
    drafted: true,
    account,
    to: recipients,
    subject,
    folder: draftsFolder,
    in_reply_to: inReplyTo,
  });
}

async function toolMarkFlag({ account, uid, folder = 'INBOX' }, seen) {
  if (!account)                   return errorReply('mark_*: "account" is required');
  if (uid == null)                return errorReply('mark_*: "uid" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);

  const client = await getClient(account);
  return await withMailbox(client, folder, async (resolved) => {
    if (seen) {
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
    }
    audit(seen ? 'mark_read' : 'mark_unread', account, { uid, folder: resolved });
    return jsonReply({ ok: true, account, uid, folder: resolved, seen });
  });
}

async function toolArchive({ account, uid, folder = 'INBOX' }) {
  if (!account)                   return errorReply('archive: "account" is required');
  if (uid == null)                return errorReply('archive: "uid" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);

  const client = await getClient(account);
  return await withMailbox(client, folder, async (sourceResolved) => {
    let archiveFolder;
    try {
      archiveFolder = await resolveFolder(client, 'all');     // Gmail All Mail / providers' Archive
    } catch {
      archiveFolder = await resolveFolder(client, 'archive');
    }
    // For Gmail-style providers where archive == removing the INBOX label,
    // a copy + remove pattern works. ImapFlow's messageMove handles both
    // the move-folders case and Gmail-label removal correctly.
    if (archiveFolder === sourceResolved) {
      // Already archived — nothing to do.
      audit('archive_noop', account, { uid, folder: sourceResolved });
      return jsonReply({ ok: true, account, uid, folder: sourceResolved, note: 'already in archive' });
    }
    await client.messageMove(uid, archiveFolder, { uid: true });
    audit('archive', account, { uid, from: sourceResolved, to: archiveFolder });
    return jsonReply({ ok: true, account, uid, from: sourceResolved, to: archiveFolder });
  });
}

async function toolMove({ account, uid, folder = 'INBOX', destination }) {
  if (!account)                   return errorReply('move: "account" is required');
  if (uid == null)                return errorReply('move: "uid" is required');
  if (!destination)               return errorReply('move: "destination" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);

  const client = await getClient(account);
  return await withMailbox(client, folder, async (sourceResolved) => {
    const destResolved = await resolveFolder(client, destination);
    await client.messageMove(uid, destResolved, { uid: true });
    audit('move', account, { uid, from: sourceResolved, to: destResolved });
    return jsonReply({ ok: true, account, uid, from: sourceResolved, to: destResolved });
  });
}

async function toolDelete({ account, uid, folder = 'INBOX' }) {
  if (!account)                   return errorReply('delete: "account" is required');
  if (uid == null)                return errorReply('delete: "uid" is required');
  if (!accountsById.has(account)) return errorReply(`unknown account: "${account}"`);

  const client = await getClient(account);
  return await withMailbox(client, folder, async (sourceResolved) => {
    const trashFolder = await resolveFolder(client, 'trash');
    await client.messageMove(uid, trashFolder, { uid: true });
    audit('delete_to_trash', account, { uid, from: sourceResolved, to: trashFolder });
    return jsonReply({ ok: true, account, uid, from: sourceResolved, to: trashFolder, recoverable: true });
  });
}

// ─── Tool registration ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_accounts',
    description:
      'List all configured email accounts and their folders (INBOX, Sent, etc.). ' +
      'Call this first to see what accounts are available: every other tool ' +
      'takes an `account` id from this list. The bot never has implicit access ' +
      'to mail not configured here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_recent',
    description:
      'List recent messages from one account (or all with account="*"). Returns ' +
      'metadata + a 200-character snippet; use read_message to get the full body. ' +
      'Default window: last 7 days, 20 messages, INBOX.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id from list_accounts, or "*" for all accounts in parallel. Defaults to all.' },
        folder:  { type: 'string', description: 'IMAP folder. Aliases (case-insensitive): "inbox" (default), "sent", "drafts", "trash", "spam"/"junk", "all"/"archive", "starred"/"flagged", "important". Aliases resolve via SPECIAL-USE so they work across Gmail (any locale), Zoho, etc. You can also pass the server-native path (e.g. "[Gmail]/Sent Mail") verbatim.' },
        limit:   { type: 'number', description: 'Max messages (default: 20)' },
        since:   { type: 'string', description: 'ISO date: only fetch messages on/after this date (default: 7 days ago)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Search messages. For Gmail accounts, `query` is full Gmail search syntax ' +
      '("from:bob has:attachment after:2026/01/01"). For non-Gmail IMAP, supports ' +
      'from:, to:, cc:, subject:, body: prefixes; everything else is matched as body text. ' +
      'Use account="*" to fan out across all configured accounts in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id, or "*" for all accounts. Defaults to all.' },
        query:   { type: 'string', description: 'Search query (Gmail syntax for Gmail accounts).' },
        folder:  { type: 'string', description: 'IMAP folder. Aliases: "inbox" (default), "sent", "drafts", "trash", "spam", "all", "starred", "important". Or pass the server-native path verbatim.' },
        limit:   { type: 'number', description: 'Max results (default: 30)' },
        since:   { type: 'string', description: 'ISO date floor: narrows the search window' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_message',
    description:
      'Fetch one full message: headers, body_text (always), body_html (when present), ' +
      'and attachment metadata (filename, size, mime; NOT content). ' +
      'Pass `account` and `uid` returned from list_recent or search. ' +
      'Use download_attachment to actually fetch attachment bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id (required)' },
        uid:     { type: 'number', description: 'Message UID from list_recent / search (required)' },
        folder:  { type: 'string', description: 'IMAP folder. Aliases: "inbox" (default), "sent", "drafts", "trash", "spam", "all", "starred", "important". Or pass the server-native path verbatim.' },
      },
      required: ['account', 'uid'],
      additionalProperties: false,
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download one attachment to /tmp/email-mcp/<account>/<uid>/<filename>. ' +
      'Returns the absolute file path. Files are ephemeral: cleared on plugin ' +
      'restart, and entries older than 1h are pruned at boot. Move the file ' +
      'into the project tree explicitly if the user wants to keep it.',
    inputSchema: {
      type: 'object',
      properties: {
        account:       { type: 'string', description: 'Account id (required)' },
        uid:           { type: 'number', description: 'Message UID (required)' },
        attachment_id: { type: 'string', description: 'Attachment id from read_message.attachments[].id (required)' },
        folder:        { type: 'string', description: 'IMAP folder. Aliases: "inbox" (default), "sent", "drafts", "trash", "spam", "all", "starred", "important". Or pass the server-native path verbatim.' },
      },
      required: ['account', 'uid', 'attachment_id'],
      additionalProperties: false,
    },
  },

  // ─── Write tools ─────────────────────────────────────────────────────────
  // All writes are gated by the email-write-protocol skill — the bot must
  // confirm content with the user BEFORE invoking these tools. Pre-flight
  // happens at the prompt layer, not here. Every successful call is appended
  // to ~/project/.email-audit.jsonl as a permanent receipt.

  {
    name: 'send_email',
    description:
      'Send a new email via SMTP. STRONG-CONFIRM tool: never call without explicit ' +
      '"tak / yes / send / wyślij" from the user after showing them the full preview ' +
      '(account, recipients incl. cc/bcc, subject, body). One email per call; no batch ' +
      'sends. The send is logged to .email-audit.jsonl with timestamp + recipients + ' +
      'subject + body snippet for an immutable trail of what the bot did on the ' +
      'user\'s behalf.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id from list_accounts (required). The "from" header is set to this account\'s email.' },
        to:      { type: 'array', items: { type: 'string' }, description: 'Recipients (required). One or more "name@domain" strings.' },
        cc:      { type: 'array', items: { type: 'string' }, description: 'Optional cc recipients.' },
        bcc:     { type: 'array', items: { type: 'string' }, description: 'Optional bcc recipients.' },
        subject: { type: 'string', description: 'Subject line (required).' },
        body:    { type: 'string', description: 'Plain-text body (required). Use \\n for newlines.' },
        html:    { type: 'string', description: 'Optional HTML body. When set, providers render this; plain `body` is the fallback for clients that prefer text.' },
      },
      required: ['account', 'to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply',
    description:
      'Reply to an existing message via SMTP. STRONG-CONFIRM tool: bot must call ' +
      'read_message first to fetch the original, show the user the thread context + ' +
      'proposed reply, and only proceed on explicit confirmation. Sets In-Reply-To + ' +
      'References headers automatically. Use reply_all=true to include the original ' +
      'cc list (still requires confirmation showing exactly who gets the reply).',
    inputSchema: {
      type: 'object',
      properties: {
        account:   { type: 'string', description: 'Account id (required).' },
        uid:       { type: 'number', description: 'UID of the message being replied to (required).' },
        folder:    { type: 'string', description: 'Folder where the original lives. Default: inbox.' },
        body:      { type: 'string', description: 'Reply body in plain text (required).' },
        html:      { type: 'string', description: 'Optional HTML body.' },
        reply_all: { type: 'boolean', description: 'When true, also include the original cc list. Bot MUST surface the full recipient set during confirmation.' },
      },
      required: ['account', 'uid', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'forward',
    description:
      'Forward an existing message to new recipients via SMTP. STRONG-CONFIRM tool: ' +
      'bot must show the user the original message body + new recipients before sending. ' +
      'Original attachments are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        account:    { type: 'string', description: 'Account id (required).' },
        uid:        { type: 'number', description: 'UID of message to forward (required).' },
        folder:     { type: 'string', description: 'Folder where the original lives. Default: inbox.' },
        to:         { type: 'array', items: { type: 'string' }, description: 'Forward recipients (required).' },
        cc:         { type: 'array', items: { type: 'string' }, description: 'Optional cc.' },
        intro:      { type: 'string', description: 'Optional message prepended above the forwarded original (e.g. "FYI: looks relevant to your Q3 deck.").' },
      },
      required: ['account', 'uid', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_draft',
    description:
      'Save an email as Drafts WITHOUT sending. Safe by design: no confirmation ' +
      'needed because nothing leaves the server. Useful when the user asks the bot ' +
      'to "draft a reply": bot writes it as a draft, user opens their mail client ' +
      'to review and send manually.',
    inputSchema: {
      type: 'object',
      properties: {
        account:    { type: 'string', description: 'Account id (required).' },
        to:         { type: 'array', items: { type: 'string' }, description: 'Recipients (required).' },
        cc:         { type: 'array', items: { type: 'string' }, description: 'Optional cc.' },
        subject:    { type: 'string', description: 'Subject (required).' },
        body:       { type: 'string', description: 'Plain-text body (required).' },
        html:       { type: 'string', description: 'Optional HTML body.' },
        in_reply_to_uid:    { type: 'number', description: 'Optional: uid of a message this draft replies to. Headers will thread the draft into that conversation.' },
        in_reply_to_folder: { type: 'string', description: 'Folder for in_reply_to_uid lookup. Default: inbox.' },
      },
      required: ['account', 'to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_read',
    description:
      'Mark a message as read (sets the \\Seen IMAP flag). Reversible; see mark_unread. ' +
      'Light-confirm: bot says "marking <subject> as read" and proceeds. The audit log ' +
      'still records every flag change.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        uid:     { type: 'number' },
        folder:  { type: 'string', description: 'Default: inbox.' },
      },
      required: ['account', 'uid'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_unread',
    description: 'Mark a message as unread (clears the \\Seen flag). Counterpart to mark_read.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        uid:     { type: 'number' },
        folder:  { type: 'string', description: 'Default: inbox.' },
      },
      required: ['account', 'uid'],
      additionalProperties: false,
    },
  },
  {
    name: 'archive',
    description:
      'Move a message out of Inbox into the All Mail / Archive folder. Light-confirm: ' +
      'recoverable (search across all folders finds it). Falls back to gracefully ' +
      'removing INBOX when the provider has no separate Archive (Gmail-style).',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        uid:     { type: 'number' },
        folder:  { type: 'string', description: 'Source folder (default: inbox).' },
      },
      required: ['account', 'uid'],
      additionalProperties: false,
    },
  },
  {
    name: 'move',
    description:
      'Move a message to a different folder. Light-confirm: show user source + ' +
      'destination folder before proceeding. Use folder aliases ("trash", "drafts", ' +
      '"sent", "all") or server-native paths.',
    inputSchema: {
      type: 'object',
      properties: {
        account:     { type: 'string' },
        uid:         { type: 'number' },
        folder:      { type: 'string', description: 'Source folder (default: inbox).' },
        destination: { type: 'string', description: 'Target folder. Aliases supported.' },
      },
      required: ['account', 'uid', 'destination'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete',
    description:
      'Move a message to Trash (soft delete, recoverable from the Trash folder for ' +
      '~30 days on Gmail/Zoho). Light-strong confirm: bot says "moving to Trash, ' +
      'still recoverable" and waits for explicit confirmation. NOT permanent delete: ' +
      'this is intentionally reversible. There is no permanent_delete tool by design.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        uid:     { type: 'number' },
        folder:  { type: 'string', description: 'Source folder (default: inbox).' },
      },
      required: ['account', 'uid'],
      additionalProperties: false,
    },
  },
];

// ─── MCP server boilerplate ────────────────────────────────────────────────

const server = new Server(
  { name: 'email-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case 'list_accounts':       return await toolListAccounts();
      case 'list_recent':         return await toolListRecent(args);
      case 'search':              return await toolSearch(args);
      case 'read_message':        return await toolReadMessage(args);
      case 'download_attachment': return await toolDownloadAttachment(args);
      case 'send_email':          return await toolSendEmail(args);
      case 'reply':               return await toolReply(args);
      case 'forward':             return await toolForward(args);
      case 'create_draft':        return await toolCreateDraft(args);
      case 'mark_read':           return await toolMarkFlag(args, true);
      case 'mark_unread':         return await toolMarkFlag(args, false);
      case 'archive':             return await toolArchive(args);
      case 'move':                return await toolMove(args);
      case 'delete':              return await toolDelete(args);
      default: return errorReply(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorReply(`${name}: ${err.message}`);
  }
});

// Graceful shutdown
async function shutdown() {
  for (const id of [...pool.keys()]) await closeClient(id);
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[email-mcp] Ready — ${accounts.length} account(s): ${accounts.map(a => a.id).join(', ')}\n`
);
