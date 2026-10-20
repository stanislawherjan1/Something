# Setting up Something with an AI coding agent

This runbook is for the **AI coding agent** (Claude Code, Codex, Cursor, …)
installing Something for the person it is talking to. Follow it top to bottom;
every step starts with a check, so you can enter mid-way and resume. If your
task is to *change* this repository instead, this is the wrong file — read
[CLAUDE.md](../CLAUDE.md).

A person doing this by hand wants [QUICK_START.md](QUICK_START.md) (guided)
or [NEW_CLIENT.md](NEW_CLIENT.md) (click-by-click) instead.

## The one hard rule: secrets never enter the chat

Anything typed into the conversation reaches the model and its logs, so:

- **Fine to ask for and handle in chat:** the server IP, the domain, the
  sign-in email addresses, the timezone. These are not secrets.
- **Never ask for, read, echo or log:** the Google OAuth Client Secret (treat
  the ID/secret pair as one), tokens of any kind, private key material. When
  they are needed, have the person run, **in their own terminal window**:

  ```bash
  ./bin/collect-secrets.sh
  ```

  Your own shell has no terminal, so the script will refuse you — by design.
  Verify progress with `./bin/collect-secrets.sh --check`: it prints only
  `set`/`missing` per field (exit 0 = complete, 2 = not yet). Never `cat` or
  `grep` values out of `clients/admin.env`, and never write a secret field
  into any `.env` yourself. If debugging ever seems to need a secret's value
  — the Client ID for a manual OAuth probe, say — it doesn't: have the
  person run the probing command in their own terminal and tell you what it
  printed.
- The Claude token is pasted by the person **into the browser wizard after
  deploy** — never into the chat, never into a file you touch. Never run
  `claude setup-token` yourself, even if the person asks you to handle that
  step: the token prints to whoever runs it.

## Step 0 — tools on this machine

Check: `command -v git ssh scp openssl curl`. Install anything missing
(macOS: `brew install <tool>`; Debian/Ubuntu: `apt-get install <tool>`).
`gcloud` is optional — step 4 has a manual fallback.

Also check provenance: `git remote -v`. If this checkout is not a clone of
the repository the person named, clone that repository fresh and continue
there — you are about to deploy it to their server as root.

## Step 1 — things the person creates in the browser

You cannot do these for them, but don't make them figure it out alone either:
[NEW_CLIENT.md](NEW_CLIENT.md) Part B has the click-by-click for the server
(B1) and DNS (B2), and [QUICK_START.md](QUICK_START.md) the gentler version
with more context. Read the relevant section and relay the clicks in chat one
step at a time — don't guess at console UIs from memory. Wait until the
person confirms each item:

1. **A Linux server** — Ubuntu 24.04, at least 4 GB RAM (e.g. Hetzner CX22 at
   <https://console.hetzner.com>), with **their SSH key added at creation**.
   You need its IP (chat-safe).
2. **A domain or subdomain** with a DNS **A record** pointing at that IP.
   On Cloudflare the record must be **DNS only** (proxy / orange cloud OFF) —
   Caddy on the server terminates TLS itself, and provisioning fails behind
   the proxy. Check: `dig +short <domain>` returns the IP. DNS can take a
   few minutes.
3. **A Google OAuth app** for sign-in (~5 min):
   - Create a project: <https://console.cloud.google.com/projectcreate>
   - Consent screen: <https://console.cloud.google.com/auth/branding> —
     app name + their email, audience **External**. If the whole team is on
     one Google Workspace domain, **Internal** is simpler: the publish step
     below then disappears (Internal apps need no publishing).
   - **Publish the app** (Audience page → "Publish app" → In production).
     Left in "Testing", every non-allow-listed login gets "access blocked" —
     the most common support issue. No review is needed for basic scopes.
     Nothing can verify this remotely, so have the person read the
     publishing status back to you before moving on.
   - Create the client: <https://console.cloud.google.com/auth/clients/create>
     — type **Web application**, redirect URIs **left empty** (step 4 adds
     the exact URI, and preflight verifies it before deploy). QUICK_START
     has the person add the URI already during creation — either order
     works; don't mix the two scripts when relaying.
4. **A paid Claude plan** (Pro or Max) — needed after deploy, in the wizard.

Check for SSH:
`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@<IP> 'echo connected'`
prints `connected` (without `accept-new`, the first-ever contact fails on
the unknown host key even when the person's key is right). Don't run the server-hardening steps yourself — `deploy.sh`
converges the server (Docker, firewall, swap, fail2ban) on every run.

## Step 2 — secrets, in the person's terminal

Check: `./bin/collect-secrets.sh --check` exits 0.

If not: hand the person one ready-to-paste line with the absolute path —
`cd '<checkout path>' && ./bin/collect-secrets.sh` — for their own terminal
(don't assume they know how to find the repo there), and have them paste the
Google Client ID and Secret from step 1.3 at its prompts. It also offers an
optional Google Cloud project ID: only the automated redirect-URI step uses
it, Enter skips. Then re-run the check. Do not open or edit
`clients/admin.env`.

## Step 3 — the client directory

Check: `clients/<name>/.env` exists with the three fields below filled.

Pick a short machine name with the person (e.g. `acme-ide`) — **the folder
name becomes the server path and Docker volume names; renaming later is
painful**. Then:

```bash
cp -r clients/example-client clients/<name>
cp clients/<name>/.env.example clients/<name>/.env
```

Edit `clients/<name>/.env` yourself — these are not secrets:

```env
HETZNER_HOST=root@<server IP>
FRONTEND_DOMAIN=<domain>
IDE_ALLOWED_EMAILS=<admin email>[,<member email>,…]   # first = admin
```

If the team is not on UTC, also set `IDE_TIMEZONE=<IANA zone>` now — daily
rituals freeze their hour when first created, so setting it later leaves them
on the old time. Everything else (names, secrets, cookies) is filled by
`bin/bootstrap-client-env.sh` automatically on deploy. **Do not pre-fill
branding** (`VITE_APP_TITLE`, `BOT_NAME`) — the first-login wizard owns it.

## Step 4 — register the OAuth callback

Check: the `oauth` preflight check — with a caveat. Standalone
`bin/preflight.sh --env-file clients/<name>/.env --json` reports `oauth` as
`warn`, because only `./deploy.sh` loads `clients/admin.env` (where the
Client ID lives) before running preflight. That warn is expected, not a
failure: the real verification is deploy's own preflight, which fails fast —
in seconds, before the build — if the URI isn't registered.

With `gcloud` installed and authenticated **and** the optional project ID
entered in step 2: `./bin/add-redirect-uri.sh <domain>`. Otherwise — the
common case — have the person add it by hand: GCP Console → APIs & Services →
Credentials → their OAuth client → Authorized redirect URIs → ADD URI →
`https://<domain>/auth/callback`.

## Step 5 — deploy

```bash
cd clients/<name> && ./deploy.sh
```

Run it plain — **never pipe `deploy.sh` through `tail`, `head` or anything
else**: the exit code is the signal, and piping loses it. The first build
takes tens of minutes on a small server; that is normal — and longer than
most agent tools wait in the foreground, so run it as a background job with
output **redirected** to a log file (`./deploy.sh > deploy.log 2>&1` —
redirection is not piping; the exit code survives), follow the log, and
judge by the exit code plus the final line.

It starts with preflight (SSH, DNS, OAuth, disk, clean git tree) and fails
fast with a fix hint. On failure, run
`bin/preflight.sh --env-file clients/<name>/.env --json`, fix the failing
check, re-run. Deeper problems: [DEPLOY.md → Troubleshooting](DEPLOY.md#troubleshooting).

Success ends with `Deploy successful! Bot is healthy.` The bot being offline
at this point is expected — it needs the Claude token from the wizard.

Two things never to do on a deployed server: `docker compose down -v`
(destroys the TLS certificate volume; Let's Encrypt allows five per domain
per week) and a second client on the same server (Caddy owns ports 80/443).

## Step 6 — verify and hand off

Check: `curl -sI https://<domain>/ | head -1` returns `HTTP/2 200`.

Then hand off in the person's own words:

1. Open `https://<domain>/app/` and sign in with the first admin email.
2. The setup wizard runs in the browser: name the coworker, describe the
   company, a bit about them — and the Claude token. For that they run, on
   their own computer:

   ```bash
   npm install -g @anthropic-ai/claude-code
   claude setup-token
   ```

   and paste the printed `sk-ant-oat01-…` **into the wizard** (valid a year,
   encrypted on their server). Not into the chat.
3. After the wizard, everything else happens inside the workspace:
   integrations, Telegram, teammates, routines.

Done. Day-2 operations (updates, backups, troubleshooting) live in
[DEPLOY.md](DEPLOY.md).
