# Deployment Guide

Domain: `<YOUR_DOMAIN>` → Hetzner VPS (`<SERVER_IP>`)

Everything runs on one server (Caddy + frontend + auth-service + code-server).
No separate Vercel deployment needed.

---

## Step 0 — Per-client `.env` (3-field minimum)

Onboarding a new client = copying the example, filling in **3 fields**, done.
Everything else is auto-derived (from folder name + the 3 fields) or
auto-generated (cryptographic-random SESSION_SECRET, CODE_SERVER_PASSWORD)
on first deploy.

```bash
mkdir -p clients/<client-name>
cp clients/example-client/.env.example clients/<client-name>/.env
$EDITOR clients/<client-name>/.env
```

The 3 fields the operator fills in:

| Field | Example | Notes |
|---|---|---|
| `HETZNER_HOST` | `root@1.2.3.4` | SSH target — must accept your key |
| `FRONTEND_DOMAIN` | `acme.example.com` | DNS A record pointed at the host |
| `IDE_ALLOWED_EMAILS` | `you@example.com` | First email = admin, rest = members. Comma-separated. |

That's it. Run `clients/<client-name>/deploy.sh` and `bin/bootstrap-client-env.sh`
fills the rest:

| Auto-derived | Auto-generated (random) |
|---|---|
| `IDE_NAME` ← folder name | `SESSION_SECRET` ← `openssl rand -hex 32` |
| `REMOTE_PATH` ← `/root/${IDE_NAME}` | `CODE_SERVER_PASSWORD` ← `openssl rand -hex 16` |
| `SESSION_COOKIE_NAME` ← `${IDE_NAME}_session` | |
| `ALLOWED_ORIGINS` ← `https://${FRONTEND_DOMAIN}` | |
| `BOT_NAME` = `bot` (operational placeholder) | |
| `VITE_APP_TITLE` = `Workspace` (generic — wizard overrides) | |
| `LEGACY_DRIVE_SYNC=false`, `LEGACY_CONFIG=false` | |

The bootstrap is **idempotent** — secrets aren't rotated on subsequent
runs. If you ever delete a field from `.env`, the next deploy fills it
again (with a fresh random value for secrets — so tread carefully).

### Branding goes through the wizard, not `.env`

Workspace title, bot name, avatar, logo, backstory and personality are
entered by the **end-user** through the in-browser onboarding wizard on
first login (4 steps: workspace name + logo → bot name + avatar → backstory
+ personality → Claude OAuth token). Values land in
`PROJECT_DIR/.branding.json` (mode 0600); the encrypted Claude token in
`PROJECT_DIR/.platform.token.enc` (AES-256-GCM).

**Don't put `VITE_APP_TITLE="Acme"` or `BOT_NAME=aria` in your operator
`.env`** for non-legacy clients — that defeats the wizard. Bootstrap
defaults (`Workspace`/`bot`) are placeholders the user will replace.

### Optional flags

- `LEGACY_DRIVE_SYNC=true` — enables rclone Drive sync (for clients that pre-date the project-data volume model)
- `LEGACY_CONFIG=true` — branding read-only via UI; managed via `.env` + `overrides/public/` + redeploy. Used by legacy clients pre-migration

### Runtime secrets (Claude / Shopify / Meta / GA4 / Telegram / …)

NOT in `.env`. The end-user supplies them through:

- **Setup wizard step 4** — Claude OAuth token (`sk-ant-oat01-…`)
- **Sidebar → Integrations dashboard** — Telegram, Shopify, Meta, Google Ads, GA4, Email IMAP, Seedream, Nano-banana, Grok

All encrypted with the per-client AES-256-GCM master key
(`/srv/<ide>/secrets/integrations.key`, generated automatically on first
deploy). See [INTEGRATIONS.md](INTEGRATIONS.md).

> Migrating an existing client? After the first redeploy with the auto-migration code, `pm2 logs workspace-api` prints a `PLAINTEXT CLEANUP` banner listing exactly which env vars to remove. Strip them, redeploy `code-server`, you're done.

---

## Step 1 — DNS (Namecheap)

In Namecheap dashboard → **<YOUR_DOMAIN>** → **Advanced DNS**:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | `<SERVER_IP>` | Automatic |
| A Record | `www` | `<SERVER_IP>` | Automatic |

Wait 1-5 minutes for propagation, then verify:
```bash
dig <YOUR_DOMAIN> +short
# Should return: <SERVER_IP>
```

---

## Step 2 — Google OAuth — add new redirect URI

**Shared OAuth model**: all clients share **one** Google OAuth app maintained by the admin. Per-client `.env` no longer needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — those are read from `clients/admin.env` (gitignored) by `deploy.sh`. Onboarding a new client = adding their callback URI to the shared app's authorised list.

**Two ways to add the URI**:

```bash
# Recommended — one-line via the helper script (uses gcloud + Google API)
./bin/add-redirect-uri.sh <YOUR_DOMAIN>

# Manual fallback — Google Cloud Console
# https://console.cloud.google.com → APIs & Services → Credentials →
#   click your shared OAuth Client → Authorised redirect URIs → ADD URI:
#   https://<YOUR_DOMAIN>/auth/callback
# → Save
```

**Admin shared env** (`clients/admin.env`) holds the shared OAuth credentials and is read by every per-client `deploy.sh` automatically. Copy the template and fill in real values:

```bash
cp clients/admin.env.example clients/admin.env
chmod 600 clients/admin.env
$EDITOR clients/admin.env
```

```bash
# clients/admin.env (gitignored)
GOOGLE_OAUTH_PROJECT_ID=workspace-shared-1234
GOOGLE_OAUTH_CLIENT_ID=987654321.apps.googleusercontent.com
GOOGLE_CLIENT_ID=987654321.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

> Need it elsewhere (e.g. shared via private dotfiles repo)? Set
> `WORKSPACE_ADMIN_ENV=/path/to/your.env` before running `deploy.sh`.

**Production publish**: the OAuth app must be in **Production** (not "Testing") for users outside your Google Workspace org to sign in. Our scopes are non-sensitive (`openid`, `email`, `profile`), so verification is automatic — usually approved within minutes. One-time step in the OAuth consent screen settings.

---

## Step 3 — Deploy to server

```bash
chmod +x deploy.sh
./deploy.sh
```

The script uploads files, builds images, and swaps containers with minimal downtime.

To deploy manually:
```bash
ssh root@<SERVER_IP>
cd <REMOTE_PATH>
docker compose up --build -d
docker compose logs -f
```

### Partial deploys

Pass a service name to rebuild only one container (faster — skips unrelated services):

```bash
./deploy.sh frontend      # login page, build-time VITE_* vars, custom logo/avatar
./deploy.sh auth          # auth-service logic changed
./deploy.sh code-server   # Dockerfile, entrypoint.sh, bot scripts, workspace-api, MCP server code
```

No argument = full deploy (all services rebuilt and swapped).

### Hot-patching a single backend file (no rebuild)

For one-line bug fixes in `workspace-api/` (or any other JS that's COPY'd into the container at build time), a full `./deploy.sh code-server` is overkill — it rebuilds the Docker image (~5 min) and recreates the container (loses bot tmux session). Faster path: scp the file in, `docker cp` it into the running container, `pm2 restart` the affected process.

```bash
# Example: hot-patch workspace-api/routes/chat.js on a single client
scp ide-template/workspace-api/routes/chat.js \
    root@<server>:<REMOTE_PATH>/workspace-api/routes/chat.js

ssh root@<server> "
  docker cp <REMOTE_PATH>/workspace-api/routes/chat.js \
            <container>:/opt/ide/workspace-api/routes/chat.js
  docker exec -u coder <container> pm2 restart workspace-api
"
```

When this is OK:
- Pure JS/TS edit in `workspace-api/`, `apps/<name>-mcp/`, or `bot/*.sh`
- No new dependencies (`npm install` would need a real rebuild)
- No `Dockerfile` / `entrypoint.sh` / `package.json` changes
- The remote `<REMOTE_PATH>/` copy on the host is also being updated, so the next full `./deploy.sh` doesn't silently revert your fix

When you must do a full rebuild instead:
- Adding/changing dependencies in any `package.json`
- Editing `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`
- Changing built frontend assets (Vite build runs inside Docker)
- Anything in `extensions/branding/` (TypeScript build step)
- Adding a new MCP `apps/` directory (needs `COPY` in Dockerfile)
- Editing any setuid-wrappers/* C source (compiled in-image; `docker cp`
  of source wouldn't update the binary at `/usr/local/bin/`)

**Setuid wrapper caveat for hot-patching workspace-api / MCPs:** since
2026-05, `workspace-api` runs as uid 1001 (`wsapi`) via the
`wsapi-runner` setuid wrapper, and each MCP runs as uid 1002 (`mcp`) via
`mcp-runner`. When you `docker cp` a new JS file in and `pm2 restart`,
PM2 spawns the wrapper as coder (1000), the wrapper drops to wsapi/mcp,
then execs the updated file — same path the original startup took. No
extra steps needed, but be aware that:
- File perms must remain readable to the target uid. `docker cp` writes
  as root; if you then `chmod 0600 owner=root` something inside the
  container, the dropped-uid process can't read it. Default `docker cp`
  preserves the source perms, so a normal `chmod +r` source file is fine.
- If the file lives under `/opt/ide/apps/<id>-mcp/` and you change its
  filename, `mcp-runner` won't find it — the wrapper hard-codes the
  resolved path as `{APPS_PREFIX}{id}{INDEX_SUFFIX}` (default
  `/opt/ide/apps/<id>-mcp/index.js`). Keep the filename.

After hot-patching, **commit + push** the change so the next normal deploy doesn't roll it back, and so other operators see the fix.

### Restarting a single PM2 process inside the container

```bash
docker exec -u coder <container> pm2 restart workspace-api
docker exec -u coder <container> pm2 restart <bot_name>           # e.g. bot
docker exec -u coder <container> pm2 restart <bot_name>-reminders
docker exec -u coder <container> pm2 list
```

Bot restart loses the in-memory `claude --channels` conversation context (~5–10 s offline) — see [ARCHITECTURE.md](ARCHITECTURE.md#what-bot-restart-actually-resets) for what survives. Workspace-api restart is invisible to web chat users — there's no persistent session there.

> **Bot restart gotcha — `tmux duplicate session`.** Bot's tmux session is named `${BOT_NAME}` and lives outside the bot's main process tree. `pm2 restart <bot>` kills the bot.sh foreground process, but **the tmux daemon + the session inside it can survive** if bot.sh's exit didn't propagate to tmux. The next bot.sh run hits `tmux new-session ... duplicate session: <name>` and exits early; PM2 retries; loop. Symptom: bot's `tail -f /home/coder/.<bot>/<bot>-out.log` shows `Claude is listening for channel messages` from the OLD timestamp but no new messages get processed.
> Hard reset:
> ```bash
> docker exec <container> sudo -u coder -i pm2 stop <bot>
> docker exec <container> sudo -u bot tmux -L <bot> kill-server
> docker exec <container> bash -c "for p in \$(pgrep -u bot -f 'claude.*dangerously|bun.*telegram|tmux.*<bot>'); do kill -9 \$p; done"
> docker exec <container> sudo -u coder -i pm2 start <bot>
> ```

> **`/doctor` schema URL false positive (pre-2026-06-05 builds).** If you see the bot's tmux pane stuck in interactive `/doctor` self-fix mode editing `~/.claude/settings.json` `$schema` URL, the bootstrap had the wrong URL (`https://json-schema.org/draft/2020-12/schema` instead of `https://json.schemastore.org/claude-code-settings.json`). claude /doctor tried to fix the URL each turn; bot.sh's settings-merge watchdog re-merged the (still-wrong) bootstrap URL back; infinite loop. Fixed in commit `bb5a8cb` (bootstrap URL aligned with what /doctor expects). If you encounter this on a stale image, hot-patch `/opt/ide/bootstrap/claude-settings.json` on the host + hard-reset the bot per the recipe above.

> **Orphan settings-watchdog (cosmetic, known issue).** Each `pm2 restart <bot>` leaves the `bot.sh` background settings-watchdog subshell orphaned (reparented to PID 1). Not destructive — every watchdog merges the same content — but messy in `ps`. To find them: `pgrep -u bot -f merge_bot_settings`. Safe to kill if needed. Tracked for a `trap` fix in next bot.sh iteration.

> **Which target for `.env` changes?** The `.env` is always uploaded to the server first (regardless of target). But for the change to take effect inside the container, you must restart the right service:
> - `LEGACY_DRIVE_SYNC`, `RCLONE_*`, `CORPORATE_FOLDER_ID`, `BOT_NAME` → `./deploy.sh code-server`
> - `VITE_*` branding vars → `./deploy.sh frontend`
> - `IDE_ALLOWED_EMAILS`, `SESSION_SECRET`, `ALLOWED_ORIGINS` → `./deploy.sh auth`
>
> **MCP keys + Claude OAuth token are NOT in `.env`.** Activate them from the workspace UI:
> - **Setup wizard** (step 4) → Claude OAuth token
> - **Integrations dashboard** → Telegram, Shopify, Meta Ads, Google Ads, Email IMAP, GA4, Gemini, Seedream, xAI Grok
>
> All of those live in the encrypted store (see [INTEGRATIONS.md](INTEGRATIONS.md)). Existing clients are auto-migrated on the first redeploy and `pm2 logs workspace-api` prints a `PLAINTEXT CLEANUP` banner listing what to remove from `.env`.

### Drive sync (legacy clients only)

**Default for new clients: server-only file storage.** New deploys keep project files in the `project-data` Docker volume only — no `rclone` running, no Drive sync. Backup story is host-level (Hetzner snapshots or `restic` to B2 — see "Backups" below).

**Pre-2026-05 clients** keep the bidirectional Drive sync via the `LEGACY_DRIVE_SYNC=true` flag in their `.env`. `entrypoint.sh` only spins up `rclone` when this flag is true AND `RCLONE_GDRIVE_TOKEN` is set. To switch a legacy client to server-only mode later: drop the flag, redeploy, and migrate any Drive-only files to the project volume manually.

### Backups (server-only mode)

Without Drive sync, project files live only in the Docker `project-data` volume on the VM. Two layers of defence:

**Layer 1 — Hetzner snapshots.** Easiest. Set up a daily snapshot in the Hetzner panel for the entire VM. ~$0.50/mo. Restore = roll back the whole VM. Good for "the box is on fire" but coarse — you can't restore one client without affecting the others on a multi-tenant host.

**Layer 2 — `restic` to Backblaze B2** (recommended for multi-tenant hosts). Per-client snapshot, content-addressed dedup, point-in-time restore. The repo bundles two scripts:

- `ide-template/scripts/restic-backup.sh <ide-name>` — snapshots project + claude + bot logs + integrations into a B2 repo. **Deliberately does NOT include the encryption key** (`/srv/<ide>/secrets/integrations.key`) — see "Integrations master key" below for why. Reads creds from `~/.workspace-admin/restic.env` (mode 0600, root-only). Auto-`init`s the repo on first run, applies retention (7 daily + 4 weekly + 12 monthly) on every run.
- `ide-template/scripts/restic-backup.cron` — drop into `/etc/cron.d/ide-backup-<client>`, fires daily at 03:17.
- `bin/restic-restore.sh <ide-name> [snapshot-id]` — interactive restore wrapper. Defaults to the latest snapshot, restores into `/tmp/ide-restore-<ide>-<ts>/` so you can pick out individual files instead of overwriting the live volume blindly.

**One-time setup** on the host:

```bash
# 1. Install restic (Debian/Ubuntu)
apt install restic

# 2. Create a B2 bucket + application key (read+write to the bucket).

# 3. Drop the env file
mkdir -p ~/.workspace-admin
cat > ~/.workspace-admin/restic.env <<EOF
export RESTIC_REPOSITORY=b2:my-ide-backups:/$(hostname)
export RESTIC_PASSWORD=<long-secret-paste>
export B2_ACCOUNT_ID=<id>
export B2_ACCOUNT_KEY=<key>
EOF
chmod 600 ~/.workspace-admin/restic.env

# 4. Smoke-test
/opt/ide-template/scripts/restic-backup.sh acme

# 5. Wire up cron (one file per client)
sed 's/<CLIENT>/acme/g' /opt/ide-template/scripts/restic-backup.cron > /etc/cron.d/ide-backup-acme
```

**Restore an individual client**:
```bash
~/IDE/bin/restic-restore.sh acme           # latest
~/IDE/bin/restic-restore.sh acme abc123    # specific snapshot id
~/IDE/bin/restic-restore.sh -l acme        # just list snapshots
```

### Integrations master key

`./deploy.sh` automatically generates `/srv/<ide>/secrets/integrations.key` (32-byte hex, mode 0600 root-owned) on first deploy if missing. This is the AES-256-GCM master key for the encrypted credentials store. It's mounted read-only into the container at `/run/secrets/integrations.key`. Two operational notes:

- **Excluded from restic backups by design.** `restic-backup.sh` skips `/srv/<ide>/secrets/` and adds belt-and-braces excludes for `**/integrations.key` and `**/secrets/**`. Keeping the key alongside the ciphertexts it protects defeats encryption-at-rest — anyone who exfiltrates a snapshot would have both halves. If you want disaster-recovery for the key itself, back it up separately (password manager, hardware token, an out-of-band repo).
- **Loss = re-entry, not data loss.** If the key is lost, every user has to re-enter their integrations + Claude OAuth token via the wizard. The encrypted blobs in the snapshot become unreadable, but no plaintext data is gone — that's the point of the design.
- **Rotation.** To rotate the key, `clearClaudeToken` + each integration's "Disconnect" button, replace the file with `openssl rand -hex 32 > /srv/<ide>/secrets/integrations.key`, redeploy, then re-enter via the UI. There is no in-place re-encrypt at the moment.

### Claude credentials — setup-token via the onboarding wizard (recommended)

The bot authenticates with Claude via a long-lived OAuth token (valid **1 year**) generated by `claude setup-token`. As of 2026-05 the token is supplied through the **first-run onboarding wizard** in the browser — it is encrypted at rest with the integrations master key and never has to live in `.env` plaintext.

**On first login** to a fresh deploy, the SetupWizard takes over the screen until the admin has supplied:

1. workspace name + logo
2. assistant name + avatar + backstory + personality sliders
3. Claude OAuth token (paste from `claude setup-token` output)

The token is encrypted via AES-256-GCM into `PROJECT_DIR/.platform.token.enc` (mode 0600). Workspace-api decrypts on demand and injects it into the bot subprocess; nothing else on the system can read it without the master key.

**Generate a token** (run on your local machine, not on the server):
```bash
npm i -g @anthropic-ai/claude-code  # if not installed
claude setup-token
```
Follow the OAuth flow in the browser, then paste the printed token (`sk-ant-oat01-…`) into the wizard step 4. Done — no `.env` edit, no redeploy.

**One token per Claude account.** If two clients share the same Claude.ai account, use the same token for both.

**Rotation / re-entry:** admins can re-enter the wizard at any time from the workspace dashboard (it lets them rotate the token before the 1-year expiry). The wizard is admin-only post-onboarding.

**Token format validation:** the API rejects pastes that don't start with `sk-ant-oat0` so an accidental wrong paste fails at save-time instead of producing a confusing 401 from claude later.

**Audit:** every token set/clear writes one line to `PROJECT_DIR/.platform.audit.log` (HARD_HIDDEN, mode 0600) with timestamp + actor email.

> **Legacy fallback.** `CLAUDE_CODE_OAUTH_TOKEN` in `.env` still works — workspace-api falls back to it if the encrypted store is empty. After moving to the wizard, **remove the variable from your per-client `.env`** to avoid keeping plaintext on disk. Workspace-api logs a warning to PM2 stderr when it detects both copies coexisting.

See [Expired credentials](#expired-credentials-api-error-401) in Troubleshooting if the token is missing or expired.

---

## Step 4 — Verification

### Health check
```bash
curl https://<YOUR_DOMAIN>/auth/health
# Expected: {"ok":true}
```

### CORS headers
```bash
curl -I -H "Origin: https://<YOUR_DOMAIN>" https://<YOUR_DOMAIN>/auth/health
# Expected headers:
# Access-Control-Allow-Origin: https://<YOUR_DOMAIN>
# Access-Control-Allow-Credentials: true
```

### Full flow
1. Open `https://<YOUR_DOMAIN>`
2. Sign in with Google
3. IDE should load — no 401 errors in DevTools console
4. DevTools → Application → Cookies: `<SESSION_COOKIE_NAME>` should be `HttpOnly`

### Bot pm2 crashloop check (automated in deploy.sh step 5b)

`deploy.sh` auto-runs step 5b after the existing health check: samples `pm2 restart_time` for the bot process, sleeps 60s, samples again. If the bot restarted >2 times in that window, deploy exits non-zero with a Telegram alert + structured debug message. Likely causes (per a 2026-05-30 incident):

- **Missing/invalid Claude credentials** — wizard token was never pasted, or the encrypted store has an incomplete entry (missing `refreshToken` or `expiresAt`). Operator pastes a fresh token via the workspace wizard.
- **PostToolUse hook crashes** — `/opt/ide/hooks/*.sh` errors out on every fire. Check `docker exec <container> bash -c 'jq . ~/.claude/settings.json'` and `cat /opt/ide/hooks/post-write-memory.sh`.
- **Malformed settings.json** — `jq` chokes on the file, claude exits at session-start. Fix: `docker exec <container> jq . ~/.claude/settings.json` to see the parser error.

Manual check (if you skipped deploy.sh or want to re-verify):

```bash
ssh root@<HOST> "docker exec -u coder <CONTAINER> bash -c 'export PM2_HOME=/home/coder/.pm2; pm2 list | grep <BOT_NAME>'"
```

Look for `status: online` and `restarts < 3` (a healthy bot has near-zero restarts after the initial cold-start cycle).

---

## Step 5 — Firewall check (critical)

```bash
ssh root@<SERVER_IP>
netstat -tulpn | grep -E ':8080|:3002'
```

These ports must NOT be on `0.0.0.0`. Only `80` and `443` should be public:
```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw deny 8080
ufw deny 3002
ufw enable
```

---

## Updating an existing deployment

Deployments don't auto-update. To pull the latest code, re-run the deploy from the client dir — it rebuilds the images on the server and swaps containers with no data loss:

```bash
cd clients/<your-client> && ./deploy.sh
```

- New env vars from the template are auto-filled by `bootstrap-client-env.sh`; existing values and generated secrets are preserved.
- Activated integrations stay active — their credentials live in the encrypted store, not in the image.
- The bot restarts (~5–10 s); memory and project files survive.
- Idempotent: safe to re-run if a deploy is interrupted.

> Watch this repository's releases for security fixes. A public deployment that lags behind a published fix is exposed — a public patch is also a public disclosure.

## Adding or removing a team member

Two ways:

- **From the workspace (no deploy):** open the **Team** dashboard and add the person's Google email. Takes effect immediately.
- **From `.env` (needs a deploy):** edit `IDE_ALLOWED_EMAILS` (comma-separated; first = admin) in `clients/<your-client>/.env`, then `./deploy.sh auth`.

The new member just signs in with Google at the workspace URL — the OAuth redirect URI is per-domain, so no per-user setup is required.

> Backups & restore (Hetzner snapshots / restic to B2) are covered above under [Backups](#backups-server-only-mode). Credential rotation lives in [INTEGRATIONS.md](INTEGRATIONS.md) (per-integration) and the wizard (Claude token).

---

## Troubleshooting

**401 in iframe:**
```bash
docker logs <IDE_NAME>-auth --tail=50
```
Check that `SESSION_COOKIE_NAME` in `.env` matches what the browser stores.

**CORS error:**
Check `ALLOWED_ORIGINS` in `.env` — must exactly match the origin including `https://`.

**TLS cert not issuing:**
Caddy auto-issues via Let's Encrypt. Check DNS propagated first (`dig <YOUR_DOMAIN>`), then:
```bash
docker logs <IDE_NAME>-caddy --tail=50
```

**Code-server not loading:**
```bash
docker exec <IDE_NAME> curl -s http://localhost:8080
docker logs <IDE_NAME> --tail=50
```

**Google Drive shows wrong/random files in IDE** (legacy clients with `LEGACY_DRIVE_SYNC=true` only):

The IDE shows files from the wrong location — usually the root of My Drive instead of the client's folder. Cause: `CORPORATE_FOLDER_ID` was empty or not set when the container started.

1. Check what folder ID rclone is using:
   ```bash
   ssh root@<SERVER_IP> "docker exec <IDE_NAME> cat /home/coder/.config/rclone/rclone.conf"
   # Look for root_folder_id= — should match the Drive folder ID from the URL
   ```
2. If it's empty, set `CORPORATE_FOLDER_ID` in `clients/<client>/.env`:
   ```env
   CORPORATE_FOLDER_ID=1yHUow9qWZ1NKluEk-i3MDsSKP_pOs1uk
   # ^ get this from the Drive URL: drive.google.com/drive/folders/<THIS_PART>
   ```
3. Redeploy `code-server` (not just `frontend` — rclone runs inside this container):
   ```bash
   ./deploy.sh code-server
   ```
4. After restart, verify sync started correctly:
   ```bash
   ssh root@<SERVER_IP> "docker exec <IDE_NAME> cat /tmp/rclone.log | tail -20"
   ```

**Drive sync failing silently** (legacy clients only):
```bash
ssh root@<SERVER_IP> "docker exec <IDE_NAME> cat /tmp/rclone.log"
ssh root@<SERVER_IP> "docker exec <IDE_NAME> cat /tmp/rclone-download.log"
```
Common causes: expired rclone token (regenerate with `rclone authorize "drive" ...` and update `RCLONE_GDRIVE_TOKEN`), or wrong `CORPORATE_FOLDER_ID` (folder not accessible by the OAuth account).

**Telegram bot not responding / missing messages:**

The bot runs as a single PM2 process (`bot.sh`) which starts Claude in tmux with `--channels plugin:telegram@claude-plugins-official`. Use the runbook below to diagnose quickly.

---

### Bot Troubleshooting Runbook

**Step 1 — Check what Claude sees in tmux**

This is always the first thing to check. It tells you the actual error.

```bash
docker exec -u coder <IDE_NAME> tmux -L <BOT_NAME> capture-pane -t <BOT_NAME> -p | tail -30
```

| What you see | Diagnosis | Fix |
|---|---|---|
| `Listening for channel messages` | Bot is up | Send a test message |
| `API Error: 401` | OAuth token expired | See "Expired credentials" below |
| `Trust this folder` / theme prompt | Stuck on prompt | Send Enter: `docker exec -u coder <IDE_NAME> tmux -L <BOT_NAME> send-keys -t <BOT_NAME> Enter` |
| Nothing / blank | tmux session died | Restart: `docker exec -u coder <IDE_NAME> pm2 restart <BOT_NAME>` |
| `Listening...` but messages queue up and no replies | Bun plugin not actually running (claude has channel scaffold but no Telegram bridge) | Verify: `docker exec <IDE_NAME> pgrep -af bun` — if empty, plugin failed to start. Most common cause: patched `server.ts` has a syntax error (caught 2026-05-23 when the bot.sh patcher's v1-inbound regex compounded duplicates across restarts). Fix: nuke + restore from image staging, then PM2 restart — `docker exec <IDE_NAME> cp /opt/ide/plugins-src/external_plugins/telegram/server.ts /home/bot/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts && docker exec -u coder <IDE_NAME> pm2 restart <BOT_NAME>` |
| Active turn at 30+ min with `Noodling`/`Symbioting` | claude stuck in a megaturn (typically 100+ tool calls) | Either wait or `/restart` via Telegram (or POST `/api/bot/restart`). `/restart` kills the current session — in-flight conversation context is lost but memory cards + RECENT_TELEGRAM snapshot survive. |
| Chromium pegging container CPU > 30 min | playwright-mcp / docs-comments-mcp orphan browser | Should self-resolve in 5 min cycle of bot-browser-watchdog. Manual kill: `docker exec <IDE_NAME> pkill -9 -f /tmp/playwright-mcp-data` (or `docs-comments-profile` for docs-comments). |

**`/restart` slash command** (operator-only): sending `/restart` to the
admin TG chat — or clicking the Restart button in the workspace
Integrations dashboard — triggers a clean PM2 cycle. Plugin sends a
SIGTERM to its parent claude process AND exits itself; tmux session
closes; bot.sh exits; PM2 restarts after 10s with a fresh claude that
re-reads `~/.claude.json` mcpServers. Use this after activating a new
integration so the bot picks up the new tools without a full container
restart. In-process conversation context is lost — long replies in
progress get cut.

**Step 2 — Check PM2 logs for crash loops**

```bash
docker exec -u coder <IDE_NAME> tail -30 /home/coder/.<BOT_NAME>/<BOT_NAME>-out.log
docker exec -u coder <IDE_NAME> tail -20 /home/coder/.<BOT_NAME>/<BOT_NAME>-error.log
```

If the bot is restarting every ~15 seconds and the error log shows `cp: cannot create ... Permission denied` — this is the git pack files bug (read-only files in plugin dir). It is fixed in `bot.sh` (chmod before cp). Make sure the latest `bot.sh` is in the container:

```bash
docker cp /path/to/ide-template/bot/bot.sh <IDE_NAME>:/home/coder/bot.sh
docker exec -u coder <IDE_NAME> pm2 restart <BOT_NAME>
```

---

### Expired credentials (API Error: 401)

**Symptoms:** bot sends "Bot is online and listening" but doesn't respond to messages. tmux pane shows `API Error: 401 — Invalid authentication credentials`.

The Claude OAuth token lasts 1 year, so this should be rare. To rotate:

**Recommended (admin in browser, no SSH):**
1. Run `claude setup-token` on your local machine, copy the printed `sk-ant-oat01-…`
2. Open `https://<frontend-domain>/app/`, sign in as an admin
3. The wizard step 4 / Settings → "Connect Claude" — paste the token, click Save
4. Bot picks up the new token within ~1 minute (workspace-api re-reads on next chat turn; bot via PM2 restart)

The new token is encrypted into `.platform.token.enc` (AES-256-GCM). No `.env` edit, no redeploy.

**Fallback (if the wizard endpoint is itself broken):** put `CLAUDE_CODE_OAUTH_TOKEN=...` in `clients/<client>/.env`, run `./deploy.sh code-server`. The bot reads from env when the encrypted store is empty. Remove the env line afterwards (workspace-api logs a warning while both copies coexist).

**Verify the token is loaded in the container:**
```bash
# Encrypted store path:
docker exec <IDE_NAME> ls -la /home/coder/project/.platform.token.enc
# Should show ~218 bytes, mode 0600, owner coder.

# Or check setup status:
docker exec <IDE_NAME> curl -sf http://localhost:3001/api/setup/status \
  | python3 -c 'import json,sys; print("hasClaudeToken:", json.load(sys.stdin)["state"]["hasClaudeToken"])'
```

---

### Nuclear option — full reset

When all else fails and the bot state is corrupted:

```bash
docker exec -u coder <IDE_NAME> bash -c '
  pm2 kill
  tmux -L <BOT_NAME> kill-server 2>/dev/null || true
  pkill -f "bun server.ts" 2>/dev/null || true
  rm -rf /home/coder/.<BOT_NAME>/.claude /home/coder/.<BOT_NAME>/.claude.json
'
```

Then restart (the bot picks up `CLAUDE_CODE_OAUTH_TOKEN` from the environment automatically):

```bash
docker exec -u coder <IDE_NAME> bash -c '
  export PATH="/home/coder/.npm-global/bin:/home/coder/.bun/bin:$PATH"
  pm2 start /home/coder/ecosystem.config.js
'
```

---

**PM2 EACCES on log files** — Dockerfile pre-creates log dirs (e.g., `/home/coder/.<bot-name>`) with `coder:coder` permissions. If you add a new `BOT_NAME`, ensure it's added to the Dockerfile `mkdir -p` line.

**Deployment hangs at `Uploading files...`:**
Modern `scp` uses the `sftp` subsystem by default, which can hang on some servers like Hetzner if the subsystem hangs or is misconfigured.
**Fix:** The deployment wrappers (`clients/*/deploy.sh`) exclusively use `scp -O` (legacy SCP protocol) along with `StrictHostKeyChecking=no` to bypass `sftp` hangs and prompts. 

**Missing environment variables in the container:**
`docker-compose.yml` relies on the `.env` file being correctly situated on the remote machine. If you edit your `.env` locally, it won't automatically sync unless told so.
**Fix:** The `deploy.sh` client wrappers now explicitly use `scp -O` to push the latest local `.env` securely to the remote machine *before* invoking `docker compose`, ensuring `IDE_NAME` and `BOT_NAME` are properly injected over.

## MCP Plugins

MCP servers are pre-installed in the Docker image — no downloads at runtime. They activate based on env vars present in `.env`.

See [INTEGRATIONS.md](INTEGRATIONS.md) for full setup guides and troubleshooting for each integration (Shopify, Meta, GA4, Google Ads, Playwright, etc.).

To activate a plugin:
1. Add the required env vars to `clients/<your-client>/.env`
2. Run `./deploy.sh code-server`
3. Verify: ask the bot *"What tools do you have?"*

Plugin activation is driven entirely by env vars — `entrypoint.sh` reads them at container start and registers the corresponding MCP servers into `~/.claude.json`. No `.mcp.json` changes needed.

---

## Security checklist

- [ ] Ports 8080 and 3002 blocked on firewall (internal only)
- [ ] `SESSION_SECRET` is 32+ cryptographically random bytes — generate with `openssl rand -hex 32`
- [ ] `IDE_ALLOWED_EMAILS` is set — at least one email before first deploy
- [ ] `.env` not committed to git
- [ ] TLS active (Caddy auto-manages)
- [ ] `https://<YOUR_DOMAIN>/auth/callback` registered in Google Cloud Console OAuth credentials
