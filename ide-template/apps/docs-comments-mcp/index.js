#!/usr/bin/env node
/**
 * Docs Comments MCP — inline (range-anchored) Google Docs comments.
 *
 * One tool: add_comment. The Docs/Drive API can't anchor a comment to a text
 * range, so we drive the Docs UI. Everything else about a comment's lifecycle
 * (list / reply / resolve / delete) goes through the Google Workspace
 * integration over the Drive API (gdrive-mcp) — see skills/optional/docs-comments.
 *
 * ── Why this MCP does NOT launch its own browser ──────────────────────────────
 * Google's anti-fraud rejects a logged-in session the moment a DIFFERENT
 * chromium process tries to reuse it from a datacenter IP — every fresh launch
 * lands on accounts.google.com/confirmidentifier (proven by A/B test 2026-06-07,
 * both login-flags and add-flags bounced). The only thing that works is to NOT
 * relaunch: keep the exact browser the operator logged into alive and DRIVE it.
 *
 * So the persistent browser lives in workspace-api (routes/docs-comments-login.js)
 * — Xvfb + chromium started at login, kept alive after, exposing CDP on
 * 127.0.0.1:9333. This MCP ATTACHES to it via Playwright connectOverCDP and
 * drives the live session. No second browser, no second fingerprint, no
 * per-call relaunch → the session survives for the life of that browser.
 *
 * Containment: the persistent chromium routes through the container egress
 * (redsocks/iptables → egress-proxy → docs-comments allowedHosts), so this MCP
 * inherits that allowlist. Plus: doc_id is regex-validated and the navigation
 * URL is hard-checked before goto. Output is structured-only ({ ok,
 * occurrence_used }) — never raw doc content — so a poisoned doc can't smuggle
 * instructions into the next turn through this tool.
 *
 * Env:
 *   DOCS_COMMENTS_CDP_URL  — CDP endpoint of the persistent browser
 *                            (default http://127.0.0.1:9333)
 *   DOCS_COMMENTS_AUDIT_LOG — JSONL audit log (default PROJECT_DIR/.docs-comments-audit.jsonl)
 *
 * Tool:
 *   add_comment(doc_id, find_text, comment_text, occurrence?, find_context?)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright-core';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────────────────────

const CDP_URL   = process.env.DOCS_COMMENTS_CDP_URL || 'http://127.0.0.1:9333';
// wsapi loopback — the MCP asks it to relaunch the persistent browser ONCE on a
// NOT_CONNECTED (chromium died mid-session) before giving up. Same container,
// so 127.0.0.1:3001 is direct (NO_PROXY covers loopback).
const WSAPI_INTERNAL_URL = process.env.WSAPI_INTERNAL_URL || 'http://127.0.0.1:3001';
const AUDIT_LOG = process.env.DOCS_COMMENTS_AUDIT_LOG
  || join(process.env.PROJECT_DIR || '/home/coder/project', '.docs-comments-audit.jsonl');

// Google Docs IDs: URL-safe [a-zA-Z0-9_-], length varies (28..72 seen). Validate
// before building any URL — rules out path-traversal / injection.
const DOC_ID_RE = /^[a-zA-Z0-9_-]{20,80}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateDocId(id) {
  if (typeof id !== 'string' || !DOC_ID_RE.test(id)) {
    throw new Error('invalid doc_id (expected 20-80 chars matching [a-zA-Z0-9_-])');
  }
}

function shortHash(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

function audit(entry) {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o640 });
  } catch (err) {
    process.stderr.write(`[docs-comments] audit append failed (${AUDIT_LOG}): ${err.message}\n`);
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'add_comment',
    description:
      "Add an inline comment anchored to a specific text fragment in a Google " +
      "Doc. Drives the live logged-in browser (Docs UI) because the Docs/Drive " +
      "API can't anchor comments to a range. Use ONLY for adding anchored " +
      "comments: list/reply/resolve/delete go through the Google Workspace " +
      "tools (mcp__gdrive__*), which are faster and need no browser. Requires the " +
      "operator to have logged in via Integrations → Docs Comments → Connect. " +
      "The bot sees only { ok, occurrence_used }, never raw doc content.",
    inputSchema: {
      type: 'object',
      required: ['doc_id', 'find_text', 'comment_text'],
      properties: {
        doc_id:       { type: 'string', description: 'Google Docs document id (between /d/ and /edit in the URL). 20-80 chars, [a-zA-Z0-9_-].' },
        find_text:    { type: 'string', description: 'The exact text fragment to anchor the comment to. Should match a single occurrence unless you also pass occurrence.' },
        comment_text: { type: 'string', description: 'The comment body. Plain text, no formatting.' },
        occurrence:   { type: 'integer', minimum: 1, description: 'When find_text appears multiple times, the N-th match (1-based). Default: 1.' },
        find_context: { type: 'string', description: 'Optional disambiguation hint (a short phrase in the same paragraph). Audit breadcrumb today.' },
      },
    },
  },
];

// ─── Tool: add_comment ─────────────────────────────────────────────────────────

async function addComment({ doc_id, find_text, comment_text, occurrence, find_context }) {
  validateDocId(doc_id);
  if (typeof find_text !== 'string' || !find_text.trim())       throw new Error('find_text is required');
  if (typeof comment_text !== 'string' || !comment_text.trim()) throw new Error('comment_text is required');
  const occ = Number.isFinite(occurrence) && occurrence >= 1 ? Math.floor(occurrence) : 1;

  const docUrl = `https://docs.google.com/document/d/${doc_id}/edit`;
  if (!docUrl.startsWith('https://docs.google.com/document/')) {
    throw new Error('refused to navigate outside docs.google.com');
  }

  // Attach to the persistent login browser over CDP. If it isn't running, ask
  // wsapi to relaunch it from the saved profile ONCE, then retry the connect
  // exactly once. No loop — `triedEnsure` makes a third attempt structurally
  // impossible. If ensure can't bring a browser up (inactive / no session /
  // wsapi unreachable), surface a clean NOT_CONNECTED. SESSION_EXPIRED is
  // produced later (after a successful attach + a bounce to accounts.google.com)
  // and is never retried — relaunch can't refresh dead cookies.
  const notConnected = () => Object.assign(
    new Error('Docs Comments is not connected: log in via the workspace UI (Integrations → Docs Comments → Connect to Google).'),
    { code: 'NOT_CONNECTED' },
  );
  let browser;
  let triedEnsure = false;
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 8000 });
      break;
    } catch {
      if (triedEnsure) throw notConnected();
      triedEnsure = true;
      try {
        const r = await fetch(`${WSAPI_INTERNAL_URL}/api/internal/docs-comments/ensure`, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (!body.ok) throw notConnected();   // inactive / no session → don't retry
      } catch (e) {
        if (e.code === 'NOT_CONNECTED') throw e;
        // ensure call itself failed (wsapi unreachable) → fall through to one retry
      }
      // Bounded wait for chromium to bind CDP before the single retry.
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  const docHash = shortHash([doc_id]);
  let page;
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw Object.assign(new Error('Docs Comments browser has no session context: reconnect via the workspace UI.'), { code: 'NOT_CONNECTED' });
    }
    page = await context.newPage();
    await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Bounced to sign-in → the live session lapsed. Surface a clean reconnect.
    const landedAt = new URL(page.url());
    if (landedAt.hostname === 'accounts.google.com') {
      throw Object.assign(
        new Error('Docs Comments session expired: reconnect via the workspace UI (Integrations → Docs Comments).'),
        { code: 'SESSION_EXPIRED' },
      );
    }
    if (landedAt.hostname !== 'docs.google.com' || !landedAt.pathname.startsWith(`/document/d/${doc_id}/`)) {
      throw new Error(`unexpected post-goto URL: ${landedAt.origin}${landedAt.pathname}`);
    }

    // Wait for the editor shell (toolbar/find/comment chrome is DOM even when
    // the doc body renders to canvas), then let the canvas paint so Ctrl+F has
    // text to find.
    await page.waitForSelector('#docs-editor', { timeout: 25000 });
    await page.waitForTimeout(3000);

    // Keyboard-driven flow — language/class-agnostic (Docs find bar + comment
    // popover are Material Design 3 with localised aria-labels):
    //   Ctrl+F → type → N×Enter (occurrence) → Esc → Ctrl+Alt+M → type → Ctrl+Enter
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(700);
    await page.keyboard.type(find_text, { delay: 8 });
    await page.waitForTimeout(400);
    for (let i = 0; i < occ; i++) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.keyboard.press('Control+Alt+m');
    await page.waitForTimeout(1000);
    await page.keyboard.type(comment_text, { delay: 4 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(2200);

    audit({
      event:            'add_comment.ok',
      doc_hash:         docHash,
      occurrence_used:  occ,
      find_text_hash:   shortHash([find_text]),
      had_find_context: !!find_context,
    });
    return { ok: true, occurrence_used: occ };
  } catch (err) {
    audit({ event: 'add_comment.fail', doc_hash: docHash, reason: err.code || err.message?.slice(0, 200) || 'unknown' });
    throw err;
  } finally {
    // Close the TAB we opened. Then disconnect the CDP client — for a
    // connectOverCDP browser, browser.close() only disconnects; it does NOT
    // terminate the persistent chromium (which workspace-api owns).
    try { await page?.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
  }
}

// ─── MCP server wiring ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'docs-comments-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'add_comment') {
      const result = await addComment(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const msg = err.code === 'NOT_CONNECTED' || err.code === 'SESSION_EXPIRED'
      ? err.message
      : `Docs Comments failed: ${err.message || String(err)}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[docs-comments-mcp] Ready (CDP attach mode)\n');
