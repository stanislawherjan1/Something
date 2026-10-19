/**
 * Files shared by link (lib/shares.js).
 *
 *   GET    /api/shares[?path=]       signed in: whether sharing is on, and the link for a file
 *                                    (with ?path) or the links this person can see and end
 *   POST   /api/shares               signed in: share { path, days? } — the file's working link if it has one
 *   PATCH  /api/shares/:token        signed in: { days } — how long it works from now (0 = no end)
 *   DELETE /api/shares/:token        signed in: end a link (its maker, or an admin for a team file)
 *   GET    /api/shares/:token/open   signed in: the file's path, when this person can open it
 *   PUT    /api/shares/settings      admin: { enabled } — sharing on or off for the workspace
 *   GET    /api/public/share/:token  ANYONE: the file's name and text, read only. nginx serves
 *                                    this one path without the sign-in check (frontend/nginx.conf).
 */
import { Router } from 'express';
import { requireActor } from '../lib/auth.js';
import { actorScope } from '../lib/file-scope.js';
import { getFileSharing, setFileSharing } from '../lib/team.js';
import * as shares from '../lib/shares.js';

// The public read is the one unauthenticated route: a plain per-address cap so
// it can't be used to hammer the disk or guess tokens quickly.
const perMin = () => Number(process.env.SHARE_PUBLIC_PER_MIN) || 60;
const hits = new Map();
function underCap(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now);
  hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length <= perMin();
}

export default function sharesRouter() {
  const router = Router();

  router.get('/public/share/:token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    // The visitor's address: Caddy sets X-Forwarded-For to it (replacing any the
    // client sent) and nginx appends Caddy's own after it, so it is the first
    // entry. X-Real-IP would be Caddy's for everyone: one shared cap for all.
    const ip = String(req.get('x-forwarded-for') || '').split(',')[0].trim() || String(req.ip || '');
    if (!underCap(ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Try again in a minute.' });
    const view = shares.publicView(req.params.token);
    if (!view) return res.status(404).json({ ok: false, error: 'This link doesn\'t work any more.' });
    return res.json({ ok: true, ...view });
  });

  router.use('/shares', requireActor);
  const who = (req) => { const s = actorScope(req); return { slug: s.slug, isAdmin: s.isAdmin }; };

  router.get('/shares', (req, res) => {
    const enabled = getFileSharing();
    if (typeof req.query.path === 'string') {
      const link = shares.linkFor(req.query.path, who(req));
      const why = shares.refusal(req.query.path, who(req));
      return res.json({ ok: true, enabled, link, canShare: !why, reason: why || null });
    }
    return res.json({ ok: true, enabled, links: shares.listFor(who(req)) });
  });

  router.post('/shares', (req, res) => {
    const out = shares.share(req.body?.path, who(req), { days: req.body?.days });
    return res.status(out.ok ? 200 : 403).json(out);
  });

  router.put('/shares/settings', (req, res) => {
    if (!actorScope(req).isAdmin) return res.status(403).json({ ok: false, error: 'Only an admin can change this.' });
    return res.json({ ok: true, enabled: setFileSharing(!!req.body?.enabled, req.actor) });
  });

  router.get('/shares/:token/open', (req, res) => {
    const path = shares.pathFor(req.params.token, who(req));
    return path ? res.json({ ok: true, path }) : res.status(403).json({ ok: false });
  });

  router.patch('/shares/:token', (req, res) => {
    const out = shares.setExpiry(req.params.token, req.body?.days, who(req));
    return res.status(out.ok ? 200 : 403).json(out);
  });

  router.delete('/shares/:token', (req, res) => {
    const out = shares.revoke(req.params.token, who(req));
    return res.status(out.ok ? 200 : 403).json(out);
  });

  return router;
}
