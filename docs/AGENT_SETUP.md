# Setting up Something with an AI coding agent

This runbook is for the **AI coding agent** (Claude Code, Codex, Cursor, …)
helping a person install Something. Your role is **navigator, not operator**:
the person runs the installer in their own terminal; you prepare the ground,
brief them on each prompt, watch the installer's state, and help at exactly
the step they are on.

Why this split is firm: agent shells have no terminal, and permission
classifiers routinely refuse to execute a just-cloned repo's scripts — so a
hand-driven copy of the install flow degrades into pasting commands back and
forth, and drifts from the real flow the moment the installer changes. The
installer (`install.sh`) is the single source of truth; you make it easier,
you don't compete with it.

If your task is to *change* this repository instead, this is the wrong file —
read [CLAUDE.md](../CLAUDE.md).

## The one hard rule: secrets never enter the chat

Anything typed into the conversation reaches the model and its logs, so:

- **Fine to ask for and handle in chat:** the server IP, the domain, the
  sign-in email addresses, the timezone. These are not secrets.
- **Never ask for, read, echo or log:** the Google OAuth Client Secret
  (treat the ID/secret pair as one), tokens of any kind, private key
  material. The installer collects the Google credentials itself, at its
  step 1, typed by the person into their own terminal. Never `cat` or
  `grep` values out of `clients/admin.env` or any `.env`. If debugging ever
  seems to need a secret's value, it doesn't: have the person run the
  probing command in their own terminal and tell you what it printed. If
  they paste a secret into the chat by accident, say so and have them
  rotate it at the provider.
- The Claude token is pasted by the person **into the browser wizard after
  deploy** — never into the chat, never into a file you touch. Never run
  `claude setup-token` yourself, even if the person asks you to handle that
  step: the token prints to whoever runs it.

## Step 0 — clone and look around

Clone the repository the person named and check provenance (`git remote -v`)
— if the checkout isn't a clone of that repo, re-clone fresh: it is about to
be deployed to their server as root. Skim [QUICK_START.md](QUICK_START.md)
so you can brief, and check basic tools exist (`command -v git ssh scp
openssl curl`).

## Step 1 — browser work, ahead of the installer

The installer will ask for these; getting them ready first keeps its run
smooth. You cannot click for the person — relay the click-by-click from
[NEW_CLIENT.md](NEW_CLIENT.md) Part B and [QUICK_START.md](QUICK_START.md),
one step at a time; don't guess at console UIs from memory.

1. **A Linux server** — Ubuntu LTS (24.04 and 26.04 are both verified; the
   provider's default image is fine), at least 4 GB RAM (e.g. Hetzner CX22),
   with their SSH key added at creation. Check:
   `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@<IP> 'echo connected'`
   (without `accept-new` the first-ever contact fails on the unknown host
   key). No key at creation? The installer's SSH step can install one using
   the root password — don't fix it by hand.
2. **A domain or subdomain** with a DNS **A record** at that IP. On
   Cloudflare: **DNS only** (orange cloud OFF) — Caddy terminates TLS itself.
   Check: `dig +short <domain>` returns the IP.
3. **A Google OAuth app** for sign-in: project → consent screen (External; or
   Internal when the whole team shares one Google Workspace domain — then no
   publishing is needed) → **publish to "In production"** → a Web-application
   client. Two realities the consoles hide:
   - The **Publish button stays greyed out** until Branding also carries an
     app home page and a privacy-policy link (their own domain is accepted)
     and the developer contact email.
   - Nothing can verify the publishing status remotely — have the person
     read it back to you. Left on "Testing", sign-in later fails with
     "access blocked" (the most common support issue).
4. **A paid Claude plan** (Pro or Max) — used after deploy, in the wizard.

## Step 2 — hand over the installer

Give the person one ready-to-paste line with the absolute path:

```bash
cd '<checkout path>' && ./install.sh
```

Brief them on what it asks, in order: the Google Client ID/Secret (typed
there, never here), the server IP, the domain, their email; the timezone is
detected automatically; a Review card sums everything up before anything is
created; then the build runs 10–30 minutes as a calm phase checklist. Tell
them to keep this chat open and paste anything they're unsure about —
prompts, warnings, whole screens.

## Step 3 — navigate while it runs

Your two instruments (both plain file reads, no script execution):

- **`.install-state`** in the repo root — three lines, `step=`, `status=`,
  `detail=`, overwritten at every transition, never holding a secret.
  Status values: `at-step` (what the person currently sees), `deploying`
  (detail = the current build phase), `stopped`, `failed` (detail = exit
  code), `done` (detail = the workspace URL).
- **`clients/<name>/deploy.log`** — the full build output; on a failure read
  its tail and translate the cause.

Where people typically stall, and what to do:

| State says | Help with |
|---|---|
| step 1 (Google sign-in) | The browser work from step 1 above, incl. the branding gate |
| step 2 (Your server) | SSH menu: option 1 installs a key using the root password |
| step 3 (Your domain) | The A record; Cloudflare proxy OFF; propagation takes minutes |
| step 5 (Review) | The OAuth-callback loop: add `https://<domain>/auth/callback` by hand in the Google console if gcloud isn't set up |
| `failed` during deploy | `deploy.log` tail; the installer's own hints; re-run is safe |

Never run `install.sh` or `deploy.sh` yourself, and never edit a `.env`
(users commonly deny that to agents anyway) — if a value must change, hand
the person a single ready-made command. Re-running the installer is always
safe: it picks up where it left off and never rotates already-saved secrets.

## Step 4 — verify and hand off

Check: `curl -sI https://<domain>/ | head -1` returns `HTTP/2 200`.

Then, in the person's own words: open `https://<domain>/app/`, sign in with
the admin email, and the browser wizard takes over — name the coworker,
describe the company, and paste the Claude token, generated on their own
computer with:

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

pasted **into the wizard** (valid a year, encrypted on their server). Not
into the chat. After the wizard: integrations, Telegram and teammates live
inside the workspace. Day-2 operations: [DEPLOY.md](DEPLOY.md).

## If the installer can't be used

The installer needs a macOS or Linux terminal (Windows: WSL2). In the rare
setup where the person truly cannot run it, fall back to the manual
[NEW_CLIENT.md](NEW_CLIENT.md) flow under the same secret rules — the Google
credentials still go through `./bin/collect-secrets.sh` in their terminal,
never through you. Never pipe `deploy.sh` through anything; run it with
output redirected to a log file.
