/**
 * /api/team/* — team whitelist management.
 *
 *   GET    /api/team           — list { entries: [{email, role, addedAt, addedBy}], me: {email, role, isAdmin} }
 *   POST   /api/team           — body: { email, role? } (admin only)
 *   PATCH  /api/team/:email    — body: { role } (admin only, lockout-protected)
 *   DELETE /api/team/:email    — admin only, refuses self-delete + last admin
 *
 * Auth: nginx auth_request /auth/verify gates every /api/* request and sets
 * the verified email in X-IDE-User. lib/auth.js cross-checks that against
 * the JWT in the session cookie before populating req.actor — header alone
 * isn't trusted in case anything inside the container ever talks to
 * workspace-api directly (port 3001, internal Docker network).
 *
 * Rate limit (5/min/IP) on writes — enough for legitimate team-edit bursts,
 * tight enough that a stolen session can't quietly invite a thousand emails.
 */

import { Router } from 'express';
import express from 'express';
import * as team from '../lib/team.js';
import { mergePersonalToWorkspace, countPersonalFiles } from '../lib/file-scope.js';
import { avatarUrl } from '../lib/user-avatars.js';
import { syncTelegramAllowedIds, syncTelegramGroups } from '../lib/integrations/telegram-sync.js';
import { listUnregistered } from '../lib/integrations/group-watcher.js';

// Rate limiter — see routes/integrations.js for the rationale (actor-keyed,
// janitor sweeps stale buckets). Same shape, separate bucket count so a
// chatty integrations user doesn't lock themselves out of team edits.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS  = 5;
const hits = new Map();

function rateKey(req) {
  return req.actor || req.ip || req.socket?.remoteAddress || 'anonymous';
}

function rateLimit(req, res, next) {
  const key = rateKey(req);
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_HITS) {
    return res.status(429).json({ error: 'Too many team changes. Wait a minute and try again.' });
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

function requireAdmin(req, res, next) {
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
  if (!team.isAdmin(req.actor)) {
    return res.status(403).json({ error: 'Only admins can change team membership.' });
  }
  next();
}

export default function teamRouter() {
  const router = Router();

  router.get('/team', (req, res) => {
    const viewerIsAdmin = req.actor ? team.isAdmin(req.actor) : false;
    const viewerEmail = String(req.actor || '').toLowerCase();
    // The member linked to the ACTIVATION admin chat id can't be unlinked from
    // the roster (bot.sh unions that id into allowFrom regardless) — flag the
    // row so the UI says so instead of offering an Unlink that would 400.
    const opId = team.operatorChatId();
    const entries = team.list().map(e => {
      // `telegramLinked` is roster-level info (who's reachable on Telegram) and
      // is visible to EVERYONE, so members can see each other's channels.
      // The raw chat id is a private contact handle, so only an admin or the
      // row's owner sees the actual value. `preferredSurface` stays visible too.
      const row = { ...e, avatarUrl: avatarUrl(e.slug), telegramLinked: !!e.telegramChatId, operatorPinned: !!(opId && e.telegramChatId === opId) };
      if (!viewerIsAdmin && e.email !== viewerEmail) row.telegramChatId = null;
      return row;
    });
    const me = req.actor ? team.find(req.actor) : null;
    res.set('Cache-Control', 'no-store');   // per-user + avatarUrl/shape changes; never serve a stale cached roster
    res.json({
      entries,
      teamMode: team.getTeamMode(),
      // How many files the caller has in their personal dir — lets the UI
      // offer "move them to the workspace" when disabling team mode.
      personalFileCount: me?.slug ? countPersonalFiles(me.slug) : 0,
      me: req.actor ? {
        email:   req.actor,
        role:    me?.role || null,
        isAdmin: me?.role === 'admin',
      } : null,
    });
  });

  // Toggle solo <-> collaborative. Admin-only. Enabling is the deliberate gate
  // that unlocks inviting teammates and the Workspace/Personal split. When
  // disabling, `mergePersonal: true` moves the CALLER's own personal files up
  // into the shared workspace (collision-renamed) — never anyone else's.
  router.put('/team/mode', requireAdmin, rateLimit, express.json({ limit: '1kb' }), (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }
    let merged = null;
    if (!enabled && req.body?.mergePersonal === true) {
      const slug = team.slugFor(req.actor);
      if (slug) merged = mergePersonalToWorkspace(slug);
    }
    res.json({ ok: true, teamMode: team.setTeamMode(enabled, req.actor), merged });
  });

  router.post('/team', requireAdmin, rateLimit, express.json({ limit: '4kb' }), (req, res) => {
    // Inviting teammates only makes sense once the workspace is collaborative.
    // Gate it server-side too (the UI hides invite in solo mode).
    if (!team.getTeamMode()) {
      return res.status(409).json({ error: 'Enable team collaboration before inviting members.' });
    }
    const { email, role } = req.body || {};
    try {
      const entry = team.add({ email, role: role || 'member', addedBy: req.actor });
      res.status(201).json({ ok: true, entry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/team/:email', requireAdmin, rateLimit, express.json({ limit: '4kb' }), (req, res) => {
    const { role, telegramChatId, preferredSurface, preferredLanguage, autoPromote } = req.body || {};
    try {
      let entry = null;
      if (role !== undefined) {
        entry = team.setRole({ email: req.params.email, role, actor: req.actor });
      }
      if (telegramChatId !== undefined || preferredSurface !== undefined || preferredLanguage !== undefined) {
        entry = team.setTelegram(req.params.email, { chatId: telegramChatId, preferredSurface, preferredLanguage }, req.actor);
        // A changed chat id changes who may DM the bot — push the new allow-list
        // to the integration + restart (background; don't block the response).
        if (telegramChatId !== undefined) syncTelegramAllowedIds().catch(() => {});
      }
      // Reflect v2: pre-consent to auto-promote this person's org DM facts to
      // shared memory (typically the operator toggles it on themselves).
      if (autoPromote !== undefined) {
        entry = team.setAutoPromote(req.params.email, !!autoPromote, req.actor);
      }
      if (!entry) return res.status(400).json({ error: 'Nothing to update (role, telegramChatId, preferredSurface, preferredLanguage, or autoPromote).' });
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/team/:email', requireAdmin, rateLimit, (req, res) => {
    try {
      const removed = team.remove({ email: req.params.email, actor: req.actor });
      // Their chat id (if any) drops out of the allow-list.
      if (removed?.telegramChatId) syncTelegramAllowedIds().catch(() => {});
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Group mode: which Telegram GROUPS the assistant is active in ────────────
  // The relevance watcher allow-lists on this registry (.team-config.json). No
  // bot restart needed: server.ts Patch 4f diverts ALL group traffic regardless
  // of access.json, and the watcher reads the config fresh per message.
  // (Telegram still only DELIVERS untagged group messages with BotFather privacy
  // mode OFF — that's an out-of-band one-time setup, see the group-mode runbook.)
  // Telegram is an admin-only surface (the AI-Settings tile is hidden from
  // members and TelegramDashboard refuses to render for them). We still answer
  // 200 for any authenticated teammate so the UI can read `canEdit`, but the
  // registry itself — group titles + member handles — is only returned to
  // admins. Writes below stay requireAdmin. nginx already gated /api/*.
  router.get('/team/telegram-groups', (req, res) => {
    if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
    const canEdit = team.isAdmin(req.actor);
    res.json({ ok: true, groups: canEdit ? team.listGroups() : [], canEdit });
  });

  // Groups the bot is IN but NOT registered yet — admin-only; powers the one-click
  // "register" affordance in the UI. Static path, no collision with :chatId below.
  router.get('/team/telegram-groups/pending', requireAdmin, (_req, res) => {
    res.json({ ok: true, pending: listUnregistered() });
  });

  router.post('/team/telegram-groups', requireAdmin, rateLimit, express.json({ limit: '2kb' }), (req, res) => {
    const { chatId, title, beat, requireMention, language } = req.body || {};
    try {
      const group = team.addGroup({ chatId, title, beat, requireMention, language, actor: req.actor });
      syncTelegramGroups().catch(() => {});   // re-seed access.json so the operator can reply into it
      res.status(201).json({ ok: true, group });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/team/telegram-groups/:chatId', requireAdmin, rateLimit, (req, res) => {
    const removed = team.removeGroup(req.params.chatId, req.actor);
    if (!removed) return res.status(404).json({ error: 'group not allow-listed' });
    syncTelegramGroups().catch(() => {});
    res.json({ ok: true, removed: req.params.chatId });
  });

  return router;
}
