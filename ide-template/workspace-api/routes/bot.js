/**
 * /api/bot/* — operator-facing bot lifecycle controls.
 *
 *   POST /api/bot/restart  — touches the restart-signal file under
 *                            /home/bot/.${BOT}/restart-signal. bot.sh's
 *                            background watcher polls the mtime, kills
 *                            the tmux session on change, and PM2 cycles
 *                            the process. Same mechanism as the
 *                            wsapi-internal restartBot() called from
 *                            integration PUT/PATCH/DELETE and from
 *                            setup token rotation.
 *
 * Previously this route POSTed `/restart` to Telegram and let the
 * grammy plugin SIGTERM claude. That broke whenever the running bot
 * wasn't polling a TG token that matched the message (fresh activate,
 * token rotation, setup-token rotation before TG configured). The file
 * signal has no such coupling — see lib/integrations/runtime.js
 * restartBot() for the full rationale.
 */

import { Router } from 'express';
import { spawn } from 'node:child_process';
import * as runtime from '../lib/integrations/runtime.js';
import { requireActor } from '../lib/auth.js';

const RELAY_RUNNER = '/usr/local/bin/monitor-runner';
const RELAY_SCRIPT = '/opt/ide/bot-relay.sh';
const MAX_TEXT_LEN = 4096;

export default function botRouter() {
  const router = Router();
  router.use('/bot', requireActor);

  router.post('/bot/restart', async (_req, res) => {
    const ok = await runtime.restartBot();
    if (!ok) {
      return res.status(503).json({
        error: 'Restart signal file not present — bot has not started in this container, or is running a pre-watcher image. Try again after a container restart.',
      });
    }
    // Bot watcher fires within 2s; PM2 restart_delay is 10s → ~10–15s
    // offline window. UI should treat as fire-and-forget.
    return res.json({ ok: true });
  });

  // POST /api/bot/send — relay a user message from the web UI into the
  // bot's tmux session. Spawns the setuid monitor-runner wrapper which
  // drops to bot uid (1003) so the per-uid tmux socket is reachable;
  // the actual tmux send-keys happens in bot-relay.sh. Message is
  // delivered with a [WEB_USER] prefix so the bot's memory-prefix
  // channel-routing rules pick the web reply tool.
  router.post('/bot/send', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ ok: false, error: 'text is required (non-empty string)' });
    }
    if (text.length > MAX_TEXT_LEN) {
      return res.status(413).json({ ok: false, error: `text exceeds ${MAX_TEXT_LEN} chars` });
    }
    const child = spawn(RELAY_RUNNER, [RELAY_SCRIPT], {
      env: { ...process.env, BOT_RELAY_MESSAGE: text },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      process.stderr.write(`[bot/send] spawn error: ${err.message}\n`);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: `spawn failed: ${err.message}` });
      }
    });
    child.on('close', (code) => {
      if (res.headersSent) return;
      if (code === 0) return res.json({ ok: true });
      const trimmed = stderr.trim().slice(0, 500);
      const status = code === 2 ? 503 : 500;
      return res.status(status).json({
        ok: false,
        error: trimmed || `bot-relay exited with code ${code}`,
      });
    });
  });

  return router;
}
