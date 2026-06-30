#!/usr/bin/env node
/**
 * docs-comments session keep-alive.
 *
 * THE BUG THIS FIXES: docs-comments drives ONE persistent Chromium logged into
 * Google Docs (Google anti-fraud blocks re-login from a fresh datacenter-IP
 * browser, so the live session can't be rebuilt automatically — see
 * docs-comments-login.js). Nothing kept that session warm: if no comment was
 * posted for a stretch, Google expired the idle session cookies (~1-2 weeks).
 * The browser PROCESS stayed alive, so every health check (watchdog,
 * /ensure browserAlive, /status profileExists) reported "connected" — while the
 * session inside was dead. The operator only found out on the next add_comment
 * (SESSION_EXPIRED), and the only fix was a manual interactive re-login. That's
 * the "I'm connected but it doesn't work, and I have to reconnect anyway"
 * complaint. Other integrations are connect-once-and-forget; this one wasn't.
 *
 * THE FIX: periodically DRIVE the live browser to https://docs.google.com/. The
 * authenticated navigation refreshes Google's session cookies, so an idle
 * session never goes stale — connect once, forget. The same navigation also
 * tells us whether the session is still valid (lands on docs.google.com) or has
 * truly expired (bounced to accounts.google.com); we report that to wsapi so the
 * UI can show honest state instead of a fake "connected", and the operator gets
 * pinged BEFORE they hit a broken comment.
 *
 * Runs as its own PM2 process. Attaches over CDP (connectOverCDP) exactly like
 * the docs-comments MCP — it does NOT launch a browser, so it needs only the
 * playwright-core library (resolved from this app's node_modules), not the
 * Chromium binary. When the integration is inactive / the browser is down, CDP
 * is unreachable and each tick is a cheap no-op (so this is safe to run on every
 * client, docs-comments or not).
 */

import { chromium } from 'playwright-core';
import { request as httpRequest } from 'node:http';

const CDP_URL       = process.env.DOCS_COMMENTS_CDP_URL || 'http://127.0.0.1:9333';
const PROBE_URL     = process.env.DOCS_COMMENTS_KEEPALIVE_URL || 'https://docs.google.com/';
const INTERVAL_MS   = Math.max(0.5, Number(process.env.DOCS_COMMENTS_KEEPALIVE_HOURS) || 6) * 3600 * 1000;
const FIRST_DELAY_MS = Math.max(0, Number(process.env.DOCS_COMMENTS_KEEPALIVE_FIRST_DELAY_S) || 120) * 1000;
const NAV_TIMEOUT   = 25000;
const WSAPI_PROBE   = process.env.DOCS_COMMENTS_PROBE_URL || 'http://127.0.0.1:3001/api/internal/docs-comments/session-probe';

let running = false;

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} [docs-keepalive] ${msg}\n`);
}

// Best-effort report of the probe result to wsapi (which owns /var/wsapi-store
// and surfaces sessionValid in /status). Never throws — the keep-alive REFRESH
// is the primary job; state reporting is a backstop.
function report(state) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try {
      const body = JSON.stringify(state);
      const u = new URL(WSAPI_PROBE);
      const req = httpRequest({
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 5000,
      }, (res) => { res.resume(); res.on('end', fin); });
      req.on('error', fin);
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } fin(); });
      req.write(body); req.end();
    } catch { fin(); }
  });
}

async function tick() {
  if (running) return;
  running = true;
  let browser = null;
  try {
    // Attach to the persistent login browser. Unreachable => integration not
    // active or browser not up yet: skip quietly (do NOT report expired).
    try {
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 8000 });
    } catch {
      log('browser not reachable over CDP — skipping (integration inactive or browser down)');
      return;
    }
    const ctx = browser.contexts()[0];
    if (!ctx) { log('no browser context — skipping'); return; }
    const page = await ctx.newPage();
    try {
      await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const host = new URL(page.url()).hostname;
      const valid = host.endsWith('docs.google.com');
      if (valid) {
        log('session refreshed — valid');
      } else {
        log(`session EXPIRED — bounced to ${host} (needs interactive re-login)`);
      }
      await report({ valid, host, checkedAt: Date.now() });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    // A navigation/CDP error mid-probe is inconclusive (transient) — don't flip
    // state to expired on a flake. Just log.
    log(`probe inconclusive: ${err.message}`);
  } finally {
    // For a connectOverCDP browser, close() only DISCONNECTS the CDP client; it
    // never terminates the persistent Chromium (wsapi owns its lifecycle).
    try { if (browser) await browser.close(); } catch { /* already gone */ }
    running = false;
  }
}

log(`started — refresh ${PROBE_URL} every ${INTERVAL_MS / 3600000}h (first run in ${FIRST_DELAY_MS / 1000}s), CDP ${CDP_URL}`);
setTimeout(function loop() {
  tick().finally(() => setTimeout(loop, INTERVAL_MS));
}, FIRST_DELAY_MS);
