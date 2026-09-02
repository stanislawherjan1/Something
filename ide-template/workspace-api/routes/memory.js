/**
 * /api/memory/* — surfaces for the LLM-wiki memory layer.
 *
 *   GET  /api/memory/graph             → { nodes, edges, generated_at }
 *   GET  /api/memory/grep              → { matches: [{ file, line, snippet }] }
 *   GET  /api/memory/prefix            → { approxTokens, sources, meetsCacheFloor, breakpoint }
 *   GET  /api/memory/prefix?raw=1      → text/plain prefix block (for bot.sh fetch)
 *   GET  /api/memory/recent/:channel   → { channel, snapshot_age_seconds, content } — live RECENT_<CHANNEL>.md
 *   GET  /api/memory/changes           → { count, changes } — the engine's write log
 *   POST /api/memory/revert            → undo one logged write (restore + replay)
 *   POST /api/memory/snapshot/refresh  → { refreshed: [{ channel, ... }] }
 *
 * Reads are pure. Two routes write: the snapshot refresh (rolling tails, for the
 * PM2 idle monitor + the chat-reset hook) and revert, which goes through the
 * memory engine. Every other memory mutation happens through the engine's own
 * route (/api/internal/memory-write), driven by the memory_write tool.
 * Auth handled upstream (nginx auth_request).
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { buildMemoryGraph } from '../lib/memory-graph.js';
import { grepMemory } from '../lib/memory-grep.js';
import { buildCachedPrefix, meetsCacheFloor } from '../lib/memory-loader.js';
import { readLog, revert as revertEvent } from '../lib/memory-engine.js';
import { writeRecentSnapshot, isSnapshotStale, SUPPORTED_CHANNELS } from '../lib/recent-snapshot.js';
import { getTeamMode, primaryAdminSlug, getUser, isAdmin } from '../lib/team.js';

export default function memoryRouter() {
  const router = Router();

  router.get('/memory/graph', (req, res) => {
    try {
      // Team mode: scope the graph to the REQUESTING user — the shared tree plus
      // THEIR own private memory/users/<slug>/, never another teammate's. Solo /
      // no team → null → shared tree only (everything tagged scope:'shared').
      const slug = getTeamMode() ? (getUser(req.actor)?.slug || null) : null;
      const graph = buildMemoryGraph(slug);
      res.json(graph);
    } catch (err) {
      process.stderr.write(`[memory/graph] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // GET /api/memory/grep?q=<query>&regex=0|1&max=10
  // Cheap deterministic lookup over memory/. Backed by ripgrep when present,
  // pure-Node fallback otherwise. Searches the shared tree plus the CALLER's own
  // private memory — never another teammate's.
  router.get('/memory/grep', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q) return res.status(400).json({ error: 'missing query: ?q=<text>' });
    const regex = req.query.regex === '1' || req.query.regex === 'true';
    const max   = req.query.max != null ? Math.max(1, Math.min(50, Number(req.query.max) || 10)) : 10;
    try {
      const actor = getTeamMode() ? (getUser(req.actor)?.slug || null) : null;
      const matches = await grepMemory(q, { maxCount: max, regex, actor });
      res.json({ query: q, regex, count: matches.length, matches });
    } catch (err) {
      process.stderr.write(`[memory/grep] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // GET /api/memory/prefix — diagnostics for the cached prefix. Reports
  // approximate token count, sources loaded, and whether the prefix clears
  // the 4096-token cache floor on Opus 4.7 / Sonnet 4.6. Used by the
  // pre-warm script and for ad-hoc debugging; returns no body content.
  //
  // GET /api/memory/prefix?raw=1 — returns the prefix BLOCK as text/plain
  // (no JSON envelope). Consumed by bot.sh to write the prefix to a file
  // and pass it to the tmux claude session via --append-system-prompt-file,
  // so the bot has the same memory-card prefix the web side gets via
  // claude.js's inline buildCachedPrefix() call. Without this endpoint
  // the bot started with global-claude.md + project CLAUDE.md only —
  // no USER_PROFILE, no RULES, no RECENT_TELEGRAM — while global-claude.md
  // told the model "you have these in your prefix, don't re-read" (gaslit).
  router.get('/memory/prefix', (req, res) => {
    // raw=1 returns the FULL prefix BLOCK — in team mode that includes the
    // primary admin's PRIVATE memory (USER_PROFILE / USER_PREFERENCES + recent
    // web/telegram tails, loaded with actor = primary admin below). Only the
    // in-container bot + pre-warm fetch it, over 127.0.0.1. A browser member
    // reaches wsapi through the SEPARATE nginx container, so their peer is never
    // loopback — gate raw on that to stop a non-admin reading the admin's
    // private memory. The JSON diagnostics (no content) stay open for the
    // AI-Settings dashboard.
    const isRaw = req.query.raw === '1';
    if (isRaw) {
      const ip = req.socket?.remoteAddress || '';
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return res.status(403).json({ error: 'loopback only' });
      }
    }
    try {
      // This endpoint has no per-user identity (it's the bot/Telegram surface
      // + the pre-warm script). In team mode the personal cards (USER_PROFILE /
      // USER_PREFERENCES) live under memory/users/<slug>/, and migrateDefaultMemory
      // relocated the operator's solo cards to the PRIMARY ADMIN's private dir —
      // so resolve the actor to that admin, or the bot would read the now-empty
      // flat cards. Solo → undefined → flat load, unchanged.
      const actor = getTeamMode() ? primaryAdminSlug() : undefined;
      const result = buildCachedPrefix({ actor });
      if (isRaw) {
        res.type('text/plain').send(result.block || '');
        return;
      }
      res.json({
        approxTokens:    result.approxTokens,
        meetsCacheFloor: meetsCacheFloor(result),
        breakpoint:      result.breakpoint,
        sources:         result.sources,
      });
    } catch (err) {
      process.stderr.write(`[memory/prefix] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // GET /api/memory/changes[?days=7] — what the memory engine actually wrote,
  // newest first, each with the id that reverts it. Memory writes are SILENT by
  // contract (no notification on any surface), so this is the surface that
  // answers "what did you save?" — for the dashboard feed and for the operator.
  router.get('/memory/changes', (req, res) => {
    try {
      const days = req.query.days != null ? Math.max(1, Math.min(90, Number(req.query.days) || 7)) : 7;
      const since = Date.now() - days * 86400 * 1000;
      // Team mode: a member sees the shared tree plus their OWN private writes,
      // never a teammate's — the same rule that guards reads.
      const me = getTeamMode() ? (getUser(req.actor)?.slug || null) : null;
      const mine = (e) => !e.target.startsWith('memory/users/') || (me && e.target.startsWith(`memory/users/${me}/`));
      const changes = readLog({ limit: 500, since })
        .filter(e => e.op !== 'relink')
        .filter(mine)
        .map(e => ({
          id: e.id, ts: e.ts, action: e.op, target: e.target, section: e.section || null,
          scope: e.scope || 'shared', owner: e.owner || null, source: e.source || null,
          added: (e.added || []).map(a => a.line), removed: e.removed || [],
          revertable: !!e.undo,
        }))
        .reverse();
      res.json({ count: changes.length, days, changes });
    } catch (err) {
      process.stderr.write(`[memory/changes] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // POST /api/memory/revert { event_id } — one-tap undo of a logged write. The
  // engine restores the pre-image and REPLAYS anything written to that file
  // afterwards, so undoing an old write cannot silently discard newer facts.
  router.post('/memory/revert', (req, res) => {
    const me = getTeamMode() ? (getUser(req.actor)?.slug || null) : null;
    if (getTeamMode() && !me) return res.status(403).json({ error: 'unknown actor' });
    try {
      const out = revertEvent({ eventId: String(req.body?.event_id || ''), actor: me });
      res.status(out.ok ? 200 : 422).json(out);
    } catch (err) {
      process.stderr.write(`[memory/revert] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // GET /api/memory/recent/:channel[?limit=N]
  // Returns the LIVE content of memory/RECENT_<CHANNEL>.md plus a
  // snapshot_age_seconds field so the caller knows how fresh the file is.
  // Exists so the Telegram bot can pull a fresher snapshot than the one
  // baked into its --append-system-prompt-file at tmux startup — that
  // prefix is static for the session lifetime, this endpoint reads the
  // file the snapshot-monitor maintains on disk (refreshed every 60s
  // when idle).
  //
  // The wrapper mcp__workspace-api__recent_messages calls this; see also
  // the `recent-context` skill which trains the model when to reach for it.
  router.get('/memory/recent/:channel', (req, res) => {
    try {
      const channel = String(req.params.channel || '').toLowerCase();
      if (!SUPPORTED_CHANNELS.includes(channel)) {
        return res.status(400).json({
          error: `invalid channel (got "${channel}"); allowed: ${SUPPORTED_CHANNELS.join(', ')}`,
        });
      }
      // Force-refresh the snapshot from the LIVE conversation log FIRST. This is
      // the whole point of recent_messages: the prefix RECENT_* block is frozen
      // at tmux start, so a relay just delivered to a teammate's Telegram is NOT
      // in it — and a stale read here would make the bot confidently cite an
      // OLDER relay. Refreshing the *file* never touches the already-loaded
      // prefix (cache-safe), it just makes this tool return the current tail.
      // Best-effort: on failure we read whatever's on disk.
      try { writeRecentSnapshot({ channel }); }
      catch (err) { process.stderr.write(`[memory/recent ${channel}] refresh failed: ${err.message}\n`); }
      const projectDir = process.env.PROJECT_DIR || '/home/coder/project';
      // RECENT_TELEGRAM is the OPERATOR's private conversation (single bot). In
      // team mode it lives in the admin's per-user dir, and ONLY the operator may
      // read it — a non-operator asking for the Telegram tail gets nothing (don't
      // hand the operator's DMs to another teammate through this tool).
      let path;
      const me = getTeamMode() ? (getUser(req.actor)?.slug || null) : null;
      if (channel === 'telegram' && getTeamMode()) {
        const adminSlug = primaryAdminSlug();
        if (!me || me !== adminSlug) {
          return res.json({ channel, exists: false, snapshot_age_seconds: null, content: '', bytes: 0,
            note: 'Telegram is the operator\'s channel; no Telegram tail for this user.' });
        }
        path = join(projectDir, 'memory', 'users', adminSlug, 'RECENT_TELEGRAM.md');
      } else if (channel === 'web' && me && /^[a-z0-9-]+$/.test(me)) {
        // Team mode writes each person's web tail to memory/users/<slug>/ and
        // REMOVES the flat file — so reading the flat path here always returned
        // "snapshot file not yet created", i.e. recent_messages({channel:"web"})
        // was dead on every team workspace while the prefix told the model to
        // rely on it. Resolve the caller's own tail; never another user's.
        path = join(projectDir, 'memory', 'users', me, 'RECENT_WEB.md');
      } else {
        path = join(projectDir, 'memory', `RECENT_${channel.toUpperCase()}.md`);
      }
      if (!existsSync(path)) {
        return res.json({
          channel,
          path,
          exists: false,
          snapshot_age_seconds: null,
          content: '',
          bytes: 0,
          note: 'snapshot file not yet created: channel may be idle or never used',
        });
      }
      const st = statSync(path);
      const ageMs = Date.now() - st.mtimeMs;
      let content = readFileSync(path, 'utf8');
      // Optional ?limit=N — truncate to last N message sections (each starts
      // with "## " on its own line). Frontmatter (between leading ---) is
      // always preserved.
      const limit = req.query.limit != null ? Math.max(1, Math.min(200, Number(req.query.limit) || 50)) : null;
      if (limit) {
        const fmEnd = content.indexOf('\n---\n', 4);
        const frontmatter = fmEnd > 0 ? content.slice(0, fmEnd + 5) : '';
        const body = fmEnd > 0 ? content.slice(fmEnd + 5) : content;
        const sections = body.split(/(?=^## )/m).filter(s => s.trim());
        const tail = sections.slice(-limit).join('');
        content = frontmatter + (frontmatter ? '\n' : '') + tail;
      }
      res.json({
        channel,
        path,
        exists: true,
        snapshot_age_seconds: Math.round(ageMs / 1000),
        snapshot_updated_at: new Date(st.mtimeMs).toISOString(),
        bytes: content.length,
        content,
      });
    } catch (err) {
      process.stderr.write(`[memory/recent/:channel] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // POST /api/memory/snapshot/refresh?channel=web|telegram|all&force=1
  // Rebuilds the rolling-snapshot memory card(s) from the source JSONL.
  // By default skips if the source isn't idle (so we don't bust the
  // prompt cache mid-conversation). Pass force=1 to refresh anyway.
  // Called by the PM2 idle monitor every 60s, and by the chat-reset
  // hook when the user clicks "Reset chat" on the web side.
  router.post('/memory/snapshot/refresh', (req, res) => {
    const requested = String(req.query.channel || 'all').toLowerCase();
    const force = req.query.force === '1' || req.query.force === 'true';
    const channels = requested === 'all'
      ? SUPPORTED_CHANNELS
      : (SUPPORTED_CHANNELS.includes(requested) ? [requested] : []);
    if (channels.length === 0) {
      return res.status(400).json({
        error: `unknown channel: "${requested}". Valid: ${SUPPORTED_CHANNELS.join(', ')}, all`,
      });
    }
    const out = [];
    for (const channel of channels) {
      try {
        if (!force && !isSnapshotStale({ channel })) {
          out.push({ channel, skipped: 'not stale' });
          continue;
        }
        const result = writeRecentSnapshot({ channel });
        out.push(result);
      } catch (err) {
        process.stderr.write(`[memory/snapshot/refresh ${channel}] ${err && err.stack || err}\n`);
        out.push({ channel, error: err && err.message || 'internal error' });
      }
    }
    res.json({ refreshed: out });
  });

  return router;
}
