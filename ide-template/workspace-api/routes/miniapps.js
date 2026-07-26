/**
 * /api/miniapps — actor-scoped CRUD for AI-built mini apps (sidebar tabs).
 *
 * A mini app is a JSON spec file written by the miniapp MCP (save_as_tab):
 * an OpenUI Lang component tree plus data sources. The UI lists them in the
 * sidebar ("Your Mini Apps") and renders them client-side; this router is the
 * sanctioned read/manage path so the dashboard never touches raw files.
 *
 * Scoping mirrors reminders.js: in team mode each user sees only their own
 * apps (stored under users/<slug>/.claude/miniapps); solo mode uses the
 * shared root (.claude/miniapps) — same split save_as_tab applies on write.
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTeamMode, getUser } from '../lib/team.js';

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Directory for the requesting actor. Team mode → personal tree; solo →
// shared root. Returns null when team mode is on but the actor has no slug
// (unidentified session) — no apps rather than leaking the shared dir.
function appsDir(req) {
  if (!getTeamMode()) return join(PROJECT_DIR, '.claude', 'miniapps');
  const slug = getUser(req.actor)?.slug || null;
  if (!slug) return null;
  return join(PROJECT_DIR, 'users', slug, '.claude', 'miniapps');
}

function readApp(dir, id) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function writeApp(dir, id, app) {
  const file = join(dir, `${id}.json`);
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(app, null, 2));
  renameSync(tmp, file);   // atomic swap (mirrors reminders)
}

export default function miniappsRouter() {
  const router = Router();

  // GET /api/miniapps — list summaries for the sidebar.
  router.get('/miniapps', (req, res) => {
    const dir = appsDir(req);
    if (!dir || !existsSync(dir)) return res.json({ apps: [] });
    try {
      const apps = readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => readApp(dir, f.slice(0, -5)))
        .filter(Boolean)
        .map(a => ({ id: a.id, name: a.name || a.id, icon: a.icon || null, order: a.order ?? 0, created: a.created || null }))
        .sort((x, y) => (x.order - y.order) || String(x.created).localeCompare(String(y.created)));
      res.json({ apps });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/miniapps/:id — full spec for the renderer.
  router.get('/miniapps/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const dir = appsDir(req);
    const app = dir ? readApp(dir, id) : null;
    if (!app) return res.status(404).json({ error: 'not found' });
    res.json({ app });
  });

  // PATCH /api/miniapps/:id — rename / reorder.
  router.patch('/miniapps/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const dir = appsDir(req);
    const app = dir ? readApp(dir, id) : null;
    if (!app) return res.status(404).json({ error: 'not found' });
    const { name, order } = req.body || {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) {
        return res.status(400).json({ error: 'bad name' });
      }
      app.name = name.trim();
    }
    if (order !== undefined) {
      if (typeof order !== 'number' || !Number.isFinite(order)) {
        return res.status(400).json({ error: 'bad order' });
      }
      app.order = order;
    }
    try {
      writeApp(dir, id, app);
      res.json({ ok: true, app: { id: app.id, name: app.name, order: app.order ?? 0 } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/miniapps/:id
  router.delete('/miniapps/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const dir = appsDir(req);
    if (!dir || !existsSync(join(dir, `${id}.json`))) return res.status(404).json({ error: 'not found' });
    try {
      unlinkSync(join(dir, `${id}.json`));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
