/**
 * MCP-side client for the credential broker.
 *
 * Every MCP that runs at uid 1002 (i.e. is launched via /usr/local/bin/
 * mcp-runner) calls `loadCredentials()` once at startup. The client:
 *
 *   1. Reads BROKER_SOCKET, BROKER_INTEGRATION_ID, BROKER_NONCE from env.
 *   2. Opens a Unix domain socket connection to BROKER_SOCKET.
 *   3. Sends one line of JSON: { op:"get", integrationId, nonce }.
 *   4. Reads one line of JSON back: { ok:true, fields | items } or
 *      { ok:false, error }.
 *   5. On success, writes the returned fields into process.env so the
 *      rest of the MCP code (which reads e.g. process.env.SHOPIFY_CLIENT_ID)
 *      keeps working without a refactor.
 *   6. Deletes BROKER_NONCE from process.env so a compromised peer at
 *      the same uid can't read it from /proc/<pid>/environ later.
 *
 * Threat model coverage:
 *   - Bot uid 1000 cannot connect to BROKER_SOCKET (group-gated, mode
 *     2770 group=wsapi-broker, coder not in that group).
 *   - Bot cannot read this MCP's env to steal nonce (different uid,
 *     /proc/<pid>/environ refuses cross-uid reads).
 *   - A sibling MCP at uid 1002 CAN read /proc/<this-pid>/environ
 *     until we delete BROKER_NONCE — this client deletes it as soon as
 *     the broker call returns, narrowing the window to ~5-10ms.
 *   - Single-use nonces: even if a sibling races to steal the nonce
 *     during that ~5ms window, the broker rejects the second call
 *     because the grant was consumed.
 *
 * Multi-account integrations: when the broker returns `items` (e.g.
 * email-imap with N accounts), this client does NOT spread them into
 * env (no canonical mapping). Instead it returns the items array to
 * the caller, who is responsible for the multi-account format. The
 * email-mcp specifically reads from a file (EMAIL_ACCOUNTS_FILE) rather
 * than from env, so the items the broker returns are advisory.
 *
 * Failure handling: if the broker is unreachable, this throws. The MCP
 * should treat this as a fatal startup error (exit 1) — running an MCP
 * with no credentials is worse than running none at all.
 */

import { createConnection } from 'node:net';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// ─── Global HTTPS_PROXY routing for every MCP ─────────────────────────────
// Every MCP imports this module at startup (calls loadCredentials()), so
// this side-effect runs once per MCP process — the earliest possible
// hook into Node's fetch/undici stack.
//
// Node's built-in fetch (undici-based) does NOT read HTTPS_PROXY /
// HTTP_PROXY env vars on its own. Without explicitly installing a
// ProxyAgent as the global dispatcher, every `fetch(...)` call from MCP
// code goes direct via the kernel's resolver + TCP stack — which on
// bot-net (Docker `internal: true`) ends in `connect ENETUNREACH`,
// because there's no route off the bridge except through the egress
// proxy on :3129. We saw exactly this in shopify-mcp on 2026-05-12 —
// DNS resolved fine (forwarder works), then the TCP dial hit
// ENETUNREACH because fetch ignored the env vars.
//
// undici.ProxyAgent honours HTTP CONNECT semantics (which is what our
// egress-proxy speaks). One agent, plugged in as global dispatcher,
// catches every fetch in the process including those buried deep in
// SDK libraries (grammy, @anthropic-ai/sdk, googleapis, …). No
// per-MCP code change needed — if it uses fetch, it goes through the
// proxy. If a library uses raw `http`/`https` modules instead (old
// `axios` does), those still bypass; we don't have any such consumer
// today, but if one shows up, install `global-agent` and it covers
// the legacy code paths too.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
                  process.env.HTTP_PROXY  || process.env.http_proxy  || null;
if (PROXY_URL) {
  try {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  } catch (err) {
    process.stderr.write(`[broker-client] failed to install proxy dispatcher (${PROXY_URL}): ${err.message}\n`);
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Send one request to the broker and resolve with the response object,
 * or reject with an error.
 */
function brokerCall(socketPath, request) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    let resolved = false;

    const finish = (fn, arg) => {
      if (resolved) return;
      resolved = true;
      try { sock.end(); } catch { /* already closed */ }
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`broker call timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx === -1) return;
      clearTimeout(timer);
      try {
        const resp = JSON.parse(buf.slice(0, newlineIdx));
        finish(resolve, resp);
      } catch (err) {
        finish(reject, new Error(`broker returned invalid JSON: ${err.message}`));
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, new Error(`broker connect failed: ${err.message}`));
    });

    sock.on('close', () => {
      if (!resolved) {
        clearTimeout(timer);
        finish(reject, new Error('broker closed connection without response'));
      }
    });
  });
}

/**
 * Public entry — load credentials for this MCP from the broker, populate
 * process.env, and zero out the nonce. Returns the response object
 * ({ fields } or { items }) for callers that need access to the raw
 * shape (multi-account integrations).
 *
 * Behavior when broker env vars are missing — i.e. the MCP is being run
 * outside the platform (local dev, manual debug): no-op success, return
 * null. The MCP code can then fall back to whatever it used pre-Phase-2
 * (read process.env directly, expecting the operator set it). This is
 * the friendly path for `node apps/grok-mcp/index.js` standalone.
 */
export async function loadCredentials() {
  const socketPath    = process.env.BROKER_SOCKET;
  const integrationId = process.env.BROKER_INTEGRATION_ID;
  const nonce         = process.env.BROKER_NONCE;

  if (!socketPath || !integrationId || !nonce) {
    // Dev / manual mode — no broker available, caller falls back to env.
    return null;
  }

  let resp;
  try {
    resp = await brokerCall(socketPath, {
      op: 'get',
      integrationId,
      nonce,
    });
  } catch (err) {
    process.stderr.write(`[broker-client] ${integrationId}: ${err.message}\n`);
    throw err;
  }

  if (!resp.ok) {
    const msg = `[broker-client] ${integrationId}: broker rejected: ${resp.error}`;
    process.stderr.write(msg + '\n');
    throw new Error(msg);
  }

  // Single integration: spread fields into process.env so existing MCP
  // code (which reads e.g. process.env.SHOPIFY_CLIENT_ID) keeps working
  // unchanged.
  if (resp.fields && typeof resp.fields === 'object') {
    for (const [key, value] of Object.entries(resp.fields)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      }
    }
  }

  // Multi-account: leave as-is for the caller. email-mcp reads from a
  // file written by workspace-api, not from env, so this is advisory.

  // Zero the nonce immediately — narrows the cross-uid /proc/<pid>/environ
  // theft window from "MCP lifetime" to "first 5-10ms after exec".
  delete process.env.BROKER_NONCE;

  return resp;
}
