/**
 * Auto-migration from legacy env vars (and bind-mounted config files) into
 * the encrypted integrations store.
 *
 * Runs on every workspace-api startup. Idempotent — for each integration:
 *   1. If already active in the store, skip (we don't overwrite what the
 *      user has explicitly set via the UI).
 *   2. Otherwise, read the source of truth (process.env, or a legacy bind-
 *      mounted file for email/GA4), validate every required field is present,
 *      and call store.activate() with the discovered values.
 *
 * Result: existing clients see their integrations already activated in the
 * dashboard right after the first redeploy with this code, without anyone
 * having to re-enter credentials.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as catalog from './catalog.js';
import * as store from './store.js';
import { isReady } from './crypto.js';
import * as runtime from './runtime.js';
import * as setup from '../setup.js';

const CLAUDE_TOKEN_RE = /^sk-ant-oat0[0-9]+-/;

// Legacy email accounts.json — admin-placed, bind-mounted read-only.
const LEGACY_EMAIL_FILE = '/home/coder/.email/accounts.json';

// Map an IMAP host to one of our catalog provider presets, falling back to
// "custom" so the migrated entry round-trips back to the user-editable form.
function providerFromHost(host) {
  const h = (host || '').toLowerCase();
  if (h === 'imap.gmail.com')          return 'gmail';
  if (h === 'imap.zoho.eu')            return 'zoho';
  if (h === 'imap.zoho.com')           return 'zoho_us';
  return 'custom';
}

// Placeholder patterns commonly left in .env templates that should NOT be
// migrated as real credentials. Otherwise activate ends up encrypting the
// literal string "FILL_ME" and the integration shows as Active in the
// dashboard even though the user never entered anything.
const PLACEHOLDER_RE = /^(FILL_ME|fill[_-]me|TODO|TBD|<.*>|your[_-].*[_-]here|xxx+|change[_-]?me)$/i;

function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).trim();
  if (!v) return true;
  return PLACEHOLDER_RE.test(v);
}

function tryActivateSimple(entry) {
  // Generic single-set integrations (grok, gemini-image, seedream, shopify,
  // meta-ads, google-ads, telegram). Pull each declared field directly from
  // process.env using the catalog field name (which matches the env var name
  // by convention for these). Placeholder values like FILL_ME are treated
  // as missing.
  const fields = {};
  const usedEnvVars = [];
  let allRequired = true;
  for (const f of (entry.fields || [])) {
    const v = process.env[f.name];
    if (typeof v === 'string' && v.trim() && !isPlaceholder(v)) {
      fields[f.name] = v.trim();
      usedEnvVars.push(f.name);
    } else if (!f.optional) {
      allRequired = false;
    }
  }
  if (!allRequired) return false;
  if (Object.keys(fields).length === 0) return false;

  store.activate(entry.id, { fields });
  return usedEnvVars;
}

function tryActivateEmailFromLegacyFile() {
  if (!existsSync(LEGACY_EMAIL_FILE)) return false;
  let raw;
  try { raw = readFileSync(LEGACY_EMAIL_FILE, 'utf8'); }
  catch { return false; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return false; }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;

  const items = parsed
    .filter(a => a && a.user && a.pass && a.host)
    .map(a => ({
      fields: {
        EMAIL_PROVIDER: providerFromHost(a.host),
        EMAIL_HOST:     a.host,
        EMAIL_PORT:     String(a.port ?? 993),
        EMAIL_USER:     String(a.user),
        EMAIL_PASS:     String(a.pass),
        EMAIL_ID:       String(a.id || a.user.split('@')[0] || 'primary'),
      },
    }));
  if (!items.length) return false;

  store.activate('email-imap', { items });
  // Source was a bind-mounted file, not env vars — return a sentinel so the
  // post-migration warning can call it out distinctly.
  return ['<file:/home/coder/.email/accounts.json>'];
}

function tryActivateGa4FromEnv() {
  const propId = (process.env.GA4_PROPERTY_ID || '').trim();
  const credsPath = (process.env.GA4_CREDENTIALS_JSON || '').trim();
  if (!propId || !credsPath) return false;
  if (isPlaceholder(propId) || isPlaceholder(credsPath)) return false;
  if (!existsSync(credsPath)) return false;

  let json;
  try { json = readFileSync(credsPath, 'utf8'); }
  catch { return false; }
  if (!json.trim()) return false;

  store.activate('ga4', {
    fields: {
      GA4_PROPERTY_ID:              propId,
      GA4_CREDENTIALS_JSON_CONTENT: json,
    },
  });
  return ['GA4_PROPERTY_ID', 'GA4_CREDENTIALS_JSON'];
}

/**
 * Run the migration. Logs every action to stderr (visible in PM2 logs).
 * Returns counts so the caller can summarise.
 *
 * Each successful tryActivate*() returns an array of the env var names (or
 * legacy file paths) it consumed, so the post-run summary can spell out
 * EXACTLY what should now be removed from the per-client `.env` to avoid
 * keeping plaintext credentials around after they've been encrypted.
 */
export function migrateFromLegacy() {
  if (!isReady()) {
    process.stderr.write('[migrate] encryption key not ready, skipping legacy migration\n');
    return { migrated: 0, skipped: 0, failed: 0, sources: [] };
  }

  let migrated = 0, skipped = 0, failed = 0;
  const consumedSources = [];

  // Claude OAuth token — pre-wizard clients had this in .env as
  // CLAUDE_CODE_OAUTH_TOKEN. The wizard now stores it encrypted via
  // setup.setClaudeToken. If we find a valid-looking token in env and the
  // encrypted store is empty, copy it across so setup.status() flips to
  // complete=true on the next request and the user isn't trapped in the
  // wizard's "Connect Claude" step.
  try {
    if (!setup.hasClaudeToken()) {
      const envTok = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
      if (envTok && CLAUDE_TOKEN_RE.test(envTok)) {
        setup.setClaudeToken(envTok, 'migration');
        consumedSources.push({ integration: '_platform', sources: ['CLAUDE_CODE_OAUTH_TOKEN'] });
        migrated++;
        process.stderr.write('[migrate] activated _platform (claude token) from CLAUDE_CODE_OAUTH_TOKEN env\n');
      }
    }
  } catch (err) {
    failed++;
    process.stderr.write(`[migrate] _platform claude token failed: ${err.message}\n`);
  }

  for (const entry of catalog.listAll()) {
    if (entry.comingSoon) continue;
    if (store.isActive(entry.id)) { skipped++; continue; }

    try {
      let used = false;
      if (entry.id === 'email-imap')      used = tryActivateEmailFromLegacyFile();
      else if (entry.id === 'ga4')        used = tryActivateGa4FromEnv();
      else                                used = tryActivateSimple(entry);

      if (used && Array.isArray(used)) {
        migrated++;
        consumedSources.push({ integration: entry.id, sources: used });
        process.stderr.write(`[migrate] activated ${entry.id} from legacy source (${used.join(', ')})\n`);
      }
    } catch (err) {
      failed++;
      process.stderr.write(`[migrate] ${entry.id} failed: ${err.message}\n`);
    }
  }

  // Apply file writes + sync .claude.json + install matching optional
  // skills for every active integration. Runs on every startup (not just
  // post-migration) so a new optional skill that ships in a later release
  // for an already-active integration also lands in the project on the
  // first restart that has it. installOptionalSkill / applyFiles are
  // idempotent — re-running for an already-set-up integration is a no-op.
  for (const entry of catalog.listAll()) {
    if (store.isActive(entry.id)) {
      try { runtime.applyFiles(entry.id); } catch {}
      try { runtime.installOptionalSkill(entry.id); } catch {}
    }
  }
  try { runtime.syncMcpServers(); } catch {}

  if (migrated > 0) {

    // Plaintext-credential housekeeping warning. The credentials are now in
    // the encrypted store, but the legacy plaintext sources (per-client .env
    // entries, bind-mounted accounts.json) are still on disk. Surface them
    // clearly in PM2 logs so the operator can prune them by hand on the next
    // deploy. We don't auto-delete because:
    //   - the .env lives on the operator's laptop, not in the container
    //   - pruning files at runtime races with admin edits
    //   - some operators may want to keep a fallback during transition
    const allEnvVars = Array.from(new Set(
      consumedSources.flatMap(s => s.sources).filter(v => !v.startsWith('<'))
    )).sort();
    const fileSources = consumedSources
      .flatMap(s => s.sources)
      .filter(v => v.startsWith('<'))
      .map(v => v.replace(/^<file:|>$/g, ''));

    process.stderr.write('[migrate] ──────────────────────────────────────────────────────\n');
    process.stderr.write('[migrate] PLAINTEXT CLEANUP — credentials are now encrypted, but\n');
    process.stderr.write('[migrate] the originals are still present on disk. Prune them:\n');
    if (allEnvVars.length > 0) {
      process.stderr.write('[migrate]   from clients/<client>/.env, remove these env vars:\n');
      for (const name of allEnvVars) process.stderr.write(`[migrate]     - ${name}\n`);
    }
    if (fileSources.length > 0) {
      process.stderr.write('[migrate]   from the host, the following files can be deleted:\n');
      for (const f of fileSources) process.stderr.write(`[migrate]     - ${f}\n`);
    }
    process.stderr.write('[migrate]   then `./deploy.sh code-server` to apply.\n');
    process.stderr.write('[migrate] ──────────────────────────────────────────────────────\n');
  }

  process.stderr.write(`[migrate] done — migrated=${migrated} already-active=${skipped} failed=${failed}\n`);
  return { migrated, skipped, failed, sources: consumedSources };
}
