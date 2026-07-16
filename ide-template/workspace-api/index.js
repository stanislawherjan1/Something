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
import { spawn } from 'node:child_process';
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
import notificationsRouter from './routes/notifications.js';
import meRouter            from './routes/me.js';
import remindersRouter     from './routes/reminders.js';
import tasksRouter         from './routes/tasks.js';
import docsCommentsLoginRouter, { attachVncUpgradeHandler, ensureBrowserOnBoot } from './routes/docs-comments-login.js';
import * as team from './lib/team.js';
import { migrateDefaultSessions } from './lib/sessions.js';
import { migrateDefaultMemory } from './lib/memory-loader.js';
import { writeRecentSnapshot } from './lib/recent-snapshot.js';
import jwt from 'jsonwebtoken';
import { isReady as cryptoReady } from './lib/integrations/crypto.js';
import { syncMcpServers } from './lib/integrations/runtime.js';
import { migrateFromLegacy } from './lib/integrations/migration.js';
import { writeAllowedHostsFile } from './lib/integrations/egress.js';
import { rehydrateRuntimeFiles } from './lib/setup.js';
import { reconcileTelegramAllowedIdsAtBoot } from './lib/integrations/telegram-sync.js';
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
app.use('/api', notificationsRouter());
app.use('/api', meRouter());
app.use('/api', remindersRouter());
app.use('/api', tasksRouter());
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
  // Self-heal the Telegram allow-list from the team roster on every boot, so a
  // member who is on the roster but never got propagated (link predates the
  // sync path, or a prior sync's bot-restart failed) is always allowed. Runs
  // before the server signals ready, so bot.sh reads the fixed integrations.env
  // when it starts. No bot restart here — bot.sh boots fresh right after.
  try {
    const tg = reconcileTelegramAllowedIdsAtBoot();
    if (tg.ok) process.stdout.write(`[workspace-api] reconciled Telegram allow-list from roster (${tg.count} linked ids)\n`);
  } catch (err) {
    process.stderr.write(`[workspace-api] telegram allow-list reconcile failed: ${err.message}\n`);
  }
}

// Team mode: persist slug + displayName for any legacy team entries so each
// user's personal directory (project/users/<slug>/) is stable from the first
// request. Independent of encryption — runs unconditionally.
try {
  if (team.ensureProfiles()) {
    process.stdout.write('[workspace-api] backfilled team user profiles (slug/displayName)\n');
  }
  // Shared team-directory card (memory/TEAM.md) — the SHARED counterpart to the
  // per-user private profiles. Regenerated from the roster on every boot (and on
  // add/remove/setRole); removed in solo mode.
  team.writeTeamRoster();
} catch (err) {
  process.stderr.write(`[workspace-api] team profile backfill failed: ${err.message}\n`);
}

// Team mode B1: adopt the legacy single-user 'default' web chat history under
// the primary admin's slug, so per-user keying doesn't orphan it. After
// ensureProfiles so the admin's slug is already assigned.
try {
  const adminSlug = team.primaryAdminSlug();
  if (migrateDefaultSessions(adminSlug)) {
    process.stdout.write(`[workspace-api] adopted default web chat history → ${adminSlug}\n`);
  }
} catch (err) {
  process.stderr.write(`[workspace-api] default session migration failed: ${err.message}\n`);
}

// Team mode B2b: per-user memory. The flat memory/USER_PROFILE.md +
// USER_PREFERENCES.md are the operator's solo-era profile; once cards load
// per-user, adopt them under the primary admin so they aren't orphaned. Gated
// on team mode (solo keeps loading them flat). Idempotent.
try {
  if (team.getTeamMode() && migrateDefaultMemory(team.primaryAdminSlug())) {
    process.stdout.write(`[workspace-api] adopted solo profile/preferences → ${team.primaryAdminSlug()} private memory\n`);
  }
} catch (err) {
  process.stderr.write(`[workspace-api] default memory migration failed: ${err.message}\n`);
}

// Team mode: the Telegram snapshot is the operator's private conversation. Move
// it out of the shared memory/RECENT_TELEGRAM.md (readable by any teammate via
// /api/files/read) into the admin's per-user dir on boot — writeRecentSnapshot
// writes the per-user file AND unlinks the stale flat one. Closes the leak
// immediately instead of waiting for the next idle refresh.
try {
  if (team.getTeamMode()) writeRecentSnapshot({ channel: 'telegram' });
} catch (err) {
  process.stderr.write(`[workspace-api] telegram snapshot relocation failed: ${err.message}\n`);
}

// Read-path backfill: every concept/topic page needs an INDEX signpost so the
// bot can find it (pages live outside the cached prefix; memory_grep skips
// users/**). New pages self-signpost via reflect-apply apply/graduate; this
// one-shot `reindex` on boot covers pages that PREDATE the signpost mechanism —
// i.e. the fleet-cascade backfill, automatic per client, no manual step. Runs as
// THIS process (wsapi) — the same uid that writes reflect's pages, so index
// ownership stays consistent (no chown). Detached + best-effort: idempotent, and
// it must never block wsapi from becoming ready.
try {
  const REFLECT_APPLY = process.env.REFLECT_APPLY_PY || '/opt/ide/hooks/reflect-apply.py';
  if (existsSync(REFLECT_APPLY)) {
    const child = spawn('python3', [REFLECT_APPLY, 'reindex'], { stdio: 'ignore', detached: true, env: process.env });
    child.on('error', (e) => process.stderr.write(`[workspace-api] memory reindex spawn failed: ${e.message}\n`));
    child.unref();
    process.stdout.write('[workspace-api] memory INDEX reindex kicked off (read-path signpost backfill)\n');
  }
} catch (err) {
  process.stderr.write(`[workspace-api] memory reindex failed: ${err.message}\n`);
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

const server = app.listen(PORT, async () => {
  process.stdout.write(`[workspace-api] listening on :${PORT}, project=${PROJECT_DIR}\n`);

  // Auto-heal the docs-comments persistent browser. ONLY here, in the listen
  // success callback, so it runs solely on the instance that actually bound the
  // port — never on a transient instance about to exit(0) for EADDRINUSE (which
  // would otherwise pkill the surviving instance's healthy browser and orphan a
  // chromium onto the CDP port). The profile lives on the persistent wsapi-store
  // volume, so the Google session survives a deploy — only the chromium PROCESS
  // is lost. Idempotent; adopts an already-running browser (CDP probe) instead
  // of killing+relaunching it. Never throws into boot.
  try {
    const r = await ensureBrowserOnBoot();
    if (!r.skipped) process.stdout.write(`[workspace-api] docs-comments auto-heal: browserAlive=${r.browserAlive}\n`);
  } catch (err) {
    process.stderr.write(`[workspace-api] docs-comments auto-heal failed: ${err.message}\n`);
  }
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
