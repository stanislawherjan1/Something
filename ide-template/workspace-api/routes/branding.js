/**
 * /api/branding/* — runtime workspace branding.
 *
 *   GET  /api/branding             — public, no auth-of-role check; the
 *                                    login page calls this before a session
 *                                    exists so it can render the org name.
 *   PUT  /api/branding             — admin only. Body: { title?, botName?, hideIdeText? }
 *   POST /api/branding/avatar      — admin only. Multipart, field name "avatar".
 *
 * GET resolves: file → env → defaults. PUT writes to a plain JSON file
 * (no encryption, nothing secret here). Avatar is stored as
 * PROJECT_DIR/branding/bot.png and served via nginx alias /branding/bot.png.
 */

import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import * as branding from '../lib/branding.js';
import * as team from '../lib/team.js';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// Admin gating piggybacks on the team store: no admins yet ⇒ no admin gate
// (lets a fresh deploy be configured before any team entry exists). Once the
// first admin is added, branding edits require admin role.
//
// `req.actor` is populated by lib/auth.js, which verifies the session cookie
// JWT and only accepts the X-IDE-User header when it agrees with the cookie
// (defense-in-depth against in-container header forgery).
function requireAdmin(req, res, next) {
  const admins = team.list().filter(e => e.role === 'admin');
  if (admins.length === 0) {
    // No admins yet (fresh deploy, wizard not done, or seeded with members
    // only). Promote the authenticated actor — nginx auth_request has
    // already verified them against IDE_ALLOWED_EMAILS so they're trusted.
    if (req.actor) {
      try { team.ensureFirstAdmin(req.actor, 'auto-bootstrap'); }
      catch (err) { process.stderr.write(`[branding] ensureFirstAdmin failed: ${err.message}\n`); }
    } else {
      req.actor = 'bootstrap';
    }
    return next();
  }
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
  if (!team.isAdmin(req.actor)) {
    return res.status(403).json({ error: 'Only admins can change branding.' });
  }
  next();
}

export default function brandingRouter() {
  const router = Router();

  router.get('/branding', (_req, res) => {
    try {
      res.json(branding.resolve());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/branding/avatar', (_req, res) => {
    if (!branding.hasAvatar()) return res.status(404).end();
    try {
      const path = branding.avatarPath();
      const stat = statSync(path);
      // Sniff PNG vs JPEG from magic bytes so we don't lock the on-disk
      // format. saveAvatar accepts either, so the served Content-Type must
      // match whatever's on disk.
      const head = readFileSync(path).slice(0, 3);
      const ct = head.equals(JPEG_MAGIC) ? 'image/jpeg' : 'image/png';
      res.setHeader('Content-Type',  ct);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'public, max-age=300');
      createReadStream(path).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Org logo — same shape as /branding/avatar. Single upload (POST
  // /api/setup/logo via the wizard) feeds both logoUrl and iconUrl in
  // useBranding(), so TopBar, LoginPage, AccessDenied and WorkspaceHeader
  // all flip to the new image at once after the wizard saves.
  router.get('/branding/logo', (_req, res) => {
    if (!branding.hasLogo()) return res.status(404).end();
    try {
      const path = branding.logoPath();
      const stat = statSync(path);
      const head = readFileSync(path).slice(0, 3);
      const ct = head.equals(JPEG_MAGIC) ? 'image/jpeg' : 'image/png';
      res.setHeader('Content-Type',  ct);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'public, max-age=300');
      createReadStream(path).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/branding', requireAdmin, express.json({ limit: '8kb' }), (req, res) => {
    const { title, botName, hideIdeText, backstory, personality } = req.body || {};
    try {
      const next = branding.update({ title, botName, hideIdeText, backstory, personality, actor: req.actor });
      res.json({ ok: true, branding: next });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/branding/avatar', requireAdmin, upload.single('avatar'), (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing "avatar" file in upload.' });
    }
    try {
      const next = branding.saveAvatar(req.file.buffer);
      res.json({ ok: true, branding: next });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
