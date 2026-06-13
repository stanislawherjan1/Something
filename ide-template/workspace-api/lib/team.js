/**
 * Team whitelist store.
 *
 * Layout under PROJECT_DIR (HARD_HIDDEN — never visible via /api/files/*):
 *   .allowed-emails.json       — JSON array of { email, role, addedAt, addedBy }
 *   .allowed-emails.audit.log  — append-only JSONL audit trail
 *
 * Roles:
 *   admin   — full team management; can add/remove/promote others
 *   member  — read-only access (auth still gated; just no team mutations)
 *
 * Lockout protection: refuse any operation that would leave the file with
 * zero admins, and refuse self-delete (user removing themselves).
 *
 * File mode 0660 (owner + `workspace` group read/write). Atomic writes via
 * tempfile + rename. Group-rw because the entrypoint may seed it as coder
 * while workspace-api reads/writes it as wsapi — both share the workspace group.
 */

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync,
  appendFileSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';

const FILE      = join(PROJECT_DIR, '.allowed-emails.json');
const TMP       = join(PROJECT_DIR, '.allowed-emails.json.tmp');
const AUDIT     = join(PROJECT_DIR, '.allowed-emails.audit.log');

const VALID_ROLES = new Set(['admin', 'member']);
// Loose RFC-5322-ish — strict enough to catch typos, lax enough to allow the
// common shapes (subdomains, plus-addressing, etc.).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalize(email);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

function ensureProjectDir() {
  // PROJECT_DIR exists in the container; this is defensive for dev.
  try { mkdirSync(PROJECT_DIR, { recursive: true }); } catch {}
}

function readRaw() {
  ensureProjectDir();
  if (!existsSync(FILE)) return [];
  try {
    const raw = readFileSync(FILE, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    process.stderr.write(`[team] read failed: ${err.message}\n`);
    return [];
  }
}

function writeRaw(entries) {
  ensureProjectDir();
  // 0o660, not 0o600: PROJECT_DIR is shared (setgid) by the `workspace` group
  // (coder, wsapi, bot, mcp). The entrypoint may bootstrap this file as coder
  // while workspace-api runs as wsapi — group-rw keeps it readable across both.
  writeFileSync(TMP, JSON.stringify(entries, null, 2), { mode: 0o660 });
  try { chmodSync(TMP, 0o660); } catch {}
  renameSync(TMP, FILE);
  try { chmodSync(FILE, 0o660); } catch {}
}

function appendAudit(action, email, extra) {
  ensureProjectDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    email: normalize(email),
    ...(extra || {}),
  }) + '\n';
  try {
    appendFileSync(AUDIT, line, { mode: 0o660 });
    chmodSync(AUDIT, 0o660);
  } catch (err) {
    process.stderr.write(`[team] audit append failed: ${err.message}\n`);
  }
}

export function list() {
  return readRaw().map(e => ({
    email:   normalize(e.email),
    role:    VALID_ROLES.has(e.role) ? e.role : 'member',
    addedAt: e.addedAt || null,
    addedBy: e.addedBy || null,
  })).filter(e => isValidEmail(e.email));
}

export function find(email) {
  const e = normalize(email);
  return list().find(x => x.email === e) || null;
}

export function isAllowed(email) {
  return Boolean(find(email));
}

export function isAdmin(email) {
  return find(email)?.role === 'admin';
}

function adminCount(entries) {
  return entries.filter(e => e.role === 'admin').length;
}

/**
 * Bootstrap: if the file doesn't exist yet, create it with the given email
 * as the sole admin. Idempotent — does nothing if the file already exists,
 * even empty.
 */
export function bootstrapIfMissing(email, addedBy = 'bootstrap') {
  ensureProjectDir();
  if (existsSync(FILE)) return false;
  if (!isValidEmail(email)) {
    throw new Error(`bootstrap: invalid email "${email}"`);
  }
  const entry = {
    email:   normalize(email),
    role:    'admin',
    addedAt: new Date().toISOString(),
    addedBy,
  };
  writeRaw([entry]);
  appendAudit('bootstrap', entry.email, { role: 'admin', addedBy });
  return true;
}

/**
 * Promote `email` to admin when the team store currently has zero admins.
 * Idempotent: returns false if the store already has at least one admin.
 *
 * Covers the chicken-and-egg case where nginx auth_request has already
 * verified the user against IDE_ALLOWED_EMAILS but the team file is either
 * missing, empty, or contains only members. Without this, admin-gated
 * endpoints (PUT /branding, POST /setup/*) return 403 forever even though
 * no admin actually exists — the open-mode fallback in middleware grants
 * the request but never seeds a real admin record, so the next call lands
 * in the same trap.
 */
export function ensureFirstAdmin(email, addedBy = 'auto-bootstrap') {
  if (!isValidEmail(email)) return false;
  const e = normalize(email);

  const entries = readRaw();
  const hasAdmin = entries.some(x => VALID_ROLES.has(x.role) && x.role === 'admin');
  if (hasAdmin) return false;

  const idx = entries.findIndex(x => normalize(x.email) === e);
  if (idx === -1) {
    const entry = { email: e, role: 'admin', addedAt: new Date().toISOString(), addedBy };
    entries.push(entry);
    writeRaw(entries);
    appendAudit('auto_bootstrap_add', e, { role: 'admin', addedBy });
  } else {
    const previous = entries[idx].role;
    if (previous === 'admin') return false;
    entries[idx] = { ...entries[idx], role: 'admin' };
    writeRaw(entries);
    appendAudit('auto_bootstrap_promote', e, { from: previous, to: 'admin', addedBy });
  }
  return true;
}

export function add({ email, role = 'member', addedBy }) {
  if (!isValidEmail(email)) throw new Error(`Invalid email format.`);
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role "${role}".`);

  const entries = readRaw();
  const e = normalize(email);
  if (entries.some(x => normalize(x.email) === e)) {
    throw new Error(`${e} is already on the team.`);
  }

  const entry = {
    email:   e,
    role,
    addedAt: new Date().toISOString(),
    addedBy: normalize(addedBy) || null,
  };
  entries.push(entry);
  writeRaw(entries);
  appendAudit('add', e, { role, addedBy: entry.addedBy });
  return entry;
}

export function setRole({ email, role, actor }) {
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role "${role}".`);

  const entries = readRaw();
  const e = normalize(email);
  const idx = entries.findIndex(x => normalize(x.email) === e);
  if (idx === -1) throw new Error(`${e} is not on the team.`);

  const previous = entries[idx].role;
  if (previous === role) return entries[idx];

  // If demoting an admin, ensure at least one admin remains.
  if (previous === 'admin' && role !== 'admin') {
    const remaining = entries.filter((_, i) => i !== idx).filter(x => x.role === 'admin').length;
    if (remaining === 0) {
      throw new Error('Cannot demote the only remaining admin.');
    }
  }

  entries[idx] = { ...entries[idx], role };
  writeRaw(entries);
  appendAudit('role_change', e, { from: previous, to: role, actor: normalize(actor) || null });
  return entries[idx];
}

export function remove({ email, actor }) {
  const entries = readRaw();
  const e = normalize(email);
  const idx = entries.findIndex(x => normalize(x.email) === e);
  if (idx === -1) throw new Error(`${e} is not on the team.`);

  const actorEmail = normalize(actor);
  if (actorEmail && actorEmail === e) {
    throw new Error('You cannot remove yourself.');
  }

  if (entries[idx].role === 'admin' && adminCount(entries) <= 1) {
    throw new Error('Cannot remove the only remaining admin.');
  }

  const removed = entries[idx];
  entries.splice(idx, 1);
  writeRaw(entries);
  appendAudit('remove', e, { role: removed.role, actor: actorEmail || null });
  return removed;
}
