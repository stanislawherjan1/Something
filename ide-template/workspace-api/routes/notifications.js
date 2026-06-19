/**
 * /api/notifications/* — server-pushed notifications into the browser.
 *
 *   GET  /api/notifications/stream  — long-lived SSE of notification events.
 *
 * Auth: nginx in the frontend service auth-gates /api/* before traffic
 * reaches this process (see ide-template/frontend/nginx.conf), same as
 * every other /api/* route. No per-route auth needed here.
 *
 * Producers (loopback, in-container) hit POST /api/internal/notify in
 * routes/internal.js — that route calls notify.publish() which fans out
 * to every subscriber attached here.
 */

import { Router } from 'express';
import { subscribe } from '../lib/notify.js';
import { getUser, isAdmin } from '../lib/team.js';

export default function notificationsRouter() {
  const router = Router();

  router.get('/notifications/stream', (req, res) => {
    res.setHeader('Content-Type',     'text/event-stream');
    res.setHeader('Cache-Control',    'no-cache');
    res.setHeader('Connection',       'keep-alive');
    // Disable nginx response buffering for this stream so events flush
    // immediately. Same header is used by /api/files/watch.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay?.(true);

    // B3: scope this stream to the viewer so a relay targeted at one teammate
    // only reaches them. Global notifications (no recipient) reach everyone.
    // Solo / no team → slug null → only global, unchanged.
    const viewer = { slug: getUser(req.actor)?.slug || null, isAdmin: isAdmin(req.actor) };
    const detach = subscribe(res, viewer);
    req.on('close', detach);
  });

  return router;
}
