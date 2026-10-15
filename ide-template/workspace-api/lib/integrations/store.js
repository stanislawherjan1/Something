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
import { requiredFields, allFields, get as getCatalog, baseId, slugOf } from './catalog.js';
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

/*
 * Owner and reach. Every connection has an owner (the slug of the person who
 * connected it) and a reach: `workspace` — an admin connected it for
 * everyone, keyed by the integration id (`granola`); `personal` — a person
 * connected their own account, keyed `<id>@<slug>` (`granola@ann`), loaded
 * in that person's turns only. Same file, same encryption, same broker; the
 * key is what tells them apart. A connection from before this had no owner:
 * it is the workspace's, owned by the primary admin (ensureOwners, at boot).
 */
export const REACHES = ['workspace', 'personal'];
/*
 * Access. A workspace connection is `read` (the team reads through it, its
 * write tools are refused in every turn by the scope-guard hook) or `write`
 * (the default, and what a connection from before had). A person's own
 * connection is always `write` — their account, their call.
 */
export const ACCESSES = ['read', 'write'];
export function accessOf(key) {
  const e = readAll()[key];
  if (!e) return null;
  if (isPersonalKey(key)) return 'write';
  return ACCESSES.includes(e.access) ? e.access : 'write';
}
/**
 * A workspace connection becomes a person's own (when collaboration is
 * switched on, the owner keeps what was theirs): decrypted and written again
 * under `id@slug` — the encryption is bound to the key — then the workspace's
 * is removed. Refuses when the person already has their own of it.
 */
export function makePersonal(id, slug) {
  if (isPersonalKey(id)) throw new Error('already a personal connection');
  const state = readAll();
  if (!state[id]) throw new Error(`${id} is not active`);
  const key = personalKey(id, slug);
  if (state[key]) throw new Error('they already have their own');
  const plain = decryptFor(id);
  activate(key, Array.isArray(plain) ? { items: plain.map(fields => ({ fields })) } : { fields: plain }, { owner: slug, reach: 'personal' });
  remove(id);
  appendAudit('make-personal', key, [], { from: id });
  return key;
}

export function setAccess(key, access) {
  if (!ACCESSES.includes(access)) throw new Error('access must be read or write');
  if (isPersonalKey(key)) throw new Error('your own connection is always read and write');
  const state = readAll();
  if (!state[key]) throw new Error(`${key} is not active`);
  state[key].access = access;
  writeAll(state);
  appendAudit('access', key, [], { access });
  return access;
}
/** Server name → 'read' for every read-only workspace connection; what the hook enforces. */
export function readOnlyServers(serverNamesOf) {
  const out = {};
  for (const [key, e] of Object.entries(readAll())) {
    if (isPersonalKey(key) || e?.access !== 'read') continue;
    for (const name of serverNamesOf(key)) out[name] = 'read';
  }
  return out;
}
export const personalKey = (id, slug) => `${baseId(id)}@${slug}`;
export const isPersonalKey = (key) => slugOf(key) !== null;

/** Workspace connections: the keys with no slug. */
export function workspaceIds() { return Object.keys(readAll()).filter(k => !isPersonalKey(k)); }
/** One person's own connections, as keys (`granola@ann`). */
export function personalIds(slug) { return slug ? Object.keys(readAll()).filter(k => slugOf(k) === slug) : []; }
/** The people who connected their own account of this integration. */
export function peopleWith(id) {
  const base = baseId(id);
  return Object.keys(readAll()).map(k => (baseId(k) === base ? slugOf(k) : null)).filter(Boolean);
}
/** Owner and reach of a key, or null when it is not connected. */
export function ownership(key) {
  const e = readAll()[key];
  if (!e) return null;
  return { owner: e.owner || null, reach: isPersonalKey(key) ? 'personal' : 'workspace' };
}
/** Connections from before owners existed become the workspace's, owned by `ownerSlug`. Returns how many. */
export function ensureOwners(ownerSlug) {
  const state = readAll();
  let n = 0;
  for (const [key, e] of Object.entries(state)) {
    if (!e || typeof e !== 'object') continue;
    if (!e.reach) { e.reach = isPersonalKey(key) ? 'personal' : 'workspace'; n++; }
    if (!e.owner && ownerSlug && !isPersonalKey(key)) { e.owner = ownerSlug; n++; }
    if (!e.owner && isPersonalKey(key)) { e.owner = slugOf(key); n++; }
  }
  if (n) writeAll(state);
  return n;
}
/** A person left: their own connections go with them. Returns the keys removed. */
export function removePersonalAll(slug) {
  const state = readAll();
  const gone = Object.keys(state).filter(k => slugOf(k) === slug);
  for (const k of gone) { appendAudit('remove', k, Object.keys(state[k].fields || {}), { reason: 'person removed' }); delete state[k]; }
  if (gone.length) writeAll(state);
  return gone;
}

/* ─── What a connection holds, for its page ──────────────────────────────── */

/** One stored field for the screen: a non-secret value in clear, a secret as `{ length, last4 }`, never both. */
function fieldView(def, record) {
  if (!record) return { name: def.name, set: false };
  const secret = def.type === 'secret' || def.type === 'json' || def.type === 'remote-mcp-oauth' || /storage-state|browser-login|password|token|secret|key/i.test(`${def.type} ${def.name}`);
  // A short secret's last characters would be most of it: shown as length alone.
  const short = (sum) => (sum && sum.length <= 8 ? { ...sum, last4: '' } : sum);
  if (secret) return { name: def.name, set: true, summary: short(summariseRecord(record)) };
  try { return { name: def.name, set: true, value: decryptValue(record) }; }
  catch { return { name: def.name, set: true, summary: short(summariseRecord(record)) }; }
}

/**
 * A connection as its page shows it: every catalog field with whether it is
 * set (a secret only as length and last characters), the items of a multi
 * connection (each its fields the same way), owner, reach, when. Null when
 * not connected. Plaintext secrets never leave the store this way.
 */
export function detail(key) {
  const state = readAll();
  const entry = state[key];
  if (!entry) return null;
  const cat = getCatalog(key);
  const defs = cat?.fields || [];
  const out = { key, id: baseId(key), owner: entry.owner || null, reach: isPersonalKey(key) ? 'personal' : 'workspace', access: accessOf(key), activatedAt: entry.activatedAt || null };
  if (cat?.multi) {
    out.items = (entry.items || []).map((it, i) => ({ index: i, fields: defs.map(d => fieldView(d, it.fields?.[d.name])) }));
  } else {
    out.fields = defs.map(d => fieldView(d, entry.fields?.[d.name]));
  }
  return out;
}

/** Add one account to a multi connection (email: a mailbox). Returns the new item's index. */
export function addItem(key, fields) {
  const cat = getCatalog(key);
  if (!cat?.multi) throw new Error(`${cat?.label || key} holds one set of settings, not a list`);
  const state = readAll();
  const entry = state[key];
  if (!entry) throw new Error(`${key} is not active`);
  const items = entry.items || [];
  items.push({ fields: buildEncryptedItem(key, fields || {}) });
  entry.items = items;
  state[key] = entry;
  writeAll(state);
  appendAudit('add-item', key, [], { items: items.length });
  return items.length - 1;
}

/** Change one account's fields in place (only the fields given; a secret left blank is kept). */
export function updateItem(key, index, fields) {
  const cat = getCatalog(key);
  if (!cat?.multi) throw new Error(`${cat?.label || key} holds one set of settings, not a list`);
  const state = readAll();
  const entry = state[key];
  const item = entry?.items?.[index];
  if (!item) throw new Error('no such item');
  const allowed = new Set(allFields(key));
  const updates = {};
  for (const [name, value] of Object.entries(fields || {})) {
    if (!allowed.has(name) || typeof value !== 'string' || value.trim() === '') continue;
    updates[name] = encryptValue(value.trim());
  }
  if (!Object.keys(updates).length) throw new Error('nothing to change');
  item.fields = { ...(item.fields || {}), ...updates };
  writeAll(state);
  appendAudit('update-item', key, Object.keys(updates), { index });
  return Object.keys(updates);
}

/** Remove one account from a multi connection; the last one removes the connection itself. */
export function removeItem(key, index) {
  const cat = getCatalog(key);
  if (!cat?.multi) throw new Error(`${cat?.label || key} holds one set of settings, not a list`);
  const state = readAll();
  const entry = state[key];
  if (!entry?.items?.[index]) throw new Error('no such item');
  entry.items.splice(index, 1);
  const last = entry.items.length === 0;
  if (last) delete state[key]; else state[key] = entry;
  writeAll(state);
  appendAudit(last ? 'remove' : 'remove-item', key, [], { index });
  return { removedConnection: last, items: entry.items.length };
}

/** Return whether an integration has stored credentials (= active). */
export function isActive(id) {
  const state = readAll();
  return Boolean(state[id]);
}

/**
 * Paused: connected, key kept, but switched off for now (catalog `pausable`).
 * Stored as the internal field PAUSED. A paused
 * integration is left out of its tools and of the egress allow-list.
 */
export function isPaused(id) {
  if (!getCatalog(id)?.pausable || !isActive(id)) return false;
  try { return decryptFor(id)?.PAUSED === 'yes'; } catch { return false; }
}

/** Connected and not paused — what callers mean by "can be used now". */
export function isUsable(id) {
  return isActive(id) && !isPaused(id);
}

export function setPaused(id, paused) {
  if (!getCatalog(id)?.pausable) throw new Error(`${id} cannot be paused`);
  return updateInternal(id, { PAUSED: paused ? 'yes' : 'no' });
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
        owner:       entry.owner || null,
        reach:       isPersonalKey(id) ? 'personal' : 'workspace',
        access:      isPersonalKey(id) ? 'write' : (ACCESSES.includes(entry.access) ? entry.access : 'write'),
      };
      continue;
    }

    const primaryFieldName = cat?.fields?.[0]?.name;
    const primary = primaryFieldName ? entry.fields?.[primaryFieldName] : null;
    out[id] = {
      active:      true,
      activatedAt: entry.activatedAt || null,
      summary:     primary ? summariseRecord(primary) : null,
      owner:       entry.owner || null,
      reach:       isPersonalKey(id) ? 'personal' : 'workspace',
      access:      isPersonalKey(id) ? 'write' : (ACCESSES.includes(entry.access) ? entry.access : 'write'),
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

export function activate(id, body, { owner = null, reach = null, access = null } = {}) {
  const cat = getCatalog(id);
  if (!cat || cat.comingSoon) throw new Error(`unknown integration: ${id}`);
  const who = owner || slugOf(id) || null;
  const how = reach || (isPersonalKey(id) ? 'personal' : 'workspace');
  const level = how === 'personal' ? 'write' : (ACCESSES.includes(access) ? access : 'write');
  if (how === 'personal' && !isPersonalKey(id)) throw new Error('a personal connection is keyed by its owner');
  if (how === 'personal' && !cat.personal) throw new Error(`${cat.label} can only be connected for the workspace`);

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
      owner:       who,
      reach:       how,
      access:      level,
    };
    writeAll(state);
    appendAudit('activate', id, [], { items: encryptedItems.length, owner: who, reach: how, access: level });
    return;
  }

  // Single-set integration — body shape: { fields: {...} } or {NAME: ...}
  const fields = body?.fields || body || {};
  const encrypted = buildEncryptedItem(id, fields);
  state[id] = {
    activatedAt: new Date().toISOString(),
    fields:      encrypted,
    owner:       who,
    reach:       how,
    access:      level,
  };
  writeAll(state);
  appendAudit('activate', id, Object.keys(encrypted), { owner: who, reach: how, access: level });
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
 * Server-side write of internal fields the catalog does NOT declare. update()
 * above is UI-driven and filters against the catalog so operators can only edit
 * declared fields — but some fields are owned by the SERVER, not the operator
 * (telegram's TELEGRAM_ALLOWED_IDS is derived from the team roster; its catalog
 * entry was removed when the settings panel took over, which silently killed
 * every roster→allowlist sync through update()). Values are encrypted exactly
 * like update()'s. Never expose this through a route.
 */
export function updateInternal(id, fields) {
  const state = readAll();
  const entry = state[id];
  if (!entry) throw new Error(`${id} is not active`);

  const updates = {};
  for (const [name, value] of Object.entries(fields || {})) {
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    updates[name] = encryptValue(value.trim());
  }
  const updatedNames = Object.keys(updates);
  if (updatedNames.length === 0) {
    throw new Error('no fields supplied to updateInternal.');
  }

  const cat = getCatalog(id);
  if (cat?.multi) {
    entry.items = (entry.items || []).map(item => ({
      ...item,
      fields: { ...(item.fields || {}), ...updates },
    }));
  } else {
    entry.fields = { ...(entry.fields || {}), ...updates };
  }
  state[id] = entry;
  writeAll(state);
  appendAudit('update-internal', id, updatedNames);
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
