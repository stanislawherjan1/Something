# Onboarding a New Client

End-to-end guide for spinning up a new client deployment. Read top-to-bottom on your first run — you ship a working IDE at the bottom. For day-2 ops and full reference, see [DEPLOY.md](DEPLOY.md).

## Mental model

Monorepo, not git forks. Client deployments live in `clients/<name>/` — only `.env` + a one-line `deploy.sh` wrapper. Logo and the rest of the branding go through the in-browser wizard on first login, not the client dir. All code is in `ide-template/`. Fix once, redeploy each client.

`clients/` is gitignored except `example-client/` (template). Real clients live only on the operator's machine.

The bot runs **inside the `code-server` container** as a PM2 process. Nothing runs locally — your machine only runs `./deploy.sh`, which SSHs into the server and builds there.

---

# Part A — One-time operator setup

> **"Operator" = you** — the person who runs the server(s) and deploys the workspace. For a single self-hosted setup, the operator and the end user are the same person; the term only matters when one person manages deployments for several others.

You do this **once for yourself**, not per client. Skip this section on every subsequent client.

## A1. Shared Google OAuth app (`clients/admin.env`)

All clients share one Google OAuth app you maintain. Per-client `.env` does NOT carry `GOOGLE_CLIENT_ID/SECRET` — they live in `clients/admin.env` (gitignored) and `deploy.sh` forwards them automatically.

**If you already have `clients/admin.env` populated, skip to A2.**

Create the OAuth app in Google Cloud Console:

1. <https://console.cloud.google.com> → create a new project (e.g. `ide-shared-oauth`)
2. APIs & Services → OAuth consent screen → External → fill in app name, support email, developer email → Save
3. APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Name: `ide-shared-oauth`
   - Authorized redirect URIs: leave empty for now — `bin/add-redirect-uri.sh` adds them per client
4. Copy the Client ID and Client Secret
5. Note the **Project ID** (top of the GCP console — looks like `ide-shared-oauth-123456`)

Drop them into `clients/admin.env`:

```env
GOOGLE_CLIENT_ID=xxxx-xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
GOOGLE_OAUTH_PROJECT_ID=ide-shared-oauth-123456
GOOGLE_OAUTH_CLIENT_ID=xxxx-xxxx.apps.googleusercontent.com   # same as GOOGLE_CLIENT_ID
```

## A2. `gcloud` CLI

`bin/add-redirect-uri.sh` uses `gcloud` to append callback URIs to the shared OAuth app without you clicking through the GCP UI per client.

```bash
# macOS
brew install --cask google-cloud-sdk
gcloud auth login
gcloud config set project <GOOGLE_OAUTH_PROJECT_ID from A1>
```

Verify: `gcloud auth list` shows the account that owns the project.

> Don't want to install gcloud? You can register each callback URI manually in the GCP console (APIs & Services → Credentials → click your OAuth client → Authorized redirect URIs → ADD URI: `https://<YOUR_DOMAIN>/auth/callback` → Save). Slower but works.

## A3. SSH key on your laptop

You'll add this public key to each Hetzner VPS at creation time so `deploy.sh` can SSH in.

```bash
ls ~/.ssh/id_ed25519.pub 2>/dev/null || ssh-keygen -t ed25519 -C "your@email.com"
cat ~/.ssh/id_ed25519.pub   # this is what you'll paste into Hetzner
```

---

# Part B — Per-client setup

These steps repeat for every new client. Goal: working `https://ide.clientname.com/app/` ready for end-user wizard.

## B1. Buy the Hetzner VPS

In <https://console.hetzner.com>:

1. **Servers → Add Server**
2. Location: closest to the client's primary user base (e.g. `nbg1` = Nuremberg, `hel1` = Helsinki, `ash` = Ashburn US)
3. Image: **Ubuntu 24.04** (recommended; latest stable Debian also works)
4. Type: **CX22** (4 GB RAM, 2 vCPU, ~€4.50/mo) is the cheapest that works; **CPX21** (~€8/mo) builds faster and is fine for 1–7 active users. Bigger if multiple heavy users expected. 4 GB RAM is the floor.
5. Networking: IPv4 + IPv6
6. SSH keys: select the public key from A3 (or **Add SSH key** with `cat ~/.ssh/id_ed25519.pub` content)
7. Name: `ide-clientname` (just for your reference in the panel)
8. Create & buy

Note the IP address. Wait ~30 s for it to boot.

## B2. Buy / point the domain

You need `ide.clientname.com` (or whatever subdomain you'll give the client) resolving to the VPS IP from B1.

**Most common providers:**

### Namecheap

1. Domain List → Manage → **Advanced DNS**
2. Add new record:
   - Type: **A Record**
   - Host: `ide` (or `@` if using the apex domain — usually you want a subdomain)
   - Value: `<IP from B1>`
   - TTL: Automatic
3. Save. Propagation usually ~1–5 minutes.

### Cloudflare

1. Add domain → DNS → Records → **Add record**
2. Type **A**, Name `ide`, IPv4 `<IP from B1>`, **Proxy status: DNS only** (orange cloud OFF — Caddy needs to terminate TLS)
3. Save. Propagation usually <1 minute.

### Other providers (GoDaddy, OVH, etc.)

Find the DNS / DNS records / Zone Editor section and add an A record: `ide` → `<IP>`. Same idea.

**Verify propagation before continuing:**

```bash
dig +short ide.clientname.com
# Expected: <IP from B1>
```

If empty, wait a minute and retry. If still empty after 5 min, the record didn't save — recheck the provider.

## B3. Server bootstrap (Docker + UFW)

Now that the server is up and the SSH key is on it (from B1 step 6):

```bash
ssh -o StrictHostKeyChecking=no root@<SERVER_IP> 'echo connected'
# Should print: connected
```

If you get `Permission denied (publickey)`, your SSH key wasn't added at server creation. In Hetzner panel: server → Security → SSH Keys → Assign your key → recreate the server (or use Hetzner's web console to add the key manually).

Once SSH works, install Docker and configure the firewall:

```bash
ssh root@<SERVER_IP> "curl -fsSL https://get.docker.com | sh"
ssh root@<SERVER_IP> "ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp \
  && ufw deny 8080 && ufw deny 3002 && ufw --force enable"
```

Verify: `ssh root@<SERVER_IP> 'docker --version && ufw status'` — Docker prints a version, UFW shows active.

## B4. Create the client directory

```bash
cd clients/
cp -r example-client clientname-ide
cd clientname-ide
cp .env.example .env
```

The directory name **becomes** `IDE_NAME` and `REMOTE_PATH` (e.g. `clientname-ide` → `/root/clientname-ide` on the server). Pick a stable name; renaming later is painful.

## B5. Add the OAuth callback URI

```bash
./bin/add-redirect-uri.sh ide.clientname.com
```

This appends `https://ide.clientname.com/auth/callback` to the shared OAuth app's authorized list. End-user's first Google sign-in won't work without it.

If you skipped A2 (no `gcloud`): do it manually — GCP Console → APIs & Services → Credentials → your OAuth client → Authorized redirect URIs → ADD URI.

## B6. Fill in `.env` — 3 fields

```env
HETZNER_HOST=root@<SERVER_IP from B1>
FRONTEND_DOMAIN=ide.clientname.com
IDE_ALLOWED_EMAILS=admin@example.com,member1@example.com,member2@example.com
                                  # first = admin, rest = members
                                  # team can also be edited later from the
                                  # Team dashboard inside the workspace
```

That's all. `bin/bootstrap-client-env.sh` (called automatically by `deploy.sh`) auto-fills everything else (`IDE_NAME`, `SESSION_SECRET`, `CODE_SERVER_PASSWORD`, …) on first run. Idempotent — re-running won't rotate secrets.

> **Don't pre-fill branding.** Workspace title, bot name, avatar, personality go through the first-login wizard. Don't set `VITE_APP_TITLE="Acme"` or `BOT_NAME=aria` here — that defeats the wizard.

## B7. Deploy

```bash
./deploy.sh
```

The wrapper:
1. Calls `bootstrap-client-env.sh` (fills missing env fields)
2. Uploads `.env` to the server via `scp`
3. SSHs into the server, builds the Docker images, swaps containers
4. Waits for the health check

Expected output ends with `Deploy successful! Bot is healthy.` (Bot won't be online yet — it needs a Claude token, which the end-user pastes in the wizard. The auth-service + frontend are up.)

If deploy fails: see [DEPLOY.md → Troubleshooting](DEPLOY.md#troubleshooting).

## B8. Verify the deploy

```bash
# Open in browser:
open https://ide.clientname.com/app/

# Or check from CLI:
curl -I https://ide.clientname.com/
# Expected: HTTP/2 200 (Caddy + Let's Encrypt cert provisioned)

ssh root@<SERVER_IP> "docker exec -u coder $IDE_NAME pm2 status"
# Expected: workspace-api online; bot/bot-reminders may be "stopped" until token is set
```

If the browser shows the login page with the workspace neutral logo, you're good — hand off to the end-user.

---

# Part C — Hand-off to the end-user

What to send the end-user (template you can paste into email/Telegram):

> **Your workspace is live: https://ide.clientname.com/app/**
>
> Sign in with the email I added you under (`<their email>`). On first login a 4-step wizard appears:
>
> 1. **Workspace name + logo** — what shows in the browser tab and top bar.
> 2. **Bot name + avatar** — your AI assistant's identity (e.g. "Aria"). Avatar can be uploaded or generated.
> 3. **Backstory + personality** — short paragraph + 4 sliders. The bot uses this to set its tone.
> 4. **Claude OAuth token** — needed for the bot to talk to Claude. Generate one on your computer:
>    ```
>    npm install -g @anthropic-ai/claude-code
>    claude setup-token
>    ```
>    Follow the OAuth flow in the browser. Copy the printed `sk-ant-oat01-…` and paste into the wizard. Token is valid for 1 year, encrypted on the server.
>
> After the wizard, the bot is live. Open **Integrations** in the left sidebar to activate Telegram, Shopify, Meta Ads, Google Ads, GA4, image generation, IMAP — whatever you need. Each integration has its own setup walkthrough inside.
>
> Skills (the "playbooks" the bot follows) are in the **Skills** sidebar item. Default ones are read-only; create your own per-project ones from there.

If the client wants you to do the Claude token step too: run `claude setup-token` on your own laptop (one token per Claude.ai account is fine — reuse across clients) and paste it into the wizard yourself.

---

## Gotchas

- **One server per client** — Caddy owns 80/443. Two clients on one server will conflict.
- **Quote `.env` values with spaces** — `VITE_APP_TITLE=Acme IDE` (unquoted) crashes deploy. Use `VITE_APP_TITLE="Acme IDE"`.
- **Save `.env` before deploying** — the script uploads it as the first step; an unsaved file means old values reach the server.
- **DNS must propagate before deploy** — Caddy provisions TLS by hitting the domain; if DNS isn't live, TLS provisioning fails and you get cert errors. `dig +short` first.
- **SSH key must work before deploy** — verify `ssh root@<IP> 'echo ok'` succeeds. Otherwise the deploy fails 30 s in after the build, which wastes 5 minutes.
- **Folder name = `IDE_NAME`** — `clients/clientname-ide/` becomes the server path `/root/clientname-ide` and the Docker volume names. Renaming later requires manual cleanup on the server.

---

## Legacy / curiosities

- **Google Drive sync** existed on early clients via rclone (`LEGACY_DRIVE_SYNC=true`). New clients use server-side restic backups to B2 instead.
- **`.env`-driven branding** (pre-wizard) is gated by `LEGACY_CONFIG=true`. Drop the flag, redeploy, and the wizard takes over.
