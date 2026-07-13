# Integrations — self-service activation

The workspace ships with an **Integrations** dashboard that lets the end user
activate, rotate, and remove third-party API keys themselves — no `.env`
edits, no SSH, no redeploys. This document covers the design, the admin
setup, the user flow, and the security model.

---

## Available integrations

Activated from the **Integrations** dashboard — no redeploy.
`ide-template/workspace-api/integrations.catalog.json` is the source of truth;
these tables mirror it. Two kinds:

### One-click — sign in, no keys to paste

Provider-hosted **remote MCP servers**. Activation is a single popup: the user
signs in to the provider and approves; the workspace-api OAuth broker registers
itself (Dynamic Client Registration), completes PKCE on the client's own domain,
and feeds the token to the MCP via a `headersHelper` — **no operator setup, no
API keys**. See [Remote-MCP one-click OAuth](#remote-mcp-one-click-oauth) for how
it works. `open` = no auth at all (keyless hosted server, instant-activate).

| Integration | What it does | Auth |
|---|---|---|
| **Airtable** | Bases, tables, records | OAuth |
| **Amplitude** | Product analytics and charts | OAuth |
| **Atlassian** | Jira and Confluence | OAuth |
| **Cal.com** | Bookings and availability | OAuth |
| **Calendly** | Scheduling and invitees | OAuth |
| **Canva** | Designs and brand assets | OAuth |
| **Cloudflare** | Workers, KV, R2, DNS | OAuth |
| **Crypto.com** | Crypto prices and charts | open |
| **Firecrawl** | Scrape, crawl, and search the web | OAuth |
| **Klaviyo** | Campaigns, flows, lists | OAuth |
| **Linear** | Issues, projects, cycles | OAuth |
| **Mailchimp** | Audiences and campaigns | OAuth |
| **Miro** | Boards and diagrams | OAuth |
| **monday.com** | Boards, items, updates | OAuth |
| **Neon** | Postgres branches and SQL | OAuth |
| **Netlify** | Sites, deploys, forms | OAuth |
| **Notion** | Pages, databases, search | OAuth |
| **Parallel Search** | Real-time web search | open |
| **PayPal** | Payments and invoices | OAuth |
| **Sentry** | Errors and releases | OAuth |
| **Stripe** | Payments and subscriptions | OAuth |
| **Supabase** | Postgres, auth, functions | OAuth |
| **Todoist** | Tasks and projects | OAuth |
| **Webflow** | Sites, CMS, publishing | OAuth |
| **Wix** | Sites, stores, orders | OAuth |
| **Zapier** | 7,000+ apps via Zapier | OAuth |

### Bring your own credentials

Self-hosted MCPs or provider APIs that need a key, token, or file you paste once
(encrypted at rest). Some — Google Workspace, Meta, Google Ads — need a
provider-side app the operator provisions; those steps are documented below.

| Integration | What it does |
|---|---|
| **Shopify** | Read orders, products, inventory; create draft orders & products; manage fulfillments |
| **Meta Ads** | Facebook + Instagram ads, campaigns, audiences, Page + IG insights, Business Portfolio |
| **Google Ads** | Campaigns, ad groups, keywords, RSAs, Keyword Planner, performance reports |
| **Google Analytics 4** | Traffic, events, conversions, user behaviour — queried from chat |
| **Google Workspace** | Docs, Sheets, Calendar, Drive, Slides, Tasks — one OAuth, six services |
| **Docs Comments** | Drop inline comments anchored to a text range in a Google Doc |
| **Email (IMAP)** | Read inbox via Gmail App Password / Zoho / custom IMAP — read-only by default |
| **Telegram** | Chat with the assistant via a Telegram bot (bot restarts ~5s on activation) |
| **Trello** | Read tasks, comment, manage labels, move cards between columns |
| **GitHub** | Read repos, issues, pull requests (official GitHub MCP) — read-only by default |
| **Substack** | Read posts, archives, authors, Notes, comments (no credentials); optional sign-in unlocks drafting, editing, images, publishing/scheduling and Notes — publishing off by default |
| **X (twitterapi.io)** | Read tweets, profiles, replies, followers, mentions |
| **Grok (xAI)** | Live X + web search — real-time takes, breaking news, fact-checks |
| **OpenAI (GPT)** | Ask GPT models (gpt-5, gpt-4.1, o-series) for second opinions |
| **Gemini** | Ask Gemini 2.5 pro/flash for second opinions, long-context |
| **Gemini Image** | Generate images via Imagen 3, edit via Gemini 2.0 Flash |
| **Seedream (BytePlus)** | Image generation (Seedream 4.5) + editing / background removal |
| **E-Signature (SignWell)** | Send documents for e-signature directly from chat |

Step-by-step setup guides further down cover GA4, Google Ads, Shopify, Meta
Ads, and Playwright; the rest are self-explanatory from their in-dashboard
steps.

---

## Why

Before this system, every client redeploy started with "what keys do you
have for me this time?" — Telegram bot tokens, OpenAI/xAI/Gemini API keys,
Shopify Admin credentials, Meta System User tokens, Google Ads developer
tokens, and so on. Each had to be pasted into a per-client `.env` and
shipped through `./deploy.sh`. Every rotation = repeat the loop.

The Integrations dashboard moves that whole flow into the running
workspace: the user sees what's available, follows the on-screen steps to
obtain credentials, pastes them, hits **Activate**. Encryption at rest +
hot-apply mean the next chat turn picks up the new MCP without any process
restart (except Telegram, which gets a 5-second `pm2 restart`).

## Architecture

```
host                                          container                                         process tree
─────────────────────────────────────────     ───────────────────────────────────────────       ─────────────────────────
/srv/<ide>/secrets/                            /run/secrets/integrations.key  (ro)              workspace-api
  integrations.key   (0600 root, generated      ↑ AES-256-GCM master key                          ↳ on PUT/DELETE: encrypt+
   once by deploy.sh)                                                                              store, write config files,
                                                                                                  syncs ~/.claude.json,
/srv/<ide>/integrations-data/                  /home/coder/.integrations-data/  (rw)              optional pm2 restart
  email/accounts.json   (0600)                   email/accounts.json                              ↳ on startup: legacy migration
  google/ga4-credentials.json (0600)             google/ga4-credentials.json
                                                                                                bot.sh (Telegram, PM2)
project-data volume                            /home/coder/project/.integrations/                  ↳ sources $HOME/.<bot>/
                                                 credentials.json   (0600, AES-GCM ciphertext)      integrations.env on every
                                                 audit.log          (0600, append-only JSONL)      restart
```

**Three storage tiers:**

1. **Master key** — owned by host root, mounted read-only into the container. Lives in `/srv/<ide>/secrets/`, deliberately separate from `.env` and from the project tree so the blast radius of any single backup leak is bounded.
2. **Encrypted credentials store** — under `PROJECT_DIR/.integrations/credentials.json`. Each field encrypted with a fresh IV; tampered ciphertext fails to decrypt rather than leaking garbage. `HARD_HIDDEN` so the file API never returns it even with `?include_hidden=true`.
3. **Config files** — credentials that an MCP reads as a path (email accounts.json, GA4 service-account JSON) get materialised under `/home/coder/.integrations-data/` (writable mount). Atomically written, mode 0600, deleted on remove.

## Remote-MCP one-click OAuth

The one-click providers in the first table above don't ship a per-provider MCP —
they're **official provider-hosted remote MCP servers**, wired through a small
OAuth broker inside workspace-api. This is what makes "add an integration"
a sign-in popup instead of a key-paste, and — crucially — adds **zero setup for
whoever deploys the product**: no operator has to register an OAuth app anywhere.

**How a connect flows:**

1. **Catalog entry** carries `mcp: { type: "http", url, allowedHosts }` and a
   single field of type `remote-mcp-oauth`. That's the whole declaration — no
   client IDs, no secrets.
2. **Start** — admin clicks Activate → popup to
   `GET /api/integrations/:id/oauth/start`. The broker
   (`lib/integrations/oauth.js`, on the MCP SDK's `auth`) runs RFC 9728/8414
   **discovery** from the MCP URL, then **Dynamic Client Registration** (RFC 7591)
   against the provider's authorization server — registering *this client's own
   domain* as the redirect URI on the fly. PKCE (S256) throughout.
3. **Callback** — the provider redirects to `GET /api/integrations/oauth/callback`,
   a **public** route (the provider redirect carries no session cookie) that is
   `state`-validated. The broker exchanges the code, encrypts the tokens into the
   same credentials store, and `postMessage`s the opener so the dashboard flips
   the tile to Active without a reload.
4. **Runtime** — `syncMcpServers` writes an `.mcp.json`/`~/.claude.json` entry
   with `type: "http"` and a `headersHelper` (`bot/mcp-auth-helper.sh`). Claude
   Code calls the helper to fetch the current bearer from the loopback route
   `GET /api/internal/mcp-token/:id`, and **re-runs it once on a 401** (Claude
   Code ≥ 2.1.193), so a silently-expired token refreshes mid-session. The broker
   refreshes with the stored refresh token on demand.

**Egress split.** workspace-api has no direct outbound; the broker's OAuth
fetches (discovery, registration, token) go through the egress **OPEN** listener
`egress-proxy:3130` (any public host, RFC1918 blocked) via an undici `ProxyAgent`
set as the SDK's `fetchFn`. The bot's actual MCP connection is gated by the
**strict** allowlist — so every one-click entry must list its MCP host in
`mcp.allowedHosts` (that's the only host the bot dials; the auth-server host can
differ and still works, because broker fetches use the open listener).

**Gotchas** that are easy to trip on:

- The broker **must use the global `fetch`** with `{ dispatcher }`, not undici's
  `fetch` — the SDK does `input instanceof Response` in `parseErrorResponse`, and
  an undici `Response` fails that check, surfacing as `"[object Response]"` on any
  non-2xx.
- A `registration_endpoint` existing in discovery **≠ open DCR**. Verify each
  provider by POSTing a registration against the *production* redirect URI before
  shipping it — some gate DCR to whitelisted partners and will 4xx.
- `pm2 restart` does **not** reload the catalog JSON; a catalog change needs a
  `docker restart` of the container.

**When a hosted MCP doesn't exist** (Shopify Admin, Google Ads) or the provider
forces pre-provisioned creds (Google Workspace's own GCP project), the
integration stays in the second table — a bring-your-own-credentials MCP.

## Catalog

`ide-template/workspace-api/integrations.catalog.json` is the single source
of truth for which integrations exist, what they need, and how to wire them
into Claude. The dashboard renders one card per entry; the runtime
translates each entry into a `mcpServers` block in `~/.claude.json`.

Each catalog entry declares:

| Field | Purpose |
|---|---|
| `id` | Slug used in API paths (`/api/integrations/<id>`) and in the encrypted store. Must match the regex `[a-z0-9_-]+`. |
| `label` | Human-readable name shown in the dashboard. |
| `logo` | Path under `frontend/public/` (e.g. `/integrations/grok.svg`). Vite's `BASE_URL` is prepended at runtime. |
| `description` | One-line summary on the tile. |
| `category` | Grouping label (`ai`, `commerce`, `marketing`, `messaging`). Currently informational only. |
| `multi` | `true` for multi-account integrations (Email IMAP). Store keeps `items[]` instead of `fields`. |
| `itemLabel`, `minItems` | Multi-only: shown in the modal accordion ("Account 1", "Account 2", …). |
| `fields[]` | Per-credential field declarations — see below. |
| `steps[]` | Numbered instructions shown in the activation modal's left column. |
| `mcp` | How to spawn the MCP server (or which long-running process to restart). See "Runtime side" below. |
| `comingSoon` | Marks the entry as visible-but-disabled in the dashboard. |
| `process` | `'telegram-bot'` for the long-running PM2 case — triggers `pm2 restart` on activate/remove. |

### Field types

```jsonc
{
  "name":        "GEMINI_API_KEY",       // env-var name passed to the MCP
  "label":       "API key",              // form label
  "type":        "secret",               // "text" | "secret" | "json" | "select" | "storage-state-json" | "docs-comments-browser-login"
  "placeholder": "AIza...",
  "helper":      "From Google AI Studio.",
  "optional":    true,                   // skipped from required-field check
  "default":     "primary",              // initial form value
  "showIf":      { "EMAIL_PROVIDER": "custom" },  // conditional visibility
  "options":     [{ "value": "gmail", "label": "Gmail" }, ...]  // select only
}
```

`showIf` is evaluated on both the client (hides the field in the form) and
the server (skips required-check) so a malicious client bypassing the form
can't slip a `custom` provider through without a host.

**Specialised field types** beyond plain text/secret/json/select:

| Type | Purpose | Storage path |
|---|---|---|
| `storage-state-json` | Paste a Playwright [`storageState()`](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state) JSON (cookies + origins). Frontend renders a drop-zone + textarea with live preview ("17 cookies on 3 domains"). Server filters cookies by per-integration domain allowlist, hashes the surviving set into `.<id>-audit.jsonl`, then encrypts. Legacy — superseded by `docs-comments-browser-login` for everything except programmatic-export flows. |
| `docs-comments-browser-login` | Renders a "Connect to Google" button. Click → wsapi spawns an Xvfb + chromium + x11vnc + websockify stack, frontend opens a modal with an embedded `<iframe>` running [noVNC](https://novnc.com). Operator logs into Google normally (incl. 2FA, security keys). "Done" gracefully kills chromium so the profile flushes to disk. Field's stored value is just a marker (`"ok"`); the real session lives in `/var/wsapi-store/docs-comments-profile/`. See "Interactive browser login" section below. |

### MCP wiring

```jsonc
"mcp": {
  "command":    "node",
  "args":       ["{appsDir}/grok-mcp/index.js"],
  "name":       "grok",                                 // mcpServers key in ~/.claude.json
  "envMap":     { "XAI_API_KEY": "XAI_API_KEY" },       // catalog-field → env-var
  "extraEnv":   { "MODEL": "grok-3-latest" },           // static defaults
  "inheritEnv": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],  // copied from process.env
  "writeFiles": [
    { "format": "shell-env", "path": "{home}/.{bot}/integrations.env", "fields": [...], "mode": 384 },
    { "fromField": "GA4_CREDENTIALS_JSON_CONTENT", "path": "{dataDir}/google/ga4-credentials.json", "mode": 384 },
    { "format": "email-accounts", "path": "{dataDir}/email/accounts.json", "mode": 384 }
  ]
}
```

**Bundle MCPs** — `mcp.services: [{ name, command, args }, ...]` on a
catalog entry tells the runtime to spawn **multiple** MCP processes from
**one** integration record. Used for the Google Workspace bundle: a
single tile + single OAuth refresh token activate seven MCPs at once
(Docs, Sheets, Calendar, Drive, Gmail, Slides, Tasks). The same `envMap`
is applied to every service in the bundle, so all seven processes get
the same `GDOCS_*` + `GWORKSPACE_ALLOW_WRITE` env. Removing the
integration wipes all seven `mcpServers` entries in one go.

**Path placeholders** resolved at spawn time by `resolvePath()` in
`workspace-api/lib/integrations/runtime.js`:

| Token | Resolves to |
|---|---|
| `{appsDir}` | `MCP_APPS_DIR` env, default `/opt/ide/apps` |
| `{dataDir}` | `INTEGRATIONS_DATA_DIR` env, default `/home/coder/.integrations-data` |
| `{home}` | `HOME` env, default `/home/coder` |
| `{bot}` | `BOT_NAME` env (lowercased), default `bot` |

**Write formats** for `writeFiles[]`:

- `fromField: "<NAME>"` — the raw decrypted value of one field, dumped as-is.
- `format: "shell-env"` — POSIX-source-able env file, used by Telegram (`bot.sh` sources it before reading `$TELEGRAM_BOT_TOKEN`).
- `format: "email-accounts"` — multi-account → builds `[{id, host, port, secure, user, pass}, ...]` from per-item flat fields, applies provider preset for Gmail / Zoho EU / Zoho US.
- `format: "storage-state"` — validates the JSON shape (cookies[] required, origins[] optional) and writes the Playwright-compatible storageState file the MCP can pass to `browser.newContext({ storageState })`. Paired with the `storage-state-json` field type. Per-integration cookie-domain allowlist in `workspace-api/lib/integrations/storage-state.js` filters out anything outside the integration's scope before encryption.

## Private per-operator integrations: `integrations.catalog.local.json`

`workspace-api/integrations.catalog.local.json` is gitignored. At wsapi
startup, `lib/integrations/catalog.js` reads it if present and merges its
`integrations[]` with the main catalog (last-write-wins on id collision).

The mechanism exists so an operator can ship an integration that's only
relevant to ONE deployment without it showing up everywhere: a fork wrapper
stages a catalog fragment into `integrations.catalog.local.json` (and the MCP
source into `apps/`) before delegating to the shared deploy, and every other
client's wrapper carries a matching `rm` cleanup so it never leaks into another
client's image.

No integration uses this path today — it used to host an early
"reviewer" integration, which has since been promoted to the first-class,
ship-to-everyone **Docs Comments** integration (now in the main catalog). The
hook is kept for any future per-operator-only integration.

Schema-wise the file is a full catalog (`{ integrations: [...] }`), not a
patch — the merge is a simple by-id union.

## Interactive browser login (noVNC)

For integrations that need a logged-in session against a third-party
website where API access doesn't exist (the canonical case: Google Docs
inline anchored comments — Drive Comments API doesn't expose the UI
state needed to position them). The cookie-paste flow that preceded this
broke against Google's session anti-fraud heuristics — fingerprint
mismatch between the operator's local Chrome (where cookies were
exported) and our headless Chromium meant the SID was rejected at first
navigation.

The new flow keeps the session inside the container from end to end. The
chromium that the operator logs into IS the chromium the integration's
MCP reuses later via `launchPersistentContext`. Same binary, same flags,
same outbound IP — Google's risk engine sees one device.

**Frontend** — `DocsCommentsBrowserLoginField` in `IntegrationsDashboard.jsx`.
Renders a "Connect to Google" button for any field with
`type: "docs-comments-browser-login"`. The renderer itself is generic — a
planned rename to a plain `browser-login` type would let a second integration
reuse it as-is.

**Backend** — `workspace-api/routes/docs-comments-login.js`:

| Endpoint | Purpose |
|---|---|
| `POST /api/integrations/docs-comments/connect-start` | Spawns the stack: Xvfb `:99`, chromium with `--user-data-dir=/var/wsapi-store/docs-comments-profile`, x11vnc bound to `127.0.0.1:5999`, websockify on `:6080` serving noVNC static assets + WS bridge to x11vnc. Marks the integration active in the store so its egress allowlist hosts apply BEFORE chromium tries to reach Google. Returns the iframe URL. |
| `GET /api/integrations/docs-comments/vnc/*` | HTTP reverse proxy into websockify's `:6080` (serves `vnc.html` + the `core/` JS modules). |
| `WS /api/integrations/docs-comments/vnc-ws` (any path under `/vnc/`) | WebSocket upgrade handler attached to the raw http.Server. Verifies the same JWT-signed session cookie `attachActor` uses for HTTP routes, then pipes to localhost websockify. Express middleware can't see upgrade events; the handler is wired in `workspace-api/index.js`. |
| `POST /api/integrations/docs-comments/connect-done` | SIGTERMs chromium (graceful — flushes the profile), then tears down x11vnc / websockify / Xvfb. |

**Container infra** (in image, no per-integration toggle):

- `Dockerfile` apt installs `xvfb x11vnc websockify novnc` (~50 MB).
- `entrypoint.sh` root-block creates `/var/wsapi-store/docs-comments-profile`
  with mode 2770 + group `workspace` so wsapi (1001, writes during
  login) and mcp (1002, reads during tool calls) both have rwx via
  group membership. The setgid bit makes chromium's writes inherit
  group=workspace.
- `frontend/nginx.conf` has a dedicated `location /api/integrations/
  docs-comments/vnc` block that preserves `Upgrade` + `Connection: upgrade`
  headers (the general `/api/` block strips them via `Connection ''`).

**MCP side** — the integration's MCP uses Playwright's
`chromium.launchPersistentContext(PROFILE_DIR, ...)` against the same
profile dir. Cookies, localStorage, IndexedDB, device-bound credentials
all carry through. No `addCookies()` shim, no field-shape normalisation,
no domain filter — the profile IS the session as chromium left it.

**Threat model** — same as the cookie-paste flow it replaces:
- Container compromise = Google session theft. Profile dir under
  `/var/wsapi-store/` is persistent volume; reads gated by group
  `workspace` membership, so coder uid 1000 cannot read it.
- The noVNC bridge is auth-gated by the existing `IDE_ALLOWED_EMAILS`
  chain (nginx `auth_request /auth/verify` + JWT cookie check on the
  WS upgrade). Without that gate an unauth'd attacker on the public
  URL could trivially log into the embedded chromium with your saved
  passwords and steal whatever account.
- Operator-recommended: a dedicated Google account (e.g.
  `docs-comments-bot@yourdomain`) with explicit access only to the docs the
  bot needs. Personal-Gmail use is supported but logs the host's IP +
  fingerprint as a trusted device upstream.

## Post-broker constraints for MCP authors

The Phase-2 credential broker + Phase-3 uid split + egress sidecar pivot (2026-05) changed eight invisible assumptions every MCP used to be able to make. New MCPs that ignore them will silently fail in production. Read this whole table before writing your first `apps/<your-mcp>/index.js`.

| Change | What breaks if you ignore it |
|---|---|
| MCPs run as uid 1002 (`mcp`), not 1000 (`coder`) | `HOME` is still `/home/coder` (inherited from PM2) but you have **no write access** there. Don't try to write to `~/.cache`, `~/.npm`, `~/.config`. Use `/tmp/` (tmpfs, world-writable) or `PROJECT_DIR/<your-integration>/` (group `workspace` rw via setgid). |
| Credentials are NOT in `process.env` at spawn time | `process.env.SHOPIFY_CLIENT_SECRET` is empty until you call the broker. Top of `index.js`: `import { loadCredentials } from '../_shared/broker-client.js'; await loadCredentials(process.env.BROKER_INTEGRATION_ID);` BEFORE any other code that reads creds. |
| `apps/_shared/broker-client.js` brings npm deps | Today `undici` (for the global ProxyAgent). Anything broker-client pulls in is installed once in `apps/_shared/node_modules/` — Node's resolver walks up from your MCP and finds it. **Do not duplicate** the dep in your `apps/<your-mcp>/package.json` (avoid version drift). |
| All outbound traffic goes through `egress-proxy:3129` (HTTP CONNECT) | `fetch()` / `undici` / `axios fetch-mode` work out-of-box (broker-client sets the global ProxyAgent). **Raw TCP libs (IMAP, SMTP, MQTT, redis, postgres) need explicit `proxy: process.env.HTTPS_PROXY` in their config** — see `apps/email-mcp/index.js` for the imapflow + nodemailer pattern. |
| `bot-net` is IPv4-only | If your lib pre-resolves the destination hostname locally (e.g. via libc `getaddrinfo`), AAAA results dial into a void. Set `family: 4` in the lib config when possible; the `NODE_OPTIONS=--dns-result-order=ipv4first` env we set per-MCP covers Node's `dns.lookup` path. |
| DNS rotation + DNS-snoop in egress-proxy | The proxy snoops its own DNS forwarder responses to learn IP→hostname mappings. As long as your lib resolves DNS via the container resolver (default for libc), CONNECT to the resolved IP is automatically allowed. **If your lib does DoH or queries an external resolver directly, you'll bypass our snoop** and get 403 at CONNECT — file a bug or pin the lib to system resolver. |
| `mcp.allowedHosts` is the only outbound surface | Add every hostname your MCP dials to the catalog entry's `mcp.allowedHosts[]`. Wildcards: `*.myshopify.com`. Per-tenant placeholders: `{{FIELD_NAME}}` (resolves from active store fields). If you forget, the proxy returns 403 and your MCP silently retries forever. |
| Headless services + writable profile dirs | Libs that spawn external processes (Chromium, ImageMagick, ffmpeg) often want to create profile/cache dirs at runtime. They default to `$HOME/.cache` or some baked-in path. Always pass an explicit writable dir (`/tmp/<your-mcp>-data/`) — see Playwright's `--user-data-dir` in `entrypoint.sh`. |

## Adding a new MCP — checklist

A working MCP in the post-broker world is six steps. Follow them in order; each maps directly to one of the constraints above.

1. **Skeleton**: `apps/<your-mcp>/{index.js, package.json}`. ES module (`"type": "module"`), `@modelcontextprotocol/sdk` dep, stdio transport. Mirror an existing MCP like `apps/trello-mcp/` for layout.

2. **Top of `index.js`** — load credentials before anything else:

    ```js
    import { loadCredentials } from '../_shared/broker-client.js';
    await loadCredentials(process.env.BROKER_INTEGRATION_ID);
    // `process.env.YOUR_API_KEY` is populated now; use as usual.
    ```

3. **Catalog entry** in `workspace-api/integrations.catalog.json`:

    ```jsonc
    {
      "id": "your-thing",
      "label": "Your Thing",
      "logo": "/integrations/your-thing.svg",
      "fields": [ /* user-supplied creds */ ],
      "steps": [ /* setup instructions */ ],
      "mcp": {
        "name": "your-thing",
        "command": "node",                                          // mcp-runner ignores this — it's templated
        "args": ["{appsDir}/your-thing-mcp/index.js"],
        "envMap": { "YOUR_FIELD": "YOUR_API_KEY" },
        "allowedHosts": ["api.your-thing.com", "*.cdn.your-thing.com"]
      }
    }
    ```

4. **If you use raw TCP** (IMAP/SMTP/MQTT/etc.) — pass proxy explicitly:

    ```js
    const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
    new TheLib({ host, port, proxy: PROXY_URL || undefined });
    ```

5. **If you write files at runtime** — never to `$HOME`, only to `/tmp/<your-mcp>-data/` or `${PROJECT_DIR}/<your-integration>/`. Create the dir at MCP startup with `fs.mkdirSync({ recursive: true })`; don't assume it exists.

6. **Deploy entry** in `ide-template/deploy.sh` — scp your `index.js` + `package.json` to the remote build context. Dockerfile LAYER 2d picks it up automatically as long as you copy with `COPY apps/your-thing-mcp /opt/ide/apps/your-thing-mcp` (already templated — bump only if you add unusual deps).

After your first deploy, verify with `docker exec <ide> su -c "claude mcp list" coder` — your MCP should show `✓ Connected`. If `✗ Failed to connect`, run the spawn manually as the `mcp` user (`docker exec -u mcp ... /usr/local/bin/mcp-runner your-thing 2>&1`) to see the actual error — claude doesn't surface MCP startup stderr.

## API

All endpoints live under `/api/integrations/*`, gated by nginx
`auth_request /auth/verify` (same as the rest of the workspace API).

### `GET /api/integrations`

Returns the full catalog merged with the active state for each entry:

```jsonc
{
  "ready": true,                               // false → 503 from PUT/DELETE
  "readyError": null,                          // diagnostic when not ready
  "integrations": [
    {
      "id": "grok",
      "label": "Grok (xAI)",
      "logo": "/integrations/grok.svg",
      "description": "...",
      "fields": [...],
      "steps": [...],
      "mcp": {...},                            // catalog passthrough
      "active": true,                          // store has creds for this id
      "activatedAt": "2026-05-02T10:30:00Z",
      "credentialSummary": { "length": 64, "last4": "a3f2" },  // single
      "itemCount": null                        // number for multi=true integrations
    },
    ...
  ]
}
```

`credentialSummary` is computed by decrypting the primary field server-side
and returning only `{length, last4}`. Plaintext never crosses the wire.

### `PUT /api/integrations/:id`

Activates an integration. Body:

```jsonc
// Single-set integration:
{ "fields": { "XAI_API_KEY": "xai-..." } }

// Multi (email-imap):
{
  "items": [
    { "fields": { "EMAIL_PROVIDER": "gmail", "EMAIL_USER": "...", "EMAIL_PASS": "..." } },
    { "fields": { "EMAIL_PROVIDER": "zoho", ... } }
  ]
}
```

Responses:

- `200 { ok: true, activatedAt, credentialSummary, restarting }` — `restarting: true` for Telegram.
- `400` — missing required field, `comingSoon` integration, or invalid body.
- `404` — unknown id.
- `409` — already active. Rotate via `DELETE` then `PUT`.
- `503` — encryption not configured. Surface admin-side fix message.

Rate-limited 5/min/IP via in-memory sliding window.

### `PATCH /api/integrations/:id`

Partial update of an active integration **without rotating credentials**.
Body shape mirrors the catalog field declarations:

```jsonc
// Single-set integration:
{ "fields": { "EMAIL_ALLOW_SEND": "true" } }

// Multi (email-imap) — `globalFields` propagates to every account:
{ "globalFields": { "EMAIL_ALLOW_SEND": "true" } }
```

Used by the **Settings** modal (gear icon on every active tile) so the
user can flip a `globalForMulti` permission toggle (e.g. "Allow sending
email" on or off) without going through `DELETE` + `PUT` and re-pasting
their IMAP password. Only catalog-declared field names are accepted;
unknown names are silently dropped. Empty string values are ignored
(treated as "not provided").

Always triggers `pm2 restart` after a successful PATCH. Most settings
edits don't move the `mcpServers` JSON — env vars stay the same and only
the `writeFile` outputs (e.g. `accounts.json`) change — and bots cache
those outputs at process start, so the diff-only restart heuristic
PUT/DELETE uses doesn't apply here.

### `DELETE /api/integrations/:id`

Wipes the encrypted credentials, deletes any `writeFiles` outputs, removes
the managed `mcpServers` entry, and triggers `pm2 restart` for Telegram.

### `GET /api/skills`

Sibling endpoint that powers the Skills dashboard — see
[`docs/SKILLS.md`](SKILLS.md) for usage. Returns project + global skills
merged with `origin: 'project'|'global'` and the description from each
SKILL.md frontmatter.

---

## Admin onboarding

### New clients

Zero extra steps. Run `./deploy.sh` as usual:

1. The script generates `/srv/<ide>/secrets/integrations.key` (32-byte hex via `openssl rand`) on first boot, mode 0600 owned by root.
2. Creates `/srv/<ide>/integrations-data/` owned by uid 1000 (the container's `coder` user), mode 0700.
3. `docker-compose.yml` already has the bind mounts for both.

The user opens **Integrations** in the workspace, follows the on-screen
steps for whatever they want to activate, and they're done.

### Migrating existing clients

For pre-2026-05 clients (clients that already have credentials in `.env`),
**one redeploy** is enough:

```bash
cd clients/<client> && ./deploy.sh code-server
```

What happens:

1. New code lands (workspace-api with auto-migration, updated bot.sh, integrations dashboard).
2. Container starts → workspace-api detects encryption-ready, runs `migrateFromLegacy()`:
   - For every catalog entry, if all required env vars are set in `process.env`, encrypt + store.
   - For email-imap, parse the legacy `/home/coder/.email/accounts.json` (if mounted) and migrate every account into the multi-store form, mapping host → provider preset.
   - For ga4, copy the JSON from `GA4_CREDENTIALS_JSON` file path into the encrypted `GA4_CREDENTIALS_JSON_CONTENT` field.
3. Migration is idempotent — `store.isActive(id)` skips anything the user already activated via the UI, so subsequent restarts are no-ops.
4. After a non-zero migration, workspace-api logs a **PLAINTEXT CLEANUP** banner to PM2 stderr listing every env var that was just encrypted. Operator should remove those vars from `clients/<client>/.env` and redeploy `code-server` to drop the plaintext copy from the container env. Until they do, both copies coexist (the encrypted store is preferred at read-time).

The user opens **Integrations** and sees everything they had configured
already **Active** with `••••<last4>` summaries. No re-entry, no SSH.

The legacy env path keeps working in parallel — `entrypoint.sh` still wires
nano-banana / shopify / meta / etc. into `mcpServers` from env vars at
container boot. workspace-api adds its own managed entries on top
(marked with `_managed_by_workspace_api: true`); manual entries are
preserved untouched.

### Reading the cleanup banner

Sample output from `pm2 logs workspace-api` after a first redeploy with
the new code:

```
[migrate] activated grok from legacy source (XAI_API_KEY)
[migrate] activated shopify from legacy source (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)
[migrate] activated email-imap from legacy source (<file:/home/coder/.email/accounts.json>)
[migrate] ──────────────────────────────────────────────────────
[migrate] PLAINTEXT CLEANUP — credentials are now encrypted, but
[migrate] the originals are still present on disk. Prune them:
[migrate]   from clients/<client>/.env, remove these env vars:
[migrate]     - SHOPIFY_CLIENT_ID
[migrate]     - SHOPIFY_CLIENT_SECRET
[migrate]     - SHOPIFY_STORE_DOMAIN
[migrate]     - XAI_API_KEY
[migrate]   from the host, the following files can be deleted:
[migrate]     - /home/coder/.email/accounts.json
[migrate]   then `./deploy.sh code-server` to apply.
[migrate] ──────────────────────────────────────────────────────
[migrate] done — migrated=3 already-active=0 failed=0
```

The encryption key never goes near `.env` — only the integration field
values do. Removing the listed vars + redeploying drops the plaintext
copy from the container env without affecting the encrypted store.

### Backups

The master key is **deliberately excluded from `restic-backup.sh`**. Snapshots contain the ciphertexts (`.integrations/credentials.json`, `.platform.token.enc`, plus materialised plaintexts under `/srv/<ide>/integrations-data/` for MCPs that need a real file on disk like email and GA4) but NOT `/srv/<ide>/secrets/integrations.key`.

Two separate compromise vectors are required to read any credential from a snapshot:

| Compromise | Result |
|---|---|
| B2 bucket only (or RESTIC_PASSWORD only) | Restic AES layer broken → ciphertexts visible, but no master key → unreadable |
| Master key only (e.g. `cat /srv/<ide>/secrets/integrations.key`) | Key in hand, but no ciphertexts → nothing to decrypt |
| Both (host shell access AND B2 key) | Game over — all credentials decryptable |

If you want disaster-recovery for the key itself, store it **separately** — password manager, hardware token, an out-of-band repo your B2 bucket admin doesn't know about. Losing the key means every user re-enters their integrations + Claude OAuth via the wizard; no other data is affected.

The data directory `/srv/<ide>/integrations-data/` contains plaintext
config files (email passwords, GA4 service-account JSON) materialised from
the encrypted store. These DO go into restic snapshots (an MCP needs a
real file path), so treat the snapshot itself as sensitive — restic
encrypts everything with `RESTIC_PASSWORD`, but `RESTIC_PASSWORD` lives in
`~/.workspace-admin/restic.env` on the host.

### Key rotation

```bash
# On the host:
ssh root@<server> "
  set -e
  KEY=/srv/<ide>/secrets/integrations.key
  # Decrypt all current creds with the old key first — clients re-enter
  # everything if you skip this step.
  # (script TBD; for now, rotation = ask users to remove + re-activate)
  openssl rand -hex 32 > \$KEY.new
  mv \$KEY.new \$KEY
  chmod 600 \$KEY
  chown 1000:1000 \$KEY
"
docker compose restart code-server
```

After rotation, every integration shows as **Inactive** until users re-enter credentials from the dashboard. The Claude OAuth token also has to be re-pasted via the wizard (admin re-entry — admin-only post-onboarding).

A proper rotation script that decrypts with the old key + re-encrypts with
the new key is on the roadmap; for now the simplest path is "remove key,
ask each user to re-enter their integrations".

## User flow

The dashboard sits in the sidebar under **Integrations**.

1. **Catalog view** — grid of tiles (`auto-fill, minmax(260px, 1fr)`), split into:
   - **Active** — already configured (green pill, masked summary, **Remove** button).
   - **Available** — not yet active (white tile, **Activate →** button).
   - Coming-soon entries appear with a grey "Soon" badge and disabled button.

2. **Activate modal** — wide two-column layout:
   - Left column: numbered "How to get your key" steps with vertical connector line. Pulled from `catalog.steps[]`.
   - Right column: form fields. Multi-account integrations get an accordion with **+ Add another account** at the bottom.
   - Footer: encryption note + Cancel / Activate.

3. **Remove dialog** — confirms, then `DELETE`s. Wipes ciphertext, removes config files, updates `mcpServers`. The bot is restarted automatically when the `mcpServers` set actually changed (or when Telegram credentials were touched). Idempotent re-saves with no diff skip the restart so the active session stays alive.

   Restart cost: ~5–10 s offline + the bot's `claude --channels` session loses in-memory conversation context (memory MCP entries persist). Telegram message history on the user side is unaffected — anything sent during the restart window is queued by Telegram and replayed once the bot reconnects.

4. **Settings modal** — gear icon on every active tile. Opens a slim modal with just the integration's `globalForMulti` permission toggles (today: Email's "Allow sending"). Submitting calls `PATCH` with the changed fields — credentials stay put, only the writeFile outputs are re-materialised, and the bot is restarted so cached configs reload. The user never re-enters their password to flip a permission.

5. **No edit of secrets by design** — to rotate a *credential* (password, API key), the user still **Remove**s and **Activate**s again. The Settings modal is permission-only; secret rotation goes through the same audit trail (`remove` + `activate` events) it always did.

## Per-plugin quick reference

| Plugin | Type | Required fields | Notes |
|---|---|---|---|
| **Grok (xAI)** | MCP | `XAI_API_KEY` | xAI Responses API (`api.x.ai/v1/responses`) with optional live X (Twitter) and web search. Single tool `ask_grok` accepts `x_search`, `web_search`, `x_handles`, `from_date`, `to_date`. Default model `grok-3` (override via `XAI_MODEL`). |
| **Gemini Image** | MCP | `GEMINI_API_KEY` | Imagen 3 + Gemini 2.0 Flash. Output → `project/generated/`. |
| **Seedream (BytePlus)** | MCP | `BYTEPLUS_API_KEY` | Seedream 4.5 + Seededit. Output shared with Gemini. |
| **SignWell** | MCP | `SIGNWELL_API_KEY` | E-signature API. Tools: `send_document` (PDF + recipients → draft or send), `get_document`, `list_documents`, `send_reminder`, `get_completed_pdf`. |
| **Telegram** | PM2 | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ALLOWED_IDS` (opt) | Long-running bot. Activate triggers `pm2 restart <bot>` (~5 s). `bot.sh` sources `$HOME/.<bot>/integrations.env` written via `format: shell-env`. |
| **Shopify** | MCP | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_APP_NAME` (opt, default `aria-mcp`) | OAuth Client Credentials Grant inside `shopify-mcp`. |
| **Meta Ads** | MCP | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_PAGE_ID/IG/BUSINESS` (opt) | System User token, doesn't expire. |
| **Google Ads** | MCP | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_REFRESH_TOKEN` (opt) | `GOOGLE_CLIENT_ID/SECRET` inherited from container env. |
| **Email (IMAP+SMTP)** | MCP | provider-aware multi-account form + workspace-level `EMAIL_ALLOW_SEND` toggle | Multi-account UI; serialises to `accounts.json` under `{dataDir}/email/`. **Read** (IMAP) is always available. **Write** (SMTP send + draft) is gated by the workspace-level "Allow sending" toggle in the Permissions panel — defaults OFF, flippable from the Settings modal (no credential re-entry). When OFF, the MCP can compose drafts but `send_email` returns "sending disabled". Existing pre-toggle users get OFF by default until they opt in. |
| **GA4** | MCP | `GA4_PROPERTY_ID`, `GA4_CREDENTIALS_JSON_CONTENT` | JSON paste; `ga4-mcp-server` (pip-installed in Dockerfile). |
| **Trello** | MCP | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARDS` (opt) | Boards/lists/cards via `api.trello.com/1`. `TRELLO_BOARDS` accepts URLs or short IDs, optionally with friendly names (`acme:URL,personal:URL`). Tools: read cards/lists (incl. label objects on `get_card`), comment, label, move between columns. |
| **Google Workspace** | MCP bundle | `GDOCS_CLIENT_ID`, `GDOCS_CLIENT_SECRET`, `GDOCS_REFRESH_TOKEN`, plus workspace toggle `GWORKSPACE_ALLOW_WRITE` | Single tile + single OAuth refresh token unlock six MCPs at once: **Docs** (read/append/replace), **Sheets** (cells, ranges, append, update, create), **Calendar** (events list/CRUD), **Drive** (search/download/export/upload/share/trash, full comment lifecycle: **list_comments** with `quoted_text` + replies, **reply_comment**, **resolve_comment**, **delete_comment** — all over the Drive API; the only comment op NOT here is range-anchored *adding*, which lives in the separate Docs Comments integration), **Slides** (decks, slides, replace), **Tasks** (lists + items). Per-user OAuth (Web client + OAuth Playground); refresh token needs six scopes (documents/drive/spreadsheets/calendar/presentations/tasks). The workspace-level `GWORKSPACE_ALLOW_WRITE` toggle (Settings cog on the active tile) gates *every* write across the bundle — defaults **On**, flippable from the cog without re-pasting credentials. Activation auto-installs six skill playbooks (gdocs/gsheets/gcalendar/gdrive/gslides/gtasks) that share the integration's logo. |
| **Docs Comments** | MCP (`docs-comments-mcp`) | none in form — populated via "Connect to Google" embedded noVNC | Drives a logged-in chromium against Google Docs to drop inline comments at **anchored text ranges** — the one comment op the Drive API can't do. One tool: `add_comment`. Reply / resolve / delete / list of *existing* comments is handled over the Drive API by the **Google Workspace** integration (`mcp__gdrive__*`), not here. Activated via the `docs-comments-browser-login` field type (see "Interactive browser login" above); session persists in `/var/wsapi-store/docs-comments-profile/`. First-class, shipped to every client. |
| **X (Twitter)** | MCP | `TWITTERAPI_IO_KEY` | Read-only tier via [twitterapi.io](https://twitterapi.io) — no X account credentials required. Tools: get tweet, user profile, mentions, search. |

> Field names below are the dashboard form names. The end-user pastes them through the **Integrations** dashboard — no `.env` editing or redeploy. Where guides below say "Update `.env`" or "Step N — Deploy", read that as "paste into the dashboard form, click Activate".

## Per-plugin setup details

## Google Analytics 4 — setup guide

GA4 gives Claude (both in IDE and Telegram bot) access to real analytics data: traffic, events, conversions, user behavior. Setup requires a Google Cloud service account.

### Step 1 — Get your GA4 Property ID

1. Go to [analytics.google.com](https://analytics.google.com)
2. Admin → Property Settings
3. Copy the **Property ID** — it's a plain number, e.g. `123456789`
   - This is NOT the Measurement ID (`G-XXXXXXXX`) or Google Tag (`GT-XXXXXXXX`)

### Step 2 — Create a service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. IAM & Admin → Service Accounts → **Create Service Account**
3. Name it (e.g. `mcp-<client>`) — no special roles needed at this step
4. Keys → **Add Key** → Create new key → **JSON** → download the file

### Step 3 — Grant access in GA4

1. In GA4 → Admin → **Account Access Management**
2. Add the service account email (e.g. `mcp-acme@acmeide.iam.gserviceaccount.com`)
3. Role: **Viewer**

### Step 4 — Add credentials to the client

Place the downloaded JSON in the client's `.google/` folder (gitignored):
```
clients/<your-client>/.google/<name>.json
```

### Step 5 — Update `.env`

```bash
GA4_PROPERTY_ID=123456789
GA4_CREDENTIALS_JSON=/home/coder/.google/<name>.json
```

### Step 6 — Update `clients/<your-client>/deploy.sh`

Add the file upload before the template deploy call:
```bash
if [ -f "$FORK_DIR/.google/<name>.json" ]; then
    ssh -o StrictHostKeyChecking=no "$HETZNER_HOST" "mkdir -p /home/coder/.google"
    scp -o StrictHostKeyChecking=no "$FORK_DIR/.google/<name>.json" \
        "$HETZNER_HOST:/home/coder/.google/<name>.json"
fi
```

This uploads the file to `/home/coder/.google/` on the host. The `docker-compose.yml` mounts that directory into the container as a read-only bind mount (`/home/coder/.google:/home/coder/.google:ro`), making the file accessible at the path set in `GA4_CREDENTIALS_JSON`.

### Step 7 — Deploy

```bash
cd clients/<your-client> && ./deploy.sh code-server
```

### Verify

Ask Claude: *"What tools do you have?"* — should list `analytics`.
Or ask directly: *"How many users visited the site yesterday?"*

### Troubleshooting

**"Permission denied" from GA4** — service account not added to GA4 Account Access Management, or wrong Property ID.

**"ga4-mcp-server: command not found"** — pip package not installed. Check Dockerfile has `pip install google-analytics-mcp`.

**Credentials file not found in container** — the file is uploaded to the host at `/home/coder/.google/` and mounted into the container via bind mount in `docker-compose.yml`. Verify: (1) `deploy.sh` uploaded the file, (2) `GA4_CREDENTIALS_JSON` path matches exactly, (3) the bind mount is present in `docker-compose.yml`.

---

## Google Ads — setup guide

Custom internal MCP server (`ide-template/apps/google-ads-mcp/`) built on the `google-ads-api` npm package (v23+). Supports both read and write operations.

### Tools available

| Tool | Description |
|---|---|
| `search` | Run any GAQL query — reports, metrics, search terms, quality scores, conversions |
| `list_accounts` | List accessible customer accounts under the manager |
| `keyword_ideas` | Keyword Planner — volume, competition, CPC estimates for seed keywords |
| `historical_metrics` | Historical search volume and bid ranges for specific keywords |
| `create_campaign` | Create a new campaign with optional geo + language targeting (starts PAUSED) |
| `update_campaign` | Pause, enable, rename, change budget |
| `create_ad_group` | Create an ad group inside a campaign |
| `update_ad_group` | Change ad group status, name, or default CPC bid |
| `create_keyword` | Add a keyword to an ad group (exact/phrase/broad) |
| `update_keyword` | Change keyword status or CPC bid |
| `create_negative_keyword` | Add a negative keyword at campaign or ad group level |
| `create_responsive_search_ad` | Create an RSA with 3–15 headlines (supports pinning) and 2–4 descriptions |
| `update_ad` | Pause, enable, or remove an existing ad |
| `update_budget` | Change a campaign's daily budget |
| `create_callout_assets` | Add callout extensions to a campaign (e.g. "Handmade to Order") |
| `create_structured_snippet` | Add a structured snippet (e.g. Types: Corsets, Lingerie, Silk) |
| `add_audience_target` | Add an audience in observation mode (user_interest or user_list) |

> All tools require OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`). The `google-ads-api` npm package does not support service accounts — OAuth is always required.

### What you need

| What | Where |
|---|---|
| **Developer Token** | [ads.google.com/aw/apicenter](https://ads.google.com/aw/apicenter) — requires a Manager (MCC) account |
| **Customer ID** | Your Google Ads account number without dashes (e.g. `1234567890`) |
| **OAuth Client ID + Secret** | Google Cloud → Credentials → OAuth 2.0 Client ID (Desktop app) |
| **Refresh Token** | Generated once via OAuth consent flow (see Step 3 below) |

### Step 1 — Get a Developer Token

1. Go to [ads.google.com/aw/apicenter](https://ads.google.com/aw/apicenter)
2. Copy the **Developer Token** (22 alphanumeric characters)
3. You must have a **Manager (MCC) account** — the token won't work without one

### Step 2 — Enable Google Ads API in Google Cloud

1. [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Enable APIs
2. Search for and enable: **Google Ads API**

### Step 3 — Set up OAuth (write tools only)

If you only need read access and Keyword Planner, skip to Step 4.

**Create an OAuth 2.0 Client:**
1. Google Cloud Console → APIs & Services → Credentials → Create Credentials → OAuth client ID
2. Application type: **Desktop app**
3. Copy **Client ID** and **Client Secret**

**Generate a Refresh Token:**

Run this one-time script locally (Node.js required):

```bash
npm install google-auth-library
```

```js
// generate-refresh-token.js
import { OAuth2Client } from 'google-auth-library';
import readline from 'readline';

const client = new OAuth2Client(
  'YOUR_CLIENT_ID',
  'YOUR_CLIENT_SECRET',
  'urn:ietf:wg:oauth:2.0:oob'
);

const url = client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/adwords'],
});

console.log('Open this URL:', url);
const rl = readline.createInterface({ input: process.stdin });
rl.question('Paste the code: ', async (code) => {
  const { tokens } = await client.getToken(code);
  console.log('GOOGLE_ADS_REFRESH_TOKEN=', tokens.refresh_token);
  rl.close();
});
```

The script prints your refresh token — copy it to `.env`.

### Step 4 — Update `.env`

```bash
# Required for all tools
GOOGLE_ADS_DEVELOPER_TOKEN=xxxxxxxxxxxxxxxxxxxx
GOOGLE_ADS_LOGIN_CUSTOMER_ID=1234567890

# Required only for write tools (campaigns, ads, keywords)
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_ADS_REFRESH_TOKEN=1//xxxx
```

> Note: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are likely already set if GA4 OAuth is configured — reuse the same values.

### Step 5 — Deploy

```bash
cd clients/<your-client> && ./deploy.sh code-server
```

### Verify

Ask Claude: *"What active campaigns do I have?"* or *"What keywords should I target for [topic]?"*

### Developer Token access levels

By default, a new Developer Token has **Test** status — it only works against test accounts. For real data you need **Basic Access**.

#### Applying for Basic Access

Go to [ads.google.com/aw/apicenter](https://ads.google.com/aw/apicenter) → **Apply for Basic Access**:

| # | Question | Recommended answer |
|---|---|---|
| 1 | Manager account (MCC) ID | Your MCC account number |
| 2 | Contact email | Your company email |
| 3 | Relationship with Google rep? | No |
| 4 | Company website | Your domain |
| 5 | Business model and how you use Google Ads | Internal AI assistant for campaign management and optimization |
| 6 | Design documentation (PDF) | 1–2 page doc describing your tool, data accessed, internal use |

### EU accounts — required field

EU-based accounts (any country in the European Union) require the `contains_eu_political_advertising` field on every campaign. The server sets this automatically to `DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING` — no configuration needed.

### Bidding strategies

| Value passed to `create_campaign` | Google Ads API field | Notes |
|---|---|---|
| `MAXIMIZE_CLICKS` (default) | `target_spend` | Maximizes clicks within budget |
| `MAXIMIZE_CONVERSIONS` | `maximize_conversions` | Requires conversion tracking set up |
| `MANUAL_CPC` | `manual_cpc` | Full manual bidding control |
| `TARGET_CPA` | `target_cpa` | Requires `target_cpa_micros` param (micros, e.g. `5000000` = €5.00) |
| `TARGET_ROAS` | `maximize_conversion_value` | Requires `target_roas` param (ratio, e.g. `3.5` = 350%) |

> In Google Ads API proto, "Maximize Clicks" is the `target_spend` field — there is no `maximize_clicks` field. The tool handles this mapping internally.

### Geo and language targeting

Pass `geo_target_ids` and/or `language_ids` to `create_campaign` to restrict targeting. Both are optional — omit to target all locations and languages.

**Common country IDs:** `2840` USA · `2826` UK · `2276` Germany · `2616` Poland · `2250` France · `2380` Italy · `2724` Spain · `2528` Netherlands · `2040` Austria · `2756` Switzerland

**Common city IDs (EU):** `1006886` London · `1006094` Paris · `1003854` Berlin · `1011419` Warsaw · `1010543` Amsterdam · `1000997` Vienna · `1005493` Madrid · `1008736` Rome · `1003803` Prague · `1007633` Budapest · `1012228` Stockholm · `1010826` Oslo · `9072483` Helsinki · `1001004` Brussels

**Common city IDs (USA):** `1023191` New York · `1013962` Los Angeles · `1016367` Chicago · `1015116` Miami · `1014221` San Francisco · `1027744` Seattle

**Language IDs:** `1000` English · `1030` Polish · `1001` French · `1009` German · `1004` Spanish · `1040` Italian

These are set as `CampaignCriteria` after the campaign is created — this is how the Google Ads API requires it (targeting is not a field on the Campaign object itself).

### Conversion goal

Pass `conversion_goal` to `create_campaign` to set which conversion category the campaign optimises for. This updates the auto-created `CampaignConversionGoal` resource after campaign creation and marks it as biddable.

**Values:** `PURCHASE` · `LEAD` · `SIGNUP` · `PAGE_VIEW` · `CONTACT` · `DOWNLOAD` · `DEFAULT`

Common mapping: e-commerce → `PURCHASE`, lead generation → `LEAD`, brand traffic → `PAGE_VIEW`.

If omitted, Google uses the account-level conversion goals (default behaviour). Set this explicitly when the campaign should optimise for a specific action. Without it, the UI may show "No marketing objective selected".

### Date format

All date fields (`start_date`, `end_date`) use **`YYYY-MM-DD`** format (e.g. `2026-04-16`). The `YYYYMMDD` format shown in the Google Ads UI is not accepted by the API.

### Troubleshooting

**"Developer token not approved"** — token is in Test status. Submit Basic Access application in API Center.

**"Customer not found"** — `GOOGLE_ADS_LOGIN_CUSTOMER_ID` must be digits only, no dashes. `123-456-7890` → `1234567890`.

**Write tools return "OAuth credentials required"** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_ADS_REFRESH_TOKEN` are missing or empty in `.env`.

**`create_campaign` fails with "required field: campaign_bidding_strategy"** — bidding strategy not recognized. Use one of: `MAXIMIZE_CLICKS`, `MAXIMIZE_CONVERSIONS`, `MANUAL_CPC`, `TARGET_CPA`, `TARGET_ROAS`.

**`create_campaign` fails with "required field: contains_eu_political_advertising"** — server is outdated. Redeploy from latest `main`.

**Orphan budgets accumulating** — each failed `create_campaign` call creates a budget before the campaign fails. Use `search` to find and remove them:
```
SELECT campaign_budget.id, campaign_budget.name FROM campaign_budget
WHERE campaign_budget.explicitly_shared = false
```
Then ask Claude to remove the orphan budget IDs.

---

## Shopify — setup guide

Custom internal MCP server (`ide-template/apps/shopify-mcp/`) built on the official Shopify GraphQL Admin API. No third-party packages — full control over what Claude can access.

### Read tools

| Tool | What it does |
|---|---|
| `get_orders` | List recent orders, filter by status |
| `get_order` | Full order details by ID or order number |
| `get_products` | Products with variants, prices, inventory |
| `get_product` | Single product full details |
| `get_collections` | List collections |
| `get_low_inventory` | Variants below a stock threshold |
| `get_sales_summary` | Revenue for today / this week / this month |
| `get_customers` | Recent customers with spend history |
| `get_customer` | Single customer by email or ID |
| `get_fulfillments` | Shipment and tracking info for an order |
| `get_draft_orders` | List draft orders / quotes |
| `get_metafield_definitions` | List available metafield definitions (namespace/key/type) for a resource |

### Write tools

**Products**

| Tool | What it does | Scope |
|---|---|---|
| `create_product` | Create a new product. Auto-publishes if `publish: true` | `write_products` |
| `update_product` | Update title, status, vendor, product type, SEO | `write_products` |
| `delete_product` | Permanently delete a product | `write_products` |
| `publish_product` | Publish to Online Store | `write_products` |
| `unpublish_product` | Hide from Online Store | `write_products` |
| `update_product_description` | Update description (plain text or HTML) | `write_products` |
| `update_product_price` | Update variant price | `write_products` |
| `add_product_tag` | Add a tag | `write_products` |
| `remove_product_tag` | Remove a tag | `write_products` |
| `add_product_variants` | Add size/color variants with inventory | `write_products` |
| `delete_product_variant` | Remove a variant | `write_products` |
| `create_product_option` | Add a product option (Size, Color) with values | `write_products` |
| `update_product_option` | Rename option or update its values | `write_products` |
| `upload_media` | Attach an image to a product from a public URL | `write_products` |
| `update_metafields` | Set metafields on any resource (product, variant, customer, etc.) | `write_products` |

**Collections**

| Tool | What it does | Scope |
|---|---|---|
| `create_collection` | Create a manual collection, optionally add products | `write_products` |
| `update_collection` | Rename, change description, add/remove products | `write_products` |

**Inventory**

| Tool | What it does | Scope |
|---|---|---|
| `update_inventory` | Set stock quantity for a variant | `write_inventory` |

**Orders & Fulfillment**

| Tool | What it does | Scope |
|---|---|---|
| `cancel_order` | Cancel an order, optionally restock | `write_orders` |
| `add_order_note` | Add a note to an order | `write_orders` |
| `create_fulfillment` | Mark order as shipped with tracking number | `write_fulfillments` |
| `create_draft_order` | Create a quote/draft order | `write_draft_orders` |

**Customers**

| Tool | What it does | Scope |
|---|---|---|
| `create_customer` | Create a new customer account | `write_customers` |
| `update_customer` | Update name, email, phone, tags, note | `write_customers` |

**Discounts**

| Tool | What it does | Scope |
|---|---|---|
| `create_discount` | Create a percentage or fixed-amount discount code | `write_discounts` |

### How authentication works

Shopify Dev Dashboard apps (2026+) use **OAuth 2 Client Credentials Grant** — there is no static `shpat_` token. The MCP server fetches a temporary token on startup using Client ID + Secret, caches it, and refreshes automatically before expiry. This is handled entirely inside `shopify-mcp/index.js` — no manual token management needed.

### Step 1 — Create an app in Shopify Dev Dashboard

1. Go to [dev.shopify.com](https://dev.shopify.com) and open your store's dashboard
2. Click **Create app** → give it a name (e.g. `aria-mcp`)
3. In the app's **Configuration**, set Admin API scopes:
   ```
   read_customers,write_customers,read_inventory,write_inventory,read_orders,write_orders,read_products,write_products,read_locations,read_fulfillments,write_fulfillments,read_draft_orders,write_draft_orders,write_discounts,read_publications,write_publications
   ```
4. Save and click **Install app** — this installs it on your store
5. Go to **Settings** → **Credentials** → copy **Client ID** and **Client Secret** (`shpss_...`)

> **Note:** The Shopify Dev Dashboard does NOT show a `shpat_` token — that was the legacy system. You only need Client ID and Secret.

### Step 2 — Find your `.myshopify.com` domain

Your custom domain (e.g. `yourstore.com`) won't work for API calls. Find the internal domain in:
- Shopify Admin URL: `admin.shopify.com/store/**your-store-handle**/...`
- The handle becomes: `your-store-handle.myshopify.com`

### Step 3 — Update `.env`

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id_here
SHOPIFY_CLIENT_SECRET=shpss_xxxxxxxxxxxxxxxxxxxx
SHOPIFY_APP_NAME=aria-mcp   # must match the app name in Shopify Dev Dashboard
```

`SHOPIFY_APP_NAME` is used as a reference URI in inventory mutations (required by Shopify API for audit trails). It defaults to `aria-mcp` if not set — change it per client to match your app name.

### Step 4 — Deploy

```bash
cd clients/<your-client> && ./deploy.sh code-server
```

The server lives at `/opt/ide/apps/shopify-mcp/index.js` inside the container — no external downloads at runtime.

### Product creation flow

When creating a product programmatically:

1. `create_product` — creates with `status: DRAFT` (invisible to customers)
2. `add_product_variants` / `create_product_option` — add sizes, colors, etc.
3. `upload_media` — attach images from public URLs
4. `update_metafields` — set Fabric Care, Sizing Guide, etc. (call `get_metafield_definitions` first to find namespace/key/type)
5. `publish_product` — make visible in Online Store

Or pass `publish: true` to `create_product` to auto-publish immediately.

### Metafields

Metafields store structured data not covered by standard Shopify fields (e.g. "Fabric & Care", "Sizing Guide", "Country of Origin").

**Workflow:**
```
1. get_metafield_definitions(owner_type: "PRODUCT")
   → returns list of { namespace, key, type, name }

2. update_metafields(
     owner_id: "gid://shopify/Product/123",
     metafields: [{ namespace: "custom", key: "fabric_care", type: "multi_line_text_field", value: "100% French Silk\nDry clean only" }]
   )
```

Common types: `single_line_text_field`, `multi_line_text_field`, `rich_text_field`, `number_integer`, `boolean`, `url`, `json`.

### Recommended skills

Three skills are available for Shopify in `ide-template/skills/shopify/`. See [SKILLS.md](SKILLS.md) for install instructions.

| Skill | Purpose |
|---|---|
| `shopify-products` | Create, update, delete products — variants, options, inventory, metafields, media, publish/unpublish |
| `shopify-orders` | Look up orders, create fulfillments, cancel orders, add notes, manage customers and draft orders |
| `shopify-store` | Collections, discount codes, bulk publish/unpublish, metafield definitions, sales summary, low inventory |

### Troubleshooting

**"Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET"** — env vars not set. Check `.env`.

**"Failed to get Shopify token: 401"** — Client ID or Secret is wrong. Regenerate in Dev Dashboard → Settings → Credentials.

**"Failed to get Shopify token: 403"** — App not installed on the store, or missing required scopes. Go to Dev Dashboard → Install app, then check scopes in Configuration.

**"Shopify API error: 403"** — Token obtained but missing scope for the specific query. Add the missing scope in Dev Dashboard → Configuration → reinstall app → redeploy.

**Inventory update fails with `compareQuantity` or `referenceDocumentUri` error** — Shopify API requires both `ignoreCompareQuantity: true` and `referenceDocumentUri` for inventory mutations. Ensure `SHOPIFY_APP_NAME` is set in `.env` and you're running the latest version of `shopify-mcp/index.js`.

---

## Meta Ads — setup guide

Custom internal MCP server (`ide-template/apps/meta-mcp/`) built directly on the Meta Graph API v22.0. No third-party SDKs — pure `fetch()` calls. Covers Facebook ad campaigns, Instagram, Pages, audiences, creatives, and full Business Portfolio management.

### How authentication works

The server uses a **System User Token** from Meta Business Manager — a non-expiring token tied to a technical user, not a real person. This is the correct approach for managed/automated tools: no OAuth flows, no token refresh, no expiry.

Each client:
1. Creates a System User in their Business Manager
2. Generates a token with the required permissions
3. Adds the token and account IDs to `.env`

### Campaigns & performance

| Tool | What it does |
|---|---|
| `get_campaigns` | List campaigns with status, objective, budget |
| `get_campaign_performance` | Spend, impressions, reach, clicks, CTR, CPC, ROAS, purchases for a campaign |
| `get_ad_account_insights` | Account-level metrics; optional breakdown by age, gender, device, placement |
| `get_ad_sets` | Ad sets within a campaign with targeting summary |
| `get_ads` | Individual ads with creative details and status |
| `get_ad_insights` | Performance per ad (creative-level): spend, CTR, CPC, purchases, ROAS — sorted by spend |
| `create_campaign` | Create a campaign with ODAX objective and budget (starts PAUSED) |
| `update_campaign_budget` | Change daily or lifetime budget |
| `pause_campaign` | Pause an active campaign immediately |
| `resume_campaign` | Resume a paused campaign |

### Ad sets & audiences

| Tool | What it does |
|---|---|
| `create_ad_set` | Create an ad set with geo/age/gender targeting, interest `flexible_spec`, custom audiences, budget |
| `update_ad_set` | Change status, daily budget, or end date |
| `search_interests` | Search interest/behavior IDs by keyword (use results in `create_ad_set`) |
| `get_audiences` | List custom and lookalike audiences with sizes and status |
| `create_custom_audience` | Build audience from customer emails (auto-hashed SHA-256) or pixel events |
| `create_lookalike_audience` | Create lookalike from a source audience for a target country |

### Creatives & media

| Tool | What it does |
|---|---|
| `upload_image` | Upload image from public URL or local path → returns image hash |
| `upload_video` | Upload video from public URL → returns video_id (Meta fetches asynchronously) |
| `create_ad_creative` | Image creative: image hash + caption + headline + CTA + URL |
| `create_video_creative` | Video creative for Reels/Stories/Feed: video_id + caption + CTA |
| `create_carousel_creative` | Carousel: 2–10 cards, each with own image/video, headline, and URL |
| `list_media_library` | List uploaded images and videos in the ad account |
| `create_ad` | Assemble ad from ad set + creative (starts PAUSED) |
| `update_ad` | Pause, enable, or archive an ad |

**Full campaign creation order:**
`create_campaign` → `create_ad_set` → `upload_image` / `upload_video` → `create_ad_creative` / `create_video_creative` / `create_carousel_creative` → `create_ad` → `resume_campaign`

### Instagram & Pages

| Tool | What it does |
|---|---|
| `get_instagram_insights` | Account-level IG metrics: reach, profile views, follower count |
| `get_instagram_media` | Recent posts with like count, comments, per-post reach/saves/interactions |
| `get_page_insights` | Facebook Page metrics: impressions, reach, page views, new fans |

### Business Portfolio _(requires `META_BUSINESS_ID`)_

Manage the entire Business Manager without touching Meta's UI.

| Tool | What it does |
|---|---|
| `get_business_overview` | Business info + all owned assets (ad accounts, pages, pixels, catalogs) |
| `list_business_users` | All users in the Business Manager with roles |
| `list_agencies` | Partner agencies with shared asset access |
| `update_user_access` | Add or remove a user's access to an ad account (tasks: MANAGE / ADVERTISE / ANALYZE) |
| `list_pixels` | All owned Meta Pixels / Datasets |
| `create_pixel` | Create a new Pixel in the Business Manager |
| `assign_pixel_to_account` | Share a pixel with an ad account |
| `list_custom_conversions` | List custom conversion events on the ad account |
| `create_custom_conversion` | Create conversion event (by pixel event type, optional URL filter or min value) |
| `list_catalogs` | List product catalogs owned by the business |
| `create_catalog` | Create a new product catalog |
| `list_product_feeds` | List feed URLs and schedules in a catalog |
| `create_product_feed` | Add a product feed URL with fetch schedule (hourly/daily/weekly) |
| `batch_upload_products` | Create/update/delete up to 50 products in a catalog per call |

#### What cannot be done via API

- Creating Facebook Pages or Instagram accounts (must exist first)
- Adding payment methods / billing (UI only)
- Business verification (manual + Meta review)
- Inviting users by email (API requires Facebook user ID)
- Connecting Shopify/WooCommerce integration (OAuth click required)

---

### Step 1 — Create a Meta App (once, yours)

You only do this once — the same Meta App can be used for all clients.

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**
2. Choose **Business** type
3. Note the **App ID** (you don't need to add it to `.env`, but keep it handy)
4. Keep the app in **Development mode** — sufficient for internal/employee use on accounts you own

> You do not need to submit this app for Meta App Review as long as you and the client are both admins on the same Business Manager and ad accounts. App Review is only required when accessing accounts of third parties who are not part of your business.

---

### Step 2 — Create a System User in the client's Business Manager

1. Go to [business.facebook.com](https://business.facebook.com) and open the client's Business Manager
2. **Business Settings** → **Users** → **System Users**
3. Click **Add** → name it (e.g. `client-ide-bot`) → role: **Admin**
4. Click **Add Assets** → select the client's **Ad Account**, **Facebook Page**, and **Instagram Account** → grant **Full Control**

---

### Step 3 — Generate a System User Token

1. In **System Users**, click the user → **Generate New Token**
2. Select your Meta App (from Step 1)
3. Select these permissions:
   - `ads_management` — required for all write tools (campaigns, ad sets, creatives, audiences, conversions, catalogs)
   - `ads_read` — required for all read tools
   - `read_insights` — required for performance metrics
   - `business_management` — required for Business Portfolio tools (users, pixels, catalogs)
   - `catalog_management` — required for product catalog and feed tools
   - `pages_read_engagement` — required for `get_page_insights`
   - `instagram_basic` — required for `get_instagram_media`
   - `instagram_manage_insights` — required for `get_instagram_insights`
4. Click **Generate Token** — copy it immediately
5. This is your **`META_ACCESS_TOKEN`** — it does not expire

---

### Step 4 — Find the required IDs

**META_AD_ACCOUNT_ID**
- Business Settings → Ad Accounts → click the account → copy the ID shown (e.g. `act_123456789`)
- Or open [business.facebook.com](https://business.facebook.com), go to Ads Manager — the URL contains `act_XXXXXXXXX`

**META_PAGE_ID**
- Go to the Facebook Page → **About** → scroll to the bottom — **Page ID** is listed
- Or: Business Settings → Pages → click the page → ID shown in the panel

**META_INSTAGRAM_ACCOUNT_ID**
- Business Settings → Instagram Accounts → click the account → ID shown in the panel
- Or call the Graph API with your token:
  ```
  https://graph.facebook.com/v22.0/{PAGE_ID}?fields=instagram_business_account&access_token={TOKEN}
  ```
  Returns `{ "instagram_business_account": { "id": "17841400000000000" } }`

---

### Step 5 — Update `.env`

```bash
META_ACCESS_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
META_AD_ACCOUNT_ID=act_123456789
META_PAGE_ID=123456789012345               # optional — enables creative tools + get_page_insights
META_INSTAGRAM_ACCOUNT_ID=17841400000000000  # optional — enables get_instagram_*
META_BUSINESS_ID=123456789                 # optional — enables Business Portfolio tools
```

All variables except `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` are optional. If omitted, the corresponding tools return a "not configured" message.

**Finding META_BUSINESS_ID:**
- Business Settings → Business Info → scroll to **Business Manager ID**
- Or open any Business Settings URL — the number after `/business/` in the URL is the Business ID

---

### Step 6 — Register in client `.mcp.json`

Add to `clients/<your-client>/.mcp.json`:

```json
{
  "mcpServers": {
    "meta": {
      "command": "node",
      "args": ["/opt/ide/apps/meta-mcp/index.js"],
      "env": {
        "META_ACCESS_TOKEN": "${META_ACCESS_TOKEN}",
        "META_AD_ACCOUNT_ID": "${META_AD_ACCOUNT_ID}",
        "META_PAGE_ID": "${META_PAGE_ID}",
        "META_INSTAGRAM_ACCOUNT_ID": "${META_INSTAGRAM_ACCOUNT_ID}",
        "META_BUSINESS_ID": "${META_BUSINESS_ID}"
      }
    }
  }
}
```

Environment variables are substituted from `.env` at container start — no hardcoded values in `.mcp.json`.

---

### Step 7 — Deploy

```bash
cd clients/<your-client> && ./deploy.sh code-server
```

The server is pre-installed in the Docker image (LAYER 2d) — no npm install at runtime.


---

### Verify

Ask Claude: *"What campaigns do I have running?"* or *"Show me ad performance for the last 7 days."*

For Instagram: *"How many people did we reach on Instagram last week?"*

---

### Date ranges

All insight tools accept either a `date_preset` or explicit `since`/`until` dates:

| Preset | Range |
|---|---|
| `today` | Today |
| `yesterday` | Yesterday |
| `last_3d` | Last 3 days |
| `last_7d` | Last 7 days (default) |
| `last_14d` | Last 14 days |
| `last_28d` | Last 28 days |
| `last_30d` | Last 30 days |
| `last_90d` | Last 90 days |
| `this_month` | Current calendar month |
| `last_month` | Previous calendar month |

Custom range: `since: "2026-04-01"` + `until: "2026-04-13"` (YYYY-MM-DD).

---

### Troubleshooting

**"Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID"** — env vars not set. Check `.env` and redeploy.

**"Meta API error 190: Invalid OAuth access token"** — token is wrong or was invalidated. Regenerate in Business Manager → System Users → Generate New Token.

**"Meta API error 100: Invalid parameter"** — ad account ID format is wrong. Must include the `act_` prefix (e.g. `act_123456789`), not just the number.

**"Meta API error 200: Permission error"** — the System User doesn't have access to the requested resource (ad account, page, or IG account). Go to Business Settings → System Users → Add Assets and grant Full Control.

**`get_instagram_insights` / `get_page_insights` returns "not configured"** — `META_INSTAGRAM_ACCOUNT_ID` or `META_PAGE_ID` not set in `.env`.

**Insights return empty data for `today`** — Meta's insights pipeline has a ~1–2 hour delay. Use `yesterday` or `last_7d` for reliable data.

**`create_ad_creative` fails with "page not found"** — `META_PAGE_ID` is not set in `.env`. This field is required to create ad creatives (Meta needs a Facebook Page to associate the ad with).

**`create_campaign` fails with "special_ad_categories missing"** — pass `special_ad_categories: []` for standard (non-special) campaigns. Required by Meta even if empty.

**`create_ad_set` fails with "optimization goal incompatible"** — certain combinations of `objective` + `optimization_goal` are not allowed by Meta. Common safe combos: `OUTCOME_SALES` + `OFFSITE_CONVERSIONS`, `OUTCOME_TRAFFIC` + `LINK_CLICKS`, `OUTCOME_LEADS` + `LEAD_GENERATION`.

**`meta` not listed in Claude's tools** — check `.mcp.json` has the `meta` entry and that env vars are set. Restart the container: `docker compose restart code-server`.

---

## Playwright — browser automation

Built-in, always-on. No `.env` variables required. The bot can open any URL, interact with the page, and take screenshots — useful for verifying changes on live storefronts, scraping content, or automating multi-step web flows.

### What the bot can do

| Action | Example prompt |
|---|---|
| Screenshot | *"Go to acme.myshopify.com and take a screenshot of the homepage"* |
| Click | *"Click the 'Add to cart' button on product page [URL]"* |
| Fill form | *"Fill in the contact form with test data and submit"* |
| Navigate | *"Go to [URL], then navigate to /collections/all and screenshot"* |
| Read content | *"Check what price is shown for product X on the live store"* |
| Verify change | *"I just updated the hero banner copy — open the store and confirm it's showing correctly"* |

### Typical Shopify workflow

```
User → Aria: "Update the product description for 'Summer Dress' and screenshot how it looks"

Aria:
  1. Shopify MCP  → update_product_description(...)
  2. Playwright   → navigate to product page on live store
  3. Playwright   → screenshot
  4. Sends screenshot to Telegram ✅
```

### Implementation details

- **Browser:** Chromium (Chrome for Testing v147), pre-installed in the Docker image — no download at runtime
- **Mode:** Headless — required in Docker (no display server). Configured via `--headless` flag
- **Package:** [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) by Microsoft
- **Location:** `/home/coder/.npm-global/bin/playwright-mcp`
- **One page at a time** — the bot works sequentially, which is sufficient for all automation tasks and keeps RAM usage within server limits

### Recommended skill: `playwright-protocol`

Enable the `playwright-protocol` skill to ensure safe and clean browser automation. It enforces screenshot storage in `/tmp/` (with cleanup), periodic cleanup of the `.playwright-mcp/` folder, and proper mobile/desktop viewport handling.

See [SKILLS.md](SKILLS.md) (or `ide-template/skills/playwright-protocol/SKILL.md`) for full instructions.

### Troubleshooting

**"playwright-mcp: command not found"** — package not installed. Check Dockerfile has the LAYER 2e block:
```bash
docker exec <IDE_NAME> ls /home/coder/.npm-global/bin/ | grep playwright
```

**"Executable doesn't exist" / Chromium not found** — browser not installed in image. Verify Dockerfile runs:
```bash
/home/coder/.npm-global/bin/playwright install --with-deps chromium
```
Then redeploy: `./deploy.sh code-server`

**Screenshot is blank / page didn't load** — the target site may block headless browsers. Try asking the bot to wait for the page to fully load before screenshotting.

**`playwright` not listed in Claude's tools** — check entrypoint log:
```bash
docker logs <IDE_NAME> 2>&1 | grep "MCP:"
```
Expected: `[entrypoint] MCP: X servers (memory, playwright, ...)`

---

## Seedream — image generation

Custom internal MCP server (`ide-template/apps/seedream-mcp/`) for BytePlus ModelArk image generation. Powered by Seedream 4.5 (text-to-image) and Seededit (image editing, background removal).

### Tools

| Tool | What it does |
|---|---|
| `generate_image` | Text-to-image with optional reference images (up to 14) |
| `edit_image` | Image-to-image editing with a text instruction |
| `remove_background` | Remove/transparent background from an image |

### Env vars

| Variable | Required | Default | Description |
|---|---|---|---|
| `BYTEPLUS_API_KEY` | Yes | — | API key from console.byteplus.com → ModelArk → API Keys |
| `BYTEPLUS_MODEL_ID` | No | `seedream-4-5-251128` | Text-to-image model ID |
| `BYTEPLUS_EDIT_MODEL_ID` | No | `seedream-5-0-260128` | Image editing + background removal model ID |
| `SEEDREAM_OUTPUT_DIR` | No | `/home/coder/project/generated` | Where to save generated images |

> **Model IDs:** The defaults (`seedream-4-5-251128`, `seedream-5-0-260128`) are BytePlus public model IDs that work without creating custom endpoints. If BytePlus assigns you a custom endpoint ID (e.g. `ep-20250101-xxxxxxxx`), override via env vars.

### Sizes

Presets: `1024x1024` (default), `2048x2048`, `4K` (3840×2160), `16:9`, `9:16`, `4:3`, `3:4`, `2:3`, `3:2`. Or custom `WxH` e.g. `1536x1024`.

### Setup

**1. Get API key** — [console.byteplus.com](https://console.byteplus.com) → ModelArk → API Keys → Create

**2. Add to `.env`:**
```env
BYTEPLUS_API_KEY=your-key-here
# Optional overrides:
# BYTEPLUS_MODEL_ID=ep-20250101-xxxxxxxx
# BYTEPLUS_EDIT_MODEL_ID=ep-20250101-yyyyyyyy
# SEEDREAM_OUTPUT_DIR=/home/coder/project/generated
```

**3. Deploy:**
```bash
cd clients/<your-client> && ./deploy.sh
```

The server auto-activates when `BYTEPLUS_API_KEY` is set — no `.mcp.json` changes needed.

### Verify

Ask Claude: *"Generate an image of a tropical beach at sunset"* — should save a PNG to `project/generated/` and return the file path.

### Troubleshooting

**"Missing BYTEPLUS_API_KEY"** — key not set in `.env`.

**API 401** — key is wrong or expired. Regenerate in BytePlus console.

**API 404 on model** — the default model IDs may not be valid for your account. Create an endpoint in BytePlus console → ModelArk → Endpoints, and set `BYTEPLUS_MODEL_ID` / `BYTEPLUS_EDIT_MODEL_ID` to the generated endpoint ID.

**`remove_background` not transparent** — Seededit may not support alpha channel. If BytePlus offers a dedicated matting model, set `BYTEPLUS_EDIT_MODEL_ID` to that endpoint.

---

## Nano Banana — Google Gemini image generation

Custom internal MCP server (`ide-template/apps/nano-banana-mcp/`) built on the `@google/genai` SDK. Two models in one server:

| Tool | Model | Description |
|---|---|---|
| `generate_image` | Imagen 3 (`imagen-3.0-generate-002`) | Highest quality text-to-image. Aspect ratios: 1:1, 3:4, 4:3, 9:16, 16:9. Up to 4 images per call. |
| `edit_image` | Gemini 2.0 Flash (`gemini-2.0-flash-preview-image-generation`) | Edit an existing image via text instruction. Accepts local path or HTTPS URL. |

### What you need

A **Gemini API key** — get one from [aistudio.google.com](https://aistudio.google.com) → Get API key. Free tier available.

### `.env` variables

```bash
GEMINI_API_KEY=AIza...

# Optional overrides (defaults shown)
# GEMINI_T2I_MODEL=imagen-3.0-generate-002
# GEMINI_EDIT_MODEL=gemini-2.0-flash-preview-image-generation
# NANO_BANANA_OUTPUT_DIR=/home/coder/project/generated
```

### Deploy

```bash
cd clients/<your-client> && ./deploy.sh code-server
```

### Seedream vs Nano Banana — when to use which

| | Seedream | Nano Banana |
|---|---|---|
| Best for | High-res fashion/product shots, background removal | Photorealistic scenes, creative compositions, quick edits |
| Text-to-image | Seedream 4.5 (up to 4K) | Imagen 3 (up to 2K) |
| Image editing | Seededit — style/color/texture | Gemini 2.0 Flash — conversational editing |
| Background removal | Yes (dedicated tool) | No |
| API | BytePlus ModelArk | Google AI Studio |

Both save to the same output directory (`project/generated/`) by default.

---
## Email — setup guide (read mailbox via IMAP)

Read-only multi-account IMAP plugin. Lets the bot search Gmail / Workspace / Zoho / any IMAP host and edit project files based on what it finds in mail.

### Tools (5, all read-only)

- `list_accounts` — list configured accounts and their folders.
- `list_recent` — recent messages with metadata + 200-char snippet (default: last 7 days, INBOX, 20 messages).
- `search` — Gmail-syntax (X-GM-RAW) for Gmail accounts; `from:`, `to:`, `cc:`, `subject:`, `body:` prefixes for non-Gmail.
- `read_message` — full body (text + html), headers, attachment metadata.
- `download_attachment` — fetch one attachment to `/tmp/email-mcp/...` (ephemeral; cleared on plugin restart).

`list_recent` and `search` accept `account: "*"` to fan out across all configured accounts in parallel.

There is no `send`, `delete`, `move`, or `flag` tool. The bot runs with `--dangerously-skip-permissions`, so the plugin's read-only-by-exposure design is the safety guarantee — even with prompt injection, the bot cannot mutate the mailbox.

### Configuration

Single JSON file at `clients/<your-client>/.email/accounts.json` (gitignored). Bind-mounted into the container as `/home/coder/.email/accounts.json:ro`.

```json
[
  {
    "id": "press",
    "label": "Press / PR",
    "host": "imap.gmail.com",
    "port": 993,
    "user": "press@example.com",
    "pass": "xxxx-xxxx-xxxx-xxxx"
  },
  {
    "id": "support",
    "label": "Support",
    "host": "imappro.zoho.eu",
    "port": 993,
    "user": "support@example.com",
    "pass": "zoho-app-specific-password"
  }
]
```

Required fields: `id`, `host`, `port`, `user`, `pass`. Optional: `label` (defaults to `id`).

If the file is absent, the plugin is **not registered** at boot — the bot has no email tools and the rest of the system runs unchanged. Same pattern as GA4: empty config = inert.

### Gmail App Password (per mailbox)

App Passwords are the simplest auth path for Gmail — no Google Cloud OAuth project, no consent flow per customer. Each mailbox needs its own App Password (per-user, per-app).

**Per-mailbox setup**:

1. Mailbox owner must have **2-Step Verification enabled**: <https://myaccount.google.com/security> → "2-Step Verification" → enable.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Name: `<bot> bot` (e.g. `Atlas bot`). Click Create.
4. Copy the 16-character password — Google won't show it again.
5. Paste into `accounts.json` as the `pass` field. Spaces are optional (Gmail IMAP accepts both `xxxx xxxx xxxx xxxx` and `xxxxxxxxxxxxxxxx`).

**Workspace caveat**: a domain admin can disable App Passwords org-wide via Admin Console → Security → 2-Step Verification. If users see "App passwords aren't available for your account", admin needs to allow them. Falls back to OAuth otherwise (not currently supported by this plugin).

### Zoho App-specific Password

Zoho hosts have **two different IMAP servers** depending on plan:

- Personal `@zohomail.com` users → `imap.zoho.com` (US), `imap.zoho.eu` (EU), `imap.zoho.in` (IN)
- Paid org with custom domain → `imappro.zoho.com` / `imappro.zoho.eu` / `imappro.zoho.in`

The exact host appears in **Zoho Settings → Mail Accounts → Server Configuration Details** for each mailbox.

**Per-mailbox setup**:

1. Mailbox owner: **enable IMAP Access** in Zoho Mail → Settings → Mail Accounts → click primary email → IMAP section → check "IMAP Access" → Save. Often disabled by default.
2. If 2FA is enabled (which it should be): generate an Application-specific Password at <https://accounts.zoho.com> → Security → App Passwords → Generate.
3. Paste the generated password into `accounts.json` as `pass`.

**Note**: Zoho Mail Free plan has IMAP **disabled by default** for new signups since 2024. Mail Lite / Premium / Workplace all have it. SAML SSO users need App-specific Password (no exclusive Zoho password to use).

### Other IMAP hosts

The plugin works against any standards-compliant IMAP host (port 993, SSL). Just set `host`, `port`, `user`, `pass` and it works — without Gmail extensions (no `X-GM-RAW`, no labels, no thread IDs), `search` accepts the simple field-prefix syntax (`from:`, `to:`, `subject:`, `body:`).

### Deploy

The per-client `deploy.sh` wrapper uploads `accounts.json` to `/home/coder/.email/accounts.json` on the server (default permissions, root-owned, bind-mounted RO into the container). Identical pattern to `.google/ga4-credentials.json`.

After redeploy, the plugin auto-registers in `~/.claude.json` if the file exists. To verify the bot picked it up:

```bash
ssh "$HETZNER_HOST" "docker logs <IDE_NAME> 2>&1 | grep email-mcp"
# Expect: "[email-mcp] Ready — N account(s): press, info, ..."
```

Or ask the bot via Telegram: "list_accounts" → it should report what's configured.

### Security model

- Credentials live in a host-side file (`/home/coder/.email/accounts.json`), never in env vars (no leak via `docker exec env`).
- Bind-mount is read-only (`:ro`) — bot cannot rewrite credentials.
- The Claude Code config has `Read(**/.email/accounts.json)` in the deny list (`.claude/settings.json`) — even the IDE Claude in the browser cannot read the file via the `Read` tool.
- App Passwords / App-specific Passwords are revocable independently of the main account password — if you ever need to cut bot access, revoke the App Password in Google/Zoho. Main account access is unaffected.
- The plugin exposes **no write tools** — even with `--dangerously-skip-permissions` the bot cannot send, delete, move, or flag mail.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[email-mcp] Config error: ... must be a non-empty array` | empty `accounts.json` | Add at least one account entry. |
| `[email-mcp] Config error: account X: missing field "host"` | malformed entry | Each account needs `id`, `host`, `port`, `user`, `pass`. |
| Bot says "I don't have email tools" | `accounts.json` not bind-mounted | Check `docker exec <IDE> ls /home/coder/.email/`. Re-deploy. |
| Authentication failed (Gmail) | wrong App Password / 2FA off / Workspace blocking | Regenerate App Password; verify 2FA is on; check Workspace admin policy. |
| Authentication failed (Zoho) | IMAP not enabled in Zoho settings | Settings → Mail Accounts → IMAP Access → check box → Save. |
| `EHOSTUNREACH` / `ETIMEDOUT` | wrong host (e.g. `imap.zoho.com` for paid org) | Use `imappro.zoho.<region>` for custom-domain Zoho accounts. |


## Adding a new integration

1. **(If a new MCP)** Add `apps/<name>-mcp/` with `index.js` exposing the tools, `package.json`, optional README. Update `Dockerfile` to `COPY` + `npm install --production`. Update `deploy.sh` to scp the dir.
2. **Add to catalog** — append an entry to `workspace-api/integrations.catalog.json` with `id`, `label`, `logo`, `description`, `fields[]`, `steps[]`, `mcp.{command,args,name,envMap,…}`.
3. **Add a logo** — drop an SVG (24×24 viewBox preferred) into `frontend/public/integrations/<id>.svg`. Brand colour as fill. simpleicons.org has most of them.
4. **(If file-based config)** Use `mcp.writeFiles[]` with one of the supported formats (`fromField`, `shell-env`, `email-accounts`) and a path under `{dataDir}/<id>/`.
5. Hot-reload workspace-api — catalog is cached at startup, restart picks up new entries.
6. Hard-refresh the browser — frontend renders the new tile.

No frontend code changes needed for typical integrations (single-set, env-based MCP).

## Troubleshooting

**`503 encryption not configured` from PUT** — `/run/secrets/integrations.key` is mounted but workspace-api can't read it.

Two common causes:

1. **Mount missing** — host file doesn't exist. Check `ls -la /srv/<ide>/secrets/integrations.key`. If absent, re-run `./deploy.sh` (the keygen block creates it).
2. **uid/gid mismatch** — host file is root-owned mode 0600 but workspace-api inside the container runs as `coder` (uid 1000). Bind-mounts preserve ownership, so a root-owned 0600 file is unreadable to the container's coder user. Fix:

   ```bash
   ssh root@<server> "chown 1000:1000 /srv/<ide>/secrets/integrations.key && chmod 600 /srv/<ide>/secrets/integrations.key"
   docker exec <ide-container> su coder -c 'pm2 restart workspace-api'
   ```

   `deploy.sh` chowns the file unconditionally on every run from this commit on, so future deploys won't repeat.

**Integration shows Active in the dashboard but the user never configured it** — auto-migration encrypted a `.env` placeholder value (`FILL_ME`, `TODO`, `<your_token_here>`, etc.) as if it were a real credential. Symptom: clicking the active card shows masked summary like `••••L_ME` with length 7 (the placeholder). Fix:

```bash
docker exec <ide-container> su coder -c 'curl -s -X DELETE http://localhost:3001/api/integrations/<id>'
```

The migration code rejects placeholders matching `/^(FILL_ME|TODO|TBD|<.*>|your[_-].*[_-]here|xxx+|change[_-]?me)$/i` from this commit on, so future migrations won't repeat. If you maintain a per-client `.env` template, swap `FILL_ME` for actual values **or** remove those lines entirely so the variable isn't set at all.

**`409 already active` when trying to PUT** — you must `DELETE /api/integrations/:id` first. The UI handles this automatically (Remove → Activate flow).

**Telegram doesn't pick up the new token** — check `pm2 logs <bot>` (process name is `${BOT_NAME}`, e.g. `bot`, NOT `telegram-<bot>`) for "Provisioning Telegram Token". If `bot.sh` wasn't redeployed (predates the integrations.env source line), the bot ignores the new file. Run `./deploy.sh code-server`.

**Bot in Telegram doesn't see a newly activated MCP** (e.g. "Grok tool not active in this session" right after activating Grok in the dashboard) — the bot caches `~/.claude.json` into `~/.${BOT}/.claude.json` at startup, so it can't see new entries until restarted. Workspace-api restarts the bot automatically when `mcpServers` actually changes; if the auto-restart didn't fire (e.g. the integration is file-only and `mcpServers` was unchanged) you can force it manually:

```bash
docker exec -u coder <ide-container> pm2 restart <bot_name>
```

The web chat (`workspace-api` → `claude -p`) doesn't have this caching problem — it reads `~/.claude.json` fresh on every turn, so newly-activated MCPs work there immediately.

**MCP tool call gets "rejected" / nothing happens** (e.g. claude says "you clicked reject" or `set_reminder` reports success but `.reminders.json` shows no new entry, or "narzędzie Groka nie jest aktywne") — claude couldn't run the MCP and creatively narrated the failure as a user rejection. The actual cause is one of three things; this playbook walks through them in order of likelihood.

**Step 1 — verify the integration is actually wired into the bot's view of `mcpServers`.**

```bash
# Web chat reads the main config — should always be in sync with UI
docker exec <ide-container> bash -c 'cat /home/coder/.claude.json | python3 -c "import json,sys; print(list(json.load(sys.stdin).get(\"mcpServers\",{}).keys()))"'

# Bot reads ITS OWN cached copy — only syncs at PM2 start
docker exec <ide-container> bash -c 'cat /home/coder/.<bot>/.claude.json | python3 -c "import json,sys; print(list(json.load(sys.stdin).get(\"mcpServers\",{}).keys()))"'
```

If the bot copy is missing the entry, that's your problem — the bot didn't restart after the integration was activated. Force it:

```bash
docker exec -u coder <ide-container> pm2 restart <bot_name>
```

After this commit, workspace-api auto-restarts the bot whenever `mcpServers` actually changes — but if the auto-restart was bypassed (e.g. process wasn't running) you may still need this manual step once.

**Step 2 — verify the MCP itself starts without erroring.**

```bash
# Run the MCP standalone (it should print "[<name>-mcp] ready" and idle on stdio)
docker exec <ide-container> bash -c 'XAI_API_KEY=<key> timeout 3 node /opt/ide/apps/grok-mcp/index.js 2>&1 | head -5'
```

If it prints `Missing XAI_API_KEY` or crashes, the credential never made it into the spawn env. Re-activate via the UI; check that the `env` block under that server in `~/.claude.json` has the right key name (e.g. `XAI_API_KEY`, not `GROK_API_KEY`).

**Step 3 — verify `permissions.allow` covers the tool.**

```bash
docker exec <ide-container> cat /home/coder/.claude/settings.json | python3 -m json.tool
```

Default allow-list:

```json
"allow": ["mcp__*", "Read", "Bash", "Glob", "Grep", "Write", "Edit"]
```

`mcp__*` covers every MCP-namespaced tool (named `mcp__<server>__<tool>`), so any new MCP you add gets free auto-approval. If a specific tool is being blocked, watch the log:

```bash
docker exec <ide-container> tail -f /home/coder/.<bot>/workspace-api-error.log | grep -E 'claude/permission-blocked|claude/unknown-top'
```

`[claude/permission-blocked] tool=<name>` means claude wanted to use `<name>` but it's not in the allow-list. Add the tool's exact pattern to `permissions.allow` in `~/.claude/settings.json` (template lives at `ide-template/global-claude.md` is for instructions; the settings file is written by `entrypoint.sh`).

**Step 4 — full stream-json debug (last resort).**

If steps 1–3 don't reveal the issue, set `CLAUDE_DEBUG_STREAM=1` in the workspace-api environment (`docker compose exec code-server env CLAUDE_DEBUG_STREAM=1 pm2 restart workspace-api`) and tail `~/.bot/workspace-api-out.log`. The raw event stream will show:
- Whether the MCP server was even spawned (`mcp_server_start` events at session init)
- Whether the tool was attempted (`content_block_start` with `type: tool_use`)
- The full tool result including `is_error` flag and error text (`user` event with `tool_result` content)

That's almost always enough to pinpoint the failure layer.

**Email MCP: "EMAIL_ACCOUNTS_FILE not found"** — likely the `/srv/<ide>/integrations-data/` mount is missing or owned by root. Run the integrations-data block from `deploy.sh` again, or `mkdir -p /srv/<ide>/integrations-data && chown -R 1000:1000 /srv/<ide>/integrations-data` on the host.

**GA4 MCP: "ga4-mcp-server: command not found"** — pip package missing from the image. Rebuild with `./deploy.sh code-server` (Dockerfile has `pip install --no-cache-dir google-analytics-mcp`).

**Migration didn't pick up an existing legacy env** — check `pm2 logs workspace-api` for `[migrate]` lines. If it says `field "X" is required`, the env is partially set (e.g. `META_ACCESS_TOKEN` without `META_AD_ACCOUNT_ID`). Set the missing one and restart workspace-api, or just activate via the UI.


### Bot self-configuration (advanced)

Bots can also register MCP servers themselves via Telegram chat. Since bots run with `bypassPermissions`, they can execute `claude mcp add ...` commands directly. This is useful for one-off integrations or experimental tools that shouldn't go in the template.

Any server registered this way is written to `~/.claude.json` which is backed up to the persistent volume — it survives restarts. Note: the entrypoint script overwrites `mcpServers` entirely on each start, so self-configured servers would be lost on container restart unless they're also in the env-based config. To permanently add a self-configured server, add it to `entrypoint.sh`.
