#!/usr/bin/env node
/**
 * Egress proxy — HTTP CONNECT-only proxy that gates outbound TCP by
 * hostname (NOT by IP). Runs in its own container (see
 * Dockerfile.egress-proxy + docker-compose.yml egress-proxy service).
 *
 * Why a hostname-based proxy and not just ipset of resolved IPs:
 *   - CDN-fronted APIs (Trello via AWS CloudFront, Gmail via Google
 *     edge, Substack via Cloudflare, …) round-robin large pools of
 *     IPs that the upstream's DNS rotates faster than a once-per-60s
 *     ipset refresh can keep up with — so legitimate API calls
 *     intermittently blackhole.
 *   - The same CDN ranges host attacker-controlled endpoints (e.g.
 *     attacker.pages.dev on Cloudflare Pages, *.s3.amazonaws.com).
 *     Allowing the whole Cloudflare CIDR by IP would let a
 *     prompt-injected bot exfiltrate to any attacker-uploaded file
 *     on the same edge. Hostname-level filtering closes that loop.
 *
 * Architecture (see docker-compose.yml):
 *   - code-server container lives on `bot-net` with `internal: true`
 *     — it has no direct internet path at all. Its only neighbour
 *     with internet is this proxy container.
 *   - This proxy container sits on TWO networks: `bot-net` (where
 *     clients reach us on :3129) and the default bridge (where we
 *     reach the open internet).
 *   - All container processes (claude, MCPs, workspace-api, bot.sh,
 *     bun plugins, curl, npm install at boot) honour HTTPS_PROXY /
 *     HTTP_PROXY env vars set by entrypoint.sh. Anything that
 *     doesn't honour them simply cannot reach the internet because
 *     `internal: true` blocks the path at the docker network layer.
 *
 * Protocol: HTTP CONNECT only.
 *   - Client sends `CONNECT api.trello.com:443 HTTP/1.1` followed by
 *     CRLFCRLF. We parse the host, look it up in the allow-list, and
 *     either open a TCP tunnel and reply `200 Connection established`
 *     or reply `403 Forbidden` and close.
 *   - We never decrypt TLS, never see the request body, never see
 *     credentials. The proxy is a pure hostname gate.
 *
 * Allow-list source: /srv/egress/allowed-hosts.txt (bind-mounted
 * read-only from the host). workspace-api writes this file every
 * time an integration activates/deactivates (egress.js
 * writeAllowedHostsFile). We watch it for changes via fs.watchFile
 * with a 5-second poll — cheap and sufficient given the file changes
 * at human cadence, not request cadence.
 *
 * Wildcard support:
 *   - Exact match: `api.trello.com` → allows `api.trello.com:*`
 *   - Suffix match: `*.substack.com` → allows any `<x>.substack.com:*`
 *     (including the apex itself — `*.substack.com` matches
 *     `substack.com` because the suffix without the dot is allowed.
 *     If you want the apex separately, list it explicitly.)
 *
 * Ports: anything. We don't whitelist by port (the host part already
 * narrows attack surface enough; if you wanted to be paranoid, only
 * allow 443/80/993/587/25 in a future revision).
 *
 * Operational notes:
 *   - PORT defaults to 3129. Override with EGRESS_PROXY_PORT.
 *   - HOST defaults to 0.0.0.0 (so containers on bot-net can reach
 *     us; the network's `internal: true` already prevents external
 *     reach).
 *   - Idle CONNECT tunnels are not killed by us — kernel + upstream
 *     handle that. We do set a 30s timeout on the initial HTTP
 *     header read so half-open clients don't pile up.
 *   - On allowlist file missing / unreadable: behaviour is fail-closed
 *     (empty set, deny everything). Safer than fail-open.
 *
 * Logging: every request gets one line — `ALLOW host:port` or
 * `DENY host:port` (plus `reload` lines when the file changes).
 * Quiet enough for production, loud enough to diagnose a "why isn't
 * my MCP reaching its API" complaint without enabling debug.
 */

'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const fs = require('node:fs');
const dnsp = require('node:dns').promises;

// Resolve hostnames using the SAME upstream the code-server container
// queries (via our :53 forwarder below) — keeps egress-proxy and clients
// in sync on which IPs Google returns under DNS round-robin. Without
// this, the container's default resolver (Docker's 127.0.0.11) may pick
// a different subset of Google's IMAP/SMTP IPs than our forwarder did,
// and the libraries' pre-resolved IP gets denied even though we hold
// other valid Google IPs in cache.
const proxyResolver = new dnsp.Resolver();

const PORT  = parseInt(process.env.EGRESS_PROXY_PORT || '3129', 10);
const HOST  = process.env.EGRESS_PROXY_HOST || '0.0.0.0';
const FILE  = process.env.EGRESS_ALLOWED_HOSTS_FILE || '/srv/egress/allowed-hosts.txt';
const HEADER_TIMEOUT_MS = 30_000;
const MAX_HEADER_BYTES  = 4_096;

// Second CONNECT listener — `:3130`, used by @playwright/mcp's
// `--proxy-server`. CONNECT requests here are forwarded with a less
// restrictive filter than `:3129`. Rationale + tradeoffs are kept in
// operator-only notes (not in this repo). Other clients route through
// `:3129` and stay subject to the allow-list.
const OPEN_PORT = parseInt(process.env.EGRESS_PROXY_OPEN_PORT || '3130', 10);

// DNS forwarder config — see DNS section near the bottom of this file.
// Default port 53/udp on the same proxy container. Requires
// CAP_NET_BIND_SERVICE on the node binary in the image (we run as an
// unprivileged user). EGRESS_PROXY_DNS_UPSTREAM is the public resolver
// we trust on the proxy's outbound interface.
const DNS_PORT     = parseInt(process.env.EGRESS_PROXY_DNS_PORT || '53', 10);
const DNS_UPSTREAM = process.env.EGRESS_PROXY_DNS_UPSTREAM || '1.1.1.1';

// Now that DNS_UPSTREAM is known, pin proxyResolver to the same server.
// See the proxyResolver declaration above for the rationale.
proxyResolver.setServers([DNS_UPSTREAM]);
const DNS_TIMEOUT_MS = 3_000;
// Cap concurrent in-flight queries so a misbehaving caller can't
// exhaust file descriptors. Each in-flight query owns one UDP socket.
const DNS_MAX_INFLIGHT = 512;

let exactHosts = new Set();   // "api.trello.com" → exact match
let exactIPs   = new Set();   // resolved IPs for hosts above — covers libs that pre-resolve before CONNECT
let suffixHosts = [];          // "substack.com" derived from "*.substack.com"

// Why exactIPs:
// nodemailer's http-proxy-client + imapflow's proxy-connection both
// DNS-resolve the destination hostname locally BEFORE sending the
// CONNECT request to us — they ship `CONNECT 64.233.167.109:993` not
// `CONNECT imap.gmail.com:993`. Hostname-only allow-list would deny.
// We resolve each allowed hostname here at reload time and accept
// requests targeting any of those IPs. Reload runs every 5s when the
// allow-list file changes (fs.watchFile) AND on a 5-min refresh timer
// to catch DNS rotations even without a file change.
const IP_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function loadHosts() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (err) {
    console.error(`[egress-proxy] cannot read ${FILE}: ${err.message} — denying all (fail-closed)`);
    exactHosts = new Set();
    exactIPs = new Set();
    suffixHosts = [];
    return;
  }
  const exact = new Set();
  const suffix = [];
  for (const line of raw.split('\n')) {
    const h = line.trim().toLowerCase();
    if (!h || h.startsWith('#')) continue;
    if (h.startsWith('*.')) {
      // *.substack.com → match anything ending with .substack.com AND
      // the apex (substack.com) itself.
      suffix.push(h.slice(2));
    } else {
      exact.add(h);
    }
  }

  // Resolve each exact hostname to A records. Parallel — one slow lookup
  // doesn't block the others. IP literals (already in `exact`) are
  // skipped. Failures per-host are swallowed; the hostname itself still
  // counts as allowed, so HTTP CONNECT to the hostname form still works.
  const newIPs = new Set();
  await Promise.all([...exact].map(async (h) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return;     // skip IPv4 literals
    if (/^\[?[0-9a-f:]+\]?$/i.test(h)) return;       // skip IPv6 literals
    try {
      const ips = await proxyResolver.resolve4(h);
      ips.forEach(ip => newIPs.add(ip));
    } catch {
      // DNS miss is fine — the hostname form still works.
    }
  }));

  exactHosts = exact;
  exactIPs = newIPs;
  suffixHosts = suffix;
  console.log(`[egress-proxy] reload: ${exact.size} exact + ${suffix.length} wildcard + ${newIPs.size} resolved IPs`);
}

// Initial load (async; CONNECT requests arriving before it completes
// will see empty allow-list and get 403 — that's fail-closed, expected).
loadHosts().catch(err => console.error(`[egress-proxy] initial load failed: ${err.message}`));
// Reload when the allow-list file changes.
fs.watchFile(FILE, { interval: 5_000 }, () => {
  loadHosts().catch(err => console.error(`[egress-proxy] reload error: ${err.message}`));
});
// Periodic IP-only refresh to catch DNS rotations without a file edit.
setInterval(() => {
  loadHosts().catch(err => console.error(`[egress-proxy] periodic refresh error: ${err.message}`));
}, IP_REFRESH_INTERVAL_MS).unref();

// ─── DNS snoop cache ──────────────────────────────────────────────────────
// The IMAP/SMTP libraries (imapflow, nodemailer's http-proxy-client) DNS-
// resolve the destination hostname client-side via libc getaddrinfo BEFORE
// issuing CONNECT to us. With Google's round-robin DNS, libc's resolved IP
// is one of many in the rotation pool, and a static cache populated by our
// own resolve4() call will hit different IPs on each query — race lost.
//
// The fix: the same libc resolve goes THROUGH our :53 forwarder. We're the
// resolver. Snoop our own DNS responses, parse out A records for any
// allow-listed hostname, and remember the IP → hostname mapping with the
// DNS TTL. When a subsequent CONNECT arrives with that IP, allow it.
//
// This guarantees the proxy and the client are looking at IDENTICAL DNS
// responses, because they share the exact same upstream call. Round-robin
// is no longer a race — it's the same answer for both sides.
//
// Map keyed by IP for O(1) CONNECT-time lookup. Entry carries the source
// hostname (observability + audit) and absolute expiry (real DNS TTL).
const dnsSnoopCache = new Map();   // ip → { hostname, expiresAt }
const DNS_SNOOP_TTL_FLOOR_S  = 60;    // never less than 1 min, in case DNS TTL is silly-small
const DNS_SNOOP_TTL_CEIL_S   = 3600;  // never more than 1 hr, so stale IPs evict reasonably

// Janitor — evict expired entries every minute. Bounded by allow-list size
// times typical Google rotation depth (~30 IPs per host * 15 hosts = 450),
// so the loop is cheap.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of dnsSnoopCache) {
    if (entry.expiresAt < now) dnsSnoopCache.delete(ip);
  }
}, 60_000).unref();

function isHostnameAllowed(host) {
  host = host.toLowerCase();
  if (exactHosts.has(host)) return true;
  for (const suf of suffixHosts) {
    if (host === suf || host.endsWith('.' + suf)) return true;
  }
  return false;
}

function isAllowed(host) {
  host = host.toLowerCase();
  if (exactHosts.has(host)) return true;
  if (exactIPs.has(host)) return true;                // static warmup cache
  const snooped = dnsSnoopCache.get(host);             // dynamic snoop cache
  if (snooped && snooped.expiresAt > Date.now()) return true;
  for (const suf of suffixHosts) {
    if (host === suf || host.endsWith('.' + suf)) return true;
  }
  return false;
}

// ─── On-miss DNS resolve ─────────────────────────────────────────────────
// Round-robin DNS escape hatch. When the iptables/redsocks transparent
// chain forwards a CONNECT with an IP address (not a hostname), and that
// IP is in none of our caches, we may still be looking at a legitimate
// allow-listed host — the client's resolver and ours just hit different
// shards of the rotation pool. Real example caught 2026-05-13:
// bun grammy multipart sendPhoto pre-resolves api.telegram.org to
// 149.154.167.220, but our `loadHosts()` resolve4 at boot got
// 149.154.166.110 — the IP isn't in exactIPs, snoop never saw it (bun
// caches DNS in-process, never re-asks our forwarder), and we DENY a
// real Telegram IP.
//
// The fix: on cache miss for an IP-literal host, re-resolve every
// allow-listed hostname *now* and check if the unknown IP shows up in
// any A-record set. If yes, promote it into exactIPs so subsequent
// CONNECTs hit the sync path instantly; if no, it really isn't ours,
// stay DENY. In-flight de-dupe so a burst of CONNECTs for the same
// unknown IP fires one lookup, not N.
//
// Threat-model: this only ALLOWS an IP after confirming a fresh DNS
// query for an allow-listed name actually returned that IP. Attacker
// who controls a DNS response could in theory cause us to allow their
// IP — but that requires either compromising 1.1.1.1 or our DNS
// forwarder's upstream, in which case the snoop cache is equally
// compromised. No new attack surface vs the existing dns-snoop model.
const inflightResolves = new Map();
async function resolveHostCached(hostname) {
  const existing = inflightResolves.get(hostname);
  if (existing) return existing;
  const p = proxyResolver.resolve4(hostname).catch(() => []);
  inflightResolves.set(hostname, p);
  // Drop the de-dupe entry after a short window. We don't want to cache
  // the result here (resolveHostCached is purely for collapsing concurrent
  // misses); the real cache is exactIPs + dnsSnoopCache.
  p.finally(() => setTimeout(() => inflightResolves.delete(hostname), 1000).unref());
  return p;
}

async function isAllowedAsync(host) {
  if (isAllowed(host)) return true;
  // Hostname (not IP) that didn't match any allow-list entry — no point
  // resolving allow-listed hosts to "discover" this name. DENY.
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;

  // IP-literal not in any cache. Try resolving every allow-listed hostname
  // in parallel and see if any of them currently maps to this IP.
  const candidates = [...exactHosts].filter(h =>
    !/^\d+\.\d+\.\d+\.\d+$/.test(h) && !/^\[?[0-9a-f:]+\]?$/i.test(h),
  );
  const results = await Promise.all(candidates.map(async h => {
    const ips = await resolveHostCached(h);
    return ips.includes(host) ? h : null;
  }));
  const match = results.find(Boolean);
  if (!match) return false;

  exactIPs.add(host);
  dnsSnoopCache.set(host, {
    hostname: match,
    expiresAt: Date.now() + DNS_SNOOP_TTL_FLOOR_S * 1000,
  });
  console.log(`[egress-proxy] on-miss-resolve ${host} matched ${match}`);
  return true;
}

// ─── DNS wire-format parser (RFC 1035) ────────────────────────────────────
// Just enough to extract qname + IPv4 A records from a response. Defensive
// bounds-checks everywhere; malformed responses return null and never
// throw. Handles name compression (the 0xC0 pointer convention) in answer
// section names — Google's responses use it heavily.

function readDnsName(buf, offset) {
  // Returns { name, next } walking past one name, or null on malformed.
  // `next` is where to resume parsing (always past the original location,
  // even when we followed a compression jump to read the name itself).
  const labels = [];
  let next = offset;
  let originalNext = -1;        // first non-pointer continuation
  let hops = 0;
  while (next < buf.length) {
    if (++hops > 100) return null;        // anti-loop guard
    const len = buf[next];
    if (len === 0) {
      const fallthrough = next + 1;
      return { name: labels.join('.'), next: originalNext >= 0 ? originalNext : fallthrough };
    }
    if ((len & 0xc0) === 0xc0) {
      if (next + 2 > buf.length) return null;
      if (originalNext < 0) originalNext = next + 2;
      const ptr = ((len & 0x3f) << 8) | buf[next + 1];
      if (ptr >= buf.length || ptr === next) return null;
      next = ptr;
    } else {
      if (next + 1 + len > buf.length) return null;
      labels.push(buf.slice(next + 1, next + 1 + len).toString('ascii'));
      next += 1 + len;
    }
  }
  return null;
}

function parseDnsResponse(buf) {
  if (buf.length < 12) return null;
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  if (qdcount === 0 || ancount === 0) return null;

  let offset = 12;
  const q = readDnsName(buf, offset);
  if (!q) return null;
  offset = q.next + 4;                                  // skip qtype + qclass
  // Skip any additional questions (rare; usually qdcount = 1)
  for (let i = 1; i < qdcount; i++) {
    const n = readDnsName(buf, offset);
    if (!n) return null;
    offset = n.next + 4;
  }

  const aRecords = [];
  for (let i = 0; i < ancount; i++) {
    const n = readDnsName(buf, offset);
    if (!n) return null;
    offset = n.next;
    if (offset + 10 > buf.length) return null;
    const type   = buf.readUInt16BE(offset);
    const cls    = buf.readUInt16BE(offset + 2);
    const ttl    = buf.readUInt32BE(offset + 4);
    const rdlen  = buf.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdlen > buf.length) return null;
    // Only A records in IN class. AAAA (28), CNAME (5), etc. ignored.
    if (type === 1 && cls === 1 && rdlen === 4) {
      const ip = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`;
      const clamped = Math.min(Math.max(ttl, DNS_SNOOP_TTL_FLOOR_S), DNS_SNOOP_TTL_CEIL_S);
      aRecords.push({ ip, ttl: clamped });
    }
    offset += rdlen;
  }
  return { qname: q.name.toLowerCase(), aRecords };
}

function snoopDnsResponse(resp) {
  // Best-effort: any parse error swallowed, the forward proceeds untouched.
  let parsed;
  try { parsed = parseDnsResponse(resp); } catch { return; }
  if (!parsed || parsed.aRecords.length === 0) return;
  if (!isHostnameAllowed(parsed.qname)) return;
  const now = Date.now();
  for (const { ip, ttl } of parsed.aRecords) {
    dnsSnoopCache.set(ip, {
      hostname: parsed.qname,
      expiresAt: now + ttl * 1000,
    });
  }
  console.log(`[egress-proxy] dns-snoop ${parsed.qname} → ${parsed.aRecords.map(r => r.ip).join(',')}`);
}

function makeConnectServer({ tag, strict }) {
  return net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { client.end('HTTP/1.1 408 Request Timeout\r\n\r\n'); } catch {}
    }, HEADER_TIMEOUT_MS);

    client.on('data', (chunk) => {
      if (resolved) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_HEADER_BYTES) {
        resolved = true;
        clearTimeout(timer);
        try { client.end('HTTP/1.1 413 Payload Too Large\r\n\r\n'); } catch {}
        return;
      }
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      resolved = true;
      clearTimeout(timer);

      const headerText = buf.slice(0, headerEnd).toString('utf8');
      const firstLine = headerText.split('\r\n', 1)[0] || '';
      const m = firstLine.match(/^CONNECT\s+([A-Za-z0-9._\-:]+):(\d{1,5})\s+HTTP\/1\.[01]\s*$/);
      if (!m) {
        console.log(`[egress-proxy] ${tag} BADREQ ${JSON.stringify(firstLine).slice(0, 120)}`);
        try { client.end('HTTP/1.1 400 Bad Request\r\n\r\nOnly CONNECT method supported.\r\n'); } catch {}
        return;
      }
      const host = m[1];
      const port = parseInt(m[2], 10);

      // Async path: isAllowedAsync may need to fire DNS resolves on a
      // cache miss for IP-literal CONNECTs from the transparent chain.
      // Track client liveness so we don't waste cycles dialling upstream
      // if the client gave up while we were resolving.
      let clientGone = false;
      client.once('close', () => { clientGone = true; });
      (async () => {
        const allowed = strict ? await isAllowedAsync(host) : true;
        if (clientGone) return;
        if (!allowed) {
          console.log(`[egress-proxy] ${tag} DENY ${host}:${port}`);
          try { client.end(`HTTP/1.1 403 Forbidden\r\n\r\nHostname ${host} not in egress allow-list.\r\n`); } catch {}
          return;
        }

        console.log(`[egress-proxy] ${tag} ALLOW ${host}:${port}`);
        const upstream = net.createConnection({ host, port }, () => {
          try { client.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: egress-proxy/1\r\n\r\n'); } catch {}
          const leftover = buf.slice(headerEnd + 4);
          if (leftover.length) upstream.write(leftover);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', (err) => {
          console.log(`[egress-proxy] ${tag} UPSTREAM_ERR ${host}:${port} ${err.message}`);
          try { client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}\r\n`); } catch {}
        });
        upstream.on('close', () => { try { client.end(); } catch {} });
        client.on('close', () => { try { upstream.destroy(); } catch {} });
        client.on('error', () => { try { upstream.destroy(); } catch {} });
      })().catch((err) => {
        console.log(`[egress-proxy] ${tag} HANDLER_ERR ${host}:${port} ${err.message}`);
        try { client.end('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } catch {}
      });
    });

    client.on('error', () => { /* client dropped — fine */ });
  });
}

// Strict listener — every client except the one configured for the
// open port (see OPEN_PORT comment near top of file) routes through here.
const server = makeConnectServer({ tag: 'strict', strict: true });
server.on('error', (err) => {
  console.error(`[egress-proxy] server error: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`[egress-proxy] listening on ${HOST}:${PORT}, allow-list ${FILE}`);
});

// Open listener — bypasses isAllowed(). Tagged separately in the log so
// open-mode connections are clearly attributable in audit.
const openServer = makeConnectServer({ tag: 'open', strict: false });
openServer.on('error', (err) => {
  // Don't exit — the strict listener is the critical path; open mode
  // failing just means Playwright-style clients can't browse, but the
  // rest of the system still works.
  console.error(`[egress-proxy] open server error: ${err.message}`);
});
openServer.listen(OPEN_PORT, HOST, () => {
  console.log(`[egress-proxy] OPEN listening on ${HOST}:${OPEN_PORT}`);
});

// ─── DNS forwarder ────────────────────────────────────────────────────────
// code-server lives on bot-net with `internal: true` — its only path to
// any external host is via this container. CONNECT proxy on :3129 covers
// HTTP/S, but HTTP clients running there (Node fetch / undici, curl,
// bun, npm) all do a local DNS lookup for the target hostname BEFORE
// they issue CONNECT — and on internal:true Docker DNS only resolves
// inter-container names, so external lookups fail with EAI_AGAIN. The
// fix is to give bot-net containers our IP as their DNS server (via
// `dns:` in docker-compose) and forward queries here.
//
// We don't filter on DNS: a bot prompt-injection that tries to
// exfiltrate to `attacker.com` will resolve it just fine, but then
// hits the CONNECT filter on :3129 and gets 403. Trying to filter at
// DNS layer too would (a) require parsing DNS wire format,
// (b) duplicate the allow-list source of truth, (c) silently break
// reverse-DNS / CNAME chains. Easier to enforce in one place — the
// hostname inside the CONNECT request line.
//
// Stateless forward: client UDP -> us -> upstream -> us -> client.
// One ephemeral UDP socket per query, capped at DNS_MAX_INFLIGHT.
// Any failure (timeout, upstream down) just lets the client retry —
// no caching, no caching bugs.
let dnsInflight = 0;
const dnsServer = dgram.createSocket('udp4');

dnsServer.on('message', (query, rinfo) => {
  if (dnsInflight >= DNS_MAX_INFLIGHT) {
    // Drop the query silently — the client will retry, and inflight
    // will have drained by then. Logging every drop would amplify
    // the storm; the inflight count itself is the signal.
    return;
  }
  dnsInflight++;

  const up = dgram.createSocket('udp4');
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    try { up.close(); } catch { /* already closed */ }
    dnsInflight--;
  };
  const timer = setTimeout(finish, DNS_TIMEOUT_MS);

  up.once('message', (resp) => {
    clearTimeout(timer);
    // Snoop BEFORE forwarding to client — populates dnsSnoopCache with
    // (ip → hostname) bindings so the subsequent CONNECT to one of those
    // IPs is allowed. See dnsSnoopCache rationale near top of file.
    snoopDnsResponse(resp);
    try { dnsServer.send(resp, rinfo.port, rinfo.address); } catch { /* client may have gone */ }
    finish();
  });
  up.on('error', () => { clearTimeout(timer); finish(); });

  up.send(query, 53, DNS_UPSTREAM, (err) => {
    if (err) { clearTimeout(timer); finish(); }
  });
});

dnsServer.on('error', (err) => {
  console.error(`[egress-proxy] DNS server error: ${err.message}`);
  // Don't exit — CONNECT proxy is still useful even if DNS dies.
  // docker HEALTHCHECK pings :3129 which keeps working.
});

dnsServer.bind(DNS_PORT, '0.0.0.0', () => {
  console.log(`[egress-proxy] DNS listening on 0.0.0.0:${DNS_PORT}, upstream ${DNS_UPSTREAM}`);
});

// Graceful shutdown so docker stop is fast.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[egress-proxy] ${sig} — closing servers`);
    server.close(() => {
      try { dnsServer.close(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
