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
import { requireActor } from '../lib/auth.js';
import * as oauth from '../lib/integrations/oauth.js';
import { writeAllowedHostsFile } from '../lib/integrations/egress.js';
import { isReady, readinessError } from '../lib/integrations/crypto.js';
import { avatarUrl } from '../lib/user-avatars.js';
import { publish as notify } from '../lib/notify.js';
import { flushAllWaiting } from '../lib/routines-add.js';

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
const RATE_MAX_HITS  = Number(process.env.INTEGRATIONS_RATE_MAX || 5);   // per minute per actor; tests raise it
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

// Which connection a request means: the workspace's (`granola`, admins only)
// or the actor's own (`granola@<slug>`, for catalog entries a person may
// connect for themselves). `?reach=personal` (or body.reach) picks the latter;
// an admin may also name another person's with `?slug=` to remove it.
function actorSlug(req) { try { return team.getUser(req.actor)?.slug || null; } catch { return null; } }
function onRoster(slug) { try { return team.list().some(m => m.slug === slug); } catch { return false; } }
function nameOf(slug) { try { return team.list().find(m => m.slug === slug)?.displayName || slug; } catch { return slug; } }
// A person as a tile shows them: name and avatar (null → initials). The owner
// of a workspace connection who has since left is "a former member": the
// connection stays the workspace's, its night import pauses (nobody lists it
// as theirs), and the screen says to reconnect.
function personOf(slug) {
  if (!onRoster(slug)) return { slug, name: 'a former member', avatarUrl: null, gone: true };
  let url = null; try { url = avatarUrl(slug); } catch { /* none */ }
  return { slug, name: nameOf(slug), avatarUrl: url };
}
function reachOf(req) { return (req.query?.reach || req.body?.reach) === 'personal' ? 'personal' : 'workspace'; }
function accessOf(req) { return (req.query?.access || req.body?.access) === 'read' ? 'read' : 'write'; }
function keyFor(req, id, res) {
  const cat = catalog.get(id);
  if (reachOf(req) === 'workspace') {
    if (!team.isAdmin(req.actor)) { res.status(403).json({ error: 'Only admins can change workspace integrations.' }); return null; }
    // A channel (Telegram) is the whole team's and sends as well as reads: no access to choose.
    return { key: id, owner: actorSlug(req), reach: 'workspace', access: cat?.teamWide ? 'write' : accessOf(req) };
  }
  if (!cat?.personal) { res.status(400).json({ error: `${cat?.label || id} can only be connected for the whole workspace.` }); return null; }
  const forSlug = typeof req.query?.slug === 'string' && req.query.slug ? req.query.slug : actorSlug(req);
  if (!forSlug) { res.status(400).json({ error: 'No person to connect this for.' }); return null; }
  // Someone else's own connection: an admin may only remove it (People tab →
  // Disconnect). Changing it — a host, a password, a whole account — would let
  // an admin point a person's mail at a server of their choosing with the
  // person's stored password, or put their own account under the person's name.
  if (forSlug !== actorSlug(req) && !(team.isAdmin(req.actor) && req.method === 'DELETE')) { res.status(403).json({ error: 'You can only change your own connections.' }); return null; }
  return { key: store.personalKey(id, forSlug), owner: forSlug, reach: 'personal', access: 'write' };
}
// After a change: files, skills, the bot's config (workspace and the
// operator's own), the egress list; the bot restarts only when its own
// config changed. A member's own connection changes nothing of the bot's.
async function afterChange(key, { files = true, skill = true, forceRestart = false } = {}) {
  const slug = catalog.slugOf(key);
  if (slug) runtime.forgetPersonalServers(slug);
  if (files) { try { runtime.applyFiles(key); } catch (err) { process.stderr.write(`[integrations] applyFiles ${key}: ${err.message}\n`); } }
  if (skill) { try { runtime.installOptionalSkill(key); } catch (err) { process.stderr.write(`[integrations] installOptionalSkill ${key}: ${err.message}\n`); } }
  // Routines picked before their integration was connected start now.
  try { flushAllWaiting(); } catch (err) { process.stderr.write(`[integrations] waiting routines: ${err.message}\n`); }
  let changed = false;
  try { ({ changed } = runtime.syncMcpServers()); }
  catch (err) { return { error: `Saved, but failed to wire up the MCP server: ${err.message}.` }; }
  try { writeAllowedHostsFile(); }
  catch (err) { process.stderr.write(`[integrations] egress refresh failed: ${err.message}\n`); }
  const restarting = changed || forceRestart;
  const restartOk = restarting ? await runtime.restartBot() : true;
  return { restarting, restartFailed: restarting && !restartOk };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tiny self-closing page the OAuth popup lands on. postMessage tells the
// dashboard (window.opener, same origin) to refresh the card; the fallback
// text covers popup-blocker → same-tab navigations.
function oauthResultPage(ok, message, id, extra = {}) {
  const payload = JSON.stringify({ type: 'integration-oauth', ok, id: id || null, ...extra });
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
  router.get('/integrations', requireActor, (req, res) => {
    const status = isReady() ? store.listStatus() : {};
    // The length and last characters of a key describe the key; they are for
    // the admin who manages it, not for every member who sees the list.
    const admin = team.isAdmin(req.actor);
    const me = actorSlug(req);
    const items = catalog.listAll().map(entry => {
      const s = status[entry.id];
      // The actor's own connection of it, and (for an admin) everyone's.
      const mineKey = me ? store.personalKey(entry.id, me) : null;
      const mine = mineKey && status[mineKey]
        ? { active: true, activatedAt: status[mineKey].activatedAt || null, summary: status[mineKey].summary || null, itemCount: status[mineKey].itemCount ?? null }
        : { active: false, activatedAt: null };
      const people = isReady() ? store.peopleWith(entry.id) : [];
      const activeFor = admin ? people.map(personOf) : undefined;
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
        // { length, last4 } when active, for an admin; null otherwise. Never plaintext.
        credentialSummary: admin ? (s?.summary || null) : null,
        // For multi=true integrations: how many items the user added.
        itemCount:         s?.itemCount ?? null,
        globalFieldValues,
        // Who connected the workspace's, its reach ('workspace') and access.
        connectedBy:       s?.active && s.owner ? personOf(s.owner) : null,
        reach:             s?.active ? 'workspace' : null,
        access:            s?.active ? (s.access || 'write') : null,
        // The actor's own connection of it (catalog `personal` entries).
        personal:          Boolean(entry.personal),
        mine,
        // Admins: the people who connected their own account of it.
        ...(activeFor ? { activeFor } : {}),
        canConnectWorkspace: admin,
        canConnectPersonal:  Boolean(entry.personal) && Boolean(me),
        // Pausable integrations: switched off for now, key kept.
        ...(entry.pausable ? { paused: Boolean(s?.active) && store.isPaused(entry.id) } : {}),
      };
    });
    // no-store so the dashboard's post-OAuth refetch always sees the freshly
    // activated integration instead of a cached (still-inactive) response.
    res.set('Cache-Control', 'no-store');
    res.json({
      ready:        isReady(),
      readyError:   isReady() ? null : readinessError(),
      integrations: items,
    });
  });

  // Pause / resume a `pausable` integration without removing it: the key stays,
  // its tools and its egress hosts go away until resumed. No bot restart —
  // the tools that use it check at the start of every turn.
  router.put('/integrations/:id/paused', requireAdmin, readyOr503, rateLimit, express.json({ limit: '1kb' }), (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat?.pausable) return res.status(404).json({ error: `"${id}" cannot be paused.` });
    if (!store.isActive(id)) return res.status(404).json({ error: `${cat.label} is not connected.` });
    if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'Body must be { paused: true | false }.' });
    try { store.setPaused(id, req.body.paused); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    try { writeAllowedHostsFile(); }
    catch (err) { process.stderr.write(`[integrations] egress refresh failed: ${err.message}\n`); }
    res.json({ ok: true, paused: req.body.paused });
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
  router.get('/integrations/:id/oauth/start', requireActor, readyOr503, rateLimit, async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat?.mcp || cat.mcp.type !== 'http') {
      return res.status(404).json({ error: 'Not a remote-MCP integration.' });
    }
    const target = keyFor(req, id, res);
    if (!target) return;
    // Public origin for the redirect_uri: explicit env wins, else the
    // Caddy-forwarded host of this very request. Both resolve to the
    // client's own domain — the self-hosted constraint (no operator-side
    // redirector) is structural here.
    const host = process.env.FRONTEND_DOMAIN || req.get('x-forwarded-host') || req.get('host');
    try {
      const authorizeUrl = await oauth.startAuth(id, `https://${host}`, { owner: target.owner, reach: target.reach, access: target.access });
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
    // A person's own connection binds to their session as well as to the
    // state: a state link that leaked cannot land one person's account under
    // another. The workspace's needs an admin's session.
    const flow = oauth.pendingFlow(state);
    if (!flow) return res.status(400).send(oauthResultPage(false, 'Unknown or expired sign-in. Start again from the integrations page.'));
    if (flow.reach === 'personal' && actorSlug(req) !== flow.owner) {
      return res.status(403).send(oauthResultPage(false, 'This sign-in belongs to another person\'s session.'));
    }
    if (flow.reach !== 'personal' && !team.isAdmin(req.actor)) {
      return res.status(403).send(oauthResultPage(false, 'Only an admin can connect this for the workspace.'));
    }
    let key;
    try {
      key = await oauth.handleCallback(state, code);
    } catch (err) {
      process.stderr.write(`[integrations] oauth callback: ${err.message}\n`);
      return res.status(400).send(oauthResultPage(false, escapeHtml(err.message)));
    }
    const after = await afterChange(key, { files: false });
    return res.send(oauthResultPage(true, null, catalog.baseId(key), { reach: flow.reach, restarting: !!after.restarting }));
  });

  // PUT — activate one integration. Body shape: { fields: { NAME: value, ... } }
  router.put('/integrations/:id', requireActor, readyOr503, rateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    if (cat.comingSoon) return res.status(400).json({ error: `${cat.label} is not yet configurable.` });
    const target = keyFor(req, id, res);
    if (!target) return;
    const key = target.key;
    if (store.isActive(key)) {
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
      store.activate(key, body, { owner: target.owner, reach: target.reach, access: target.access });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Telegram activation asks for the admin's own chat id — mirror it into the
    // activating admin's roster entry so the Telegram settings panel shows them
    // linked instead of asking for the SAME id again a minute later. Best-effort:
    // a conflict (id already linked to someone else) must not fail activation.
    if (key === 'telegram') {
      const adminChatId = typeof body.fields?.TELEGRAM_ADMIN_CHAT_ID === 'string'
        ? body.fields.TELEGRAM_ADMIN_CHAT_ID.trim() : '';
      if (adminChatId) {
        try { team.setTelegram(req.actor, { chatId: adminChatId }, req.actor); }
        catch (err) {
          process.stderr.write(`[integrations] telegram admin chat-id mirror skipped: ${err.message}\n`);
        }
      }
    }

    // Files on disk (email accounts.json, GA4 service account), the optional
    // skill, the bot's config, the egress list; a restart when the bot's own
    // config changed. A member's own connection changes nothing of the bot's.
    const after = await afterChange(key, { forceRestart: cat.process === 'telegram-bot' });
    if (after.error) return res.status(500).json({ error: after.error });
    const state = store.listStatus()[key];
    res.json({
      ok:                true,
      activatedAt:       state?.activatedAt || null,
      credentialSummary: state?.summary || null,
      reach:             target.reach,
      restarting:        after.restarting,
      restartFailed:     after.restartFailed,
    });
  });

  // PATCH — partial update of an active integration without rotating
  // credentials. Body: { fields: {...} } for single, { globalFields: {...} }
  // for multi. Used to flip Permissions toggles (e.g. EMAIL_ALLOW_SEND)
  // without a full Remove → Activate cycle.
  // One connection, for its page: fields with whether they are set (secrets
  // as length and last characters), items for a multi one, owner and reach.
  router.get('/integrations/:id', requireActor, readyOr503, (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    const admin = team.isAdmin(req.actor);
    const me = actorSlug(req);
    // Members see only their own connection's fields; the workspace's is an
    // admin's to look into (its presence is on the list).
    const workspace = admin ? store.detail(id) : null;
    const mine = me ? store.detail(store.personalKey(id, me)) : null;
    const people = admin ? store.peopleWith(id).map(slug => ({ ...personOf(slug), activatedAt: store.listStatus()[store.personalKey(id, slug)]?.activatedAt || null })) : undefined;
    res.set('Cache-Control', 'no-store');
    res.json({
      ...cat,
      workspaceActive: store.isActive(id),
      connectedBy: store.ownership(id)?.owner ? personOf(store.ownership(id).owner) : null,
      workspace: workspace ? { ...workspace, connectedBy: workspace.owner ? personOf(workspace.owner) : null } : null,
      mine,
      ...(people ? { activeFor: people } : {}),
      canConnectWorkspace: admin,
      canConnectPersonal: Boolean(cat.personal) && Boolean(me),
      globalFieldValues: store.isActive(id) ? store.readGlobalFieldValues(id) : {},
    });
  });

  // Accounts of a multi connection (a mailbox each), edited in place.
  router.post('/integrations/:id/items', requireActor, readyOr503, rateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const target = keyFor(req, req.params.id, res);
    if (!target) return;
    try {
      const index = store.addItem(target.key, req.body?.fields || {});
      const after = await afterChange(target.key, { skill: false, forceRestart: target.reach === 'workspace' });
      res.json({ ok: true, index, restarting: after.restarting, restartFailed: after.restartFailed });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  router.patch('/integrations/:id/items/:n', requireActor, readyOr503, rateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const target = keyFor(req, req.params.id, res);
    if (!target) return;
    try {
      const updated = store.updateItem(target.key, Number(req.params.n), req.body?.fields || {});
      const after = await afterChange(target.key, { skill: false, forceRestart: target.reach === 'workspace' });
      res.json({ ok: true, updated, restarting: after.restarting, restartFailed: after.restartFailed });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  router.delete('/integrations/:id/items/:n', requireActor, readyOr503, rateLimit, async (req, res) => {
    const target = keyFor(req, req.params.id, res);
    if (!target) return;
    try {
      const r = store.removeItem(target.key, Number(req.params.n));
      if (r.removedConnection) { try { runtime.unlinkFiles(target.key); } catch { /* best-effort */ } }
      const after = await afterChange(target.key, { files: !r.removedConnection, skill: false, forceRestart: target.reach === 'workspace' });
      res.json({ ok: true, ...r, restarting: after.restarting, restartFailed: after.restartFailed });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Does the connection work? A remote-MCP one gets a fresh token from the
  // provider; a stored-key one is decrypted and checked for its required
  // fields. The answer names the problem, never a secret.
  router.post('/integrations/:id/test', requireActor, readyOr503, rateLimit, async (req, res) => {
    const target = keyFor(req, req.params.id, res);
    if (!target) return;
    const cat = catalog.get(req.params.id);
    if (!store.isActive(target.key)) return res.status(404).json({ ok: false, error: `${cat.label} is not connected.` });
    const at = new Date().toISOString();
    try {
      if ((cat.fields || []).some(f => f.type === 'remote-mcp-oauth')) {
        await oauth.getFreshToken(target.key);
        return res.json({ ok: true, at, detail: 'Signed in; the provider accepted the token.' });
      }
      const plain = store.decryptFor(target.key);
      const items = Array.isArray(plain) ? plain : [plain];
      const required = catalog.requiredFields(req.params.id);
      const missing = items.flatMap((it, i) => required.filter(n => !it[n]).map(n => (items.length > 1 ? `${n} (item ${i + 1})` : n)));
      if (missing.length) return res.json({ ok: false, at, error: `Missing: ${missing.join(', ')}` });
      return res.json({ ok: true, at, detail: items.length > 1 ? `${items.length} accounts stored and readable.` : 'Stored and readable.' });
    } catch (err) {
      const reauth = err.code === 'reauth_required';
      return res.json({ ok: false, at, error: reauth ? 'The sign-in has expired — reconnect.' : String(err.message || err).replace(/[A-Za-z0-9_-]{24,}/g, '…'), reauth });
    }
  });

  // PATCH — edit an active connection's settings in place (the workspace's for
  // an admin, a person's own with ?reach=personal).
  // The same for several at once — the switch-on screen sends its whole answer
  // in one request: one rate-limit hit, one restart of the bot.
  router.post('/integrations/make-personal', requireActor, readyOr503, rateLimit, express.json({ limit: '8kb' }), async (req, res) => {
    if (!team.isAdmin(req.actor)) return res.status(403).json({ error: 'Only an admin can do this.' });
    const slug = actorSlug(req);
    if (!slug) return res.status(400).json({ error: 'No person to give them to.' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 100) : [];
    const moved = [], failed = [];
    for (const id of ids) {
      const cat = catalog.get(id);
      if (!cat || !cat.personal) { failed.push({ id, error: cat ? `${cat.label} can only be the team's.` : 'unknown integration' }); continue; }
      try { runtime.unlinkFiles(id); moved.push(store.makePersonal(id, slug)); }
      catch (err) { failed.push({ id, error: err.message }); }
    }
    let restarting = false;
    if (moved.length) {
      try { runtime.applyFiles(moved[0]); } catch { /* best-effort */ }
      for (const k of moved.slice(1)) { try { runtime.applyFiles(k); } catch { /* best-effort */ } }
      const after = await afterChange(moved[0], { files: false, skill: false, forceRestart: true });
      restarting = after.restarting;
    }
    res.status(failed.length && !moved.length ? 400 : 200).json({ ok: !failed.length, moved, failed, restarting });
  });

  // When collaboration is switched on, the owner decides per connection:
  // the team uses it, or it stays theirs alone (re-keyed as their own).
  router.post('/integrations/:id/make-personal', requireActor, readyOr503, rateLimit, async (req, res) => {
    if (!team.isAdmin(req.actor)) return res.status(403).json({ error: 'Only an admin can do this.' });
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    if (!cat.personal) return res.status(400).json({ error: `${cat.label} can only be the team's.` });
    const slug = actorSlug(req);
    if (!slug) return res.status(400).json({ error: 'No person to give it to.' });
    try {
      runtime.unlinkFiles(id);
      const key = store.makePersonal(id, slug);
      const after = await afterChange(key, { files: true, skill: false, forceRestart: true });
      res.json({ ok: true, key, restarting: after.restarting });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.patch('/integrations/:id', requireActor, readyOr503, rateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    const target = keyFor(req, id, res);
    if (!target) return;
    const key = target.key;
    if (!store.isActive(key)) return res.status(404).json({ error: `${cat.label} is not active.` });
    const body = req.body;
    // `{ access: 'read' | 'write' }` alone: the team's access level, no reconnect.
    if (body && typeof body === 'object' && body.access && !body.fields && !body.globalFields) {
      if (target.reach !== 'workspace') return res.status(400).json({ error: 'Your own connection is always read and write.' });
      try { store.setAccess(key, body.access); } catch (err) { return res.status(400).json({ error: err.message }); }
      runtime.writeAccessMap();
      return res.json({ ok: true, access: body.access, restarting: false, restartFailed: false });
    }
    if (!body || typeof body !== 'object' || (!body.fields && !body.globalFields)) {
      return res.status(400).json({ error: 'Body must include `fields`, `globalFields` or `access`.' });
    }
    let updatedNames;
    try { updatedNames = store.update(key, body); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    // A workspace change restarts the bot (its config or files changed); a
    // person's own connection reaches their turns on the next turn.
    const after = await afterChange(key, { skill: false, forceRestart: target.reach === 'workspace' });
    if (after.error) return res.status(500).json({ error: after.error });
    res.json({
      ok: true,
      updated: updatedNames,
      restarting: after.restarting,
      restartFailed: after.restartFailed,
    });
  });

  // DELETE — wipe one connection: the workspace's (admin), or a person's own
  // (?reach=personal; an admin may name another person's with ?slug=).
  router.delete('/integrations/:id', requireActor, readyOr503, rateLimit, async (req, res) => {
    const id = req.params.id;
    const cat = catalog.get(id);
    if (!cat) return res.status(404).json({ error: `Unknown integration "${id}".` });
    const target = keyFor(req, id, res);
    if (!target) return;
    const key = target.key;
    if (!store.isActive(key)) return res.status(404).json({ error: `${cat.label} is not active.` });
    store.remove(key);
    // An admin took away a person's own connection: that person hears it,
    // with the reason when one was given.
    if (target.reach === 'personal' && target.owner !== actorSlug(req)) {
      const reason = typeof req.query?.reason === 'string' && req.query.reason.trim() ? ` Reason: ${req.query.reason.trim().slice(0, 200)}` : '';
      try { notify({ kind: 'integration', recipient: target.owner, title: `${cat.label} disconnected`, body: `${nameOf(actorSlug(req))} disconnected your own ${cat.label}.${reason} You can connect it again any time.`, meta: { integration: id } }); }
      catch (err) { process.stderr.write(`[integrations] notice not sent: ${err.message}\n`); }
    }
    // The DCR client is the integration's, shared by every connection of it:
    // it goes when the last connection does.
    if (cat.mcp?.type === 'http' && !store.isActive(id) && !store.peopleWith(id).length) {
      try { oauth.forgetClient(id); } catch {}
    }
    try { runtime.unlinkFiles(key); }
    catch (err) {
      process.stderr.write(`[integrations] unlinkFiles ${key}: ${err.message}\n`);
    }
    const after = await afterChange(key, { files: false, skill: false, forceRestart: cat.process === 'telegram-bot' });
    if (after.error) return res.status(500).json({ error: `Removed, but failed to update the MCP config: ${after.error}` });
    res.json({
      ok: true,
      restarting: after.restarting,
      restartFailed: after.restartFailed,
    });
  });

  return router;
}
