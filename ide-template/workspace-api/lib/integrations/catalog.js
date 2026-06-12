/**
 * Loads + validates integrations.catalog.json once at startup.
 *
 * The catalog is the source of truth for which integrations exist, what
 * fields they need, what helper text the UI shows, and how to spawn the
 * MCP server (or which long-running process to restart).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH       = join(__dirname, '..', '..', 'integrations.catalog.json');
// Optional, gitignored. Present on a client where the operator has staged
// an operator-only integration staged on one client's box. Entries here
// are merged on top of the main catalog at load time. Same shape: an
// object with `integrations: [...]`. Missing file is silently skipped —
// every other client sees only the shared catalog.
const CATALOG_LOCAL_PATH = join(__dirname, '..', '..', 'integrations.catalog.local.json');

let cached = null;

function validateEntry(i) {
  if (!i.id || typeof i.id !== 'string') throw new Error('integration missing id');
  if (i.comingSoon) return;
  if (!Array.isArray(i.fields) || i.fields.length === 0) {
    throw new Error(`integration ${i.id} must declare fields[] (or be marked comingSoon)`);
  }
  for (const f of i.fields) {
    if (!f.name || !f.label) throw new Error(`integration ${i.id} field missing name/label`);
  }
}

function load() {
  if (cached) return cached;
  const raw = readFileSync(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.integrations)) {
    throw new Error('integrations.catalog.json: missing "integrations" array');
  }
  for (const i of parsed.integrations) validateEntry(i);

  // Merge local (gitignored) catalog if present. Last-write-wins on id
  // collision so a local entry CAN override a shared one if a future use
  // case wants that (rare; today only used for net-new private entries).
  if (existsSync(CATALOG_LOCAL_PATH)) {
    try {
      const localRaw = readFileSync(CATALOG_LOCAL_PATH, 'utf8');
      const localParsed = JSON.parse(localRaw);
      const localEntries = Array.isArray(localParsed?.integrations) ? localParsed.integrations : [];
      for (const i of localEntries) validateEntry(i);
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
export function get(id) {
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
