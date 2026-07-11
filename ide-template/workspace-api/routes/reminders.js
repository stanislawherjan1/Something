/**
 * /api/reminders — actor-scoped read + guarded mutation for the Reminders UI.
 *
 * Why this exists: the dashboard used to read the raw .reminders.json via
 * /api/files/read and DELETE by rewriting the whole file via /api/files/write.
 * In team mode that's a real hole — .reminders.json sits at the project root,
 * which scope-rule makes world-writable to every member, so anyone could read
 * every teammate's reminder titles and nuke/retarget anyone's. These two
 * endpoints are the sanctioned path: the GET scopes visibility to the actor and
 * the cancel enforces ownership. Solo (no team mode) → unscoped, exactly as
 * before.
 *
 * Visibility note: in the UI EVERYONE — including the admin — sees only what
 * concerns them (set by them, targets them, or team-wide). The admin's
 * "see/manage everything" is an AI action via the reminder MCP, deliberately
 * NOT surfaced in the dashboard.
 */

import express, { Router } from 'express';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getTeamMode, getUser, list as teamList } from '../lib/team.js';
import { avatarUrl } from '../lib/user-avatars.js';

const REMINDERS_FILE = join(process.env.PROJECT_DIR || '/home/coder/project', '.reminders.json');
const EVERYONE = '*everyone*';

function readReminders() {
  try {
    const parsed = JSON.parse(readFileSync(REMINDERS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(r => r && typeof r === 'object') : [];
  } catch { return []; }
}

function writeReminders(reminders) {
  const tmp = REMINDERS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(reminders, null, 2));
  renameSync(tmp, REMINDERS_FILE);   // atomic swap (mirrors reminder-mcp)
}

export default function remindersRouter() {
  const router = Router();

  // Current user's slug (team mode); null in solo → unscoped legacy behaviour.
  const actorSlug = (req) => (getTeamMode() ? (getUser(req.actor)?.slug || null) : null);
  const isAdmin   = (req) => {
    if (!getTeamMode()) return true;                 // solo: full control
    const u = getUser(req.actor);
    return !!u && u.role === 'admin';
  };

  // A reminder concerns this user if they set it, are a recipient, or it's
  // team-wide. System rituals + legacy operator reminders (no recipients AND no
  // setter) are the operator's → only the admin/operator sees them. Solo
  // (me=null) → everything.
  const concernsMe = (r, me, admin) => {
    if (!me) return true;
    const rc = Array.isArray(r.recipients) ? r.recipients : null;
    // A per-user system trigger (system + has recipients, e.g. the per-user
    // morning-planner) is PERSONAL: each user sees only their OWN, admin
    // included — so the operator doesn't see every teammate's planner and a
    // teammate DOES see theirs. Shared operator rituals (system, no recipients:
    // backup/audit/reflect) stay operator-only below.
    if (r.kind === 'system' && rc) return rc.includes(me) || rc.includes(EVERYONE);
    if (r.kind === 'system' || (!rc && !r.setBy)) return admin;
    if ((r.setBy || '') === me) return true;
    return !!rc && (rc.includes(me) || rc.includes(EVERYONE));
  };

  // GET /api/reminders — scoped list + a slug→{name,avatar} map for badges.
  router.get('/reminders', (req, res) => {
    try {
      const me = actorSlug(req);
      const admin = isAdmin(req);
      const reminders = readReminders().filter(r => concernsMe(r, me, admin));
      // slug → { name, avatar } for the recipient avatars in the UI.
      const people = {};
      if (getTeamMode()) for (const m of teamList()) {
        people[m.slug] = { name: m.displayName || m.slug, avatar: avatarUrl(m.slug) || null };
      }
      res.set('Cache-Control', 'no-store');   // per-user + shape changes over time; never let the browser serve a stale cached list
      return res.json({ ok: true, teamMode: getTeamMode(), me, reminders, people });
    } catch (err) {
      process.stderr.write(`[reminders] list failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/reminders/cancel { id } — guarded delete. Member cancels only what
  // they set; admin cancels anything; system rituals are protected (toggle via
  // their own path, never deleted here). The ONLY sanctioned UI mutation.
  router.post('/reminders/cancel', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const reminders = readReminders();
      const idx = reminders.findIndex(r => r.id === id);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'reminder not found' });
      const r = reminders[idx];
      if (r.kind === 'system') {
        return res.status(403).json({ ok: false, error: 'system reminders cannot be cancelled here' });
      }
      const me = actorSlug(req);
      if (me && !isAdmin(req) && (r.setBy || '') !== me) {
        return res.status(403).json({ ok: false, error: 'only the person who set it (or an admin) can cancel this reminder' });
      }
      reminders.splice(idx, 1);
      writeReminders(reminders);
      return res.json({ ok: true, id });
    } catch (err) {
      process.stderr.write(`[reminders] cancel failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
