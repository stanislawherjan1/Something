/**
 * /api/me — the requesting user's team-mode identity + self-service profile.
 *
 *   GET    /api/me            → { email, slug, role, displayName, isAdmin,
 *                                teamMode, personalRoot, avatarUrl }
 *   PATCH  /api/me            → set your OWN displayName (self-service)
 *   POST   /api/me/avatar     → upload your avatar (browser pre-resizes to a
 *                                512×512 webp; server validates + stores)
 *   DELETE /api/me/avatar     → remove your avatar
 *   GET    /api/me/avatar?slug=<slug>  → stream a user's avatar bytes
 *
 * Drives the sidebar Workspace/Personal split, the role badge, the admin
 * system-files toggle, and the per-user profile (name + avatar). Profile edits
 * are self-service (your own entry) — never admin-gated.
 */

import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_DIR } from '../lib/config.js';
import { requireActor } from '../lib/auth.js';
import { actorScope, USERS_DIR } from '../lib/file-scope.js';
import { getTeamMode, setProfile } from '../lib/team.js';
import * as userAvatars from '../lib/user-avatars.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },   // browser pre-resizes; 1 MB safety cap
});

// multer raises LIMIT_FILE_SIZE BEFORE the route handler, so it would fall
// through to the global 500 handler. Translate it into a 400 the UI can show.
function avatarUpload(req, res, next) {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'That image is too large.'
        : 'Avatar upload failed.';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

// The /api/me identity payload, shared by GET /me and PATCH /me.
function meEnvelope(req) {
  const scope = actorScope(req);
  const teamMode = getTeamMode();
  return {
    email:        scope.email,
    slug:         scope.slug,
    role:         scope.role,
    displayName:  scope.displayName,
    isAdmin:      scope.isAdmin,
    teamMode,
    // Personal section root (e.g. "users/jan") — null in solo mode so the
    // frontend renders the flat file list.
    personalRoot: teamMode ? scope.personalPrefix : null,
    // Cache-busted URL for this user's custom avatar, or null (frontend falls
    // back to the Google picture / initial).
    avatarUrl:    scope.slug ? userAvatars.avatarUrl(scope.slug) : null,
  };
}

export default function meRouter() {
  const router = Router();

  router.get('/me', requireActor, (req, res) => {
    const scope = actorScope(req);
    // Only materialise the personal dir in team mode — a solo workspace has no
    // Workspace/Personal split, so there's no personal section to back.
    if (getTeamMode() && scope.slug) {
      try { mkdirSync(resolve(PROJECT_DIR, USERS_DIR, scope.slug), { recursive: true }); }
      catch { /* best-effort — a real FS error surfaces on the tree call */ }
    }
    res.json(meEnvelope(req));
  });

  // Self-service display name. Edits the CALLER's own entry only.
  router.patch('/me', requireActor, express.json({ limit: '2kb' }), (req, res) => {
    const { displayName } = req.body || {};
    if (typeof displayName !== 'string') {
      return res.status(400).json({ error: 'displayName (string) is required.' });
    }
    try {
      setProfile(req.actor, { displayName });
      res.json(meEnvelope(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Upload your avatar — the browser sends a pre-resized 512×512 webp.
  router.post('/me/avatar', requireActor, avatarUpload, (req, res) => {
    const { slug } = actorScope(req);
    if (!slug) return res.status(400).json({ error: 'No profile for this user.' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'Missing "avatar" file.' });
    try {
      const a = userAvatars.saveUserAvatar(slug, req.file.buffer);
      res.json({ ok: true, avatarUrl: userAvatars.avatarUrl(slug), avatarUpdatedAt: a?.avatarUpdatedAt || null });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/me/avatar', requireActor, (req, res) => {
    const { slug } = actorScope(req);
    if (!slug) return res.status(400).json({ error: 'No profile for this user.' });
    const removed = userAvatars.deleteUserAvatar(slug);
    if (!removed) return res.status(404).json({ error: 'No avatar to remove.' });
    res.json({ ok: true });
  });

  // Stream a user's avatar. Auth-gated (post-login only — nginx + requireActor);
  // any teammate may fetch any slug's avatar (they're shown in the team list).
  router.get('/me/avatar', requireActor, (req, res) => {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
    if (!slug || !userAvatars.hasAvatar(slug)) return res.status(404).end();
    userAvatars.streamUserAvatar(slug, res);
  });

  return router;
}
