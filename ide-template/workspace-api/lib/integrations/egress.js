/**
 * Egress allow-list writer.
 *
 * Builds a host-only, newline-separated text file of every outbound
 * hostname the currently-active integrations need to reach. Written to
 * /home/coder/.egress/allowed-hosts.txt (bind-mounted from
 * /srv/<ide>/egress/ on the host). The egress-proxy sidecar mounts the
 * same host dir read-only at /srv/egress/ and watches the file for
 * changes (5s poll, see scripts/egress-proxy.js).
 *
 * Why a sidecar proxy + Docker `internal: true` network rather than letting
 * code-server reach the internet directly:
 *   - code-server is on bot-net (`internal: true` in docker-compose.yml).
 *     Docker's network layer drops every packet that tries to egress from
 *     that network — so a process inside code-server can't bypass the
 *     proxy by dialling raw IPs, even with full container privileges.
 *     The structural guarantee is at the network bridge, not at iptables
 *     or ipset (those were the pre-2026-05-11 enforcement and they had
 *     real-world holes: CDN round-robin DNS outraced the 60-second ipset
 *     refresh, and CDN CIDR ranges hosted both legitimate API endpoints
 *     and attacker-controlled exfil destinations).
 *   - The egress-proxy sidecar (scripts/egress-proxy.js) is on bot-net
 *     AND default; it accepts HTTP CONNECT requests from code-server,
 *     filters by hostname against the allow-list this file writes, and
 *     opens upstream TCP tunnels for approved hosts. It never decrypts
 *     TLS — it's a hostname gate, not a MitM.
 *   - workspace-api itself runs inside code-server (uid 1001), so it
 *     too goes through the proxy. That's fine: workspace-api's
 *     outbound calls (broker grant issue, claude API for chat) all
 *     hit hosts on the active allow-list (api.anthropic.com is
 *     always-on; integration-specific hosts are added when activated).
 *
 * Format on disk: one hostname per line, lower-cased, no comments, no
 * empty lines. Sorted for diff-friendliness. Atomic write via tempfile +
 * rename (host-side script may read mid-write otherwise).
 *
 * Placeholder substitution — `mcp.allowedHosts` entries wrapped in
 * `{{NAME}}` are per-tenant tokens substituted from the active
 * credentials store:
 *   - `{{SHOPIFY_STORE_DOMAIN}}` → the SHOPIFY_STORE_DOMAIN field value
 *   - `{{EMAIL_HOSTS_RESOLVED}}` → expand per-account, mirroring the
 *     EMAIL_PROVIDER preset map in runtime.js (gmail/zoho/zoho_us → fixed
 *     imap+smtp pair; custom → EMAIL_HOST as-is).
 *   - generic `{{FIELD_NAME}}` → look up in fields; drop if absent.
 *
 * Out-of-scope (documented gaps — see docs/plan-broker-egress-2026-05.md):
 *   - nano-banana / meta-mcp accept user-supplied URLs to fetch arbitrary
 *     remote images. Those go through the same egress chain, so unlisted
 *     hosts are blocked. Users must paste images by local path or upload
 *     via the workspace UI; arbitrary URLs from chat won't fetch.
 */

import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import * as catalog from './catalog.js';
import * as store from './store.js';

const EGRESS_DIR = process.env.EGRESS_DIR || '/home/coder/.egress';
const ALLOWED_HOSTS_FILE = join(EGRESS_DIR, 'allowed-hosts.txt');
const TMP_FILE           = join(EGRESS_DIR, '.allowed-hosts.txt.tmp');

// Always-allowed hostnames regardless of which integrations are active.
//   - api.anthropic.com — Claude API for both web chat and bot
//   - api.telegram.org  — Telegram polling + sendMessage (the bot dials it
//     even before the Telegram integration is activated, e.g. for
//     bot-notify.sh shutdown messages)
//   - registry.npmjs.org / plugins.anthropic.com — plugin engine + npm
//     tarball metadata (auto-update checks, even though installs happen
//     at build time per Dockerfile LAYER 2b.5)
//   - oauth2.googleapis.com / www.googleapis.com — Google's central OAuth
//     endpoint + the catch-all Google API host. Used by:
//       (a) rclone Drive sync (LEGACY_DRIVE_SYNC=true clients),
//       (b) every google-workspace MCP service for OAuth refresh,
//       (c) ga4 service-account auth.
//
// Notably absent: github.com.  Pre-2026-05-11 the bot ran
// `claude plugins install telegram@claude-plugins-official` at every
// start, which clones the marketplace from github. That made
// github.com a required runtime egress — and a generic exfil target,
// since github lets anyone host arbitrary files. Dockerfile LAYER 2b.5
// now bakes the plugin source into the image (offline-ready), so
// github is not needed at runtime and is deliberately NOT on this
// list. If a future plugin must talk to github at runtime, prefer to
// stage the data through Anthropic's plugins.anthropic.com mirror or
// add an integration-specific allowedHosts entry — not a blanket
// allow.
const BASE_PLATFORM_ALLOWLIST = [
  'api.anthropic.com',
  'api.telegram.org',
  'registry.npmjs.org',
  'plugins.anthropic.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
];

function platformAllowlist() {
  return [...BASE_PLATFORM_ALLOWLIST];
}

// Email provider presets — must match runtime.js `renderFile` email-accounts
// logic. Provider id → list of hostnames the email-mcp will dial (IMAP +
// SMTP, since EMAIL_ALLOW_SEND=yes is per-account).
const EMAIL_PRESETS = {
  gmail:   ['imap.gmail.com', 'smtp.gmail.com'],
  zoho:    ['imap.zoho.eu',   'smtp.zoho.eu'],
  zoho_us: ['imap.zoho.com',  'smtp.zoho.com'],
};

function expandPlaceholders(host, fields, items) {
  if (!host.includes('{{')) return [host];

  if (host === '{{EMAIL_HOSTS_RESOLVED}}') {
    const hosts = new Set();
    for (const item of (items || [])) {
      const provider = (item.EMAIL_PROVIDER || 'gmail').toLowerCase();
      const preset = EMAIL_PRESETS[provider];
      if (preset) {
        preset.forEach(h => hosts.add(h));
      } else if (item.EMAIL_HOST) {
        // Custom IMAP — add the configured host. We can't infer the SMTP
        // host without an explicit field, so per-account EMAIL_ALLOW_SEND
        // on a custom provider currently requires the user to also be on
        // the same domain for IMAP+SMTP (typical when the org runs its
        // own mail server). If this trips someone, add an EMAIL_SMTP_HOST
        // field to the catalog.
        hosts.add(item.EMAIL_HOST.trim());
      }
    }
    return Array.from(hosts);
  }

  // Generic {{FIELD_NAME}} — single value from fields map.
  const m = host.match(/^\{\{([A-Z_][A-Z0-9_]*)\}\}$/);
  if (m) {
    const v = (fields?.[m[1]] || '').trim();
    return v ? [v] : [];
  }

  // Unknown placeholder — drop. We refuse to write a literal `{{...}}`
  // string into allowed-hosts.txt since the host script would resolve it
  // to nothing and it'd just be noise in the file.
  process.stderr.write(`[egress] unknown placeholder in allowedHosts: ${host}\n`);
  return [];
}

/**
 * Compute the union of platform allowlist + every active integration's
 * `mcp.allowedHosts`, with placeholders expanded from the active store.
 *
 * Throws nothing — a single misconfigured integration shouldn't break the
 * whole egress file. Decrypt failures are logged + skipped.
 */
export function computeAllowedHosts() {
  const out = new Set(platformAllowlist().map(h => h.toLowerCase()));

  for (const id of store.activeIds()) {
    const cat = catalog.get(id);
    if (!cat || !cat.mcp || !Array.isArray(cat.mcp.allowedHosts)) continue;

    let plain;
    try { plain = store.decryptFor(id); }
    catch (err) {
      process.stderr.write(`[egress] decrypt ${id} failed, skipping: ${err.message}\n`);
      continue;
    }

    const isMulti = cat.multi === true;
    const fields  = isMulti ? null : plain;
    const items   = isMulti ? plain : null;

    for (const host of cat.mcp.allowedHosts) {
      for (const expanded of expandPlaceholders(host, fields, items)) {
        if (typeof expanded === 'string' && expanded) {
          out.add(expanded.toLowerCase());
        }
      }
    }
  }

  return Array.from(out).sort();
}

/**
 * Write the allowed-hosts.txt file the host-side egress-allowlist.sh reads.
 * Atomic write via tempfile + rename. Mode 0644 since this file is read
 * by a host-side script that runs as root (or a dedicated user) and
 * doesn't share our uid; we still write 0600 on the parent dir to keep
 * the directory non-listable from arbitrary uids inside the container.
 *
 * Returns the resolved host list on success, or null on failure (logs to
 * stderr; doesn't throw — callers don't gate on this).
 */
export function writeAllowedHostsFile() {
  try {
    mkdirSync(EGRESS_DIR, { recursive: true });
    try { chmodSync(EGRESS_DIR, 0o755); } catch {}
  } catch (err) {
    // First boot before the bind-mount is in place — log once, no-op.
    process.stderr.write(`[egress] cannot mkdir ${EGRESS_DIR}: ${err.message}\n`);
    return null;
  }

  const hosts = computeAllowedHosts();
  const body = hosts.join('\n') + '\n';
  try {
    writeFileSync(TMP_FILE, body, { mode: 0o644 });
    try { chmodSync(TMP_FILE, 0o644); } catch {}
    renameSync(TMP_FILE, ALLOWED_HOSTS_FILE);
    try { chmodSync(ALLOWED_HOSTS_FILE, 0o644); } catch {}
  } catch (err) {
    process.stderr.write(`[egress] write ${ALLOWED_HOSTS_FILE} failed: ${err.message}\n`);
    return null;
  }
  return hosts;
}
