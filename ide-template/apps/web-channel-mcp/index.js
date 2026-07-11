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
        'Send a message into a user\'s workspace (a notification + chat entry). ' +
        'THIS IS THE ONLY WAY to reach a person from here: use it for EVERY ' +
        'relay, INCLUDING when the user says "message them on Telegram" / "ask ' +
        'them on TG". There is NO separate Telegram tool on this surface; this ' +
        'tool delivers to the teammate on whichever surface THEY chose (their web ' +
        'workspace always, plus their Telegram if they linked it and prefer it); ' +
        'the routing is automatic, you do NOT pick the channel. NEVER tell the ' +
        'user you sent / relayed something unless you actually called this tool ' +
        'and it returned success; the result states WHERE it landed: relay that ' +
        'truthfully (do not promise Telegram if the result says web only). ' +
        'Two modes: (1) reply to the CURRENT web user (omit `recipient`); ' +
        '(2) RELAY to ANOTHER teammate: set `recipient` to their slug (TEAM ' +
        'roster). Compose a NATURAL, human message addressed to them: greet them ' +
        'and weave the sender in conversationally ("Hi Jan, Stan is asking ' +
        'whether you finished the analysis"), in the RECIPIENT\'s language (roster ' +
        'shows "writes in <lang>"). Put the whole message in `body`: delivered ' +
        'VERBATIM, no "X asked me to forward" preamble. Only relay to a known ' +
        'slug, only when the user asked you to pass something on. `title` = short ' +
        'chat-list label (optional), `body` = the message.',
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
          recipient: {
            type: 'string',
            description:
              "Optional teammate SLUG to RELAY to (cross-user). Omit to reply to " +
              "the current web user. Must be a real slug from the TEAM roster.",
          },
          channel: {
            type: 'string',
            enum: ['telegram', 'web'],
            description:
              "Optional explicit delivery channel: set this ONLY when the user " +
              "names one ('on Telegram' → 'telegram'; 'in their workspace' / 'on " +
              "web' → 'web'). It OVERRIDES the recipient's default preference. " +
              "Omit it normally: the recipient is then reached on whichever " +
              "channel THEY prefer. 'telegram' delivers only to Telegram when " +
              "they're linked (no duplicate web toast).",
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
    // B3 cross-user relay: recipient = a teammate slug (omit → current web user).
    // The SENDER is this turn's actor, set by claude.js as IDE_ACTOR_SLUG — wsapi
    // resolves it to a display name + uses it for attribution.
    const recipient = typeof args?.recipient === 'string' ? args.recipient.trim() : '';
    // Explicit delivery channel override ('telegram' | 'web'); '' = recipient's
    // own preference decides.
    const channel = (args?.channel === 'telegram' || args?.channel === 'web') ? args.channel : '';
    const from = (process.env.IDE_ACTOR_SLUG || '').trim();
    // B3 v2 relay threading: the sender's current web session id, so wsapi can
    // pair it with the recipient's relay thread and keep replies in-thread.
    const fromSession = (process.env.IDE_SESSION_ID || '').trim();
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
      let delivery = null;
      try {
        const sRes = await fetch(CHAT_SESSION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, recipient, from, fromSession, channel }),
        });
        const sJson = await sRes.json().catch(() => ({}));
        if (sRes.ok && sJson?.ok && sJson?.id) sessionId = sJson.id;
        if (sJson?.delivery) delivery = sJson.delivery;
      } catch (_) { /* swallow — fall through to notify */ }

      // Fire the web toast UNLESS this went to Telegram-only by explicit request
      // (delivery.webToast === false) — the recipient already has it on Telegram,
      // a web toast would be redundant/contradictory.
      const wantWebToast = !delivery || delivery.webToast !== false;
      let notifyId = null;
      if (wantWebToast) {
        const nRes = await fetch(NOTIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'bot',
            title,
            body,
            meta: sessionId ? { session_id: sessionId } : {},
            recipient,   // scopes the toast to the recipient teammate (relay); empty → global
            from,        // wsapi resolves this to a name + builds the recipient-facing relay title
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
        notifyId = nJson.id;
      }

      // Tell the bot WHERE it actually landed so it relays the truth to the user,
      // instead of promising a channel that didn't happen. Covers relay + self.
      const d = delivery || {};
      const who = recipient ? 'their' : 'your';
      let where;
      if (d.telegram && d.webToast === false) {
        where = `Delivered to ${who} Telegram.`;
      } else if (d.telegram) {
        where = `Delivered to ${who} workspace AND ${who} Telegram.`;
      } else if (d.telegramRequested && d.recipientLinkedTelegram === false) {
        where = `Delivered to ${who} workspace. Telegram was requested but ${recipient ? 'they have' : 'you have'} NOT linked Telegram, so it did NOT reach Telegram; tell the user that plainly, don't claim it went to Telegram.`;
      } else if (d.telegramRequested) {
        where = `Delivered to ${who} workspace. Telegram was requested but the Telegram send did not go through; say it's in the workspace, not on Telegram.`;
      } else {
        where = `Delivered to ${who} workspace.`;
      }
      return {
        content: [{
          type: 'text',
          text: `Sent.${sessionId ? '' : ' (session-create failed; message still delivered.)'} ${where}`,
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
