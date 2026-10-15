#!/usr/bin/env node
/**
 * remote-mcp — a local stdio bridge to a provider's hosted MCP server that
 * needs the person's OAuth token (Granola, Fathom, tl;dv, …).
 *
 * The CLI used to connect to those servers directly, with a token fetched
 * once by a headers helper when the server was first started. A session in
 * tmux lives for days, the token for an hour: once it expired the server
 * answered 401, the CLI tried an OAuth flow of its own (an auth host the
 * egress allow-list does not carry), and the tools were gone until the bot
 * was restarted. This bridge asks workspace-api for a fresh token on every
 * call instead — workspace-api refreshes it before it expires — and
 * reconnects when the token changes.
 *
 * Started by mcp-runner (`mcp-runner remote`) as the mcp user, with:
 *   REMOTE_MCP_ID         the integration id (what workspace-api refreshes)
 *   REMOTE_MCP_URL        the hosted server's URL
 *   REMOTE_MCP_TRANSPORT  http (Streamable HTTP, default) | sse
 *   WORKSPACE_API_PORT    loopback port of workspace-api (default 3001)
 *   IDE_TURN_ID           the turn's token (inherited from the CLI), which
 *                         /api/internal/mcp-token requires
 * The server name the CLI sees is the catalog's, so tool names do not change.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const ID        = String(process.env.REMOTE_MCP_ID || '').trim();
const URL_      = String(process.env.REMOTE_MCP_URL || '').trim();
const TRANSPORT = process.env.REMOTE_MCP_TRANSPORT === 'sse' ? 'sse' : 'http';
const WSAPI     = `http://127.0.0.1:${process.env.WORKSPACE_API_PORT || '3001'}`;
// `granola` is the workspace's connection, `granola@ann` Ann's own.
if (!/^[a-z0-9-]{1,64}(@[a-z0-9-]{1,64})?$/.test(ID) || !/^https:\/\//.test(URL_)) {
  process.stderr.write('[remote-mcp] REMOTE_MCP_ID and REMOTE_MCP_URL (https) are required\n');
  process.exit(2);
}

// The person's current access token, from workspace-api (which refreshes it
// from the stored refresh token before it expires). A 401 here means the
// connection needs to be made again on the integrations screen.
async function freshToken() {
  const r = await fetch(`${WSAPI}/api/internal/mcp-token/${encodeURIComponent(ID)}`, {
    headers: { 'X-IDE-Turn': process.env.IDE_TURN_ID || '' },
  });
  if (r.status === 401) throw new Error(`${ID} needs reconnecting on the integrations screen (its sign-in is no longer valid).`);
  if (!r.ok) throw new Error(`workspace-api could not provide a token for ${ID} (HTTP ${r.status}).`);
  const j = await r.json().catch(() => ({}));
  const m = /^Bearer\s+(\S+)$/.exec(String(j.Authorization || ''));
  if (!m) throw new Error(`workspace-api returned no token for ${ID}.`);
  return m[1];
}

let live = null;   // { client, token }
async function remote() {
  const token = await freshToken();
  if (live && live.token === token) return live.client;
  if (live) { try { await live.client.close(); } catch { /* gone */ } live = null; }
  const opts = { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
  const transport = TRANSPORT === 'sse'
    ? new SSEClientTransport(new URL(URL_), opts)
    : new StreamableHTTPClientTransport(new URL(URL_), opts);
  const client = new Client({ name: `remote-mcp/${ID}`, version: '1.0.0' });
  await client.connect(transport);
  live = { client, token };
  return client;
}

// One attempt with the current connection; on a refusal (the token was
// revoked between calls, the connection dropped) once more on a fresh one.
async function withRemote(fn) {
  try { return await fn(await remote()); }
  catch (err) {
    const msg = String(err?.message || err);
    if (live && /401|unauthori[sz]ed|not connected|closed|ECONNRESET|fetch failed/i.test(msg)) {
      try { await live.client.close(); } catch { /* gone */ }
      live = null;
      return fn(await remote());
    }
    throw err;
  }
}

const server = new Server({ name: ID, version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const r = await withRemote((c) => c.listTools());
  return { tools: r.tools || [] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await withRemote((c) => c.callTool({ name: req.params.name, arguments: req.params.arguments || {} }));
  } catch (err) {
    return { content: [{ type: 'text', text: `${ID}: ${String(err?.message || err)}` }], isError: true };
  }
});

const stdio = new StdioServerTransport();
await server.connect(stdio);
process.stderr.write(`[remote-mcp] ${ID} ready (${TRANSPORT}, ${URL_})\n`);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, async () => { try { await live?.client.close(); } catch { /* gone */ } process.exit(0); });
}
