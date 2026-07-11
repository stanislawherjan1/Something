/**
 * Playwright `storageState` parser, validator, and domain-scoped filter.
 *
 * Legacy cookie-paste login model (the docs-comments integration has since
 * migrated to the interactive browser-login flow; this parser is kept for
 * backward compatibility / any future paste-based integration):
 *   - UI pastes a JSON dump of cookies + origins from the user's logged-in
 *     browser session (DevTools / EditThisCookie export).
 *   - Backend filters that JSON down to ONLY the cookies/origins we want
 *     the bot to see — mail.google.com, drive.google.com, etc. are stripped
 *     even though the user pasted them. Defense in depth: catalog egress
 *     allowlist gates network at TCP-level, Playwright route handler gates
 *     per-request, and this filter ensures we don't even persist out-of-
 *     scope cookies in encrypted form.
 *
 * SHA-256 hashes are computed for both the pre-filter and post-filter
 * cookie set and written to the integration's audit log. Three uses:
 *   - Diagnose why a session expired earlier than expected (compare hash
 *     trajectory).
 *   - Forensics: confirm bot wasn't shipped a stash of cookies for sites
 *     it shouldn't have known about.
 *   - Detect drift: if a future deploy quietly changes the filter
 *     whitelist, audit-log hashes show the post-filter set silently
 *     gained / lost entries.
 *
 * No persisted secrets in this module — caller (store.activate) handles
 * encryption. We only manipulate plain-text JSON for the few milliseconds
 * between parse and pass-through.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Domain whitelist for cookies + origins. Anything not matching one of
// these (exact match, OR cookie's domain ends with `.<entry>`) is stripped.
// Curated to minimum required for docs.google.com to function:
//   - docs.google.com         — primary target
//   - accounts.google.com     — SSO + session refresh
//   - apis.google.com         — internal Docs JSON API
//   - ssl.gstatic.com         — static assets (CSS, fonts, JS bundles)
//   - lh3.googleusercontent.com — user avatars in Docs UI
//   - fonts.googleapis.com    — webfonts
//   - fonts.gstatic.com       — webfont files
//   - clients4.google.com     — Google session keep-alive
//   - clients6.google.com     — Google session keep-alive
//   - .google.com             — top-level SSO cookies (SID, HSID, NID,
//                                APISID, SAPISID, etc.) that Google sets
//                                without a subdomain to share login state
//                                across all properties. Required for any
//                                Docs request to authenticate.
//
// Notably EXCLUDED:
//   - mail.google.com, drive.google.com, photos.google.com, calendar.google.com
//   - youtube.com, googleusercontent.com (broad)
//   - keep.google.com, scholar.google.com, news.google.com
//   - .googleadservices.com, .doubleclick.net (ad tracking)
//
// The `.google.com` entry IS a compromise: any cookie set on `.google.com`
// is by design shared across every Google service. The bot's egress
// allowlist (catalog mcp.allowedHosts) and Playwright route gate prevent
// network reach to mail/drive/etc., so even though the cookie is present,
// the bot can't *use* it to query those services. Total airgap would
// require killing `.google.com` cookies — which kills SSO refresh, which
// kills the whole point of the integration.
const ALLOWED_DOMAINS = [
  'docs.google.com',
  'accounts.google.com',
  'apis.google.com',
  'ssl.gstatic.com',
  'lh3.googleusercontent.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'clients4.google.com',
  'clients6.google.com',
  '.google.com',
];

const ALLOWED_ORIGINS = new Set([
  'https://docs.google.com',
  'https://accounts.google.com',
  'https://apis.google.com',
]);

/**
 * Cookie domain test. Cookies use both ".foo.com" (RFC 2109, "this host +
 * any subdomain") and "foo.com" (host-only) forms interchangeably for the
 * same origin — browsers treat them as the same site. We normalise both
 * sides by stripping the leading dot before comparison.
 *
 * Examples — all match:
 *   cookie ".docs.google.com" vs whitelist "docs.google.com"
 *   cookie  "docs.google.com" vs whitelist "docs.google.com"
 *   cookie ".google.com"      vs whitelist ".google.com"
 *   cookie  "google.com"      vs whitelist ".google.com"
 *
 * Still rejected: "mail.google.com" — not in whitelist, and ".google.com"
 * is NOT a wildcard suffix here. Only exact-after-dot-strip matches.
 */
function isAllowedDomain(domain) {
  if (typeof domain !== 'string' || !domain) return false;
  const stripDot = (s) => (s.startsWith('.') ? s.slice(1) : s);
  const d = stripDot(domain.toLowerCase());
  for (const allowed of ALLOWED_DOMAINS) {
    if (d === stripDot(allowed)) return true;
  }
  return false;
}

/**
 * Parse the user-pasted JSON string. Accepts either:
 *   - Playwright `storageState()` shape: `{ cookies: [...], origins: [...] }`
 *   - EditThisCookie / Chrome DevTools export shape: bare array of cookies
 *
 * Throws with a user-facing message if neither shape matches. The thrown
 * message is safe to surface in the UI — it does NOT include cookie values,
 * just structure-level diagnostics.
 */
export function parseStorageState(rawJson) {
  if (typeof rawJson !== 'string' || rawJson.trim() === '') {
    throw new Error('Empty input: paste the JSON export from your browser.');
  }
  let parsed;
  try { parsed = JSON.parse(rawJson); }
  catch (err) { throw new Error(`Invalid JSON: ${err.message}`); }

  // Bare array → wrap as cookies-only state.
  if (Array.isArray(parsed)) {
    return { cookies: parsed, origins: [] };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cookies)) {
    return {
      cookies: parsed.cookies,
      origins: Array.isArray(parsed.origins) ? parsed.origins : [],
    };
  }
  throw new Error(
    'Unrecognised shape: expected either a Playwright storageState object ' +
    '({cookies, origins}) or a bare cookies array.'
  );
}

/**
 * Strip cookies + origins that aren't in our whitelist. Returns a new
 * object, never mutates the input. `filtered` summary helps the audit log
 * show what was dropped without exposing values.
 */
export function filterStorageState(state) {
  const cookiesIn = Array.isArray(state.cookies) ? state.cookies : [];
  const originsIn = Array.isArray(state.origins) ? state.origins : [];

  const cookiesKept = [];
  const cookiesDropped = []; // domains only, for audit summary
  for (const c of cookiesIn) {
    if (c && typeof c === 'object' && isAllowedDomain(c.domain)) {
      cookiesKept.push(c);
    } else if (c && typeof c === 'object' && c.domain) {
      cookiesDropped.push(c.domain);
    }
  }

  const originsKept = [];
  const originsDropped = [];
  for (const o of originsIn) {
    if (o && typeof o === 'object' && typeof o.origin === 'string' && ALLOWED_ORIGINS.has(o.origin)) {
      originsKept.push(o);
    } else if (o && o.origin) {
      originsDropped.push(o.origin);
    }
  }

  const filtered = { cookies: cookiesKept, origins: originsKept };
  const summary = {
    cookies_in:       cookiesIn.length,
    cookies_kept:     cookiesKept.length,
    cookies_dropped:  cookiesIn.length - cookiesKept.length,
    origins_in:       originsIn.length,
    origins_kept:     originsKept.length,
    // Unique domain summary of what was stripped — useful when an operator
    // wonders "why isn't <X>.google.com working" (answer: it was filtered
    // out, here's the list).
    dropped_domains:  [...new Set(cookiesDropped)].sort(),
    dropped_origins:  [...new Set(originsDropped)].sort(),
  };
  return { filtered, summary };
}

/**
 * Stable SHA-256 over the cookie *names* (sorted, joined with `\n`).
 * We deliberately don't hash the cookie values — the goal is to detect
 * "what session is this" (which set of cookies were stored), not to be
 * able to confirm a specific cookie value via offline lookup. Names-only
 * hashing also avoids accidentally building a rainbow-tableable artifact.
 */
export function hashCookieNames(state) {
  const names = (Array.isArray(state.cookies) ? state.cookies : [])
    .map(c => (c && typeof c.name === 'string' ? `${c.domain || ''}|${c.name}` : ''))
    .filter(Boolean)
    .sort();
  return createHash('sha256').update(names.join('\n')).digest('hex');
}

/**
 * Append an audit-log line to the integration's audit JSONL. Caller
 * supplies the project workspace dir (so we land in
 * <project>/.docs-comments-audit.jsonl). Idempotent — creates parent dir if
 * missing, opens for append.
 *
 * Fields stored:
 *   ts                          — ISO 8601 timestamp
 *   event                       — "storage-state-saved" (this entry type)
 *   pre_filter_hash             — SHA-256 of original cookie name set
 *   post_filter_hash            — SHA-256 of filtered cookie name set
 *   summary                     — { cookies_in, cookies_kept, ... } from
 *                                  filterStorageState()
 *
 * No values, no cookie content, no PII. Audit log can sit alongside the
 * project files without exposing anything sensitive — it's a hash + count
 * trail, not a recovery vector.
 */
export function appendAuditEntry(auditPath, entry) {
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, JSON.stringify(entry) + '\n', { mode: 0o640 });
  } catch (err) {
    // Audit failure shouldn't block the activation. Log to stderr; the
    // operator sees the warning in pm2 logs, the integration still works.
    process.stderr.write(`[storage-state] audit append failed (${auditPath}): ${err.message}\n`);
  }
}

/**
 * One-shot helper called by store.activate when a field is declared with
 * `type: "storage-state-json"`. Parses, filters, hashes, audit-logs,
 * returns the filtered JSON string ready to encrypt + persist.
 *
 *   const filteredJsonStr = processStorageStateField(rawJson, auditPath);
 *   encrypted[name] = encryptValue(filteredJsonStr);
 *
 * Throws on invalid input (parseStorageState's error message bubbles up).
 */
export function processStorageStateField({ rawJson, auditPath, integrationId }) {
  const parsed = parseStorageState(rawJson);
  const preHash = hashCookieNames(parsed);
  const { filtered, summary } = filterStorageState(parsed);
  const postHash = hashCookieNames(filtered);

  if (auditPath) {
    appendAuditEntry(auditPath, {
      ts:               new Date().toISOString(),
      event:            'storage-state-saved',
      integration_id:   integrationId,
      pre_filter_hash:  preHash,
      post_filter_hash: postHash,
      summary,
    });
  }

  return JSON.stringify(filtered);
}

// Exported for testing — the whitelist is intentionally module-private
// otherwise, so callers can't loosen it by accident.
export const _testing = { ALLOWED_DOMAINS, ALLOWED_ORIGINS, isAllowedDomain };
