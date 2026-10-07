/**
 * workspace-api as an MCP client of a provider's hosted server — the same
 * remote MCP the bot's turns use (catalog `mcp.type: "http"`), reached the
 * same way: the person's OAuth access token from the encrypted store
 * (lib/integrations/oauth.js, refreshed when stale) and the egress proxy's
 * open listener, as the OAuth calls themselves go. One connection per call,
 * closed after; nothing is cached.
 *
 * Used by the night memory import (lib/memory-sources.js): fetching a
 * meeting's transcript through a model turn meant the model re-emitting the
 * whole transcript as a tool argument — twenty minutes and a fortune in
 * tokens for one meeting. Code fetches; the model is not in the loop.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ProxyAgent } from 'undici';
import * as catalog from './catalog.js';
import { getFreshToken } from './oauth.js';

const PROXY_URL = process.env.MCP_OAUTH_PROXY_URL ?? 'http://egress-proxy:3130';
const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const proxyFetch = dispatcher ? (url, init) => fetch(url, { ...init, dispatcher }) : undefined;

let override = null;
/** Tests: `fn(id)` returns a stand-in with `callTool({ name, arguments })` and `close()`. */
export function configureClient(fn) { override = fn; }

/** Text of a tool result's content, joined. */
export function textOf(result) {
  const c = result?.content;
  if (typeof c === 'string') return c;
  return (Array.isArray(c) ? c : []).filter(x => x && x.type === 'text').map(x => x.text).join('\n');
}

/**
 * Connect to the integration's remote MCP server as the workspace and run
 * `fn(client)`; the client is closed afterwards whatever happens.
 */
export async function withRemote(id, fn) {
  if (override) { const c = await override(id); try { return await fn(c); } finally { await c.close?.(); } }
  const cat = catalog.get(id);
  if (!cat?.mcp || cat.mcp.type !== 'http' || !cat.mcp.url) throw new Error(`${id} has no remote MCP server`);
  const token = await getFreshToken(id);
  const transport = new StreamableHTTPClientTransport(new URL(cat.mcp.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  });
  const client = new Client({ name: 'workspace-api', version: '1.0.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { try { await client.close(); } catch { /* gone */ } }
}
