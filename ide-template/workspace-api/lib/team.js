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
  appendFileSync, chmodSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './config.js';

const FILE      = join(PROJECT_DIR, '.allowed-emails.json');
const TMP       = join(PROJECT_DIR, '.allowed-emails.json.tmp');
const AUDIT     = join(PROJECT_DIR, '.allowed-emails.audit.log');
const CONFIG    = join(PROJECT_DIR, '.team-config.json');

// admin — full management; member — uses AI, owns their files; observer —
// read-only (zero actions). Observer enforcement lands in a later phase; it's
// accepted as data now so the registry shape is final.
const VALID_ROLES = new Set(['admin', 'member', 'observer']);
// Where a teammate prefers to be reached for relays. 'both' = web thread (always
// the record) + a Telegram ping; 'telegram' = prefer TG; 'web' = web only.
const VALID_SURFACES = new Set(['web', 'telegram', 'both']);

// Preferred WRITING LANGUAGE — SHARED roster metadata (not private), because
// another teammate's bot needs it to compose a relay in the right language and
// can't read this person's private memory. Free text ("Polish", "English",
// "pl"); trimmed, capped, or null if unset.
function normalizeLang(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 40) : null;
}
// Loose RFC-5322-ish — strict enough to catch typos, lax enough to allow the
// common shapes (subdomains, plus-addressing, etc.).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

// A personal Telegram chat id is a POSITIVE integer (a user's DM). Negative ids
// are groups/channels — never a private per-teammate link (a relay there would
// fan out to everyone in the group), so reject them. Normalize to a clean string
// or null; a bad value never reaches the allow-list or an outbound send.
function normalizeChatId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return /^\d{4,20}$/.test(s) ? s : null;
}

export function isValidEmail(email) {
  const e = normalize(email);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

// ─── Identity: slug + displayName (team mode) ────────────────────────────────
// Each user gets a filesystem slug (path-safe, e.g. project/users/<slug>/) and
// a human displayName. Derived from the email local-part; slugs are unique and,
// once assigned, PERSISTED — a user's personal directory must never move
// because another user joined. Single registry (this file) — no parallel
// users.json — so the two stores can't drift.

function slugify(localPart) {
  const base = String(localPart || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alnum → hyphen
    .replace(/^-+|-+$/g, '')       // trim hyphens
    .slice(0, 32);
  return base || 'user';
}

function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`.slice(0, 40);
    if (!taken.has(candidate)) return candidate;
  }
}

function deriveDisplayName(localPart) {
  const words = String(localPart || '')
    .replace(/[.+_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || 'User';
}

// Return entries enriched with a stable slug + displayName, assigning any that
// are missing. Pure (no write) — dedup walks entries in insertion order so the
// result is deterministic and matches what ensureProfiles() persists.
function withProfiles(entries) {
  const taken = new Set(entries.map(e => e.slug).filter(Boolean));
  return entries.map(e => {
    const email = normalize(e.email);
    const localPart = email.split('@')[0] || 'user';
    let slug = e.slug;
    if (!slug) {
      slug = uniqueSlug(slugify(localPart), taken);
      taken.add(slug);
    }
    const displayName = e.displayName || deriveDisplayName(localPart);
    return { ...e, email, slug, displayName };
  });
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
  const valid = readRaw().map(e => ({
    email:          normalize(e.email),
    role:           VALID_ROLES.has(e.role) ? e.role : 'member',
    addedAt:        e.addedAt || null,
    addedBy:        e.addedBy || null,
    slug:           e.slug || null,
    displayName:    e.displayName || null,
    // Cross-surface contact (team mode): the teammate's linked Telegram chat id
    // and where they prefer to be reached. Drives relay delivery routing.
    telegramChatId:   normalizeChatId(e.telegramChatId),
    preferredSurface: VALID_SURFACES.has(e.preferredSurface) ? e.preferredSurface : null,
    // Shared so a teammate's bot can relay to this person in their language.
    preferredLanguage: normalizeLang(e.preferredLanguage),
  })).filter(e => isValidEmail(e.email));
  return withProfiles(valid);   // fills slug/displayName if absent (deterministic)
}

export function find(email) {
  const e = normalize(email);
  return list().find(x => x.email === e) || null;
}

/** Enriched identity for an email: { email, slug, role, displayName, ... } or null. */
export function getUser(email) {
  return find(email);
}

/** Path-safe slug for an email, or null if not on the team. */
export function slugFor(email) {
  return find(email)?.slug || null;
}

/**
 * Slug of the workspace's primary admin — the original (bootstrap) admin if
 * present (entries are insertion-ordered, so the first admin is the bootstrap
 * one), else the first member. Used to target owner-facing things that have no
 * specific user yet (proactive bot web messages) and to adopt the legacy
 * single-user 'default' chat history. Falls back to 'default'.
 */
export function primaryAdminSlug() {
  const all = list();
  const admin = all.find(u => u.role === 'admin') || all[0];
  return admin?.slug || 'default';
}

/**
 * Persist slug + displayName for any legacy entries that lack them. Idempotent;
 * call once at startup so the on-disk store matches what list() derives, and a
 * user's personal directory slug is stable across restarts. Returns true if it
 * wrote anything.
 */
export function ensureProfiles() {
  const raw = readRaw();
  if (!raw.length) return false;
  const enriched = withProfiles(raw.map(e => ({ ...e, email: normalize(e.email) })));
  const changed = enriched.some((e, i) => e.slug !== raw[i].slug || e.displayName !== raw[i].displayName);
  if (changed) {
    writeRaw(enriched);
    appendAudit('profiles_backfill', '', { count: enriched.length });
  }
  return changed;
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

export function add({ email, role = 'member', addedBy, displayName }) {
  if (!isValidEmail(email)) throw new Error(`Invalid email format.`);
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role "${role}".`);

  const entries = readRaw();
  const e = normalize(email);
  if (entries.some(x => normalize(x.email) === e)) {
    throw new Error(`${e} is already on the team.`);
  }

  // Assign a unique slug up front (don't wait for the startup backfill) so the
  // new user's personal directory is addressable immediately. Dedup against the
  // slugs all current entries hold or would be assigned.
  const localPart = e.split('@')[0] || 'user';
  const taken = new Set(withProfiles(entries).map(x => x.slug));
  const slug = uniqueSlug(slugify(localPart), taken);

  const entry = {
    email:       e,
    role,
    slug,
    displayName: (displayName && String(displayName).trim()) || deriveDisplayName(localPart),
    addedAt:     new Date().toISOString(),
    addedBy:     normalize(addedBy) || null,
  };
  entries.push(entry);
  writeRaw(entries);
  appendAudit('add', e, { role, slug, addedBy: entry.addedBy });
  writeTeamRoster();
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
  writeTeamRoster();
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
  writeTeamRoster();
  return removed;
}

/**
 * Self-service profile edit — a user sets their OWN displayName. Preserves
 * slug/role/addedAt (only displayName changes). Caller (routes/me.js) passes
 * the actor's own email; not admin-gated. Avatars are stored as files
 * (lib/user-avatars.js), versioned by mtime — they don't touch this store.
 */
export function setProfile(email, { displayName }) {
  const e = normalize(email);
  const entries = readRaw();
  const idx = entries.findIndex(x => normalize(x.email) === e);
  if (idx === -1) throw new Error(`${e} is not on the team.`);

  if (displayName !== undefined) {
    const trimmed = String(displayName).trim();
    if (!trimmed || trimmed.length > 100) {
      throw new Error('Display name must be 1–100 characters.');
    }
    entries[idx] = { ...entries[idx], displayName: trimmed };
  }
  writeRaw(entries);
  appendAudit('profile_update', e, {});
  return getUser(e);
}

/**
 * Set a teammate's cross-surface contact: their Telegram chat id and/or
 * preferred relay surface. Used by an admin (any member) and by a member on
 * themselves (self-link). `chatId` '' / null clears the link; an invalid value
 * throws. `preferredSurface` must be web|telegram|both, or null to clear. The
 * chat id feeds telegramAllowedIds() (bot access) and outbound relay routing;
 * the surface is mirrored into the TEAM roster so the bot knows where to reach
 * them. Returns the updated enriched member.
 */
export function setTelegram(email, { chatId, preferredSurface, preferredLanguage } = {}, actor) {
  const e = normalize(email);
  const entries = readRaw();
  const idx = entries.findIndex(x => normalize(x.email) === e);
  if (idx === -1) throw new Error(`${e} is not on the team.`);

  const patch = {};
  if (chatId !== undefined) {
    const cleared = chatId === '' || chatId === null;
    if (!cleared && normalizeChatId(chatId) === null) {
      throw new Error('Telegram chat id must be a positive integer (your DM with the bot, e.g. 123456789).');
    }
    patch.telegramChatId = cleared ? null : normalizeChatId(chatId);
    // A chat id maps to ONE person: reject linking one that another teammate
    // already holds (otherwise inbound routing is ambiguous + outbound double-
    // delivers). No name in the error — don't reveal who holds it.
    if (patch.telegramChatId) {
      const taken = entries.some((x, i) => i !== idx && normalizeChatId(x.telegramChatId) === patch.telegramChatId);
      if (taken) throw new Error('That Telegram chat id is already linked to another teammate.');
    }
  }
  if (preferredSurface !== undefined) {
    const cleared = preferredSurface === '' || preferredSurface === null;
    if (!cleared && !VALID_SURFACES.has(preferredSurface)) {
      throw new Error('Preferred surface must be web, telegram, or both.');
    }
    patch.preferredSurface = cleared ? null : preferredSurface;
  }
  if (preferredLanguage !== undefined) {
    patch.preferredLanguage = normalizeLang(preferredLanguage);
  }
  entries[idx] = { ...entries[idx], ...patch };
  writeRaw(entries);
  appendAudit('telegram_update', e, {
    actor: normalize(actor) || null,
    linked: patch.telegramChatId !== undefined ? !!patch.telegramChatId : undefined,
    preferredSurface: patch.preferredSurface,
    preferredLanguage: patch.preferredLanguage,
  });
  writeTeamRoster();   // surface hint is mirrored into the roster card
  return getUser(e);
}

/**
 * The Telegram chat ids allowed to DM the bot, derived from the team store —
 * every member with a linked chat id. This is the source of truth that the
 * integration's TELEGRAM_ALLOWED_IDS must track, so adding a member (and their
 * chat id) grants access WITHOUT re-running the activation flow. The admin's own
 * chat id (TELEGRAM_ADMIN_CHAT_ID) is added by the bot separately. Sorted +
 * de-duped for a stable value (no needless bot restarts).
 */
export function telegramAllowedIds() {
  return [...new Set(list().map(m => m.telegramChatId).filter(Boolean))].sort();
}

/** Reverse lookup: which member owns this Telegram chat id (inbound routing). */
export function userByChatId(chatId) {
  const id = normalizeChatId(chatId);
  if (!id) return null;
  return list().find(m => m.telegramChatId === id) || null;
}

// ─── Team config: solo vs collaborative ──────────────────────────────────────
// A solo workspace shouldn't carry team UI (the Workspace/Personal split, role
// badges, invite flow) — that's overkill for one person. `teamMode` gates all
// of it. Stored separately from the member list so toggling it never touches
// the allowlist.

function readConfig() {
  if (!existsSync(CONFIG)) return {};
  try {
    const raw = readFileSync(CONFIG, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    process.stderr.write(`[team] config read failed: ${err.message}\n`);
    return {};
  }
}

function writeConfig(cfg) {
  ensureProjectDir();
  const tmp = CONFIG + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o660 });
  try { chmodSync(tmp, 0o660); } catch {}
  renameSync(tmp, CONFIG);
  try { chmodSync(CONFIG, 0o660); } catch {}
}

/**
 * Is this a collaborative (team) workspace? An explicit toggle (set via the
 * Team UI) wins; absent that, default to collaborative only when more than one
 * person is on the team — so a fresh solo workspace stays clean, while an
 * existing multi-person deploy lights up team mode automatically.
 */
export function getTeamMode() {
  const cfg = readConfig();
  if (typeof cfg.teamMode === 'boolean') return cfg.teamMode;
  return list().length > 1;
}

export function setTeamMode(enabled, actor) {
  const cfg = readConfig();
  cfg.teamMode  = !!enabled;
  cfg.updatedAt = new Date().toISOString();
  if (actor) cfg.updatedBy = normalize(actor);
  writeConfig(cfg);
  appendAudit('team_mode', actor || '', { enabled: !!enabled });
  writeTeamRoster();   // roster card appears/disappears with team mode
  return cfg.teamMode;
}

// ─── Telegram group registry (group mode) ────────────────────────────────────
// Which Telegram GROUP chats the assistant is active in (ambient relevance
// watcher → isolated group brain). Stored under the team config's `groups` key,
// NOT the member allowlist: group membership is the access boundary, not a
// per-sender list (operator decision — the bot only joins the team's own group).
// A group id is a NEGATIVE integer (supergroups are -100…); normalizeGroupId is
// deliberately SEPARATE from normalizeChatId (positive-only, guards the DM
// fan-out invariant — see its comment). Design: docs/future-plans/TELEGRAM_GROUP_MODE.md
function normalizeGroupId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return /^-\d{6,20}$/.test(s) ? s : null;
}

/** All allow-listed groups as [{ chatId, title, requireMention, beat, addedAt, addedBy }]. */
export function listGroups() {
  const cfg = readConfig();
  const g = (cfg && typeof cfg.groups === 'object' && cfg.groups) ? cfg.groups : {};
  return Object.entries(g)
    .filter(([chatId]) => normalizeGroupId(chatId))
    .map(([chatId, v]) => ({ chatId, ...(v && typeof v === 'object' ? v : {}) }));
}

/** Config for one group, or null if not allow-listed. */
export function getGroup(chatId) {
  const id = normalizeGroupId(chatId);
  if (!id) return null;
  const cfg = readConfig();
  const v = cfg.groups && cfg.groups[id];
  return v && typeof v === 'object' ? { chatId: id, ...v } : null;
}

/** Is this group allow-listed (the assistant may operate in it)? */
export function isAllowedGroup(chatId) {
  return getGroup(chatId) !== null;
}

/**
 * Add / update an allow-listed group. `requireMention` defaults to FALSE
 * (ambient — the whole point of group mode); `beat` is an optional operator
 * override that steers what the relevance watcher treats as on-beat.
 */
export function addGroup({ chatId, title, requireMention, beat, language, actor } = {}) {
  const id = normalizeGroupId(chatId);
  if (!id) throw new Error('invalid group id (must be a negative integer)');
  const cfg = readConfig();
  if (!cfg.groups || typeof cfg.groups !== 'object') cfg.groups = {};
  const prev = cfg.groups[id] && typeof cfg.groups[id] === 'object' ? cfg.groups[id] : {};
  cfg.groups[id] = {
    title:          title != null ? String(title).slice(0, 120) : (prev.title || ''),
    requireMention: requireMention != null ? !!requireMention : (prev.requireMention ?? false),
    beat:           beat != null ? String(beat).slice(0, 600) : (prev.beat || ''),
    // Optional per-group reply language (free text, e.g. "English", "Polish").
    // Empty → the brain infers the language from each message, as in 1:1.
    language:       language != null ? String(language).slice(0, 40) : (prev.language || ''),
    // Preserve the seen-members map across edits (e.g. a language change) —
    // it's populated by recordGroupMember and must survive an upsert.
    members:        (prev.members && typeof prev.members === 'object') ? prev.members : {},
    addedAt:        prev.addedAt || new Date().toISOString(),
    addedBy:        prev.addedBy || (actor ? normalize(actor) : ''),
    updatedAt:      new Date().toISOString(),
  };
  cfg.updatedAt = new Date().toISOString();
  writeConfig(cfg);
  appendAudit('group_add', actor || '', { chatId: id });
  writeChannelsCard();
  return getGroup(id);
}

/** Remove an allow-listed group. Returns true if it existed. */
export function removeGroup(chatId, actor) {
  const id = normalizeGroupId(chatId);
  if (!id) return false;
  const cfg = readConfig();
  if (!cfg.groups || !cfg.groups[id]) return false;
  delete cfg.groups[id];
  cfg.updatedAt = new Date().toISOString();
  writeConfig(cfg);
  appendAudit('group_remove', actor || '', { chatId: id });
  writeChannelsCard();
  return true;
}

/**
 * Record a member SEEN in a group (from a group message): from_id → display name.
 * Lightweight, persisted into the group's `members` map; writes only on change so
 * a busy group doesn't thrash the config. Feeds the shared CHANNELS card so the
 * bot knows who's in each group. No-op if the group isn't registered.
 */
export function recordGroupMember(chatId, fromId, name) {
  const id = normalizeGroupId(chatId);
  const fid = String(fromId == null ? '' : fromId).trim();
  if (!id || !/^\d{4,20}$/.test(fid)) return false;
  const cfg = readConfig();
  if (!cfg.groups || !cfg.groups[id]) return false;
  const g = cfg.groups[id];
  if (!g.members || typeof g.members !== 'object') g.members = {};
  const nm = name ? String(name).slice(0, 60) : (g.members[fid] || fid);
  if (g.members[fid] === nm) return false;   // unchanged — skip the write
  g.members[fid] = nm;
  cfg.updatedAt = new Date().toISOString();
  writeConfig(cfg);
  writeChannelsCard();
  return true;
}

const CHANNELS_CARD = join(PROJECT_DIR, 'memory', 'CHANNELS.md');

/**
 * Write the shared `memory/CHANNELS.md` card from the group registry — the
 * Telegram groups the bot is in, their chat_ids, and the members seen in each.
 * BOTH brains load it (it's in LOAD_ORDER, shared tier), so the operator knows
 * which groups exist and their chat_ids — enough to reply into one from a DM.
 * Auto-maintained on add/remove/member-seen; never hand-edited. Idempotent.
 */
export function writeChannelsCard() {
  try {
    const groups = listGroups();
    const head = `---
card: CHANNELS
purpose: The Telegram GROUPS this assistant is in + who's in them + their chat_ids. Auto-maintained by workspace-api — do NOT hand-edit.
write_when: a group is registered/removed, or a new member is seen in a group. Never written by the agent.
---

# CHANNELS — Telegram groups I'm in

`;
    let body;
    if (!groups.length) {
      body = "_Not in any Telegram group yet._\n";
    } else {
      body = groups.map(g => {
        const members = g.members && typeof g.members === 'object' ? Object.values(g.members) : [];
        const mlist = members.length ? members.join(', ') : '(no members seen yet)';
        return `## ${g.title || 'Untitled group'}\n- chat_id: \`${g.chatId}\` (use this with the Telegram reply tool to post here)\n- members seen: ${mlist}\n`;
      }).join('\n');
    }
    const content = head + body;
    const tmp = CHANNELS_CARD + '.tmp';
    writeFileSync(tmp, content, { mode: 0o660 });
    try { chmodSync(tmp, 0o660); } catch {}
    renameSync(tmp, CHANNELS_CARD);
    return true;
  } catch (err) {
    process.stderr.write(`[team] writeChannelsCard failed: ${err.message}\n`);
    return false;
  }
}

const TEAM_ROSTER = join(PROJECT_DIR, 'memory', 'TEAM.md');

/**
 * Write the shared team-directory card `memory/TEAM.md` from the roster — the
 * SHARED counterpart to the per-user private profiles. PUBLIC fields only
 * ({displayName, slug, role}); each person's profile CONTENT stays private in
 * memory/users/<slug>/, so the slug here is a POINTER, not the content. Gated on
 * team mode (removed in solo so it's not noise). Idempotent; call at startup and
 * whenever the roster changes (add/remove/setRole). Returns true if it changed
 * the file. memory/ is shared, so this card is visible to every teammate + the
 * memory dashboard — that's intended (knowing who's on the team is not private).
 */
export function writeTeamRoster() {
  try {
    if (!getTeamMode()) {
      if (existsSync(TEAM_ROSTER)) { unlinkSync(TEAM_ROSTER); return true; }
      return false;
    }
    const contactHint = (m) => {
      // Bot-facing routing guideline — surface only, never the raw chat id.
      const linked = m.telegramChatId ? 'Telegram linked' : 'no Telegram';
      const pref = m.preferredSurface
        ? `prefers ${m.preferredSurface}`
        : (m.telegramChatId ? 'prefers either' : 'web only');
      return `${pref} (${linked})`;
    };
    const langHint = (m) => (m.preferredLanguage ? `writes in ${m.preferredLanguage}` : 'unknown');
    const rows = list()
      .map(m => `| ${m.displayName || m.slug} | \`${m.slug}\` | ${m.role} | ${langHint(m)} | ${contactHint(m)} | \`memory/users/${m.slug}/\` |`)
      .join('\n');
    const body =
`---
card: TEAM
purpose: Team roster — who is in this workspace (display name, slug, role). Each person's detailed profile is PRIVATE in memory/users/<slug>/ — you only see the current user's, plus admins see all. The slug is a pointer, not the content.
---

# Team

The people sharing this workspace. Use it to recognise teammates and for attribution. A person's profile, preferences, and notes are their OWN private memory at \`memory/users/<slug>/\` — never assume this roster reveals their personal facts, and never open another teammate's private memory (it's tool-guard blocked unless it's the current user or you're an admin).

When you relay a message to someone (web_send_message), compose it in their **Language** and use the **Contact** column as a hint for where they like to be reached — the system handles the actual delivery (the web thread is always the record; Telegram is an extra ping when they prefer it and are linked). Language + Contact are SHARED here precisely because *your* bot can't read *their* private memory — so anything needed to reach a teammate correctly lives in this roster, not in their private cards.

| Name | slug | Role | Language | Contact | Private memory |
|------|------|------|----------|---------|----------------|
${rows}
`;
    mkdirSync(join(PROJECT_DIR, 'memory'), { recursive: true });
    const tmp = `${TEAM_ROSTER}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, TEAM_ROSTER);
    return true;
  } catch (err) {
    process.stderr.write(`[team] writeTeamRoster failed: ${err.message}\n`);
    return false;
  }
}
