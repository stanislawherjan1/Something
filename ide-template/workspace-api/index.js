/**
 * Workspace API — entry point.
 *
 * Wraps Claude Code CLI in an SSE-friendly HTTP API for the custom React
 * workspace. All real logic lives in lib/ and routes/ — this file is just
 * the Express setup.
 *
 *   POST /api/chat                  — one chat turn (SSE stream)
 *   GET  /api/files/tree            — lazy directory listing
 *   GET  /api/files/read            — small text file content
 *   GET  /api/files/raw             — streamed file bytes (images, etc.)
 *   GET  /api/files/watch           — SSE stream of FS change events
 *   GET  /api/health                — liveness check
 *
 * Auth: not handled here. nginx in the frontend service auth-gates /api/*
 * via auth_request /auth/verify before traffic reaches this process. See
 * ide-template/frontend/nginx.conf.
 */

import express from 'express';
import helmet from 'helmet';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, PROJECT_DIR } from './lib/config.js';
import { stop as stopWatcher } from './lib/watcher.js';
import { cookieMiddleware, attachActor } from './lib/auth.js';
import healthRouter        from './routes/health.js';
import chatRouter          from './routes/chat.js';
import filesRouter         from './routes/files.js';
import integrationsRouter  from './routes/integrations.js';
import skillsRouter        from './routes/skills.js';
import teamRouter          from './routes/team.js';
import brandingRouter      from './routes/branding.js';
import setupRouter         from './routes/setup.js';
import memoryRouter        from './routes/memory.js';
import botRouter           from './routes/bot.js';
import internalRouter      from './routes/internal.js';
import docsCommentsLoginRouter, { attachVncUpgradeHandler } from './routes/docs-comments-login.js';
import jwt from 'jsonwebtoken';
import { isReady as cryptoReady } from './lib/integrations/crypto.js';
import { syncMcpServers } from './lib/integrations/runtime.js';
import { migrateFromLegacy } from './lib/integrations/migration.js';
import { writeAllowedHostsFile } from './lib/integrations/egress.js';
import { rehydrateRuntimeFiles } from './lib/setup.js';
import { startBroker } from './lib/integrations/broker.js';
import { decryptFor } from './lib/integrations/store.js';
import { get as getCatalog } from './lib/integrations/catalog.js';

const app = express();
// One proxy hop (nginx in the frontend service). Without this, req.ip resolves
// to nginx's internal IP and every per-IP rate-limit collapses into a single
// shared bucket. See routes/{integrations,team,setup}.js — they key the
// limiter on req.actor first, then req.ip; setting trust proxy makes the
// IP fallback behave correctly when req.actor is unset.
app.set('trust proxy', 1);
// Don't advertise Express in response headers. Strip the `X-Powered-By`
// fingerprint so a scanner has to work harder for a stack signature.
app.disable('x-powered-by');
// Defense-in-depth headers. CSP is intentionally NOT set here — the SPA is
// served by nginx (port 3000), so its CSP belongs in Caddy at the edge where
// it covers every response uniformly. helmet's other defaults (X-DNS-Prefetch,
// X-Download-Options, X-Permitted-Cross-Domain-Policies, Origin-Agent-Cluster,
// Cross-Origin-*) all make sense for /api responses. HSTS comes from Caddy
// already; turn it off here so we don't double-write.
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieMiddleware);
app.use(attachActor);

app.use('/api', healthRouter());
app.use('/api', chatRouter());
app.use('/api', filesRouter());
app.use('/api', integrationsRouter());
app.use('/api', skillsRouter());
app.use('/api', teamRouter());
app.use('/api', brandingRouter());
app.use('/api', setupRouter());
app.use('/api', memoryRouter());
app.use('/api', botRouter());
app.use('/api', internalRouter());
app.use('/api/integrations/docs-comments', docsCommentsLoginRouter());

// On startup: seed WORKSPACE.md into .claude/ if it doesn't exist yet.
// The file is a human-readable UI reference for Claude — users can edit it
// freely; we never overwrite an existing copy.
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src  = join(__dirname, 'assets', 'WORKSPACE.md');
  const dest = join(PROJECT_DIR, '.claude', 'WORKSPACE.md');
  if (!existsSync(dest)) {
    mkdirSync(join(PROJECT_DIR, '.claude'), { recursive: true });
    copyFileSync(src, dest);
  }
} catch (err) {
  process.stderr.write(`[workspace-api] WORKSPACE.md seed failed: ${err.message}\n`);
}

// On startup:
//   1. Auto-migrate legacy env / bind-mounted credentials into the encrypted
//      store. Idempotent — skips integrations the user already activated via
//      the UI. Lets existing clients see "Active" right after the first
//      redeploy without re-entering anything.
//   2. Reconcile .claude.json's mcpServers block with whatever is in the
//      store now. Covers host reboot, container redeploy, manual edits to
//      the credentials file, etc.
// Both skipped silently if encryption isn't configured (= dev mode without
// INTEGRATIONS_KEY mounted).
if (cryptoReady()) {
  try { migrateFromLegacy(); }
  catch (err) { process.stderr.write(`[workspace-api] legacy migration failed: ${err.message}\n`); }
  try { syncMcpServers(); }
  catch (err) { process.stderr.write(`[workspace-api] mcp sync on startup failed: ${err.message}\n`); }
  // Re-hydrate the bot's runtime credential files from the encrypted
  // store. /home/bot/ is not volume-mounted, so every container recreate
  // wipes ~/.claude/.credentials.json + integrations.env back to whatever
  // .migrated.bak snapshot the Phase-3 migration block grabs. Without
  // this, the bot boots with a months-old token on every redeploy.
  try {
    const r = rehydrateRuntimeFiles();
    if (r.ok) process.stdout.write(`[workspace-api] rehydrated bot creds from encrypted store\n`);
    else      process.stdout.write(`[workspace-api] rehydrate skipped: ${r.skipped}\n`);
  } catch (err) {
    process.stderr.write(`[workspace-api] rehydrate failed: ${err.message}\n`);
  }
}

// Seed the egress allowlist file on every boot — covers the cold-start
// case (no integrations yet) where the host script would otherwise read a
// non-existent file and apply an empty allowlist (which still lets the
// platform reach Anthropic/Telegram, but logs a WARN). Runs OUTSIDE the
// cryptoReady gate because the platform allowlist itself doesn't need to
// decrypt anything; integrations layered on top do, and computeAllowedHosts
// gracefully skips them when decrypt fails.
try { writeAllowedHostsFile(); }
catch (err) { process.stderr.write(`[workspace-api] egress seed failed: ${err.message}\n`); }

// Start the credential broker. UDS server at /var/wsapi-store/run/broker.sock
// (mode 0660 group=wsapi-broker — coder uid 1000 cannot connect, mcp uid
// 1002 can). MCPs spawned via mcp-runner receive a single-use nonce in env
// + integration id, then call us here to fetch their decrypted credentials.
//
// Broker is in-process (no separate Node instance) — workspace-api already
// owns the AES key + encrypted store, no benefit to splitting it off
// further given they share uid 1001.
if (cryptoReady()) {
  try {
    startBroker({
      getCredentials: async (id) => {
        const cat = getCatalog(id);
        if (!cat) return null;
        const plain = decryptFor(id);
        if (!plain) return null;
        // Multi-account integrations (email-imap) return an array; broker
        // serialises that as `items: [...]`. Single integrations return
        // an object; serialise as `fields: {...}`.
        return cat.multi ? { items: plain } : { fields: plain };
      },
      onLog: (_level, msg) => process.stderr.write(`${msg}\n`),
    });
  } catch (err) {
    process.stderr.write(`[workspace-api] broker start failed: ${err.message}\n`);
  }
}

// Global error handler — catches anything a route forgot to handle so we
// don't return Express's default HTML stack-trace page. Goes last in the
// middleware chain. The `next` parameter is required for Express to treat
// this as an error handler even though it's unused.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  process.stderr.write(`[workspace-api/unhandled] ${err.stack || err.message}\n`);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal server error' });
});

const server = app.listen(PORT, () => {
  process.stdout.write(`[workspace-api] listening on :${PORT}, project=${PROJECT_DIR}\n`);
});

// EADDRINUSE handling. Without this, a port collision (e.g. a prior wsapi
// hasn't released :3001 yet when PM2 spawns the retry) propagates as an
// unhandled 'error' event and Node exits with stack trace + non-zero exit
// code. PM2 reads that as a crash, restarts immediately, port still held,
// crash again — until max_restarts (50). During that cycle each transient
// wsapi instance also creates the broker UDS socket via startBroker() (see
// below) then dies, leaving the broker socket file path bound to a dead
// process. MCPs spawned by the eventually-surviving wsapi connect to a
// stale socket file → ECONNREFUSED → integration MCPs silently fail.
//
// Cleaner: log the conflict and exit code 0 so PM2 backs off with its
// restart_delay (10s) instead of looping at sub-second rates. Caught
// 2026-06-04 — root cause of the multi-hour canary debugging session.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    process.stderr.write(`[workspace-api] port ${PORT} already in use — another wsapi is still shutting down. Exiting cleanly so PM2 backs off.\n`);
    process.exit(0);
  }
  process.stderr.write(`[workspace-api] http server error: ${err.stack || err.message}\n`);
  process.exit(1);
});

// Attach the noVNC WebSocket upgrade handler. Express middleware can't
// see the 'upgrade' event — it has to be wired on the raw http.Server.
// We verify the JWT-signed session cookie inline, same secret + cookie
// name as the HTTP-side attachActor.
const VNC_SESSION_SECRET = process.env.SESSION_SECRET || '';
const VNC_SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'ide_session';
attachVncUpgradeHandler(server, (req) => {
  if (!VNC_SESSION_SECRET) return false;
  const cookieHeader = req.headers.cookie || '';
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${VNC_SESSION_COOKIE}=([^;]+)`));
  if (!m) return false;
  try {
    const payload = jwt.verify(m[1], VNC_SESSION_SECRET);
    return Boolean(payload?.email);
  } catch {
    return false;
  }
});

// Graceful shutdown so PM2 restarts cleanly. Without explicit server.close()
// + broker socket cleanup, the kernel held :3001 + the broker UDS socket file
// for several seconds after Node exit. PM2's restart_delay (10s) usually
// covered it, but under load (or after SIGKILL) the new wsapi raced the
// previous one and hit EADDRINUSE — same root cause as the server.on('error')
// handler above. Belt-and-braces: close everything before exit.
//
// chokidar holds inotify watches; if we don't stopWatcher() the inotify
// instance leaks per restart cycle.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[workspace-api] shutdown: received ${signal}, cleaning up...\n`);

  // Stop accepting new HTTP connections + drain in-flight ones.
  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Hard timeout in case a long-running SSE stream blocks close().
      setTimeout(() => resolve(), 3000);
    });
  } catch {}

  // chokidar inotify cleanup.
  try { await stopWatcher(); } catch {}

  // Best-effort broker UDS socket cleanup (broker.js unlinks-on-start
  // anyway, but removing it here makes the next spawn's startup cleaner
  // and avoids a window where the file points to a closed listener).
  try {
    const { unlinkSync, existsSync } = await import('node:fs');
    const sockPath = process.env.BROKER_SOCKET || '/var/wsapi-store/run/broker.sock';
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {}

  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
