/**
 * migrate — versioned, reviewable data migrations that ship with each release.
 *
 * The migrations before this were one-off boot functions with stamp files: no
 * preview, no dry run, no rollback, no record of what ran on which deployment.
 * Each migration is now a module in ../migrations/NNNN-<name>.mjs:
 *
 *   export default {
 *     id, title,
 *     kind: 'structural' | 'content',
 *     enabled(ctx)   → bool       (e.g. only when MEMORY_V4 is on)
 *     paths(ctx)     → [rel]      what it may touch — backed up before apply
 *     inputs(ctx)    → [rel]      what it reads — hashed so a stale plan is refused
 *     recognize(ctx) → bool       optional: a legacy stamp says it already ran
 *     check(ctx)     → { needed, summary }
 *     plan(ctx)      → { summary, actions: [{ op, path, detail }] }
 *     apply(ctx, plan) → { changed }        (plan = what plan() returned, stored; reuse its work)
 *   ctx.progress?.(done, total, label) reports inside a step; ctx.shouldStop?.() is
 *   a cancel the migration checks between units of work (before the backup it is
 *   free; after it the framework restores the archive).
 *     verify(ctx)    → { ok, problems }
 *   }
 *
 * STRUCTURAL migrations (dirs, perms, seeding a file next to an untouched source)
 * run by themselves at boot and are idempotent. CONTENT migrations (moving or
 * trimming what people wrote) never run by themselves: the operator reads the
 * plan, then applies it — from the CLI (bin/migrate.mjs) or the upgrade banner,
 * which call these same functions.
 *
 * Every apply first tars the paths it may touch into the store; rollback restores
 * that archive and removes anything the migration created. State lives in the
 * store (WSAPI_STORE_DIR), outside memory/, so restoring memory never forgets
 * what ran.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWrite } from './atomic-write.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', 'migrations');

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function storeDir() { return join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'migrations'); }
function statePath() { return join(storeDir(), 'state.json'); }

export function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return { applied: {} }; }
}
function writeState(state) {
  mkdirSync(storeDir(), { recursive: true });
  atomicWrite(statePath(), JSON.stringify(state, null, 2) + '\n');
}
function record(id, entry) {
  const state = readState();
  state.applied = state.applied || {};
  state.applied[id] = { ...(state.applied[id] || {}), ...entry };
  writeState(state);
}

/** What a migration sees: paths, team shape, the v4 flag. Built fresh per call. */
export async function buildContext(extra = {}) {
  const team = await import('./team.js');
  const teamMode = team.getTeamMode();
  let groups = [];
  try { groups = team.listGroups().map(g => String(g.chatId ?? g.id ?? g)).filter(g => /^-\d+$/.test(g)); } catch { /* no groups */ }
  return {
    projectDir: projectDir(),
    memoryDir: join(projectDir(), 'memory'),
    teamMode,
    roster: teamMode ? team.list().map(u => u.slug).filter(Boolean) : [],
    groups,
    flag: process.env.MEMORY_V4 || 'off',
    log: (msg) => process.stderr.write(`[migrate] ${msg}\n`),
    ...extra,
  };
}

export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => /^\d{4}-[a-z0-9-]+\.mjs$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const m = (await import(pathToFileURL(join(dir, f)).href)).default;
    if (!m || m.id !== f.replace(/\.mjs$/, '')) throw new Error(`migration ${f}: id must equal the file name`);
    if (!['structural', 'content'].includes(m.kind)) throw new Error(`migration ${f}: kind must be structural or content`);
    out.push(m);
  }
  return out;
}

// ─── hashing the inputs, so an apply can refuse a plan made on other data ─────

function filesUnder(rel) {
  const abs = join(projectDir(), rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = join(rel, e.name);
    if (e.isDirectory()) out.push(...filesUnder(child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

function inputsSha(rels) {
  const h = createHash('sha256');
  for (const f of [...new Set(rels.flatMap(filesUnder))].sort()) {
    h.update(f).update('\0').update(readFileSync(join(projectDir(), f))).update('\0');
  }
  return h.digest('hex');
}

// ─── backup / restore ────────────────────────────────────────────────────────

function backup(id, rels) {
  mkdirSync(storeDir(), { recursive: true });
  const existing = rels.filter(r => existsSync(join(projectDir(), r)));
  const manifest = [...new Set(existing.flatMap(filesUnder))].sort();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = join(storeDir(), `${id}-${stamp}.tar.gz`);
  if (existing.length) {
    const r = spawnSync('tar', ['czf', archive, '-C', projectDir(), ...existing], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`backup failed: ${r.stderr || r.error?.message}`);
  }
  return { archive: existing.length ? archive : null, manifest, paths: rels };
}

function restore(b) {
  // Anything the migration created (not in the manifest) goes; then the archive
  // puts every original file back byte for byte.
  const keep = new Set(b.manifest);
  for (const rel of b.paths) for (const f of filesUnder(rel)) if (!keep.has(f)) rmSync(join(projectDir(), f), { force: true });
  if (b.archive) {
    // The files are what matter. Directories under memory/ are owned by another
    // user (coder) with the group writable, so tar can put every FILE back but
    // cannot set the directory's mode or mtime — and reports that as failure.
    // Those metadata lines are not a failed restore; anything else is.
    const r = spawnSync('tar', ['xzf', b.archive, '-C', projectDir(), '--no-same-owner', '--no-same-permissions', '-m'], { encoding: 'utf8' });
    if (r.status !== 0) {
      const serious = String(r.stderr || '').split('\n').filter(l => l.trim() && !/Cannot (utime|change mode)|Exiting with failure status due to previous errors/.test(l));
      if (serious.length || r.error) throw new Error(`restore failed: ${serious.join('; ') || r.error?.message}`);
    }
  }
}

// ─── the operations ──────────────────────────────────────────────────────────

async function find(id, opts) {
  const m = (await loadMigrations(opts.dir)).find(x => x.id === id);
  if (!m) throw new Error(`no migration ${JSON.stringify(id)}`);
  return m;
}

export async function status(opts = {}) {
  const ctx = opts.ctx || await buildContext();
  const state = readState().applied || {};
  const out = [];
  for (const m of await loadMigrations(opts.dir)) {
    const applied = state[m.id] && !state[m.id].rolledBackAt ? state[m.id] : null;
    const enabled = m.enabled ? !!m.enabled(ctx) : true;
    let needed = false, summary = '';
    if (!applied && enabled) ({ needed, summary } = await m.check(ctx));
    out.push({ id: m.id, title: m.title, kind: m.kind, enabled, applied: !!applied, appliedAt: applied?.appliedAt || null, needed, summary });
  }
  return out;
}

/** Dry run: what would change, written to the store for review. Touches nothing else. */
export async function plan(id, opts = {}) {
  const ctx = { ...(opts.ctx || await buildContext()), progress: opts.onProgress || null, shouldStop: opts.shouldStop || null };
  const m = await find(id, opts);
  const p = await m.plan(ctx);
  const out = { id, createdAt: new Date().toISOString(), inputsSha: inputsSha(m.inputs ? m.inputs(ctx) : m.paths(ctx)), plan: p };
  mkdirSync(storeDir(), { recursive: true });
  atomicWrite(join(storeDir(), `${id}.plan.json`), JSON.stringify(out, null, 2) + '\n');
  return out;
}

/**
 * Apply one migration. A content migration needs a stored plan whose inputs have
 * not changed since (`auto` refuses content outright). Backup first; verify after;
 * a failed verify rolls back by itself.
 */
export async function apply(id, opts = {}) {
  const ctx = { ...(opts.ctx || await buildContext()), progress: opts.onProgress || null, shouldStop: opts.shouldStop || null };
  const m = await find(id, opts);
  if (m.kind === 'content' && opts.auto) throw new Error(`${id} is a content migration: it never runs by itself`);
  if (m.enabled && !m.enabled(ctx)) throw new Error(`${id} is not enabled on this deployment`);
  const sha = inputsSha(m.inputs ? m.inputs(ctx) : m.paths(ctx));
  let p;
  if (m.kind === 'content') {
    let stored;
    try { stored = JSON.parse(readFileSync(join(storeDir(), `${id}.plan.json`), 'utf8')); }
    catch { throw new Error(`${id}: no plan — run plan first and review it`); }
    if (stored.inputsSha !== sha) throw new Error(`${id}: the data changed since the plan was made — plan again`);
    p = stored.plan;
  } else {
    p = await m.plan(ctx);
  }
  opts.onStep?.('backup');
  const b = backup(id, m.paths(ctx));
  let result;
  // A failed apply is recorded BEFORE the restore is attempted, so a restore
  // that also fails can never eat the cause (it did once: the state ended with
  // no error at all, and the screen showed only tar's complaints).
  const failed = (cause) => {
    let restored = true, restoreError = null;
    try { restore(b); } catch (e) { restored = false; restoreError = e.message; }
    record(id, { failedAt: new Date().toISOString(), error: cause, restored, restoreError, backup: b.archive });
    const err = new Error(restored ? `${cause} — memory restored from the backup` : `${cause} — AND the restore failed: ${restoreError}`);
    err.restored = restored;
    return err;
  };
  try {
    opts.onStep?.('apply');
    result = await m.apply(ctx, p);
  } catch (err) {
    throw failed(String(err.message || err));
  }
  opts.onStep?.('verify');
  const v = await m.verify(ctx);
  if (!v.ok) throw failed(`verify failed: ${v.problems.join('; ')}`);
  record(id, { kind: m.kind, appliedAt: new Date().toISOString(), inputsSha: sha, backup: b.archive, manifest: b.manifest, paths: b.paths, result, rolledBackAt: null, error: null });
  ctx.log(`${id} applied: ${JSON.stringify(result)}`);
  return { id, result, backup: b.archive };
}

export async function verify(id, opts = {}) {
  const ctx = opts.ctx || await buildContext();
  return (await find(id, opts)).verify(ctx);
}

export async function rollback(id, opts = {}) {
  const e = readState().applied?.[id];
  if (!e || !e.appliedAt || e.rolledBackAt) throw new Error(`${id} is not applied`);
  restore({ archive: e.backup, manifest: e.manifest || [], paths: e.paths || [] });
  record(id, { rolledBackAt: new Date().toISOString() });
  return { id, restoredFrom: e.backup };
}

/**
 * Boot: record what legacy stamps say already ran, then apply every enabled
 * STRUCTURAL migration that is needed, in order. Content migrations are only
 * reported. Never throws — a failure is logged and leaves that migration pending.
 */
export async function autoApply(opts = {}) {
  const ctx = opts.ctx || await buildContext();
  const state = readState().applied || {};
  const report = { applied: [], recorded: [], pendingContent: [], failed: [] };
  for (const m of await loadMigrations(opts.dir)) {
    if (state[m.id]?.appliedAt && !state[m.id].rolledBackAt) continue;
    if (state[m.id]?.rolledBackAt) continue;   // an operator rolled it back: stay out of the way
    try {
      if (m.recognize && await m.recognize(ctx)) {
        record(m.id, { kind: m.kind, appliedAt: new Date().toISOString(), recordedFromLegacy: true });
        report.recorded.push(m.id);
        continue;
      }
      if (m.enabled && !m.enabled(ctx)) continue;
      const { needed } = await m.check(ctx);
      if (!needed) continue;
      if (m.kind === 'content') { report.pendingContent.push(m.id); continue; }
      await apply(m.id, { ...opts, ctx, auto: true });
      report.applied.push(m.id);
    } catch (err) {
      ctx.log(`${m.id} failed: ${err.message}`);
      report.failed.push({ id: m.id, error: err.message });
    }
  }
  return report;
}

/**
 * Delete migration backups older than `days` (default 30). The archive is the
 * operator's rollback and the source of people's "download the backup" after the
 * move; after the window neither is offered. Its state entry records when it went.
 */
export function pruneBackups({ now = Date.now(), days = 30 } = {}) {
  const cutoff = now - days * 86400_000;
  const removed = [];
  let names = [];
  try { names = readdirSync(storeDir()).filter(f => f.endsWith('.tar.gz')); } catch { return removed; }
  for (const f of names) {
    const abs = join(storeDir(), f);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.mtimeMs >= cutoff) continue;
    rmSync(abs, { force: true });
    removed.push(f);
  }
  if (removed.length) {
    const state = readState();
    for (const [id, e] of Object.entries(state.applied || {})) {
      if (e.backup && removed.includes(e.backup.split('/').pop())) state.applied[id] = { ...e, backupPrunedAt: new Date(now).toISOString() };
    }
    writeState(state);
  }
  return removed;
}

export const _internals = { inputsSha, filesUnder, relative, restore };
