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
import { getTeamMode, setProfile, setTelegram, find as findMember } from '../lib/team.js';
import { syncTelegramAllowedIds } from '../lib/integrations/telegram-sync.js';
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
  const member = findMember(scope.email);
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
    // Cross-surface contact (own). Lets the UI show the "link your Telegram"
    // prompt when Telegram is active but this user hasn't linked a chat id.
    telegramChatId:   member?.telegramChatId || null,
    preferredSurface: member?.preferredSurface || null,
    preferredLanguage: member?.preferredLanguage || null,
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
    // no-store: this identity payload changes shape over time (avatarUrl, new
    // fields) and is per-user — without it the browser heuristically caches the
    // response (it has an etag but no cache-control) and keeps serving a stale
    // pre-deploy body on soft reloads, so new fields never appear.
    res.set('Cache-Control', 'no-store');
    res.json(meEnvelope(req));
  });

  // Self-service profile. Edits the CALLER's own entry only — display name
  // and/or their own cross-surface contact (Telegram chat id + preferred
  // surface), so a teammate can self-link without an admin.
  router.patch('/me', requireActor, express.json({ limit: '2kb' }), (req, res) => {
    const { displayName, telegramChatId, preferredSurface, preferredLanguage } = req.body || {};
    try {
      let touched = false;
      if (displayName !== undefined) {
        if (typeof displayName !== 'string') {
          return res.status(400).json({ error: 'displayName must be a string.' });
        }
        setProfile(req.actor, { displayName });
        touched = true;
      }
      if (telegramChatId !== undefined || preferredSurface !== undefined || preferredLanguage !== undefined) {
        setTelegram(req.actor, { chatId: telegramChatId, preferredSurface, preferredLanguage }, req.actor);
        // Self-link changes who may DM the bot — refresh the allow-list (bg).
        if (telegramChatId !== undefined) syncTelegramAllowedIds().catch(() => {});
        touched = true;
      }
      if (!touched) {
        return res.status(400).json({ error: 'Nothing to update (displayName, telegramChatId, preferredSurface, preferredLanguage).' });
      }
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
