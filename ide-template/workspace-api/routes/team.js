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

import { soloSharedToOwner } from '../lib/memory-solo.js';
import { Router } from 'express';
import express from 'express';
import * as team from '../lib/team.js';
import { reschedulePlanFor } from '../lib/planner-schedule.js';
import { mergePersonalToWorkspace, countPersonalFiles } from '../lib/file-scope.js';
import { restoreDefaultMemory, migrateDefaultMemory } from '../lib/memory-loader.js';
import { avatarUrl } from '../lib/user-avatars.js';
import { syncTelegramAllowedIds, syncTelegramGroups } from '../lib/integrations/telegram-sync.js';
import { listUnregistered } from '../lib/integrations/group-watcher.js';
import * as slackChannels from '../lib/integrations/slack-channels.js';
import { pendingUsers as slackPendingUsers, forgetPending as slackForgetPending } from '../lib/integrations/slack-listener.js';

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
      const row = { ...e, avatarUrl: avatarUrl(e.slug), telegramLinked: !!e.telegramChatId, slackLinked: !!e.slackUserId, operatorPinned: !!(opId && e.telegramChatId === opId) };
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
  router.put('/team/mode', requireAdmin, rateLimit, express.json({ limit: '1kb' }), async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }
    // Solo is one person: with anyone else on the roster, team mode stays on
    // until they are removed (removal archives their private trees and their
    // own connections). The answer names them so the screen can say who.
    if (!enabled) {
      const me = String(req.actor || '').toLowerCase();
      const others = team.list().filter(m => String(m.email || '').toLowerCase() !== me);
      if (others.length) return res.status(409).json({ error: 'Remove everyone else from the team first.', others: others.map(m => ({ email: m.email, name: m.displayName || m.email, role: m.role })) });
    }
    let merged = null;
    if (!enabled && req.body?.mergePersonal === true) {
      const slug = team.slugFor(req.actor);
      if (slug) merged = mergePersonalToWorkspace(slug);
    }
    const wasTeam = team.getTeamMode();
    const teamMode = team.setTeamMode(enabled, req.actor);
    // Switched on: what solo kept in shared memory is the owner's, not the new team's.
    let movedToOwner = null;
    if (teamMode && !wasTeam) {
      try { movedToOwner = await soloSharedToOwner(team.primaryAdminSlug()); }
      catch (err) { process.stderr.write(`[team] solo memory to the owner: ${err.message}\n`); }
    }
    // Solo reads the one person's cards flat, team mode from users/<admin>:
    // move them with the switch. Waiting for the next boot left the owner's
    // profile looking empty until then (seen on the canary).
    if (teamMode && !wasTeam) {
      try { migrateDefaultMemory(team.primaryAdminSlug()); }
      catch (err) { process.stderr.write(`[team] solo cards to the owner: ${err.message}\n`); }
    }
    if (!teamMode) restoreDefaultMemory(team.primaryAdminSlug());
    // Everyone's private trees are theirs again at once — a merge recreates
    // the caller's users/<slug> as workspace-api's, readable by every turn,
    // and only a boot re-assigned it before (seen on the canary).
    try { team.reconcileSlots(); } catch (err) { process.stderr.write(`[team] reconcile after the switch: ${err.message}\n`); }
    res.json({ ok: true, teamMode, merged, ...(movedToOwner ? { movedToOwner } : {}) });
  });

  // The workspace's default time zone (people without their own use it).
  // Changing it moves the morning planning of everyone who follows it.
  router.put('/team/default-timezone', requireAdmin, rateLimit, express.json({ limit: '1kb' }), (req, res) => {
    try {
      const tz = team.setDefaultTimezone(String(req.body?.timezone || ''), req.actor);
      for (const m of team.list()) if (!m.timezone && m.slug) { try { reschedulePlanFor(m.slug); } catch { /* best effort */ } }
      res.json({ ok: true, defaultTimezone: tz });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
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
    const { role, telegramChatId, preferredSurface, preferredLanguage, slackUserId } = req.body || {};
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
      // A Slack account links itself by email; an admin may link one by id when
      // the person's Slack email is not the roster one (admins only — a self-link
      // by id would let someone claim another person's account).
      if (slackUserId !== undefined) {
        entry = team.setSlack(req.params.email, { userId: slackUserId }, req.actor);
      }
      // Reflect v2: pre-consent to auto-promote this person's org DM facts to
      // shared memory (typically the operator toggles it on themselves).
      if (!entry) return res.status(400).json({ error: 'Nothing to update (role, telegramChatId, slackUserId, preferredSurface, or preferredLanguage).' });
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
    res.json({ ok: true, groups: canEdit ? team.listGroups().filter(g => g.kind === 'telegram') : [], canEdit });
  });

  // ─── Channels of every kind (today: Slack) ──────────────────────────────
  // The registered rooms, the rooms waiting for an admin's yes, and the people
  // who wrote to the bot on Slack without being on the team. Admins only see
  // the pending lists; everyone sees that the surface exists.
  router.get('/team/channels', (req, res) => {
    if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
    const canEdit = team.isAdmin(req.actor);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const groups = canEdit ? team.listGroups().filter(g => !kind || g.kind === kind) : [];
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true, canEdit, groups,
      pending: canEdit ? slackChannels.pendingChannels() : [],
      pendingPeople: canEdit ? slackPendingUsers() : [],
    });
  });

  // Approve a room (a Slack channel the bot was added to), or change one.
  router.post('/team/channels', requireAdmin, rateLimit, express.json({ limit: '2kb' }), async (req, res) => {
    const { chatId, title, beat, requireMention, language, openAudience } = req.body || {};
    try {
      const id = String(chatId || '').trim();
      if (id.startsWith('slack-')) {
        const group = await slackChannels.approveChannel(id, { actor: req.actor, title, beat, requireMention, language, openAudience });
        // A room reopened to outsiders, or closed to them again, is rechecked at once.
        if (openAudience != null) await slackChannels.checkAudience(id, { quiet: true });
        return res.status(201).json({ ok: true, group });
      }
      const group = team.addGroup({ chatId: id, title, beat, requireMention, language, actor: req.actor });
      syncTelegramGroups().catch(() => {});
      res.status(201).json({ ok: true, group });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Decline or remove a room: the bot leaves a Slack channel it is removed from here.
  router.delete('/team/channels/:chatId', requireAdmin, rateLimit, async (req, res) => {
    const id = String(req.params.chatId || '').trim();
    if (id.startsWith('slack-')) {
      const known = !!team.getGroup(id) || slackChannels.pendingChannels().some(p => p.chatId === id);
      if (!known) return res.status(404).json({ error: 'not a known channel' });
      await slackChannels.rejectChannel(id, 'removed by an admin');
      return res.json({ ok: true, removed: id });
    }
    const removed = team.removeGroup(id, req.actor);
    if (!removed) return res.status(404).json({ error: 'group not allow-listed' });
    syncTelegramGroups().catch(() => {});
    res.json({ ok: true, removed: id });
  });

  // Who is in the room now — re-run the audience check on demand.
  router.post('/team/channels/:chatId/recheck', requireAdmin, rateLimit, async (req, res) => {
    const id = String(req.params.chatId || '').trim();
    if (!team.getGroup(id)) return res.status(404).json({ error: 'not a registered channel' });
    try {
      const audience = await slackChannels.checkAudience(id);
      res.json({ ok: true, audience, group: team.getGroup(id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // A person who wrote on Slack without being on the team: forget the request
  // (adding them is POST /api/team with their email, as for anyone).
  router.delete('/team/channels/pending-people/:id', requireAdmin, rateLimit, (req, res) => {
    slackForgetPending(String(req.params.id || ''));
    res.json({ ok: true });
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
