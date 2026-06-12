import { Router } from 'express';
import { PROJECT_DIR } from '../lib/config.js';
import { getSessionId } from '../lib/sessions.js';

export default function healthRouter() {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      project_dir: PROJECT_DIR,
      session: getSessionId() ? 'active' : 'idle',
    });
  });
  return router;
}
