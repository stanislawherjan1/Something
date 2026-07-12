/**
 * /api/integrations/* — self-service integration activation.
 *
 *   GET    /api/integrations           — catalog + per-integration status
 *                                        (active flag, activation timestamp,
 *                                         redacted summary { length, last4 })
 *   PUT    /api/integrations/:id       — body: { fields: { ... } }
 *                                        Encrypts + stores; updates mcpServers
 *                                        (or restarts Telegram). 409 if active.
 *   DELETE /api/integrations/:id       — wipes credentials, deactivates.
 *
 * No PATCH / Edit by design: rotation goes through DELETE → PUT so the
 * activate/remove audit trail always lines up with reality, and we never
 * have to reason about "partial update with old key still valid" states.
 *
 * All write paths go through rateLimit (5 req / minute / IP) to make
 * brute-forcing a partially-known field cost-prohibitive.
 */

import { Router } from 'express';
import express from 'express';
import * as catalog from '../lib/integrations/catalog.js';
import * as store from '../lib/integrations/store.js';
import * as runtime from '../lib/integrations/runtime.js';
import * as team from '../lib/team.js';
import * as oauth from '../lib/integrations/oauth.js';
import { writeAllowedHostsFile } from '../lib/integrations/egress.js';
import { isReady, readinessError } from '../lib/integrations/crypto.js';

// Tiny in-memory rate limiter — sliding window. Keyed on the verified actor
// email (req.actor) when present, falling back to req.ip when not. The actor
// key is more meaningful than IP behind nginx + Caddy — IP is one hop away
// (we set `app.set('trust proxy', 1)` in index.js), but actor is the
// authenticated identity, so a stolen-cookie loop hits its own bucket.
//
// A janitor runs every window to drop stale empty buckets — without it the
// Map keeps every one-shot key forever, since the 429 path doesn't write
// back the filtered (smaller) array.
//
// Not meant to survive a multi-replica deploy (we run a single workspace-api
// per client).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS  = 5;
const hits = new Map();   // key → number[] (timestamps within window)

function rateKey(req) {
  return req.actor || req.ip || req.socket?.remoteAddress || 'anonymous';
}

function rateLimit(req, res, next) {
  const key = rateKey(req);
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_HITS) {
    return res.status(429).json({
      error: 'Too many integration changes. Wait a minute and try again.',
    });
  }
  recent.push(now);
  hits.set(key, recent);
  next();
}

// Drop stale buckets so single-hit keys don't accumulate. .unref() so the
// timer never keeps the process alive past SIGTERM.
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of hits) {
    if (ts.every(t => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  }
}, RATE_WINDOW_MS).unref();

function readyOr503(_req, res, next) {
  if (isReady()) return next();
  return res.status(503).json({
    error: 'Integrations are not configured on this server. Ask your admin to mount the encryption key.',
    detail: readinessError(),
  });
}

// Credential writes (activate / rotate / remove) are admin-only — same gate as
// team/branding/setup. attachActor (lib/auth.js) never rejects on its own, so
// without this any actor-less request reaching workspace-api on 127.0.0.1:3001
// (a compromised MCP, a code-server terminal, a prompt-injected bot — all of
// which bypass nginx auth_request) could store, rotate, or wipe encrypted
// secrets. Mirrors routes/team.js requireAdmin.
function requireAdmin(req, res, next) {
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
  if (!team.isAdmin(req.actor)) {
    return res.status(403).json({ error: 'Only admins can change integrations.' });
  }
  next();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tiny self-closing page the OAuth popup lands on. postMessage tells the
// dashboard (window.opener, same origin) to refresh the card; the fallback
// text covers popup-blocker → same-tab navigations.
function oauthResultPage(ok, message, id) {
  const payload = JSON.stringify({ type: 'integration-oauth', ok, id: id || null });
  return `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Connection failed'}</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center;max-width:28rem">
<h2>${ok ? 'Connected ✓' : 'Connection failed'}</h2>
<p>${ok ? 'You can close this window.' : (message || 'Something went wrong.')}</p>
</div>
<script>
try { if (window.opener) window.opener.postMessage(${payload}, window.location.origin); } catch (e) {}
if (${ok ? 'true' : 'false'}) setTimeout(() => window.close(), 800);
</script>
</body>`;
}

export default function integrationsRouter() {
  const router = Router();

  // GET — anyone can read the catalog + status (no secrets returned).
  router.get('/integrations', (_req, res) => {
    const status = isReady() ? store.listStatus() : {};
    const items = catalog.listAll().map(entry => {
      const s = status[entry.id];
      // Non-secret values for globalForMulti fields, e.g. EMAIL_ALLOW_SEND.
      // Lets the Settings modal pre-populate with the user's current
      // choice. Empty object when nothing exposable / not active.
      const globalFieldValues = (isReady() && s?.active)
        ? store.readGlobalFieldValues(entry.id)
        : {};
      return {
        ...entry,
        active:            Boolean(s?.active),
        activatedAt:       s?.activatedAt || null,
        // { length, last4 } when active, null otherwise. Never plaintext.
        credentialSummary: s?.summary || null,
        // For multi=true integrations: how many items the user added.
        itemCount:         s?.itemCount ?? null,
        globalFieldValues,
      };
    });
    res.json({
      ready:        isReady(),
      readyError:   isReady() ? null : readinessError(),
      integrations: items,
    });
  });

  // ─── Remote-MCP OAuth (catalog entries with mcp.type === "http") ─────────
  //
  // workspace-api is the OAuth client (MCP-spec discovery + DCR + PKCE via
  // lib/integrations/oauth.js); the popup flow is:
  //   dashboard opens GET /integrations/:id/oauth/start in a popup
  //     → 302 to the provider's consent page
  //     → provider redirects to GET /integrations/oauth/callback?code&state
  //     → tokens land in the encrypted store, MCP config + egress sync,
  //       page postMessages the opener and closes itself.

  // The popup rides the admin's session cookies, so requireAdmin holds here.
  router.get('/integrations/:id/oauth/start', requireAdmin, readyOr503, rateLimit, async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat?.mcp || cat.mcp.type !== 'http') {
      return res.status(404).json({ error: 'Not a remote-MCP integration.' });
    }
    // Public origin for the redirect_uri: explicit env wins, else the
    // Caddy-forwarded host of this very request. Both resolve to the
    // client's own domain — the self-hosted constraint (no operator-side
    // redirector) is structural here.
    const host = process.env.FRONTEND_DOMAIN || req.get('x-forwarded-host') || req.get('host');
    try {
      const authorizeUrl = await oauth.startAuth(id, `https://${host}`);
      return res.redirect(authorizeUrl);
    } catch (err) {
      process.stderr.write(`[integrations] oauth start ${id}: ${err.message}\n`);
      return res.status(502).send(oauthResultPage(false, `Could not reach the provider: ${escapeHtml(err.message)}`));
    }
  });

  // No requireAdmin: the provider's redirect carries no session guarantee we
  // control. The single-use `state` param — minted in startAuth, bound to one
  // pending flow, 10-min TTL — is what authenticates this request (plus PKCE
  // on the code exchange itself).
  router.get('/integrations/oauth/callback', readyOr503, rateLimit, async (req, res) => {
    const { code, state, error, error_description: desc } = req.query;
    if (error) {
      return res.status(400).send(oauthResultPage(false, `Provider returned: ${escapeHtml(String(desc || error))}`));
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      return res.status(400).send(oauthResultPage(false, 'Missing code or state parameter.'));
    }
    let id;
    try {
      id = await oauth.handleCallback(state, code);
    } catch (err) {
      process.stderr.write(`[integrations] oauth callback: ${err.message}\n`);
      return res.status(400).send(oauthResultPage(false, escapeHtml(err.message)));
    }

    // Mirror the PUT post-activation recipe: optional skill, MCP config,
    // egress allowlist, bot restart when the mcpServers block changed.
    try { runtime.installOptionalSkill(id); } catch {}
    let changed = false;
    try { ({ changed } = runtime.syncMcpServers()); }
    catch (err) {
      process.stderr.write(`[integrations] oauth sync ${id}: ${err.message}\n`);
    }
    try { writeAllowedHostsFile(); }
    catch (err) {
      process.stderr.write(`[integrations] egress refresh failed: ${err.message}\n`);
    }
    if (changed) { try { await runtime.restartBot(); } catch {} }

    return res.send(oauthResultPage(true, null, id));
  });

  // PUT — activate one integration. Body shape: { fields: { NAME: value, ... } }
  router.put('/integrations/:id', requireAdmin, readyOr503, rateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    if (cat.comingSoon) return res.status(400).json({ error: `${cat.label} is not yet configurable.` });
    if (store.isActive(id)) {
      // Browser-login integrations (e.g. Docs Comments) are PRE-activated by
      // their own connect-start flow — it must mark the integration active so
      // the egress allowlist opens before the embedded Google login runs. The
      // dashboard's generic Save then PUTs again and would trip this guard,
      // surfacing a spurious "already active" error right after a successful
      // login. For these, re-activation is idempotent and harmless
      // (store.activate just rewrites the marker), so let it through. The
      // remove-first guard still protects credential-bearing integrations from
      // accidental overwrite.
      const isBrowserLogin = Array.isArray(cat.fields) && cat.fields.length > 0
        && cat.fields.every((f) => typeof f.type === 'string' && f.type.endsWith('browser-login'));
      if (!isBrowserLogin) {
        return res.status(409).json({
          error: `${cat.label} is already active. Remove it first if you want to rotate the credentials.`,
        });
      }
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Missing JSON body.' });
    }
    if (cat.multi) {
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ error: 'Body must be { items: [{ fields: {...} }, ...] }.' });
      }
    } else if (!body.fields || typeof body.fields !== 'object') {
      return res.status(400).json({ error: 'Body must be { fields: { ... } }.' });
    }

    try {
      store.activate(id, body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Telegram activation asks for the admin's own chat id — mirror it into the
    // activating admin's roster entry so the Telegram settings panel shows them
    // linked instead of asking for the SAME id again a minute later. Best-effort:
    // a conflict (id already linked to someone else) must not fail activation.
    if (id === 'telegram') {
      const adminChatId = typeof body.fields?.TELEGRAM_ADMIN_CHAT_ID === 'string'
        ? body.fields.TELEGRAM_ADMIN_CHAT_ID.trim() : '';
      if (adminChatId) {
        try { team.setTelegram(req.actor, { chatId: adminChatId }, req.actor); }
        catch (err) {
          process.stderr.write(`[integrations] telegram admin chat-id mirror skipped: ${err.message}\n`);
        }
      }
    }

    // Some integrations need files on disk (email accounts.json, GA4 service-
    // account JSON). Write them BEFORE syncing mcp config so the file exists
    // when the next claude turn spawns the MCP.
    try { runtime.applyFiles(id); }
    catch (err) {
      process.stderr.write(`[integrations] applyFiles ${id}: ${err.message}\n`);
    }

    // If a matching optional skill exists in /opt/ide/skills/optional/, copy
    // it into ~/.claude/skills/ so the bot has the protocol playbook
    // available right after activation. Idempotent + non-destructive — user
    // edits to an existing skill survive.
    try { runtime.installOptionalSkill(id); }
    catch (err) {
      process.stderr.write(`[integrations] installOptionalSkill ${id}: ${err.message}\n`);
    }

    // Hot-apply: write the MCP config so the next claude turn picks it up.
    let changed = false;
    try {
      ({ changed } = runtime.syncMcpServers());
    } catch (err) {
      // We've already saved credentials, but couldn't update the MCP config.
      // Surface the error so the admin can investigate; the credentials are
      // still on disk and a manual restart will pick them up.
      return res.status(500).json({
        error: `Saved, but failed to wire up the MCP server: ${err.message}. Try restarting workspace-api.`,
      });
    }

    // Refresh the egress allow-list — the host-side ipset polls
    // allowed-hosts.txt on its own cadence (~60-300s), so this just makes
    // the new integration's hostnames reachable on the next sync. Failure
    // here doesn't block activation: the integration is already saved,
    // and the host script will pick up the new file on its next read.
    try { writeAllowedHostsFile(); }
    catch (err) {
      process.stderr.write(`[integrations] egress refresh failed: ${err.message}\n`);
    }

    // Restart the bot only when something the bot actually caches has
    // changed. Two trigger conditions:
    //   1. mcpServers diff — `changed` from syncMcpServers
    //   2. Telegram integration touched — its credentials live in
    //      integrations.env, which the bot reads once at startup
    // Both result in re-running bot.sh, which re-reads the cached config.
    // Idempotent re-saves (same fields) skip the restart and keep the
    // active session alive.
    const restarting = changed || cat.process === 'telegram-bot';
    // Await so we can surface the signal result. Restart goes via file-touch
    // (runtime.restartBot), which is sync-ish — bot watcher picks up within
    // 2s and the PM2 cycle follows. The credentials are already saved
    // regardless of restart outcome, so a failed signal is a UI hint, not
    // a transaction rollback.
    const restartOk = restarting ? await runtime.restartBot() : true;

    const state = store.listStatus()[id];
    res.json({
      ok:                true,
      activatedAt:       state?.activatedAt || null,
      credentialSummary: state?.summary || null,
      restarting,
      restartFailed:     restarting && !restartOk,
    });
  });

  // PATCH — partial update of an active integration without rotating
  // credentials. Body: { fields: {...} } for single, { globalFields: {...} }
  // for multi. Used to flip Permissions toggles (e.g. EMAIL_ALLOW_SEND)
  // without a full Remove → Activate cycle.
  router.patch('/integrations/:id', requireAdmin, readyOr503, rateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    if (!store.isActive(id)) return res.status(404).json({ error: `${cat.label} is not active.` });

    const body = req.body;
    if (!body || typeof body !== 'object' || (!body.fields && !body.globalFields)) {
      return res.status(400).json({ error: 'Body must include `fields` or `globalFields`.' });
    }

    let updatedNames;
    try { updatedNames = store.update(id, body); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    // Re-materialise files in case a field that backs a writeFile changed.
    try { runtime.applyFiles(id); }
    catch (err) {
      process.stderr.write(`[integrations] applyFiles ${id} (update): ${err.message}\n`);
    }

    try { runtime.syncMcpServers(); }
    catch (err) {
      return res.status(500).json({
        error: `Saved, but failed to wire up the MCP server: ${err.message}.`,
      });
    }

    // PATCH can change SHOPIFY_STORE_DOMAIN, EMAIL_HOST, etc. — refresh
    // egress so the new hostname becomes reachable on the host script's
    // next sync.
    try { writeAllowedHostsFile(); }
    catch (err) {
      process.stderr.write(`[integrations] egress refresh failed: ${err.message}\n`);
    }

    // Always restart on PATCH. Settings tweaks rarely move the
    // `mcpServers` JSON (env vars stay the same for email — only the
    // accounts.json on disk changes), so the `changed` heuristic used in
    // PUT/DELETE doesn't apply. Bots cache their writeFile outputs at
    // process start, so a restart is the only way the new value takes
    // effect immediately. Telegram users tolerate a ~5 s blip.
    const restartOk = await runtime.restartBot();

    res.json({
      ok: true,
      updated: updatedNames,
      restarting: true,
      restartFailed: !restartOk,
    });
  });

  // DELETE — wipe credentials and deactivate.
  router.delete('/integrations/:id', requireAdmin, readyOr503, rateLimit, async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    if (!store.isActive(id)) return res.status(404).json({ error: `${cat.label} is not active.` });

    store.remove(id);

    // Remote-MCP integrations: also drop the DCR client registration so a
    // future Connect starts from a clean registration.
    if (cat.mcp?.type === 'http') {
      try { oauth.forgetClient(id); } catch {}
    }

    try { runtime.unlinkFiles(id); }
    catch (err) {
      process.stderr.write(`[integrations] unlinkFiles ${id}: ${err.message}\n`);
    }

    let changed = false;
    try {
      ({ changed } = runtime.syncMcpServers());
    } catch (err) {
      return res.status(500).json({
        error: `Removed, but failed to update the MCP config: ${err.message}.`,
      });
    }

    // Tighten the egress allowlist — the integration's hostnames should
    // no longer be reachable. Host script picks up the shrinkage on its
    // next sync.
    try { writeAllowedHostsFile(); }
    catch (err) {
      process.stderr.write(`[integrations] egress refresh failed: ${err.message}\n`);
    }

    // Restart only when the cached set actually shrank (or for telegram,
    // since the bot's env file changed). Signal goes via file-touch so it
    // works regardless of whether TG was the integration being removed.
    const restarting = changed || cat.process === 'telegram-bot';
    const restartOk = restarting ? await runtime.restartBot() : true;

    res.json({
      ok: true,
      restarting,
      restartFailed: restarting && !restartOk,
    });
  });

  return router;
}
