/**
 * /api/integrations/docs-comments/* — interactive Google login for the Docs
 * Comments integration, built around ONE long-lived browser.
 *
 * Why one persistent browser: Google's anti-fraud rejects a logged-in session
 * the moment a DIFFERENT chromium process tries to reuse it (datacenter IP +
 * "new device" → re-verification on every fresh launch). Proven by an A/B test
 * 2026-06-07: a freshly launched chromium on the saved profile lands on
 * accounts.google.com/confirmidentifier regardless of flags. The only thing
 * that works is to NOT relaunch — keep the exact browser the user logged into
 * alive, and have add_comment drive THAT browser over CDP instead of launching
 * its own. So:
 *
 *   - The browser (Xvfb + chromium) is PERSISTENT — it survives connect-done
 *     and lives until it crashes / wsapi restarts / the integration is reset.
 *     chromium runs with --remote-debugging-port so the docs-comments MCP can
 *     attach via Playwright connectOverCDP (see apps/docs-comments-mcp).
 *   - The viewer (x11vnc + websockify + noVNC) is TRANSIENT — spun up only for
 *     the interactive login, torn down on connect-done. The browser keeps running.
 *
 * Flow:
 *   1. POST /connect-start → ensure the persistent browser is up (Xvfb :99 +
 *      chromium on the profile, CDP on 127.0.0.1:9333, pointed at
 *      accounts.google.com) → start the viewer (x11vnc :5999 + websockify :6080
 *      serving noVNC) → wait until websockify is reachable → return the iframe URL.
 *   2. UI loads /api/integrations/docs-comments/vnc/vnc.html. User logs in.
 *   3. POST /connect-done → tear down ONLY the viewer. The browser stays alive
 *      so add_comment can reuse the live session.
 *
 * WS upgrade for noVNC is wired in index.js via attachVncUpgradeHandler(server)
 * — express middleware can't see upgrade events on its own.
 *
 * Single operator per deploy — one browser, one viewer at a time.
 */

import { Router } from 'express';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { requireActor } from '../lib/auth.js';
import { activate, isActive } from '../lib/integrations/store.js';
import { syncMcpServers } from '../lib/integrations/runtime.js';
import { writeAllowedHostsFile } from '../lib/integrations/egress.js';

const PROFILE_DIR        = '/var/wsapi-store/docs-comments-profile';
const NOVNC_DIR          = '/usr/share/novnc';
const CHROMIUM_BIN       = '/opt/playwright-browsers/chromium-1223/chrome-linux64/chrome';
const DISPLAY_NUM        = ':99';
const X11VNC_PORT        = 5999;
const WEBSOCKIFY_PORT    = 6080;
const VNC_BACKEND_HOST   = '127.0.0.1';
// CDP endpoint the docs-comments MCP attaches to. Bound to localhost; only
// in-container processes can reach it (same trust boundary as the open memory
// routes). --remote-allow-origins=* is required or chromium 111+ rejects the
// CDP websocket with 403.
const CDP_PORT           = 9333;
const CDP_ADDR           = '127.0.0.1';

// Persistent browser (survives connect-done). Transient viewer (login only).
let browser = null;   // { xvfb, chromium, startedAt }
let viewer  = null;   // { x11vnc, websockify }

function isAlive(child) { return !!child && child.exitCode === null && child.signalCode === null; }
function browserAlive() { return !!browser && isAlive(browser.chromium) && isAlive(browser.xvfb); }

// A profile counts as "session-bearing" only if Chromium wrote a cookies DB.
// readdirSync(...).length > 0 is NOT enough — a half-written/empty profile
// would relaunch into accounts.google.com and emit a false SESSION_EXPIRED.
function profileHasSession() {
  return existsSync(join(PROFILE_DIR, 'Default', 'Cookies'))
      || existsSync(join(PROFILE_DIR, 'Default', 'Network', 'Cookies'));
}

// Shared precondition for every silent (viewer-less) relaunch (boot + MCP heal).
// Only relaunch when the operator actually activated docs-comments AND the saved
// profile still carries a Google session — never spin up chromium on an empty
// profile (would falsely report SESSION_EXPIRED to a client who never connected).
function canAutoHeal() {
  return isActive('docs-comments') && profileHasSession();
}

function killPid(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

function spawnQuiet(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    ...opts,
  });
  child.stdout.on('data', (b) => process.stderr.write(`[docs-comments-login:${cmd}] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[docs-comments-login:${cmd}] ${b}`));
  // An unhandled 'error' event on a spawned child (e.g. ENOENT when the chromium
  // binary path is stale) throws and crashes the WHOLE wsapi process. Handle it
  // so a spawn failure degrades to a logged error instead of a boot crash-loop.
  child.on('error', (err) => {
    process.stderr.write(`[docs-comments-login:${cmd}] spawn error: ${err.message}\n`);
  });
  child.on('exit', (code, sig) => {
    process.stderr.write(`[docs-comments-login:${cmd}] exit code=${code} sig=${sig}\n`);
  });
  return child;
}

function preflightProfileCleanup() {
  // Kill any orphaned chromium on the profile + clear the Singleton lock files
  // it leaves behind on a SIGKILL'd parent (else next launch hits "profile
  // appears to be in use" and exits 21).
  try { execSync(`pkill -9 -f '${PROFILE_DIR}'`, { stdio: 'ignore' }); } catch { /* nothing */ }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { unlinkSync(join(PROFILE_DIR, name)); } catch { /* missing → fine */ }
  }
}

// Kill leftover VIEWER procs (x11vnc + websockify) + clear their ports. Does
// NOT touch Xvfb — the persistent browser owns it. Specific patterns so they
// can't match wsapi itself.
function preflightViewerCleanup() {
  for (const pat of [`x11vnc -display ${DISPLAY_NUM}`, `websockify ${WEBSOCKIFY_PORT}`]) {
    try { execSync(`pkill -9 -f '${pat}'`, { stdio: 'ignore' }); } catch { /* nothing */ }
  }
}

// Full stack cleanup including Xvfb + the X display lock — used only when
// (re)launching the persistent browser from scratch (the browser is dead).
function preflightStackCleanupAll() {
  const dnum = DISPLAY_NUM.replace(':', '');
  preflightViewerCleanup();
  try { execSync(`pkill -9 -f 'Xvfb ${DISPLAY_NUM}'`, { stdio: 'ignore' }); } catch { /* nothing */ }
  try { unlinkSync(`/tmp/.X${dnum}-lock`); } catch { /* none */ }
  try { unlinkSync(join('/tmp/.X11-unix', `X${dnum}`)); } catch { /* none */ }
}

// Resolve once websockify is accepting connections on :6080, so we only hand
// the UI a vncUrl that will load (no iframe racing into "VNC backend unreachable").
function waitForBackend(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = createConnection(WEBSOCKIFY_PORT, VNC_BACKEND_HOST);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// Bring up the persistent browser (Xvfb + chromium) if it isn't already alive.
// Idempotent — if the browser is healthy this is a no-op and the existing
// logged-in session is preserved.
function ensureBrowser() {
  if (browserAlive()) return browser;

  mkdirSync(PROFILE_DIR, { recursive: true });
  preflightProfileCleanup();
  preflightStackCleanupAll();

  // umask 0007 so every file/dir chromium writes in the shared profile is
  // group-rwx (group=workspace) — the mcp uid that drives this browser over
  // CDP must be able to read it. Inherited by chromium at fork; restore after.
  const prevUmask = process.umask(0o007);
  setTimeout(() => process.umask(prevUmask), 5000);

  const xvfb = spawnQuiet('Xvfb', [DISPLAY_NUM, '-screen', '0', '1366x900x24', '-nolisten', 'tcp']);

  const chromium = spawnQuiet(CHROMIUM_BIN, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI,Translate,AutofillServerCommunication',
    '--disable-blink-features=AutomationControlled',
    // CDP so the docs-comments MCP can attach (connectOverCDP) and drive THIS
    // browser instead of launching its own. allow-origins=* or chromium 111+
    // 403s the CDP websocket.
    `--remote-debugging-port=${CDP_PORT}`,
    `--remote-debugging-address=${CDP_ADDR}`,
    '--remote-allow-origins=*',
    '--start-maximized',
    'https://accounts.google.com/',
  ], {
    env: {
      ...process.env,
      DISPLAY: DISPLAY_NUM,
      HOME:            PROFILE_DIR,
      XDG_CONFIG_HOME: PROFILE_DIR,
      XDG_CACHE_HOME:  PROFILE_DIR,
    },
  });

  browser = { xvfb, chromium, startedAt: Date.now() };

  // If either half dies, drop the handle so the next ensureBrowser relaunches
  // (a relaunch loses the Google session → operator must re-login, but that's
  // rarer than the old per-add_comment relaunch).
  const onDeath = (which) => () => {
    if (browser && (browser.chromium === chromium || browser.xvfb === xvfb)) {
      process.stderr.write(`[docs-comments-login] persistent browser ${which} exited — dropping handle\n`);
      killPid(chromium.pid, 'SIGKILL');
      killPid(xvfb.pid, 'SIGTERM');
      browser = null;
    }
  };
  chromium.on('exit', onDeath('chromium'));
  chromium.on('error', onDeath('chromium'));   // spawn ENOENT → drop handle, don't crash
  xvfb.on('exit', onDeath('xvfb'));
  xvfb.on('error', onDeath('xvfb'));

  return browser;
}

// Boot-time auto-heal entry point (called from index.js after listen).
// Relaunches the persistent browser from the saved profile WITHOUT a viewer
// if the integration is active AND the profile has a Google session. This
// automates the operator's manual remove+add after a container recreate: the
// Chromium profile lives on the persistent wsapi-store volume, so the session
// survives a deploy — only the chromium PROCESS is lost. Idempotent
// (ensureBrowser no-ops if the browser is already alive).
export function ensureBrowserOnBoot() {
  if (!canAutoHeal()) return { skipped: true };
  ensureBrowser();          // NO startViewer() — viewer-less by design
  return { browserAlive: browserAlive() };
}

// Loopback /ensure entry point (called by the docs-comments MCP after a
// NOT_CONNECTED). Same guard + relaunch as boot; returns whether the browser
// is now alive so the MCP knows whether a single retry is worthwhile. Never
// re-logins and never clears the profile — so a relaunch on a truly-expired
// session honestly re-produces SESSION_EXPIRED instead of masking it.
export function ensureBrowserForMcp() {
  if (!canAutoHeal()) return { ok: false, reason: 'inactive_or_no_session', browserAlive: browserAlive() };
  ensureBrowser();
  return { ok: true, browserAlive: browserAlive() };
}

function startViewer() {
  stopViewer();
  preflightViewerCleanup();

  const x11vnc = spawnQuiet('x11vnc', [
    '-display', DISPLAY_NUM,
    '-rfbport', String(X11VNC_PORT),
    '-localhost', '-forever', '-shared', '-nopw', '-quiet', '-noxdamage',
  ]);
  const websockify = spawnQuiet('websockify', [
    `${WEBSOCKIFY_PORT}`,
    `${VNC_BACKEND_HOST}:${X11VNC_PORT}`,
    '--web', NOVNC_DIR,
  ]);

  viewer = { x11vnc, websockify };

  // If a viewer proc dies, drop the handle so the proxy reports "no session"
  // and the next connect-start rebuilds it. Does NOT touch the browser.
  for (const [name, h] of Object.entries(viewer)) {
    h.on('exit', () => {
      if (viewer && viewer[name] === h) {
        process.stderr.write(`[docs-comments-login] viewer ${name} exited — tearing down viewer\n`);
        stopViewer();
      }
    });
  }
  return viewer;
}

function stopViewer() {
  if (viewer) {
    killPid(viewer.x11vnc?.pid, 'SIGTERM');
    killPid(viewer.websockify?.pid, 'SIGTERM');
    viewer = null;
  }
  preflightViewerCleanup();
}

// Full reset — kill the persistent browser too (used when the integration is
// removed / a clean rebuild is forced).
function stopBrowser() {
  stopViewer();
  if (browser) {
    killPid(browser.chromium?.pid, 'SIGTERM');
    setTimeout(() => { killPid(browser?.chromium?.pid, 'SIGKILL'); killPid(browser?.xvfb?.pid, 'SIGTERM'); }, 1500);
    browser = null;
  }
}

// HTTP proxy to websockify (noVNC static assets + vnc.html). Gated on the
// VIEWER being up (the browser may be alive without a viewer post-login).
function httpProxy(req, res) {
  if (!viewer) {
    res.status(503).json({ error: 'No active docs-comments viewer — POST /connect-start first.' });
    return;
  }
  const upstreamPath = req.url.replace(/^\/vnc/, '') || '/';
  const upstream = httpRequest({
    host: VNC_BACKEND_HOST,
    port: WEBSOCKIFY_PORT,
    method: req.method,
    path: upstreamPath,
    headers: { ...req.headers, host: `${VNC_BACKEND_HOST}:${WEBSOCKIFY_PORT}` },
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    process.stderr.write(`[docs-comments-login] http proxy error: ${err.message}\n`);
    if (!res.headersSent) res.status(502).json({ error: 'VNC backend unreachable' });
  });
  req.pipe(upstream);
}

// WS upgrade handler — wired in index.js. Pipes the wsapi-terminated upgrade
// into a TCP connection to websockify. Auth via the existing actor cookie.
export function attachVncUpgradeHandler(server, isAuthorised) {
  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/api/integrations/docs-comments/vnc')) return;
    if (!isAuthorised(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!viewer) {
      socket.write('HTTP/1.1 503 No Session\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamPath = req.url.replace(/^\/api\/integrations\/docs-comments\/vnc/, '') || '/';
    const upstream = createConnection(WEBSOCKIFY_PORT, VNC_BACKEND_HOST, () => {
      const lines = [`${req.method} ${upstreamPath} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) { for (const vv of v) lines.push(`${k}: ${vv}`); }
        else { lines.push(`${k}: ${v}`); }
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const cleanup = () => { try { upstream.destroy(); } catch {} try { socket.destroy(); } catch {} };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
    upstream.on('end', cleanup);
    socket.on('end', cleanup);
  });
}

export default function docsCommentsLoginRouter() {
  const router = Router();
  router.use(requireActor);

  router.get('/status', (_req, res) => {
    const profileFiles = existsSync(PROFILE_DIR) ? readdirSync(PROFILE_DIR).length : 0;
    res.json({
      sessionActive:     !!viewer,          // a login viewer is up right now
      browserAlive:      browserAlive(),    // the persistent browser is running
      profileExists:     profileFiles > 0,
      integrationActive: isActive('docs-comments'),
    });
  });

  router.post('/connect-start', async (_req, res) => {
    try {
      // Pre-activate so the egress allowlist opens before chromium reaches
      // Google. No-op if already active.
      try {
        if (!isActive('docs-comments')) activate('docs-comments', { PROFILE_OK: 'pending' });
        syncMcpServers();
        writeAllowedHostsFile();
      } catch (err) {
        process.stderr.write(`[docs-comments-login] preflight activate failed (continuing): ${err.message}\n`);
      }

      ensureBrowser();   // launch the persistent browser if it isn't already up
      startViewer();     // (re)attach the noVNC viewer to it

      const ready = await waitForBackend(8000);
      if (!ready) {
        stopViewer();
        process.stderr.write('[docs-comments-login] viewer backend never came up within 8s — torn down\n');
        return res.status(503).json({ error: 'browser_failed_to_start' });
      }
      res.json({
        ok: true,
        startedAt: browser?.startedAt || Date.now(),
        vncUrl: '/api/integrations/docs-comments/vnc/vnc.html?path=api/integrations/docs-comments/vnc/websockify&autoconnect=true&resize=scale',
      });
    } catch (err) {
      stopViewer();
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Done / Cancel: tear down ONLY the viewer. The browser keeps running so
  // add_comment can reuse the live session over CDP.
  router.post('/connect-done', (_req, res) => {
    stopViewer();
    res.json({ ok: true });
  });

  // Full reset — kill the persistent browser too (e.g. before a clean re-login).
  router.post('/reset', (_req, res) => {
    stopBrowser();
    res.json({ ok: true });
  });

  // Reverse-proxy any GET into websockify (noVNC static assets + vnc.html).
  router.get(/^\/vnc(\/.*)?$/, httpProxy);

  return router;
}
