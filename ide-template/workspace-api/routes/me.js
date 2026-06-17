/**
 * GET /api/me — the requesting user's team-mode identity.
 *
 * Returns { email, slug, role, displayName, isAdmin, personalRoot } from the
 * team registry and ensures the user's personal directory
 * (project/users/<slug>/) exists so the "Personal Files" sidebar section has
 * somewhere to list on first login. Drives the sidebar Workspace/Personal
 * split, the role badge, and the admin system-files toggle.
 */

import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_DIR } from '../lib/config.js';
import { requireActor } from '../lib/auth.js';
import { actorScope, USERS_DIR } from '../lib/file-scope.js';

export default function meRouter() {
  const router = Router();

  router.get('/me', requireActor, (req, res) => {
    const scope = actorScope(req);
    // Materialise the personal dir so the first tree call doesn't 404.
    if (scope.slug) {
      try { mkdirSync(resolve(PROJECT_DIR, USERS_DIR, scope.slug), { recursive: true }); }
      catch { /* best-effort — a real FS error surfaces on the tree call */ }
    }
    res.json({
      email:        scope.email,
      slug:         scope.slug,
      role:         scope.role,
      displayName:  scope.displayName,
      isAdmin:      scope.isAdmin,
      personalRoot: scope.personalPrefix,   // e.g. "users/jan" — Personal section root
    });
  });

  return router;
}
