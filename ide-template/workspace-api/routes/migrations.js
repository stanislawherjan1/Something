/**
 * Migrations from the browser: the upgrade banner and its review modal.
 *
 *   GET  /migrations/status        everyone signed in: is the new memory here,
 *                                  available, or being moved; admins also get
 *                                  the pending content migrations
 *   POST /migrations/:id/start     admins: plan + apply a content migration in
 *                                  the background (the modal is the review)
 *   GET  /migrations/:id/job       admins: its progress
 *   GET  /memory/backup            everyone signed in: their OWN memory as a
 *                                  .tar.gz (lib/memory-backup.js) — before the
 *                                  migration from memory/, after it from the
 *                                  archive the migration took
 *
 * The buttons run the same modules as bin/migrate.mjs — one code path, no shell
 * from the browser. Rollback stays with the operator (CLI): there is no switch
 * back in the product. Every start and download is audit-logged in the store.
 */
import { Router } from 'express';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import * as migrate from '../lib/migrate.js';
import * as ledger from '../lib/memory-ledger.js';
import { streamBackup } from '../lib/memory-backup.js';
import { requireActor } from '../lib/auth.js';
import { getUser, getTeamMode, primaryAdminSlug, memberGroupsOf } from '../lib/team.js';

export const MEMORY_MIGRATION = '0005-legacy-memory-to-ledger';
const SLUG_RE = /^[a-z0-9-]+$/;

function storeDir() { return join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'migrations'); }
function stampPath() { return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory', '_engine', '.v4-migrated'); }

function audit(action, email, extra = {}) {
  try {
    mkdirSync(storeDir(), { recursive: true });
    appendFileSync(join(storeDir(), 'audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), action, email: email || null, ...extra }) + '\n', { mode: 0o660 });
  } catch (err) { process.stderr.write(`[migrations] audit failed: ${err.message}\n`); }
}

function who(req) {
  const u = getUser(req.actor);
  const slug = u?.slug || (getTeamMode() ? null : primaryAdminSlug());
  if (!slug || slug === 'default' || !SLUG_RE.test(slug)) return null;
  return { slug, email: req.actor, admin: u?.role === 'admin' };
}

// One migration at a time; progress lives in memory (a restart mid-run leaves the
// framework's own state and backup — the operator's CLI takes it from there).
const jobs = new Map();
const jobView = (j) => ({ id: j.id, state: j.state, step: j.step, error: j.error, result: j.result || null, progress: j.progress || null, startedAt: j.startedAt });

export default function migrationsRouter() {
  const router = Router();

  router.get('/migrations/status', requireActor, async (req, res) => {
    const me = who(req);
    if (!me) return res.status(403).json({ ok: false, error: 'not on this workspace\'s team' });
    res.set('Cache-Control', 'no-store');
    try {
      const all = await migrate.status();
      const mem = all.find(m => m.id === MEMORY_MIGRATION);
      const migrated = existsSync(stampPath());
      // Whichever migration is running or last ran — the move, or a follow-up like the card sort.
      const job = [...jobs.values()].find(j => j.state === 'running') || jobs.get(MEMORY_MIGRATION) || [...jobs.values()].pop() || null;
      return res.json({
        ok: true,
        memory: { mode: ledger.v4Mode(), migrated, available: !!(mem && mem.enabled && mem.needed && !migrated), job: job && jobView(job) },
        pending: me.admin ? all.filter(m => m.kind === 'content' && m.enabled && m.needed && !m.applied).map(m => ({ id: m.id, title: m.title, summary: m.summary })) : undefined,
        admin: me.admin,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/migrations/:id/start', requireActor, async (req, res) => {
    const me = who(req);
    if (!me?.admin) return res.status(403).json({ ok: false, error: 'admins only' });
    const id = String(req.params.id);
    const m = (await migrate.loadMigrations()).find(x => x.id === id);
    if (!m || m.kind !== 'content') return res.status(404).json({ ok: false, error: 'no such content migration' });
    if ([...jobs.values()].some(j => j.state === 'running')) return res.status(409).json({ ok: false, error: 'a migration is already running' });
    // The job carries progress inside a step ({ done, total, label, at }) so the
    // screen can show a count, a rate-based ETA and — when `at` stops moving —
    // that nothing is happening; and a cancel, honoured between units of work.
    const job = { id, state: 'running', step: 'plan', error: null, startedAt: new Date().toISOString(), by: me.email, progress: null, cancel: false };
    jobs.set(id, job);
    audit('migration_start', me.email, { id });
    const onProgress = (done, total, label) => { job.progress = { done, total, label, at: new Date().toISOString() }; };
    const shouldStop = () => job.cancel;
    (async () => {
      try {
        await migrate.plan(id, { onProgress, shouldStop });
        const r = await migrate.apply(id, { onStep: (s) => { job.step = s; job.progress = null; }, onProgress, shouldStop });
        Object.assign(job, { state: 'done', step: 'done', finishedAt: new Date().toISOString(), result: r.result });
        audit('migration_done', me.email, { id, result: r.result });
      } catch (err) {
        const cancelled = job.cancel && /cancelled/.test(err.message);
        Object.assign(job, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err.message, finishedAt: new Date().toISOString() });
        audit(cancelled ? 'migration_cancelled' : 'migration_failed', me.email, { id, error: cancelled ? undefined : err.message });
        if (!cancelled) process.stderr.write(`[migrations] ${id} failed: ${err.message}\n`);
      }
    })();
    return res.status(202).json({ ok: true, job: jobView(job) });
  });

  // Cancel a running migration. Before the backup nothing has been written and
  // the run simply stops; after it, apply() restores the archive on the error.
  router.post('/migrations/:id/cancel', requireActor, (req, res) => {
    const me = who(req);
    if (!me?.admin) return res.status(403).json({ ok: false, error: 'admins only' });
    const job = jobs.get(String(req.params.id));
    if (!job || job.state !== 'running') return res.status(409).json({ ok: false, error: 'nothing running' });
    job.cancel = true;
    audit('migration_cancel_requested', me.email, { id: job.id, step: job.step });
    return res.json({ ok: true });
  });

  router.get('/migrations/:id/job', requireActor, (req, res) => {
    const me = who(req);
    if (!me?.admin) return res.status(403).json({ ok: false, error: 'admins only' });
    res.set('Cache-Control', 'no-store');
    const job = jobs.get(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: 'no job' });
    return res.json({ ok: true, job: jobView(job) });
  });

  router.get('/memory/backup', requireActor, async (req, res) => {
    const me = who(req);
    if (!me) return res.status(403).json({ ok: false, error: 'not on this workspace\'s team' });
    let archive = null;
    if (existsSync(stampPath())) {
      archive = migrate.readState().applied?.[MEMORY_MIGRATION]?.backup || null;
      if (!archive || !existsSync(archive)) return res.status(410).json({ ok: false, error: 'the backup from the move is no longer kept (30 days)' });
    }
    const date = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="memory-backup-${me.slug}-${date}.tar.gz"`);
    res.set('Cache-Control', 'no-store');
    try {
      const files = await streamBackup(res, { slug: me.slug, groups: memberGroupsOf(me.slug), archive });
      audit('memory_backup_download', me.email, { files, fromArchive: !!archive });
    } catch (err) {
      process.stderr.write(`[migrations] backup for ${me.slug} failed: ${err.message}\n`);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'backup failed' });
      else res.end();
    }
  });

  return router;
}

export function _jobsForTests() { return jobs; }
