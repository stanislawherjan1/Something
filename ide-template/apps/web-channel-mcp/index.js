#!/usr/bin/env node
/**
 * Web Channel MCP — lets the bot push a message into the workspace UI's
 * notification stream (the bottom-right toast / future Bot Chat thread).
 *
 * Tools:
 *   web_send_message — POST a chat-style reply to /api/internal/notify
 *                      on workspace-api. wsapi fans it out to every
 *                      browser tab via /api/notifications/stream SSE.
 *
 * Why this exists: the bot's tmux Claude session has a Telegram channel
 * plugin when a TG token is wired, but TG-less clients had no surface
 * for the bot to talk back to the user. Reminder triggers, /memory
 * commands, and ad-hoc web messages all dead-ended because the only
 * "reply" tools available wrote to Telegram. With this MCP loaded the
 * bot has a first-class web reply tool, regardless of TG configuration.
 *
 * Pair with hooks/web-mirror.sh (PostToolUse): when the bot uses
 * telegram_send_message, the hook also pushes a copy into the web
 * stream so users with both surfaces see the same conversation in
 * each. This MCP is for native web replies; the hook is for mirroring.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const WSAPI_PORT = process.env.WORKSPACE_API_PORT || '3001';
const NOTIFY_URL        = `http://127.0.0.1:${WSAPI_PORT}/api/internal/notify`;
const CHAT_SESSION_URL  = `http://127.0.0.1:${WSAPI_PORT}/api/internal/chat-session`;

const server = new Server(
  { name: 'web-channel-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'web_send_message',
      description:
        'Send a message to the user in the workspace web UI. Use this when ' +
        "the inbound prompt came over the web channel (e.g. prefixed with " +
        "[WEB_USER] or [REMINDER channel=web]), OR when there is no Telegram " +
        "channel available. The message renders as a notification toast in " +
        "the user's browser; future Bot Chat view will thread these into a " +
        "single conversation. Prefer plain text — no markdown rendering yet. " +
        'Use `title` for the headline (~60 chars), `body` for the longer ' +
        'reply. If you only have one line, set `title` only.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Headline line. Required unless body is provided.',
          },
          body: {
            type: 'string',
            description:
              'Optional longer message body. Plain text, newlines preserved.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'web_send_message') {
    const title = typeof args?.title === 'string' ? args.title.trim() : '';
    const body  = typeof args?.body  === 'string' ? args.body.trim()  : '';
    if (!title && !body) {
      return {
        content: [{ type: 'text', text: 'Provide at least `title` or `body`.' }],
        isError: true,
      };
    }
    try {
      // First create the chat-history session so the bubble click target
      // resolves to a real conversation. Failure here is non-fatal — the
      // toast still fires; the user can find the message but the click
      // → open conversation wiring goes inert.
      let sessionId = null;
      try {
        const sRes = await fetch(CHAT_SESSION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body }),
        });
        const sJson = await sRes.json().catch(() => ({}));
        if (sRes.ok && sJson?.ok && sJson?.id) sessionId = sJson.id;
      } catch (_) { /* swallow — fall through to notify */ }

      const nRes = await fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'bot',
          title,
          body,
          meta: sessionId ? { session_id: sessionId } : {},
        }),
      });
      const nJson = await nRes.json().catch(() => ({}));
      if (!nRes.ok || !nJson?.ok) {
        return {
          content: [{
            type: 'text',
            text: `web_send_message: wsapi /notify responded ${nRes.status}: ${JSON.stringify(nJson)}`,
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: sessionId
            ? `Sent (notification=${nJson.id}, session=${sessionId}).`
            : `Sent (notification=${nJson.id}, session-create failed — toast only).`,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `web_send_message: ${err.message}`,
        }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
