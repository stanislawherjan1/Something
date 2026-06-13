# Quick Start

Go from nothing to a running workspace in about 45–60 minutes — most of it
waiting for a server to boot, DNS to propagate, and the first build to run. No
prior server experience needed; every step is spelled out.

The flow is: rent a small Linux server → point a domain at it → create a
Google sign-in app → run one install command. The installer does the rest.

> Already comfortable with servers and DNS? Skip to
> [Run the installer](#run-the-installer) — the one command guides you through
> the rest. The manual, click-by-click version lives in
> [NEW_CLIENT.md](NEW_CLIENT.md).

> **Prefer to let an AI do the work?** You don't have to do any of this by
> hand. Open this repository in an AI coding assistant —
> [Claude Code](https://www.anthropic.com/claude-code), Cursor, Codex, or
> similar — and ask it to walk you through the install, paste any error back to
> it for a fix, and request changes ("rename the assistant", "add an
> integration") in plain English. You'll still create the accounts in section 1
> yourself; the agent can handle the terminal and the code.

---

## 1. What you need before starting

| Thing | Why | Cost |
|---|---|---|
| A Linux server (VPS) | Your workspace runs here 24/7 | from ~€4.50/mo (Hetzner **CX22**); **CPX21** (~€8) builds faster |
| A domain (or subdomain) | The web address you'll open, e.g. `workspace.yourcompany.com` | You may already own one |
| A Google account | Sign-in is via Google | Free |
| A **paid** Claude plan (Pro or Max) | The assistant runs on Claude; you paste a token after install. **Free Claude accounts can't generate that token.** | from ~$20/mo at [claude.ai](https://claude.ai) |
| Node.js + npm (on your computer) | Used once to generate the Claude token (`claude setup-token`) | Free, [nodejs.org](https://nodejs.org) |
| A Telegram bot token | *Optional* — only if you want to chat on Telegram too | Free, via [@BotFather](https://t.me/BotFather) |

You'll also run the installer from your own computer — **macOS or Linux**. On
Windows, use [WSL2](https://learn.microsoft.com/windows/wsl/install) with Ubuntu
and follow the Linux steps inside it. The installer needs `git`, `ssh`, `scp`,
`openssl`, and `curl` — it checks for these and tells you how to install any
that are missing.

---

## 2. Create your server

We use [Hetzner Cloud](https://console.hetzner.com) in this guide (cheap,
reliable, fast). Any Ubuntu server works, but the steps below are for Hetzner.

> Hetzner asks for a payment method (card or PayPal) at signup before you can
> create a server. The server itself is ~€4.50–8/mo depending on the size.

### 2a. First, make your SSH key  *(on your computer)*

An SSH key is how your computer — and the installer — log in to the server.
**You need it before creating the server**, because you paste it in during
setup. Run this on your computer (macOS or Linux; on Windows use WSL):

```bash
# Creates a key only if you don't already have one — it never overwrites:
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

This prints one line starting with `ssh-ed25519` — **copy that whole line.**
You'll paste it in step 2b. (No passphrase is set, so the installer can log in
without prompting.)

> **Don't want to deal with keys before buying?** Skip this and create the
> server with a **root password** instead (Hetzner emails it to you). When you
> run the installer, pick the *"only has a root password"* option in Step 1 and
> it will generate and install a key for you automatically.

### 2b. Then create the server  *(in your browser)*

1. Sign up / log in at <https://console.hetzner.com>.
2. **Add Server**.
3. **Location:** pick the one closest to you or your team.
4. **Image:** **Ubuntu 24.04**.
5. **Type:** **CX22** (2 vCPU / 4 GB RAM, ~€4.50/mo) is the cheapest that
   works. For faster builds and a bit more headroom, **CPX21** (3 vCPU / 4 GB,
   ~€8/mo). 4 GB RAM is the floor — don't go smaller.
6. **SSH key:** click **Add SSH key** and paste the line you copied in 2a.
7. **Create & Buy**.

After ~30 seconds the server shows an **IP address** (e.g. `203.0.113.4`).
Keep it handy — you'll need it next.

### 2c. Check you can log in  *(on your computer)*

```bash
ssh root@<YOUR_SERVER_IP> 'echo connected'
# Expected: connected   (type "yes" if asked to confirm the fingerprint)
```

If you see `Permission denied (publickey)`, the key wasn't attached at
creation — see [Troubleshooting](#troubleshooting). If your key has a custom
name (not `id_ed25519`), the installer will offer to wire it up for you.

---

## 3. Point your domain

Your workspace needs a web address that resolves to the server's IP. You do
this by adding a **DNS A record** at whoever manages your domain.

Decide the address first — usually a subdomain like
`workspace.yourcompany.com`.

### Cloudflare
1. Select your domain → **DNS** → **Add record**.
2. **Type:** `A` · **Name:** `workspace` (the subdomain part) ·
   **IPv4 address:** `<YOUR_SERVER_IP>`.
3. **Proxy status: DNS only** (grey cloud, *not* orange) — the server needs to
   terminate HTTPS itself.
4. **Save**. Live in under a minute.

### Namecheap
1. **Domain List → Manage → Advanced DNS**.
2. **Add New Record:** Type `A Record` · Host `workspace` ·
   Value `<YOUR_SERVER_IP>` · TTL Automatic.
3. **Save**. Live in ~1–5 minutes.

### GoDaddy (and most others)
1. Find **DNS** / **Manage DNS** / **DNS Records**.
2. Add a record: Type `A` · Name/Host `workspace` · Value/Points to
   `<YOUR_SERVER_IP>`.
3. **Save**.

### Verify it worked

```bash
dig +short workspace.yourcompany.com
# Expected: <YOUR_SERVER_IP>
```

No `dig`? Install it (`brew install bind` on macOS, `sudo apt install dnsutils`
on Linux), or use `nslookup workspace.yourcompany.com`, or just wait ~2 minutes
and move on.

If it's empty, wait a minute and try again. **Don't continue until it prints
your server IP** — the HTTPS certificate can't be issued otherwise.

---

<a id="google-oauth"></a>

## 4. Google OAuth setup

This lets people sign in to your workspace with their Google account. It's the
fiddliest step — follow it closely. ~5 minutes.

> Already have a shared OAuth app from a previous install? You only need to add
> this domain's redirect URI (step **c** below) and can reuse the same Client
> ID / Secret.

**a. Create a project**
- Go to <https://console.cloud.google.com>.
- Top bar → project dropdown → **New Project** → name it (e.g.
  `workspace-login`) → **Create**, then select it.

**b. Create the OAuth client**
- **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
- If prompted to configure the consent screen first, do step **d** first, then
  come back here.
- **Application type:** **Web application**.
- **Name:** anything (e.g. `workspace`).

**c. Add the redirect URI**
- Under **Authorized redirect URIs → Add URI**, paste exactly:
  ```
  https://workspace.yourcompany.com/auth/callback
  ```
  (your domain, with `/auth/callback` on the end — no trailing slash).
- **Create**.

**d. Publish the consent screen**
- **APIs & Services → OAuth consent screen**.
- **User type: External** → fill app name + your email where required.
- Set **Publishing status** to **Production** (click **Publish app**), not
  *Testing*. In *Testing* mode only a handful of allow-listed accounts can sign
  in — Production lets your whole team in.
- This app only requests basic `email` / `profile` scopes, so Google publishes
  it immediately — **no app review or verification needed**. (If a login ever
  shows "This app isn't verified", re-check the status really is Production.)

**e. Copy your credentials**
- Back in **Credentials**, open your OAuth client.
- Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the
  **Client Secret** (starts with `GOCSPX-`). The installer asks for both.

---

<a id="run-the-installer"></a>

## 5. Run the installer

From your own computer, run:

```bash
curl -fsSL https://raw.githubusercontent.com/stanislawherjan1/Something/main/install.sh | bash
```

It walks you through four short steps:

- **Step 0 — Google sign-in:** paste the Client ID and Secret from step 4e.
- **Step 1 — Server:** paste your server's **IP** (copied straight from Hetzner — `root@` is assumed). It checks it can connect.
- **Step 2 — Domain:** paste `workspace.yourcompany.com`. It checks DNS.
- **Step 3 — Admin email:** the Google account you'll sign in with.
- **Step 4 — Deploy:** it builds everything on the server and waits for the
  health check.

The first deploy takes a few minutes (it builds the container images on the
server). When it finishes you'll see your workspace URL and the next steps.

> The installer only orchestrates scripts already in the repo — it writes your
> three answers into a config file and calls the existing deploy. Nothing is
> hidden; re-running it is safe (it's idempotent).

---

## 6. First login

1. Open **https://workspace.yourcompany.com** and sign in with your admin
   Google account.
2. A short **wizard** appears — set the workspace name, logo, the assistant's
   name, and personality.
3. **Claude token.** The wizard asks for one so the assistant can think.
   Generate it on your computer (needs Node.js installed and a **paid Claude
   plan — Pro or Max**; free accounts can't generate a token):
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude setup-token
   ```
   Follow the browser flow, copy the printed `sk-ant-oat01-…` value, and paste
   it into the wizard. (Valid ~1 year, stored encrypted on your server.)
4. **Add integrations.** Open **Integrations** in the sidebar to connect tools
   — Shopify, Gmail, Google Ads, image generation, and more. Each has its own
   setup walkthrough.
5. **Telegram (optional).** In **Integrations → Telegram**, paste a bot token
   from [@BotFather](https://t.me/BotFather) to chat with your assistant there
   too — same memory, same context.

That's it. Your assistant is live.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser: **connection refused** / page won't load | DNS not pointing at the server, or the firewall is blocking 80/443 | Re-check `dig +short <domain>` returns your server IP. Open ports: `ssh root@<IP> "ufw allow 80/tcp && ufw allow 443/tcp"`. Give TLS a minute to issue on first load. |
| `ssh: Permission denied (publickey)` | Your public key isn't on the server | Add it: `ssh-copy-id root@<IP>` — then retry. (Or in Hetzner: Server → Rescue/Console to add the key, or recreate the server with the key attached.) |
| SSH works with `ssh -i ~/.ssh/<key>` but **not** plain `ssh` | Your key has a non-default name, so `ssh` doesn't try it | The installer offers to fix this; or add to `~/.ssh/config`: `Host <IP>` / `IdentityFile ~/.ssh/<key>` / `IdentitiesOnly yes`. Then `ssh root@<IP> 'echo ok'` works without `-i`. |
| Google: **`redirect_uri_mismatch`** at login | The callback URL isn't registered on your OAuth client | In Google Console → **Credentials** → your OAuth client → **Authorized redirect URIs**, add exactly `https://<your-domain>/auth/callback` (no trailing slash) and save. See [Google OAuth setup](#google-oauth). |
| Signed in, but **the bot doesn't reply on Telegram** | No Telegram token set | Open **Integrations → Telegram** in the workspace and paste a bot token from [@BotFather](https://t.me/BotFather). |
| Deploy **times out or fails partway** | Transient network/build hiccup, or DNS/Docker wasn't ready | Just run it again — the deploy is idempotent: `./clients/<your-domain>/deploy.sh`. Confirm Docker is installed (`ssh root@<IP> 'docker --version'`) and DNS resolves first. |
| Deploy fails: **`no space left on device`** | Server disk filled with old build cache | `ssh root@<IP> "df -h"` to check, then `ssh root@<IP> "docker builder prune -af"` to free space — or pick a larger Hetzner plan. |

Still stuck? See the full operations reference in [DEPLOY.md](DEPLOY.md) and the
end-to-end manual walkthrough in [NEW_CLIENT.md](NEW_CLIENT.md).
