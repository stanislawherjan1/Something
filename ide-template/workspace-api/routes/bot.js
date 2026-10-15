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
import * as runtime from '../lib/integrations/runtime.js';
import { requireActor } from '../lib/auth.js';
import { isAdmin } from '../lib/team.js';

export default function botRouter() {
  const router = Router();
  router.use('/bot', requireActor);
  // A restart interrupts whatever the bot is doing for everyone, so it is an
  // admin's control (the UI offers it on the admin's screen only).
  router.use('/bot', (req, res, next) => {
    if (!isAdmin(req.actor)) return res.status(403).json({ error: 'Only admins can restart the bot.' });
    next();
  });

  router.post('/bot/restart', async (_req, res) => {
    const ok = await runtime.restartBot();
    if (!ok) {
      return res.status(503).json({
        error: 'Restart signal file not present: bot has not started in this container, or is running a pre-watcher image. Try again after a container restart.',
      });
    }
    // Bot watcher fires within 2s; PM2 restart_delay is 10s → ~10–15s
    // offline window. UI should treat as fire-and-forget.
    return res.json({ ok: true });
  });

  return router;
}
