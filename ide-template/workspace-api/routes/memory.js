/**
 * /api/memory/* — surfaces for the LLM-wiki memory layer.
 *
 *   GET  /api/memory/graph             → { nodes, edges, generated_at }
 *   GET  /api/memory/grep              → { matches: [{ file, line, snippet }] }
 *   GET  /api/memory/prefix            → { approxTokens, sources, meetsCacheFloor, breakpoint }
 *   GET  /api/memory/prefix?raw=1      → text/plain prefix block (for bot.sh fetch)
 *   GET  /api/memory/recent/:channel   → { channel, snapshot_age_seconds, content } — live RECENT_<CHANNEL>.md
 *   GET  /api/memory/threads           → { count, threads: [{ thread_id, title, ... }] }
 *   POST /api/memory/snapshot/refresh  → { refreshed: [{ channel, ... }] }
 *
 * Reads are pure. The snapshot refresh writes to memory/RECENT_<CHANNEL>.md
 * and is intended for the PM2 idle monitor + the chat-reset hook. Auth
 * handled upstream (nginx auth_request).
 */

import { Router } from 'express';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildMemoryGraph } from '../lib/memory-graph.js';
import { grepMemory } from '../lib/memory-grep.js';
import { buildCachedPrefix, meetsCacheFloor } from '../lib/memory-loader.js';
import { listVerdictCards, readVerdictCard } from '../lib/verdict-card-reader.js';
import { writeRecentSnapshot, isSnapshotStale, SUPPORTED_CHANNELS } from '../lib/recent-snapshot.js';

export default function memoryRouter() {
  const router = Router();

  router.get('/memory/graph', (_req, res) => {
    try {
      const graph = buildMemoryGraph();
      res.json(graph);
    } catch (err) {
      process.stderr.write(`[memory/graph] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  // GET /api/memory/grep?q=<query>&regex=0|1&max=10
  // Cheap deterministic lookup over memory/. Backed by ripgrep when present,
  // pure-Node fallback otherwise (see lib/memory-grep.js).
  router.get('/memory/grep', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q) return res.status(400).json({ error: 'missing query: ?q=<text>' });
    const regex = req.query.regex === '1' || req.query.regex === 'true';
    const max   = req.query.max != null ? Math.max(1, Math.min(50, Number(req.query.max) || 10)) : 10;
    try {
      const matches = await grepMemory(q, { maxCount: max, regex });
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
    try {
      const result = buildCachedPrefix();
      if (req.query.raw === '1') {
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

  // GET /api/memory/threads — list verdict cards (P4 Track B follow-up).
  // Sorted by written_at DESC. Optional ?status=done|junked|active filter,
  // optional ?limit=<N> (1..1000, default 200). Single-card lookup via
  // /api/memory/threads/:id. Cheap — scans memory/threads/*.md per call.
  router.get('/memory/threads', (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !['done', 'junked', 'active'].includes(status)) {
        return res.status(400).json({ error: `invalid status (got "${status}"); allowed: done, junked, active` });
      }
      const limit = req.query.limit != null
        ? Math.max(1, Math.min(1000, Number(req.query.limit) || 200))
        : 200;
      const threads = listVerdictCards({ status, limit });
      res.json({ count: threads.length, status: status || null, threads });
    } catch (err) {
      process.stderr.write(`[memory/threads] ${err && err.stack || err}\n`);
      res.status(500).json({ error: err && err.message || 'internal error' });
    }
  });

  router.get('/memory/threads/:id', (req, res) => {
    try {
      const card = readVerdictCard(req.params.id);
      if (!card) return res.status(404).json({ error: 'verdict card not found' });
      res.json(card);
    } catch (err) {
      process.stderr.write(`[memory/threads/:id] ${err && err.stack || err}\n`);
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
      const path = join(process.env.PROJECT_DIR || '/home/coder/project',
                        'memory', `RECENT_${channel.toUpperCase()}.md`);
      if (!existsSync(path)) {
        return res.json({
          channel,
          path,
          exists: false,
          snapshot_age_seconds: null,
          content: '',
          bytes: 0,
          note: 'snapshot file not yet created — channel may be idle or never used',
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
