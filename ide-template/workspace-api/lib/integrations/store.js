/**
 * Encrypted credentials store + audit log.
 *
 * Layout under PROJECT_DIR (HARD_HIDDEN — never visible via /api/files/*):
 *   .integrations/credentials.json   — { <id>: { activatedAt, fields: { <name>: <encryptedRecord> } } }
 *   .integrations/audit.log          — append-only JSONL: { ts, action, id, fieldNames }
 *
 * File mode 0600 (owner read/write only). Reads are atomic via readFileSync.
 * Writes are atomic via tempfile + rename to avoid partial-write corruption
 * if the process is killed mid-write.
 *
 * The store does NOT itself decide whether encryption is configured — callers
 * (routes/integrations.js) check `crypto.isReady()` first and bail with 503.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from '../config.js';
import { encryptValue, decryptValue, summariseRecord } from './crypto.js';
import { requiredFields, allFields, get as getCatalog } from './catalog.js';
import { processStorageStateField } from './storage-state.js';

// Phase-2 broker isolation: the encrypted store moved out of PROJECT_DIR
// (which is shared with code-server uid 1000 + mcp uid 1002 via the
// `workspace` group) into /var/wsapi-store/ which is owned by uid 1001
// only. PROJECT_DIR-shared meant any group member could read the
// ciphertext — which still required the AES key, but defence in depth.
//
// The fallback to PROJECT_DIR/.integrations is for dev mode (no
// WSAPI_STORE_DIR set, no uid split) — in production both env var and
// uid split are always in place.
const DIR        = process.env.WSAPI_STORE_DIR || join(PROJECT_DIR, '.integrations');
const CREDS_FILE = join(DIR, 'credentials.json');
const AUDIT_FILE = join(DIR, 'audit.log');
const TMP_FILE   = join(DIR, '.credentials.json.tmp');

function ensureDir() {
  mkdirSync(DIR, { recursive: true });
  // Mode 0711: owner full, others traverse-only. NOT 0700 — that blocks
  // mcp uid 1002 from reaching the broker UDS at /var/wsapi-store/run/
  // broker.sock. Linux requires +x on every path component; mcp's
  // wsapi-broker group membership on the sub-dir is useless if it can't
  // traverse this parent. Files inside (credentials.json, audit.log)
  // stay 0600 wsapi-only via per-file chmod in writeAll, so +x on the
  // dir grants navigation to a known sub-path only — no list, no read.
  // entrypoint.sh chmod 0711's this on boot too, but every
  // readAll/writeAll comes through here and would have overwritten the
  // entrypoint chmod with 0700 a few seconds later — that silently
  // broke every broker-mediated MCP from Phase 2 until 2026-05-11.
  try { chmodSync(DIR, 0o711); } catch {}
}

function readAll() {
  ensureDir();
  if (!existsSync(CREDS_FILE)) return {};
  try {
    const raw = readFileSync(CREDS_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`[integrations-store] read failed: ${err.message}\n`);
    return {};
  }
}

function writeAll(state) {
  ensureDir();
  // Write to a temp file then rename so a crash mid-write can't corrupt the
  // canonical file. chmod the tempfile *before* it has interesting content.
  writeFileSync(TMP_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { chmodSync(TMP_FILE, 0o600); } catch {}
  renameSync(TMP_FILE, CREDS_FILE);
  try { chmodSync(CREDS_FILE, 0o600); } catch {}
}

function appendAudit(action, id, fieldNames, extra) {
  ensureDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    id,
    fieldNames: fieldNames || [],
    ...(extra || {}),
  }) + '\n';
  try {
    appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
    chmodSync(AUDIT_FILE, 0o600);
  } catch (err) {
    process.stderr.write(`[integrations-store] audit append failed: ${err.message}\n`);
  }
}

/** Return whether an integration has stored credentials (= active). */
export function isActive(id) {
  const state = readAll();
  return Boolean(state[id]);
}

/** Snapshot of every integration's status, for the dashboard. */
export function listStatus() {
  const state = readAll();
  const out = {};
  for (const id of Object.keys(state)) {
    const entry = state[id];
    const cat = getCatalog(id);

    if (cat?.multi) {
      const items = entry.items || [];
      out[id] = {
        active:      true,
        activatedAt: entry.activatedAt || null,
        itemCount:   items.length,
        summary:     null,
      };
      continue;
    }

    const primaryFieldName = cat?.fields?.[0]?.name;
    const primary = primaryFieldName ? entry.fields?.[primaryFieldName] : null;
    out[id] = {
      active:      true,
      activatedAt: entry.activatedAt || null,
      summary:     primary ? summariseRecord(primary) : null,
    };
  }
  return out;
}

/**
 * Save fields for an integration. Validates that every required field is
 * present and non-empty. Encrypts each value, writes atomically.
 *
 * Throws on validation error or if the integration is unknown / comingSoon.
 */
/**
 * Validate + encrypt one set of plain fields. Used by both single- and
 * multi-account integrations. Skips fields that are conditionally hidden
 * (showIf evaluated against the same item's values) so we don't insist on
 * an EMAIL_HOST when the user picked Gmail provider, for example.
 */
function buildEncryptedItem(id, plainFields) {
  const required = new Set(requiredFields(id));
  const allowed  = new Set(allFields(id));
  const cat = getCatalog(id);
  const fieldDefs = (cat?.fields || []).reduce((m, f) => (m[f.name] = f, m), {});

  const isVisible = (name) => {
    const def = fieldDefs[name];
    if (!def?.showIf) return true;
    return Object.entries(def.showIf).every(([k, v]) => plainFields?.[k] === v);
  };

  const cleaned = {};
  for (const name of allowed) {
    const v = plainFields?.[name];
    const present = typeof v === 'string' && v.trim() !== '';
    if (!present) {
      if (required.has(name) && isVisible(name)) {
        throw new Error(`field "${name}" is required`);
      }
      continue;
    }
    // Field type `storage-state-json` (legacy cookie-paste path; docs-comments
    // now uses the browser-login flow instead): the
    // raw paste is a Playwright storageState dump that we MUST filter to
    // a domain whitelist before persisting. Filter + hash + audit log,
    // then encrypt the cleaned JSON instead of the raw paste. Defense in
    // depth: even if the encryption store is compromised, attacker only
    // gets the post-filter cookie set, never the user's full Google
    // browser session. Failure surfaces a user-facing error (UI shows
    // "Invalid JSON" / "Unrecognised shape" rather than a 500).
    const def = fieldDefs[name];
    if (def?.type === 'storage-state-json') {
      cleaned[name] = processStorageStateField({
        rawJson: v,
        auditPath: join(PROJECT_DIR, `.${id}-audit.jsonl`),
        integrationId: id,
      });
      continue;
    }
    cleaned[name] = v.trim();
  }

  const encrypted = {};
  for (const [name, plain] of Object.entries(cleaned)) {
    encrypted[name] = encryptValue(plain);
  }
  return encrypted;
}

export function activate(id, body) {
  const cat = getCatalog(id);
  if (!cat || cat.comingSoon) throw new Error(`unknown integration: ${id}`);

  const state = readAll();

  if (cat.multi) {
    const items = Array.isArray(body?.items) ? body.items : [];
    const min = cat.minItems || 1;
    if (items.length < min) throw new Error(`At least ${min} item required.`);

    const encryptedItems = items.map(item => ({
      fields: buildEncryptedItem(id, item?.fields || item || {}),
    }));

    state[id] = {
      activatedAt: new Date().toISOString(),
      items:       encryptedItems,
    };
    writeAll(state);
    appendAudit('activate', id, [], { items: encryptedItems.length });
    return;
  }

  // Single-set integration — body shape: { fields: {...} } or {NAME: ...}
  const fields = body?.fields || body || {};
  const encrypted = buildEncryptedItem(id, fields);
  state[id] = {
    activatedAt: new Date().toISOString(),
    fields:      encrypted,
  };
  writeAll(state);
  appendAudit('activate', id, Object.keys(encrypted));
}

/**
 * Partial update of an active integration — used by PATCH /api/integrations/:id
 * for editing settings (e.g. flipping a Permissions toggle) without forcing
 * the user to re-paste credentials.
 *
 * Body shapes:
 *   { fields: {...partial...} }       — single integration: merge into entry.fields
 *   { globalFields: {...partial...} } — multi: merge into EVERY item.fields
 *
 * Only declared catalog fields are accepted; unknown names are silently
 * ignored. Empty-string values are also ignored (treated as "not provided").
 */
export function update(id, body) {
  const cat = getCatalog(id);
  if (!cat || cat.comingSoon) throw new Error(`unknown integration: ${id}`);

  const state = readAll();
  const entry = state[id];
  if (!entry) throw new Error(`${id} is not active`);

  const allowed = new Set(allFields(id));
  const incoming = body?.globalFields || body?.fields || {};
  if (!incoming || typeof incoming !== 'object') {
    throw new Error('body must include `fields` or `globalFields`.');
  }

  const updates = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!allowed.has(name)) continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    updates[name] = encryptValue(value.trim());
  }
  const updatedNames = Object.keys(updates);
  if (updatedNames.length === 0) {
    throw new Error('no recognised fields supplied to update.');
  }

  if (cat.multi) {
    // Propagate to every existing item — globalForMulti fields are
    // shared across accounts, and per-account edits on multi aren't
    // supported in this MVP. (Future: per-item PATCH with item index.)
    entry.items = (entry.items || []).map(item => ({
      ...item,
      fields: { ...(item.fields || {}), ...updates },
    }));
  } else {
    entry.fields = { ...(entry.fields || {}), ...updates };
  }
  state[id] = entry;
  writeAll(state);
  appendAudit('update', id, updatedNames);
  return updatedNames;
}

/**
 * Read plaintext values for non-secret global fields (those flagged
 * globalForMulti). Used by the dashboard so the Permissions panel can
 * pre-populate with the user's current choices when they click Settings.
 *
 * Secrets are NEVER returned — this is a non-secret-only path. Callers
 * read summarised secrets via the existing credentialSummary instead.
 */
export function readGlobalFieldValues(id) {
  const cat = getCatalog(id);
  if (!cat) return {};
  const exposable = (cat.fields || []).filter(f =>
    f.globalForMulti && f.type !== 'secret' && f.type !== 'json',
  );
  if (exposable.length === 0) return {};

  const state = readAll();
  const entry = state[id];
  if (!entry) return {};

  // For multi take the first item's snapshot — globalForMulti fields are
  // propagated identically to every item, so item[0] is canonical.
  const source = cat.multi
    ? (entry.items?.[0]?.fields || {})
    : (entry.fields || {});

  const out = {};
  for (const f of exposable) {
    const rec = source[f.name];
    if (!rec) continue;
    try { out[f.name] = decryptValue(rec); }
    catch { /* corrupt or wrong key — leave undefined */ }
  }
  return out;
}

/** Remove all stored credentials for an integration. No-op if not active. */
export function remove(id) {
  const state = readAll();
  if (!state[id]) return false;
  const fieldNames = Object.keys(state[id].fields || {});
  delete state[id];
  writeAll(state);
  appendAudit('remove', id, fieldNames);
  return true;
}


/**
 * Decrypt all fields for one integration. Returns plaintext map suitable for
 * spawn-time env injection. Throws if not active or decryption fails.
 *
 * INTENTIONALLY exported only for runtime.js (which builds spawn env).
 * Never exposed over the API.
 */
export function decryptFor(id) {
  const state = readAll();
  const entry = state[id];
  if (!entry) throw new Error(`${id} is not active`);

  const cat = getCatalog(id);
  if (cat?.multi) {
    return (entry.items || []).map(it => {
      const out = {};
      for (const [name, record] of Object.entries(it.fields || {})) {
        out[name] = decryptValue(record);
      }
      return out;
    });
  }

  const out = {};
  for (const [name, record] of Object.entries(entry.fields || {})) {
    out[name] = decryptValue(record);
  }
  return out;
}

/** All active integration ids — used by runtime to build mcpServers config. */
export function activeIds() {
  return Object.keys(readAll());
}
