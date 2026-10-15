/**
 * Loads + validates integrations.catalog.json once at startup.
 *
 * The catalog is the source of truth for which integrations exist, what
 * fields they need, what helper text the UI shows, and how to spawn the
 * MCP server (or which long-running process to restart).
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH       = join(__dirname, '..', '..', 'integrations.catalog.json');
// Optional, gitignored. Present on a client where the operator has staged
// an operator-only integration staged on one client's box. Entries here
// are merged on top of the main catalog at load time. Same shape: an
// object with `integrations: [...]`. Missing file is silently skipped —
// every other client sees only the shared catalog.
const CATALOG_LOCAL_PATH = process.env.INTEGRATIONS_CATALOG_LOCAL || join(__dirname, '..', '..', 'integrations.catalog.local.json');

let cached = null;
// The local catalog is read again when its file changes (a stat per lookup;
// an operator can add or override an entry without a restart).
let localStamp = null;
function stampOf(path) { try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; } catch { return null; } }

function validateEntry(i) {
  if (!i.id || typeof i.id !== 'string') throw new Error('integration missing id');
  if (i.comingSoon) return;
  // `fields[]` is required as an array but MAY be empty: a credential-less,
  // read-only integration (a keyless hosted server) activates with no inputs at all.
  if (!Array.isArray(i.fields)) {
    throw new Error(`integration ${i.id} must declare a fields[] array (empty is allowed for a credential-less integration)`);
  }
  for (const f of i.fields) {
    if (!f.name || !f.label) throw new Error(`integration ${i.id} field missing name/label`);
  }
}

function load() {
  const stamp = stampOf(CATALOG_LOCAL_PATH);
  if (cached && stamp === localStamp) return cached;
  localStamp = stamp;
  const raw = readFileSync(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.integrations)) {
    throw new Error('integrations.catalog.json: missing "integrations" array');
  }
  for (const i of parsed.integrations) validateEntry(i);
  // A person may connect their own account of anything, unless the entry says
  // `personal: false` (its runtime is bound to the bot's home, a browser, or the bot itself).
  for (const i of parsed.integrations) i.personal = i.personal !== false;

  // Merge local (gitignored) catalog if present. Last-write-wins on id
  // collision so a local entry CAN override a shared one if a future use
  // case wants that (rare; today only used for net-new private entries).
  if (existsSync(CATALOG_LOCAL_PATH)) {
    try {
      const localRaw = readFileSync(CATALOG_LOCAL_PATH, 'utf8');
      const localParsed = JSON.parse(localRaw);
      const localEntries = Array.isArray(localParsed?.integrations) ? localParsed.integrations : [];
      for (const i of localEntries) validateEntry(i);
      for (const i of localEntries) i.personal = i.personal !== false;
      const ids = new Set(localEntries.map(i => i.id));
      const merged = [
        ...parsed.integrations.filter(i => !ids.has(i.id)),
        ...localEntries,
      ];
      parsed.integrations = merged;
      process.stderr.write(`[catalog] merged ${localEntries.length} local integration(s): ${[...ids].join(', ')}\n`);
    } catch (err) {
      // Don't crash startup if the local file is malformed — log + continue
      // with the shared catalog only. Operators can spot the issue in logs.
      process.stderr.write(`[catalog] integrations.catalog.local.json invalid, ignoring: ${err.message}\n`);
    }
  }

  cached = parsed;
  return cached;
}

/** All catalog entries in declaration order. */
export function listAll() {
  return load().integrations;
}

/** One entry by id, or null. */
/** `granola@ann` → `granola`: a person's own connection is keyed by the integration id and their slug. */
export function baseId(key) {
  const s = String(key || '');
  const at = s.indexOf('@');
  return at === -1 ? s : s.slice(0, at);
}
/** The slug a personal key names, or null for a workspace key. */
export function slugOf(key) {
  const s = String(key || '');
  const at = s.indexOf('@');
  return at === -1 ? null : s.slice(at + 1) || null;
}

export function get(id) {
  id = baseId(id);
  return load().integrations.find(i => i.id === id) || null;
}

/** Required field names for an integration (excluding optional + comingSoon). */
export function requiredFields(id) {
  const i = get(id);
  if (!i || i.comingSoon) return [];
  return (i.fields || []).filter(f => !f.optional).map(f => f.name);
}

/** All declared field names — used by store.activate to encrypt optional ones too. */
export function allFields(id) {
  const i = get(id);
  if (!i || i.comingSoon) return [];
  return (i.fields || []).map(f => f.name);
}

/** Public-safe view of one entry (drops nothing today, but a guard for future). */
export function publicView(id) {
  const i = get(id);
  if (!i) return null;
  // Strip server-only fields (none yet, but keep the function for future-proofing).
  const { ...safe } = i;
  return safe;
}
