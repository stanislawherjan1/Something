/**
 * /api/setup/* — first-run onboarding wizard.
 *
 *   GET  /api/setup/status   — { complete, missing, state }
 *   POST /api/setup/branding — body: { title?, botName? } (just calls branding.update)
 *   POST /api/setup/avatar   — multipart, field "avatar"
 *   POST /api/setup/token    — body: { token } (encrypts CLAUDE_CODE_OAUTH_TOKEN)
 *
 * Authorization model:
 *   - While setup is incomplete, the endpoints are open. This is what
 *     lets the wizard run on a fresh deploy before any admin exists.
 *   - Once setup is complete, the same endpoints become admin-only — the
 *     wizard can be re-entered (e.g. token rotation) but only by admins.
 *
 * `req.actor` is populated by lib/auth.js (JWT verification on the session
 * cookie + cross-check against X-IDE-User). Defense-in-depth against header
 * forgery from inside the code-server container.
 *
 * Audit: every state-changing call appends one line to .platform.audit.log
 * via setup.audit(). The log is HARD_HIDDEN so it can't be read or tampered
 * with through /api/files/*.
 *
 * Rate limit (10/min/IP) on writes — defends against a stolen wizard cookie
 * spamming setup endpoints. Reads (GET /status) aren't limited.
 */

import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import * as setup from '../lib/setup.js';
import * as branding from '../lib/branding.js';
import * as team from '../lib/team.js';
import { restartBot } from '../lib/integrations/runtime.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// Rate limiter — see routes/integrations.js for the rationale (actor-keyed,
// janitor sweeps stale buckets). Wizard limit is 10/min so the user can
// click through Step 1-4 without tripping it.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS  = 10;
const hits = new Map();

function rateKey(req) {
  return req.actor || req.ip || req.socket?.remoteAddress || 'anonymous';
}

function rateLimit(req, res, next) {
  const key = rateKey(req);
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_HITS) {
    return res.status(429).json({ error: 'Too many setup changes. Wait a minute and try again.' });
  }
  recent.push(now);
  hits.set(key, recent);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of hits) {
    if (ts.every(t => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  }
}, RATE_WINDOW_MS).unref();

function requireSetupOrAdmin(req, res, next) {
  const s = setup.status();
  if (!s.complete) {
    // Pre-onboarding: still require an authenticated actor (nginx auth_request
    // already gates `/api/*` to whitelisted Google emails, so req.actor must
    // resolve). This stops two surprises:
    //   1. The "first-mover wins admin" race — every wizard write is now
    //      attributed to a verified email, and team.ensureFirstAdmin is
    //      called below with that email so audit logs name the right person.
    //   2. The 'wizard' sentinel previously masked who actually clicked.
    if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
    return next();
  }
  // Post-onboarding: admin-only re-entry.
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });

  // No admins yet → promote the authenticated actor (nginx auth_request has
  // already verified them against IDE_ALLOWED_EMAILS). Same chicken-and-egg
  // fix as in routes/branding.js requireAdmin.
  const admins = team.list().filter(e => e.role === 'admin');
  if (admins.length === 0) {
    try { team.ensureFirstAdmin(req.actor, 'auto-bootstrap'); }
    catch (err) { process.stderr.write(`[setup] ensureFirstAdmin failed: ${err.message}\n`); }
    return next();
  }

  if (!team.isAdmin(req.actor)) {
    return res.status(403).json({ error: 'Only admins can change setup.' });
  }
  next();
}

export default function setupRouter() {
  const router = Router();

  router.get('/setup/status', (_req, res) => {
    try {
      res.json(setup.status());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/setup/branding', requireSetupOrAdmin, rateLimit, express.json({ limit: '8kb' }), (req, res) => {
    const { title, botName, hideIdeText, backstory, personality } = req.body || {};
    try {
      const next = branding.update({ title, botName, hideIdeText, backstory, personality, actor: req.actor });
      const changed = [];
      if (typeof title       === 'string') changed.push('title');
      if (typeof botName     === 'string') changed.push('botName');
      if (typeof hideIdeText === 'boolean') changed.push('hideIdeText');
      if (typeof backstory   === 'string') changed.push('backstory');
      if (personality && typeof personality === 'object') changed.push('personality');
      setup.audit('branding_update', req.actor, { fields: changed });
      res.json({ ok: true, branding: next, status: setup.status() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/setup/avatar', requireSetupOrAdmin, rateLimit, upload.single('avatar'), (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing "avatar" file in upload.' });
    }
    try {
      const next = branding.saveAvatar(req.file.buffer);
      setup.audit('avatar_upload', req.actor, { bytes: req.file.buffer.length });
      res.json({ ok: true, branding: next, status: setup.status() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/setup/avatar/preset', requireSetupOrAdmin, rateLimit, express.json({ limit: '2kb' }), (req, res) => {
    const { preset } = req.body || {};
    if (!preset) return res.status(400).json({ error: 'Missing preset ID.' });
    try {
      const next = branding.applyPresetAvatar(String(preset));
      setup.audit('avatar_preset', req.actor, { preset: String(preset) });
      res.json({ ok: true, branding: next, status: setup.status() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/setup/logo', requireSetupOrAdmin, rateLimit, upload.single('avatar'), (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing "logo" file in upload.' });
    }
    try {
      branding.saveLogo(req.file.buffer);
      setup.audit('logo_upload', req.actor, { bytes: req.file.buffer.length });
      res.json({ ok: true, status: setup.status() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/setup/token', requireSetupOrAdmin, rateLimit, express.json({ limit: '8kb' }), async (req, res) => {
    const { token } = req.body || {};
    try {
      // setClaudeToken emits 'token_set' audit + writes .credentials.json
      // and integrations.env. Bot still has the OLD token cached in its
      // claude process — restart so the new turn reads the new creds.
      setup.setClaudeToken(token, req.actor);
      const restartOk = req.actor === 'migration'
        ? true                          // migration path skips restart
        : await restartBot();
      res.json({
        ok: true,
        status: setup.status(),
        restarting: req.actor !== 'migration',
        restartFailed: req.actor !== 'migration' && !restartOk,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/setup/token', requireSetupOrAdmin, rateLimit, async (req, res) => {
    try {
      // clearClaudeToken emits 'token_clear' audit + unlinks credentials.
      // Restart so the bot stops authing with the just-cleared token.
      setup.clearClaudeToken(req.actor);
      const restartOk = req.actor === 'migration' ? true : await restartBot();
      res.json({
        ok: true,
        status: setup.status(),
        restarting: req.actor !== 'migration',
        restartFailed: req.actor !== 'migration' && !restartOk,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
