/**
 * Credential broker — UDS server that delivers decrypted credentials to
 * MCPs over a Unix domain socket gated by group membership.
 *
 * Lives in-process inside workspace-api (uid 1001). MCPs (uid 1002) call
 * here at startup with a nonce that workspace-api issued at spawn time.
 * Broker validates the nonce → integration mapping and returns plaintext
 * fields. The nonce stays valid for 24h (see NONCE_TTL_MS rationale below)
 * and is multi-use within that window so MCP crash-recovery + lazy-spawn
 * still works.
 *
 * Threat model the broker addresses:
 *   1. Bot (uid 1003) / coder (uid 1000) tries to read
 *      /proc/<wsapi-pid>/environ — different uid, kernel returns EACCES.
 *   2. Bot / coder tries to connect to /var/wsapi-store/run/broker.sock —
 *      file is mode 0660 owned wsapi:wsapi-broker; coder + bot are NOT in
 *      that group; connect fails at filesystem layer.
 *   3. Compromised MCP-A (uid 1002) reads MCP-B's nonce from
 *      /proc/<mcp-b-pid>/environ — same uid 1002, /proc allows the read.
 *      Stolen nonce is valid for the rest of the 24h window — but only
 *      for MCP-B's integration (the broker checks integrationId binding,
 *      see (4)). The structural protection here is the uid split, not
 *      nonce uniqueness.
 *   4. Compromised MCP-A calls broker.get with MCP-B's nonce asking for
 *      MCP-B's integration — broker delivers MCP-B's credentials. This
 *      is an accepted residual risk (audit re-evaluation 2026-05-11):
 *      MCPs are first-party code; the uid isolation already shuts the
 *      high-impact coder→mcp leak; sibling-MCP impersonation would
 *      require pre-existing RCE in one of our own MCP packages.
 *
 * Wire protocol — line-oriented JSON over UDS, one request per
 * connection. Server reads one line of JSON, writes one line of JSON,
 * closes. Keeps the protocol surface minimal.
 *
 *   Request:  { "op": "get", "integrationId": "shopify", "nonce": "abc123" }
 *   Response: { "ok": true, "fields": { ... }, "items": [ ... ]? }
 *             | { "ok": false, "error": "string" }
 */

import { createServer } from 'node:net';
import { unlinkSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const SOCKET_PATH = process.env.BROKER_SOCKET || '/var/wsapi-store/run/broker.sock';
// Grants are valid for 24h after issue. The original design (30s TTL +
// single-use) assumed every MCP would fetch its credentials within
// milliseconds of being spawned. Claude actually lazy-spawns MCPs
// (delayed until the first tool call that needs them), and re-spawns
// after crashes — both of which arrive well after the 30s window, with
// the same nonce. The result was every broker-mediated integration
// failing silently. 24h covers a normal bot session lifetime; the
// process-level uid isolation is what keeps coder/bot uids out, not the
// nonce TTL.
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQ_BYTES = 4 * 1024;
// How often the janitor sweeps expired grants. Decoupled from TTL —
// with a 24h TTL we don't want to wait that long to evict, but also
// don't need to spin every 30s.
const JANITOR_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Active grants — Map<nonce, { integrationId, expiresAt }>
 *
 * Nonces are issued by workspace-api at MCP-spawn time (written into
 * the mcpServers config). MCPs claim them at startup and re-use them
 * on crash recovery. Grants are NOT single-use — claude can re-spawn
 * an MCP that crashed and the new process needs the same broker
 * answer. The integration-id binding (consumeGrant checks
 * grant.integrationId === requested integrationId) means a sibling
 * MCP that scraped MCP-B's nonce from /proc/<pid>/environ can only
 * use it to claim MCP-B's credentials — not its own — which is
 * exactly the impersonation case the integrationId check covers.
 * Sibling-MCP impersonation of a different integration's credentials
 * remains possible inside the 24h window and is an accepted residual
 * risk (audit re-evaluation 2026-05-11): the uid isolation alone
 * already prevents the much higher-impact coder→mcp leak, and our
 * MCPs are first-party code, not arbitrary user input.
 */
const grants = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, grant] of grants) {
    if (grant.expiresAt < now) grants.delete(nonce);
  }
}, JANITOR_INTERVAL_MS).unref();

/**
 * Issue a fresh credential grant for `integrationId`. Returns the
 * nonce string the caller should pass to the MCP via env.
 *
 * Called by lib/integrations/runtime.js when building the mcpServers
 * config — every spawn gets a freshly-minted nonce so we never reuse
 * across integrations, but the MCP process behind it may consume the
 * grant multiple times (e.g. on crash recovery).
 */
export function issueGrant(integrationId) {
  const nonce = randomBytes(32).toString('base64url');
  grants.set(nonce, {
    integrationId,
    expiresAt: Date.now() + NONCE_TTL_MS,
  });
  return nonce;
}

/**
 * Resolve a nonce + claimed integrationId to the live grant. Returns
 * null on miss / mismatch / expiry. Does NOT consume the grant — see
 * the rationale in the grants map comment above.
 */
function consumeGrant(nonce, integrationId) {
  const grant = grants.get(nonce);
  if (!grant)                                 return null;
  if (grant.expiresAt < Date.now())           return null;
  if (grant.integrationId !== integrationId)  return null;
  return grant;
}

/**
 * Start the UDS server. Idempotent — if SOCKET_PATH already exists from
 * a stale workspace-api crash, we unlink + bind fresh.
 */
export function startBroker({ getCredentials, onLog }) {
  // Make sure the parent dir exists. entrypoint.sh creates it root-owned
  // chmod 2770 group=wsapi-broker; we only need to bind a socket in it.
  try { mkdirSync(dirname(SOCKET_PATH), { recursive: true }); } catch {}

  // Clean up stale socket from a previous boot.
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch {}
  }

  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let resolved = false;

    socket.setTimeout(5_000);
    socket.on('timeout', () => socket.destroy());

    socket.on('data', (chunk) => {
      if (resolved) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_REQ_BYTES) {
        respond(socket, { ok: false, error: 'request too large' });
        resolved = true;
        return;
      }
      const newlineIdx = buf.indexOf(0x0a);
      if (newlineIdx === -1) return;   // wait for full line

      const line = buf.subarray(0, newlineIdx).toString('utf8');
      resolved = true;

      let req;
      try { req = JSON.parse(line); }
      catch {
        respond(socket, { ok: false, error: 'invalid json' });
        return;
      }

      handleRequest(req, { getCredentials, onLog })
        .then(resp => respond(socket, resp))
        .catch(err => {
          onLog?.('error', `[broker] handler crashed: ${err.message}`);
          respond(socket, { ok: false, error: 'internal error' });
        });
    });

    socket.on('error', () => { /* logged by the parent process */ });
  });

  server.listen(SOCKET_PATH, () => {
    // Mode 0660 — owner (wsapi) read/write, group (wsapi-broker) read/write,
    // world: nothing. mcp uid 1002 is in wsapi-broker group; coder uid
    // 1000 is NOT, so it cannot connect at the filesystem layer.
    try {
      chmodSync(SOCKET_PATH, 0o660);
      onLog?.('info', `[broker] listening on ${SOCKET_PATH}`);
    } catch (err) {
      onLog?.('error', `[broker] chmod ${SOCKET_PATH} failed: ${err.message}`);
    }
  });

  server.on('error', (err) => {
    onLog?.('error', `[broker] server error: ${err.message}`);
  });

  return server;
}

async function handleRequest(req, { getCredentials, onLog }) {
  if (!req || typeof req !== 'object') {
    return { ok: false, error: 'malformed request' };
  }

  if (req.op !== 'get') {
    return { ok: false, error: `unknown op: ${req.op}` };
  }

  const integrationId = String(req.integrationId || '').trim();
  const nonce = String(req.nonce || '').trim();
  if (!integrationId || !nonce) {
    return { ok: false, error: 'missing integrationId or nonce' };
  }
  if (!/^[a-z0-9-]{1,32}$/.test(integrationId)) {
    return { ok: false, error: 'invalid integrationId' };
  }
  if (nonce.length > 256 || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
    return { ok: false, error: 'invalid nonce' };
  }

  const grant = consumeGrant(nonce, integrationId);
  if (!grant) {
    onLog?.('warn', `[broker] grant rejected for ${integrationId} (nonce missing/used/expired/mismatch)`);
    return { ok: false, error: 'grant invalid' };
  }

  let creds;
  try { creds = await getCredentials(integrationId); }
  catch (err) {
    onLog?.('error', `[broker] getCredentials(${integrationId}) failed: ${err.message}`);
    return { ok: false, error: 'decrypt failed' };
  }
  if (!creds) {
    return { ok: false, error: 'integration not active' };
  }

  onLog?.('info', `[broker] delivered ${integrationId}`);
  // creds is either { fields: {...} } for single integrations or
  // { items: [...] } for multi (e.g. email-imap with multiple accounts).
  // The MCP-side broker-client knows which shape to expect per integration.
  return { ok: true, ...creds };
}

function respond(socket, payload) {
  try {
    socket.write(JSON.stringify(payload) + '\n');
  } catch { /* socket may be already closed */ }
  socket.end();
}
