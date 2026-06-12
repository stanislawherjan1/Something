# Something — Technical Architecture

**Deep dive into system design, components, and implementation details**

---

## Table of Contents

- [System Overview](#system-overview)
- [Component Architecture](#component-architecture)
- [Data Flow](#data-flow)
- [Network Architecture](#network-architecture)
- [Authentication System](#authentication-system)
- [File Synchronization](#file-synchronization)
- [Frontend Architecture](#frontend-architecture)
- [Backend Services](#backend-services)
- [Deployment Architecture](#deployment-architecture)
- [Performance & Scalability](#performance--scalability)
- [Glossary](#glossary)

---

## Glossary

New to the project? These terms recur throughout the docs.

| Term | What it means |
|---|---|
| **MCP (Model Context Protocol)** | Anthropic's open standard for giving an LLM tools. Each integration (Shopify, Gmail, …) runs as an MCP server exposing specific actions to the assistant. |
| **workspace-api** (wsapi) | The Node.js backend inside the container — file API, chat, integrations, and the credential broker. Runs as its own low-privilege user. |
| **code-server** | VS Code running in the browser; the base of the workspace container. |
| **Caddy** | Reverse proxy in front of everything; terminates HTTPS with an automatic Let's Encrypt certificate. |
| **broker** | An in-process credential server in workspace-api. MCPs fetch decrypted secrets over a local socket using single-use tokens, so plaintext keys never sit in MCP environments. |
| **egress proxy** | A sidecar that filters the container's outbound network against an allowlist, limiting what a compromised MCP could reach or exfiltrate. |
| **setuid runners** | Small C wrappers (`wsapi-runner`, `bot-runner`, `mcp-runner`) that drop each process to a dedicated UID, isolating the parts of the system from one another. |
| **the wizard** | The first-login onboarding flow: workspace name, logo, the assistant's name/personality, and the Claude token. |
| **legacy client** | A deployment predating the wizard that still carries branding/credentials in `.env` (gated by `LEGACY_CONFIG` / `LEGACY_DRIVE_SYNC`). New deploys don't use these. |
| **Phase 2 / Phase 3** | Two security migrations: Phase 2 introduced the broker and split processes across UIDs; Phase 3 moved the Telegram bot to its own UID. |

---

## System Overview

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                           │
│  ┌─────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │
│  │   Google    │  │   Google   │  │  Telegram  │  │   Meta   │ │
│  │    OAuth    │  │    Drive   │  │    API     │  │   API    │ │
│  └─────────────┘  └────────────┘  └────────────┘  └──────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS
                              │
┌──────────────────────────────────────────────────────────────────┐
│                   Hetzner VPS (Docker Compose)                   │
│                                                                  │
│  ports 80/443 ──▶ Caddy (TLS + routing)                         │
│                        │                                         │
│            ▼                                                    │
│       frontend (nginx)                                          │
│       3000 (login SPA)                                          │
│       3001 (IDE proxy)                                          │
│            │                                                    │
│       auth-service:3002 (internal)                              │
│            │                                                    │
│       code-server:8080 (internal)                               │
│            ├── VS Code UI                                       │
│            ├── Claude Code bot (PM2 + tmux)                     │
│            ├── rclone (Google Drive sync)                       │
│            └── MCP servers (shopify, meta, playwright, …)       │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS
                              │
┌──────────────────────────────────────────────────────────────────┐
│                         Client Devices                           │
│         Desktop (Chrome) · Tablet (Safari) · Mobile             │
└──────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | React 19 + Vite 7, Tailwind v4, shadcn / Radix, BlockNote, framer-motion, react-markdown + remark-gfm, lucide-react | SPA — workspace UI + legacy code-server frame |
| **Workspace API** | Node.js + Express | File tree / read / write / watch (SSE), chat stream proxy, integrations + skills CRUD with AES-256-GCM encrypted store |
| **Auth Provider** | Google OAuth 2.0 | OAuth, ID token verification |
| **Reverse Proxy** | Caddy 2 | TLS termination, routing |
| **Gateway** | nginx | Auth proxy, static files |
| **Auth Service** | Node.js + Express | JWT verification, sessions |
| **IDE** | code-server (VS Code) | Web-based IDE |
| **File Sync** | rclone | Google Drive bidirectional sync |
| **Bot** | Claude Code CLI + PM2 + tmux | Telegram AI assistant |
| **Email (mailbox read)** | IMAP client (Node.js, email-mcp) | Pull: bot reads existing Gmail / Zoho / IMAP mailboxes on demand, read-only |
| **MCP servers** | shopify-mcp, meta-mcp, email-mcp, … + npm packages | Claude tool extensions |
| **Container Runtime** | Docker + Docker Compose | Containerization |
| **Hosting** | Hetzner VPS | One server per client |

---

## Component Architecture

### Docker Compose Services

```yaml
services:
  caddy:           # Reverse proxy (TLS termination)
    └─▶ ports: 80, 443 (public)

  frontend:        # nginx + React SPA
    └─▶ ports: 3000 (login), 3001 (IDE proxy)
    └─▶ depends: auth-service

  auth-service:    # Node.js authentication
    └─▶ port: 3002 (internal only)
    └─▶ depends: none (calls Google OAuth via Internet)

  code-server:     # VS Code in browser + bot + MCP servers
    └─▶ port: 8080 (internal)
    └─▶ runs: Claude Code bot (PM2 + tmux), rclone sync, MCP servers
    └─▶ depends: egress-proxy (allowlist enforcement)

  egress-proxy:    # Outbound HTTP CONNECT filter (per-integration allowlist)
    └─▶ port: 3129 (internal, code-server only)
    └─▶ port: 3130 (internal, Playwright bypass)
    └─▶ port: 53/udp (internal DNS forwarder + snoop)
    └─▶ depends: none
```

The `egress-proxy` sidecar is the network egress point. All TCP from any
uid in `code-server` is transparently REDIRECTed by iptables to a local
redsocks instance which CONNECTs through the proxy. The proxy enforces a
hostname allowlist (`/srv/egress/allowed-hosts.txt`, refreshed by
workspace-api on every integration activate). See SECURITY.md "Egress
filtering" for the full design.

### Component Dependencies

```
caddy
  └─▶ frontend:3001
        ├─▶ auth-service:3002 (auth_request)
        └─▶ code-server:8080 (proxy_pass)

frontend (nginx)
  ├─▶ /auth/* → auth-service:3002
  ├─▶ /auth/verify → auth-service:3002/auth/verify (internal)
  └─▶ /* → code-server:8080

auth-service
  └─▶ Google OAuth + JWKS (HTTPS, external)

code-server
  ├─▶ Google Drive API (rclone, HTTPS, external)
  └─▶ Anthropic API (Claude Code, HTTPS, external)
```

---

## Data Flow

### Login Flow (Detailed)

```
┌─────────┐
│ Browser │
└────┬────┘
     │
     │ 1. GET https://<YOUR_DOMAIN>
     ├──────────────────────────────────────────────────────────▶
     │                                           ┌──────────────┐
     │                                           │ Hetzner VPS  │
     │                                           │ Caddy+nginx  │
     │                          2. HTML + JS ◀───┤ (Frontend)   │
     ◀──────────────────────────────────────────┤              │
     │                                           └──────────────┘
     │ 3. Click "Sign in with Google"
     │
     │ 4. GET /auth/google
     ├──────────────────────────────────────────────────────────▶
     │                                           ┌──────────────┐
     │                                           │ auth-service │
     │  5. Generate state+PKCE, set state cookie │              │
     │  6. Redirect to Google OAuth          ◀───┤              │
     ◀──────────────────────────────────────────┤              │
     │                                           └──────────────┘
     │
     │ 7. GET https://accounts.google.com/...
     ├──────────────────────────────────────────────────────────▶
     │                                           ┌──────────────┐
     │                                           │   Google     │
     │               8. Login form + 2FA ◀───────┤   OAuth      │
     ◀──────────────────────────────────────────┤              │
     │                                           │              │
     │ 9. Submit credentials                     │              │
     ├──────────────────────────────────────────▶│              │
     │                                           │              │
     │     10. Redirect to /auth/callback    ◀───┤              │
     ◀──────────────────────────────────────────┤              │
     │    (?code=xxx&state=xxx)                  └──────────────┘
     │
     │ 11. GET /auth/callback?code=xxx&state=xxx
     ├──────────────────────────────────────────────────────────▶
     │                                           ┌──────────────┐
     │                                           │ auth-service │
     │  12. Verify state (CSRF) + PKCE           │              │
     │  13. Exchange code → id_token             │              │
     │  14. Verify id_token via Google JWKS      │              │
     │  15. Check email in IDE_ALLOWED_EMAILS    │              │
     │  16. Create signed session cookie         │              │
     │                                           │              │
     │  17. Redirect to /app/ + Set-Cookie   ◀───┤              │
     ◀──────────────────────────────────────────┤              │
     │                                           └──────────────┘
     │
     │ 18. Redirect to IDE iframe
     │     (https://<YOUR_DOMAIN>)
     │
     │ 23. GET / (with <SESSION_COOKIE_NAME> cookie)
     ├──────────────────────────────────────────────────────────▶
     │                                           ┌──────────────┐
     │                                           │ Hetzner VPS  │
     │                                           │   (Caddy)    │
     │                                           └──────┬───────┘
     │                                                  │
     │                                           ┌──────▼───────┐
     │                                           │  frontend    │
     │  24. auth_request /auth/verify            │   (nginx)    │
     │                                           └──────┬───────┘
     │                                                  │
     │                                           ┌──────▼───────┐
     │                                           │ auth-service │
     │  25. Verify session (in-memory lookup)    │              │
     │  26. 200 OK                           ◀───┤              │
     │                                           └──────────────┘
     │                                                  │
     │                                           ┌──────▼───────┐
     │                                           │ code-server  │
     │  27. Proxy to code-server                 │   (VS Code)  │
     │  28. Serve VS Code UI                 ◀───┤              │
     │                                           │              │
     │  29. HTML + WebSocket connection      ◀───┤              │
     ◀──────────────────────────────────────────┤              │
     │                                           └──────────────┘
     │
     │ 30. IDE loaded (user sees VS Code)
     │
```

### IDE Request Flow (Every Request)

```
Browser
  │
  │ GET /vscode/file?path=...
  │ Cookie: <SESSION_COOKIE_NAME>=xxx
  │
  ▼
Caddy (Port 443)
  │ TLS termination
  │
  ▼
Frontend nginx (Port 3001)
  │
  ├─▶ auth_request /auth/verify (internal subrequest)
  │     │
  │     ▼
  │   Auth-service (Port 3002)
  │     │ Check session in memory
  │     │
  │     └─▶ 200 OK (valid) OR 401 Unauthorized (invalid)
  │
  ├─▶ If 200 OK: proxy_pass to code-server
  │     │
  │     ▼
  │   Code-server (Port 8080)
  │     │ Serve file
  │     │
  │     └─▶ 200 OK + file content
  │
  └─▶ If 401: return 401 to browser
```

### File Sync Flow (Google Drive)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Code-Server Container                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  /home/coder/project (local filesystem)                 │   │
│  │  ├─ file1.txt                                           │   │
│  │  ├─ folder/                                             │   │
│  │  │   └─ file2.js                                        │   │
│  │  └─ ...                                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│          ▲                                        │             │
│          │                                        │             │
│  ┌───────┴────────┐                      ┌────────▼────────┐   │
│  │  rclone sync   │                      │  inotifywait    │   │
│  │  (download)    │                      │  (file watch)   │   │
│  │  Every 30s     │                      │  On change      │   │
│  └───────┬────────┘                      └────────┬────────┘   │
│          │                                        │             │
│          │ flock /tmp/rclone-sync.lock            │             │
│          │ (shared lock)                          │             │
│          │                                        │             │
│          │                                3s debounce          │
│          │                                        │             │
│          │                                        ▼             │
│          │                              ┌─────────────────┐    │
│          │                              │  rclone sync    │    │
│          │                              │  (upload)       │    │
│          │                              │  On change      │    │
│          │                              └────────┬────────┘    │
│          │                                       │             │
│          └───────────────────────────────────────┘             │
│                                  │                             │
└──────────────────────────────────┼─────────────────────────────┘
                                   │
                                   │ HTTPS (Google Drive API)
                                   │ OAuth token: RCLONE_GDRIVE_TOKEN
                                   │
                                   ▼
                        ┌────────────────────┐
                        │   Google Drive     │
                        │   (Cloud Storage)  │
                        │                    │
                        │  - Corporate files │
                        │  - Root folder ID  │
                        │  - Version history │
                        └────────────────────┘
```

**Lock Mechanism**:
- **Download** (every 30s): Non-blocking lock (`flock -n`)
  - If upload is running: skip this cycle
  - If upload is NOT running: sync Drive → local

- **Upload** (on change): Blocking lock (`flock`)
  - Wait for download to finish
  - Then sync local → Drive

**Prevents**:
- Simultaneous upload + download (file corruption)
- Race conditions (both trying to modify same file)

---

## Process Isolation & Credential Broker

The `code-server` container runs FOUR uids with deliberately narrow
permissions. Three setuid C wrappers (`setuid-wrappers/`) shepherd
processes into the right uid; the credential broker (UDS socket) is how
MCPs reach their secrets without those secrets ever sitting in
`/proc/<pid>/environ`.

### The four uids

| uid | Account | What runs here | What it can read |
|---|---|---|---|
| 1000 | `coder` | code-server, terminal sessions, anything the operator does in the IDE | own files; can traverse to `PROJECT_DIR` (group `workspace`); CANNOT read wsapi secrets, MCP secrets, or bot's OAuth |
| 1001 | `wsapi` | `workspace-api` (HTTP backend) | encrypted credentials store at `/var/wsapi-store/credentials.json`; master AES key at `/run/secrets/integrations.key` (docker secret, mode 0400 wsapi-only); decrypts on-demand per request |
| 1002 | `mcp` | every brokered MCP (Trello, Gdocs, Shopify, etc.) | own files; the broker UDS at `/var/wsapi-store/run/broker.sock` (group `wsapi-broker`); fetches its own credentials per-spawn via nonce; CANNOT read other integrations' creds |
| 1003 | `bot` | `bot.sh` + tmux + claude session + telegram plugin (bun) | own files; `~/.bot/integrations.env` (mode 0660 group=botshare, written by wsapi); `~/.claude/.credentials.json` (Anthropic OAuth token, encrypted-store sourced); CANNOT read wsapi store directly |

`workspace` (gid 1100), `wsapi-broker` (gid 1101), `botshare` (gid 1102)
are the cross-uid bridges. Examples:
- `workspace` (members: coder, wsapi, mcp) — for `PROJECT_DIR` files all
  three need (the user's working files).
- `wsapi-broker` (members: wsapi, mcp) — for the broker socket. coder is
  NOT a member: an operator with shell access can't connect to the
  socket and impersonate an MCP.
- `botshare` (members: bot, wsapi) — for `integrations.env`. wsapi writes
  it on activation; bot reads it at startup. Same group also covers the
  Telegram conversation log so wsapi's snapshot writer can ingest it.

### The three setuid wrappers

PM2 itself runs as coder (uid 1000). It can't `setuid()` to anything
else. Three tiny C programs (~80 lines each) handle the drop:

| Binary | Source | Drops to | Used for |
|---|---|---|---|
| `/usr/local/bin/wsapi-runner` | `setuid-wrappers/wsapi-runner.c` | uid 1001 (`wsapi`) | PM2 spawns `wsapi-runner` instead of `node /opt/ide/workspace-api/index.js`. Wrapper sets `initgroups(wsapi)`, drops uid, then `execve` of node. Does NOT call `prctl(PR_SET_NO_NEW_PRIVS)` — see below. |
| `/usr/local/bin/bot-runner` | `setuid-wrappers/bot-runner.c` | uid 1003 (`bot`) | PM2 spawns `bot-runner` for the Telegram bot, which then runs `bot.sh`. Drops uid, sets `HOME=/home/bot`, execs bash. Also does NOT call `prctl(PR_SET_NO_NEW_PRIVS)` — same reason. |
| `/usr/local/bin/mcp-runner` | `setuid-wrappers/mcp-runner.c` | uid 1002 (`mcp`) | Claude's `~/.claude.json` mcpServers entries set `command: /usr/local/bin/mcp-runner`, `args: [<integration-id>]`. Wrapper translates id → `/opt/ide/apps/<id>-mcp/index.js`, drops uid, sets `PR_SET_NO_NEW_PRIVS`, execs node. Integration id is validated against `[a-z0-9-]{1,32}` — no path traversal. |
| `/usr/local/bin/monitor-runner` | `setuid-wrappers/monitor-runner.c` | uid 1003 (`bot`) | Used by `bot-reminders`, `bot-snapshot`, `bot-browser-watchdog` PM2 entries. Whitelists a small set of script paths under `/opt/ide/` so PM2-as-coder can run them as bot. Sets `PR_SET_NO_NEW_PRIVS`. |

Each wrapper validates its own setuid bit (`stat /proc/self/exe`) and refuses to run if missing — catches deploy regressions where chmod was lost. The mcp-runner additionally rejects arg strings that aren't exact matches in the allowlist regex.

**Two wrappers (mcp-runner + monitor-runner) call `prctl(PR_SET_NO_NEW_PRIVS)` after the uid drop, two don't.** This is a deliberate asymmetry:

- **mcp-runner + monitor-runner are terminal nodes** — they exec a node MCP server or a bash monitor script that never needs to spawn another setuid binary. NoNewPrivs is pure defence-in-depth there.
- **wsapi-runner + bot-runner are orchestrator nodes** — they exec `node workspace-api` / `bash bot.sh` which in turn spawn claude, which spawns mcp-runner. NoNewPrivs on the orchestrator inherits the whole way down the tree, and the kernel then refuses every subsequent setuid exec, including mcp-runner's own setuid drop. The result is broker-mediated MCPs failing to load credentials, silently. Caught and documented on `bot-runner.c` first; carried over to `wsapi-runner.c` in commit `b47344c` after the same trap surfaced on the web side.

The trade-off: wsapi-process and bot-process CAN exec setuid binaries (mcp-runner, bot-runner, system setuid). The realistic threats remain bounded — mcp-runner argv whitelist, bot-runner's hardcoded script path, NOPASSWD sudo stripped — and the privilege drop above is the actual load-bearing security control.

### Credential broker

`workspace-api/lib/integrations/broker.js` binds a Unix domain socket at
`/var/wsapi-store/run/broker.sock` (owner wsapi:wsapi-broker, mode 0660).
Only members of `wsapi-broker` (= wsapi itself + mcp) can connect.

**Spawn-time flow** when claude calls an MCP tool:
1. claude reads `~/.claude.json` mcpServers entry. The entry's `env`
   includes a fresh `BROKER_NONCE` (random base64), `BROKER_INTEGRATION_ID`,
   and `BROKER_SOCKET=/var/wsapi-store/run/broker.sock`. **No plaintext
   credentials.** wsapi rotates the nonce in the mcpServers block on
   every activation/update of the integration.
2. claude spawns the MCP via mcp-runner. mcp-runner drops to uid 1002,
   execs node, MCP boots.
3. Top of `apps/<id>-mcp/index.js`: `await loadCredentials(BROKER_INTEGRATION_ID)`
   from `apps/_shared/broker-client.js`. Client connects to the UDS,
   sends `{ integrationId, nonce }`, broker validates nonce against
   stored grant, returns the decrypted credential map.
4. broker-client populates `process.env.<KEY>` for each credential field.
   The MCP's existing code reads `process.env.SHOPIFY_API_KEY` etc.
   normally — the only change in MCP authoring is the one `await
   loadCredentials(...)` at the top of `index.js`.

**Why this matters operationally:**
- A coder uid with terminal access can read `~/.claude.json` (file
  perms don't gate JSON reading) and see the nonces — but can't connect
  to the broker (not in `wsapi-broker` group) so the nonces are useless.
- `/proc/<mcp-pid>/environ` has BROKER_NONCE + BROKER_INTEGRATION_ID but
  NOT the actual API keys. The keys live in node's heap inside the MCP
  process. To exfiltrate, an attacker would need code execution INSIDE
  the MCP, which is a much higher bar than reading a file.
- Nonces are single-use per spawn (`store.consumeNonce` deletes on
  fetch). Replay attempts fail.
- Master AES key (`/run/secrets/integrations.key`) is a docker secret
  mounted read-only into the container, owned root:root before
  wsapi-runner chowns to 1001:1001 mode 0400. coder cannot read.

The full Phase-2 (broker) + Phase-3 (bot uid split) timeline + threat
coverage matrix is in `SECURITY.md` "Encryption scope" section.

### Claude Code Stop hooks

`bootstrap/claude-settings.json` registers two Stop-event hooks (and one PostToolUse hook) that fire after every claude turn:

| Hook | Event | What it does |
|---|---|---|
| `hooks/verify-denials.sh` | Stop | Scans the assistant's last text for absence-claim patterns ("nie mam X", "doesn't exist", "I don't see Y in my tools", …) and, if the model didn't run any lookup tool (Read/Bash/Glob/Grep/memory_grep) that turn, blocks the response and pushes a feedback string asking it to verify before claiming absence. Appends the offending quote to `memory/patterns/verification-failures.md` so `taste-recall` can show it back next session. |
| `hooks/verify-telegram-reply.sh` | Stop | Detects Telegram-channel turns by `transcript_path` prefix (`/home/bot/*` = bot tmux, `/home/wsapi/*` = web). For Telegram turns, scans the last assistant message for any `mcp__plugin_telegram_telegram__*` tool use. If none, blocks the response and forces the model to reply via the Telegram MCP — closes the silent-failure mode where the response landed in the IDE transcript only and the operator saw nothing. Whitelists internal triggers (`[REMINDER]`, `[REPO_AUDIT_TRIGGER]`, etc.) and explicit silence requests ("tylko zapisz", "don't reply"). |
| `hooks/post-write-memory.sh` | PostToolUse (Write\|Edit on `memory/`) | Fires a Telegram notification with a 200-char preview of the write so the operator sees within seconds what the bot decided to remember. Closes the memory-write feedback loop. |

Both Stop hooks log to `/tmp/verify-{denials,telegram-reply}.log` for live observability — operator can `tail -f` to see when they fire. The hooks exit 0 unless they're blocking; blocking sends stderr back to the model as system feedback and CC re-prompts the model with `stop_hook_active=true` so the hook can't loop.

The PostToolUse hook never blocks — it's fire-and-forget for notifications.

### Per-channel claude config asymmetry — and how the memory prefix gets in

Web side (`workspace-api` → `runClaudeTurn`) and Telegram side (`bot.sh` → tmux interactive `claude`) both run claude, but through different process trees:

- Web spawns `claude -p` per turn. `runClaudeTurn` calls `buildCachedPrefix()` in-process and passes the result via `--append-system-prompt <block>` on each spawn. claude reads settings from `/home/wsapi/.claude/settings.json` (HOME-based) — `entrypoint.sh` deploys `bootstrap/claude-settings.json` content there.
- Telegram spawns a single long-lived interactive `claude --channels plugin:telegram@...` inside tmux. There's no per-turn spawn → no opportunity to inject `--append-system-prompt` per turn. Instead, `bot.sh` curls `GET /api/memory/prefix?raw=1` into `$BOT_HOME/.claude/memory-prefix.txt` at tmux startup and passes `--append-system-prompt-file <path>`. claude reads settings from `/home/bot/.claude/settings.json`, which CC overwrites at startup down to a 120-byte stub — bot.sh runs a background `merge_bot_settings()` watchdog that jq-merges `bootstrap/claude-settings.json` back on top (first 30 s at 5 s intervals, then every 5 min).

Both paths end up with the SAME settings (hooks + `autoMemoryEnabled: false`) and the SAME memory prefix content — just plumbed through different files. The asymmetry exists because tmux's claude is interactive (no per-turn spawn) and CC's first-run code overwrites bot's settings.json (so the watchdog is required to keep hooks alive).

## Telegram Bot Architecture

### Process Model

```
pm2 (process manager, coder user)
└── <BOT_NAME>           ← bot.sh (single bot process)

Inside code-server container:
  tmux socket: /tmp/tmux-1000/<BOT_NAME>
  tmux session: <BOT_NAME>
    └── claude --dangerously-skip-permissions
               --channels plugin:telegram@claude-plugins-official
                 └── bun server.ts  (Telegram plugin, spawned by Claude)
```

### Startup Sequence

1. `entrypoint.sh` starts pm2 → pm2 launches `bot.sh`
2. `bot.sh`:
   - Syncs `.claude.json` + `.claude/` credentials to isolated `$BOT_HOME` (prevents DB lock conflicts with IDE session)
   - Writes Telegram token + `access.json` (allowlist with string IDs) to `$BOT_HOME/.claude/channels/telegram/`
   - Calls `claude plugins enable telegram@claude-plugins-official` with `HOME=$BOT_HOME` (required for bun to spawn)
   - Kills any bun that `plugins enable` may have started
   - Starts fresh tmux session with `claude --channels`
   - Polls tmux pane output — auto-accepts trust/onboarding prompts, waits for "Listening for channel messages"
   - Enters monitoring loop (script alive = pm2 keeps running)
3. Script exits when tmux session dies → pm2 restarts → clean start

### Why `claude plugins enable` is Required

`claude --channels plugin:telegram@...` loads the plugin from Claude's plugin registry. Without `claude plugins enable` having been called first, Claude enters "Listening" mode but never spawns the bun plugin server — messages are silently dropped.

### MCP Config Persistence

`entrypoint.sh` seeds `~/.claude.json` at first boot. After that the file
is owned by `workspace-api`'s `syncMcpServers()` (in
`lib/integrations/runtime.js`), which rewrites the `mcpServers` block on
every integration activate/update/remove. The block is **merged** into
existing entries (not overwritten in full), so MCPs added outside the
catalog flow (e.g. a hand-edited `mcp__manual_thing`) survive.

What's IN the block:
- `command: /usr/local/bin/mcp-runner` (setuid wrapper → drops to uid 1002)
- `args: ["<integration-id>"]`
- `env: { BROKER_SOCKET, BROKER_INTEGRATION_ID, BROKER_NONCE, ... }`

What's NOT in the block (Phase-2 invariant):
- No `API_KEY` / `CLIENT_SECRET` / `TOKEN` plaintext. Credentials are
  decrypted on-demand by the MCP at startup via the broker UDS. The
  nonce in `env` is the only thing claude needs to give the MCP for it
  to fetch its own creds — and the nonce is single-use within a 24h TTL
  bound to one integration id.

This is why `~/.claude.json` is safe to log, snapshot, or paste into a
bug report — even leaked, the nonces in it are useless without access
to the broker UDS (gated by `wsapi-broker` group), and there are no
plaintext credentials anywhere in the file.

See "Process Isolation & Credential Broker" above for the full broker
protocol.

### Two Claude Code consumers, one config source

Two callers spawn the `claude` CLI against the same `/home/bot/.claude.json`:

| Consumer | How it spawns claude | Tool list freshness |
|---|---|---|
| **Bot** (`claude --channels`, PM2 process `${BOT_NAME}`) | Long-lived process in tmux. claude reads `~/.claude.json` ONCE at process start. | Cached for the lifetime of the bot's claude process. New MCPs visible only after PM2 restart (`/restart` slash command or `POST /api/bot/restart`). |
| **Web chat** (`claude -p` spawned per turn by `workspace-api`) | Fresh `claude -p` process per user message. Passes `--mcp-config /home/bot/.claude.json` so the EXACT same file backs both paths. | Per-process startup re-reads the file → newly-activated MCPs ARE available, BUT `--resume <sessionId>` is also passed, and claude's session cache pins the tool list captured at session-creation. Activating a new integration mid-session does NOT add its tools to that session — operator has to start a fresh chat (Reset / "+ New chat") to see them. |

Common confusion: a claude session in the web chat that pre-dates an
integration activation will not see that integration's tools, even though
`claude mcp list` (run inline) reports them as registered. This is
`--resume` semantics, not a bug, and not "two claude codes on the
server" (a hallucination the bot's claude has been observed producing
when asked why a new tool isn't visible).

Workspace-api triggers `pm2 restart ${BOT_NAME}` after `syncMcpServers()` reports a diff (or any Telegram credential touch). Idempotent re-saves (same fields) skip the restart so the active bot session is preserved. The web chat does NOT auto-reset on activation — operator decides when to start a fresh session by clicking **+ New chat** in the sidebar (ChatGPT-style per-topic sessions, see `docs/future-plans/WEB_CHAT_MULTI_SESSION.md` for the design + migration record).

### `/restart` Slash Command

Operator-only command, recognised by a `bot.command("restart", ...)` handler
that `bot.sh` injects into the vendored telegram plugin's `server.ts` at
startup (Patch v3). When the admin sends `/restart`:

1. Plugin ACKs in the chat ("🔄 Restartuję — wracam za chwilę.").
2. Plugin sends `SIGTERM` to its parent process (claude) AND schedules its
   own `process.exit(0)` 800ms later. The `kill(ppid)` is load-bearing —
   without it `process.exit` only kills the bun plugin subprocess and
   claude keeps running, tmux session stays alive, bot.sh's while-loop
   doesn't notice, PM2 never cycles, the bot ends up silent (plugin dead,
   claude orphaned). Caught 2026-05-22.
3. claude exits → tmux pane closes → tmux session has no panes → ends.
4. bot.sh's `while tmux has-session` loop exits.
5. PM2 sees bot.sh exited → restart after 10s.
6. Fresh bot.sh re-reads `~/.claude.json` (incl. any newly-activated MCPs)
   and starts a fresh claude session.

Net effect: 10-15s of bot downtime, then a clean session with whatever
integration changes happened since the last restart. In-flight conversation
state is lost (claude's context window resets); use the memory cards +
RECENT_TELEGRAM snapshot for continuity.

Also reachable from the workspace UI as a button (POST `/api/bot/restart`).
The wsapi route reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ADMIN_CHAT_ID` from
`/home/bot/.bot/integrations.env` (wsapi-managed, mode 0660 group=botshare)
and dispatches `/restart` to the admin chat via the Telegram Bot API — the
plugin then runs the same exit path as a manual TG message. The wsapi
endpoint exists so the operator can recycle the bot from the Integrations
dashboard without context-switching to Telegram.

### Plugin Patcher (bot.sh Python block)

The vendored `claude-plugins-official/telegram/server.ts` ships from the
marketplace and gets monkey-patched at bot startup so it behaves the way
we need. Each patch is keyed by a marker comment (`// CC-BOT-PATCH:
<name>`); `bot.sh` runs through the file once per startup. Two correctness
properties:

- **Idempotent** — applying twice produces the same file. The marker
  presence check (`if marker not in content`) covers most patches.
- **Auto-updating** for patches whose body might change between releases
  (currently `restart command v3`). Those use a strip-and-reapply: detect
  any prior injection by marker + the `{...}` block immediately after,
  delete it, then add the current body. New body propagates on next
  restart; no manual nuke required.

If `/opt/ide/plugins-src/external_plugins/telegram/server.ts` exists but
the in-place copies under `/home/bot/.claude/plugins/{cache,marketplaces}/`
are missing (operator deleted them, partial download), bot.sh self-heals
by copying from the image's read-only staging before patching.

### Tool Permissions

Tool calls (Read, Bash, Edit, MCP tools, etc.) are governed by `~/.claude/settings.json`'s `permissions.allow` list — declarative, not blanket. Default ships with:

```json
{
  "permissions": {
    "allow": ["mcp__*", "Read", "Bash", "Glob", "Grep", "Write", "Edit"],
    "defaultMode": "acceptEdits"
  },
  "skipDangerousModePermissionPrompt": true
}
```

`mcp__*` covers every MCP tool (pattern matches `mcp__<server>__<tool>` names). Bot.sh and `claude.js` (web chat) additionally pass `--dangerously-skip-permissions` for non-interactive operation, but the allow-list remains the source of truth: `workspace-api/lib/claude.js` does NOT auto-approve incoming `permission_request` events — it only logs them so missing entries can be added to `permissions.allow` deliberately.

`--add-dir '$CLAUDE_CONFIG_DIR'` (bot.sh) and `--add-dir <project>/.claude` (claude.js) widen the trusted scope so the assistant can edit `~/.claude/skills/` and `CLAUDE.md` without per-write prompts.

### Claude Instructions — Two-Layer System

Claude's behavioral instructions are split across two layers:

```
~/.claude/CLAUDE.md          ← system layer (deployed by entrypoint.sh from ide-template/global-claude.md)
                                Inherited by all clients, all bots.
                                Contains: Telegram formatting, Drive verification,
                                error handling, scheduling, capability surfacing,
                                file routing, memory usage rules, skills location.

project/.claude/CLAUDE.md    ← client layer (lives in Google Drive, evolves with project)
                                Client-specific: persona, team, project context,
                                active integrations, tone, recurring tasks.
                                Template: clients/example-client/CLAUDE.md.template
```

`bot.sh` copies `~/.claude/` to the bot's isolated home on every start, so both layers are always available to the bot.

**To update system-level rules** — edit `ide-template/global-claude.md`, redeploy.  
**To update client identity** — edit `project/.claude/CLAUDE.md` in the IDE (syncs to Drive automatically).

---

### Knowledge Graph Memory

Each bot has a persistent knowledge graph stored at `/home/coder/.claude/memory.jsonl` on the `claude-data` Docker volume. It survives container restarts and redeploys.

```
memory.jsonl (JSONL format)
  entities   ← nodes: people, files, projects, facts
  relations  ← directed edges: "A → works_on → B"
  observations ← atomic facts attached to entities
```

The bot uses this graph to:
- **Index files** — after saving a file, stores its path and topic coverage so future sessions can `search_nodes("topic")` instead of scanning directories
- **Remember preferences** — user working patterns, decisions, project context that isn't in the code
- **Session continuity** — on session start, queries memory before reading files; on session end, indexes anything new

Each bot has its own isolated graph (separate containers = separate `claude-data` volumes). Bots do not share memory.

---

### Reminder System (end-to-end)

Time-based reminders are split across three components — an MCP for setting/listing/cancelling, a flat-file store, and a polling daemon that fires due ones via Telegram.

```
Claude (web chat or bot)
  │  set_reminder({ title: "Send report", description: "Weekly summary",
  │                 due: "in 2 hours" })
  ▼
apps/reminder-mcp/index.js          ← stdio MCP
  writes ~/project/.reminders.json  ← atomic rename (.tmp → .json)
                                       schema: [{ id, title, description, due,
                                                  repeat, status, created }]
                                       Legacy single-`message` reminders are
                                       auto-split on render (\n → " — " → ":")
  ▲
  │ reads every 60s
bot/reminder-monitor.sh             ← PM2 process `${BOT_NAME}-reminders`
  for each reminder where due ≤ now AND status === 'pending':
    │
    │ Bot session alive?
    │
    ├── Yes ─▶  bot/bot-notify.sh ──▶ inject [REMINDER] line into bot tmux
    │                                  session (tmux send-keys). Bot's
    │                                  `claude --channels` session phrases
    │                                  the reminder and replies in the
    │                                  user's voice via Telegram.
    │
    └── No  ─▶  Direct Telegram fallback — POST to `api.telegram.org/bot…
                /sendMessage` with the bare title + description. Used when
                the bot is mid-restart (integration activation) or the
                tmux session crashed: the reminder still lands, just
                without the bot's elaboration.

  After fire:
    - Repeating reminders (daily/weekly) — `due` rolled forward, status stays 'pending'
    - One-shots — status flipped to 'sent', then garbage-collected on the next tick
```

**Persistence:**
- `.reminders.json` lives at `~/project/.reminders.json` — survives container restarts (project volume on server-only clients, Drive sync on legacy clients)
- The MCP and monitor both read/write the same file with atomic renames so a crash mid-write can't corrupt it
- Memory MCP (knowledge graph) does NOT track reminders — they're a separate system. Don't migrate reminders into memory entities.

**Why a tmux trigger and not a direct Telegram API call?**
The reminder needs to reach the user *with the bot's identity and voice* (so the assistant can elaborate, ask follow-ups, etc.). Firing through the bot's claude session lets the model phrase the reminder and continue the conversation rather than dumping a raw line into the chat.

**Two reminder paradigms in CLAUDE.md** — `global-claude.md` distinguishes:
- `set_reminder` (this MCP) — fires via Telegram independently of any session, used for "remind me at X" / "in 2 hours"
- `Pending Reminders.md` (file in project) — checked at session start, used for "next time we talk" / "don't let me forget"

The bot must use the right one — see [global-claude.md](../ide-template/global-claude.md) "Scheduling & Reminders" + "Session Notes & Pending Reminders".

---

### Telegram Inbound Image Policy

When a Telegram user attaches a photo, the plugin downloads it to `${BOT_HOME}/.claude/channels/telegram/inbox/<ts>-<id>.<ext>` and surfaces the path to claude via the `image_path` attribute on the inbound `<channel>` envelope. Claude Reads the file to understand the content.

**The bot must NOT include that path back in the `reply` tool's `files: []` array.** Doing so makes the bot echo the user's own image back at them — annoying noise. The rule is enforced at the prompt level in [`global-claude.md`](../ide-template/global-claude.md) under the Telegram section: *"read inbound images to understand them, but never re-attach — only attach new files the user doesn't already have."*

This affects only bot replies. The web chat (`/api/chat`) doesn't have this issue because attachments there flow through `multer` + `saveAttachments`, not the Telegram inbox path, and the assistant doesn't attach files back to web chat at all.

---

### What "Bot Restart" Actually Resets

When `restartBot()` fires (via integration activate/deactivate, or a manual `pm2 restart ${BOT_NAME}`), the bot's `claude --channels` session is killed and re-launched. This means:

| State | Survives restart? | Notes |
|---|---|---|
| In-memory conversation context (last user messages, assistant chain-of-thought) | ❌ Lost | New session starts blank — bot doesn't remember what you were just talking about |
| Knowledge graph memory (`~/.claude/memory.jsonl`) | ✅ Survives | Stored on `claude-data` volume; entities + observations are read on demand |
| Pending reminders (`.reminders.json`) | ✅ Survives | Lives in project volume; the monitor PM2 process is also restarted but state is on disk |
| Session notes / `Pending Reminders.md` | ✅ Survives | Project files |
| Telegram message history (user-side) | ✅ Survives | Telegram stores it server-side independently |
| In-flight messages (sent during the ~5–10 s offline window) | ✅ Replayed | Telegram queues messages while the bot is offline and delivers them on reconnect |
| `mcpServers` list | ✅ Updated | The whole point — bot now sees the new/removed MCP |
| `integrations.env` | ✅ Updated | New tokens take effect |

**What this means for the user:** if you ask the bot a complex question and then activate a new integration mid-thought, the bot will lose track of the conversation. Either: (a) finish the current task first, (b) summarise what you were doing into memory ("zapamiętaj że pracujemy nad X") before activating, or (c) accept the reset.

---

## Network Architecture

### Port Mapping

```
External (Internet)
  │
  └─▶ Port 80/443 (HTTP/HTTPS) → Caddy container
                                     │
                                     └─▶ frontend:3000 (internal)
                                     └─▶ frontend:3001 (internal)

Internal (Docker Network)
  │
  ├─▶ frontend:3000 → React SPA (login page)
  │
  ├─▶ frontend:3001 → nginx (IDE proxy)
  │     ├─▶ auth-service:3002/auth/* (public auth endpoints)
  │     ├─▶ auth-service:3002/auth/verify (internal auth_request)
  │     └─▶ code-server:8080 (IDE proxy)
  │
  ├─▶ auth-service:3002 → Node.js (JWT verification)
  │
  └─▶ code-server:8080 → VS Code (IDE)
```

**Security**:
- ✅ Ports 8080 and 3002 NOT exposed to Internet (no `ports:` in docker-compose)
- ✅ Only accessible via Docker bridge network
- ✅ Caddy only routes to frontend:3001 (not code-server directly)

### DNS Configuration

```
<YOUR_DOMAIN>   →  Hetzner VPS (203.0.113.10)   # Caddy terminates TLS and routes to the frontend + backend, all in-container
```

**Caddy Routing**:
```caddyfile
<YOUR_DOMAIN> {
    reverse_proxy frontend:3001
}
```

### Cross-Domain Communication

**Challenge**: Frontend on `<YOUR_DOMAIN>`, backend on `<YOUR_DOMAIN>`

**Solution**:
1. **CORS**: Strict whitelist in auth-service
   ```javascript
   allowedOrigins = ['https://<YOUR_DOMAIN>', ...]
   ```

2. **Cookies**: `SameSite=None` + `Secure` + `Domain=<YOUR_DOMAIN>`
   ```javascript
   res.cookie('<SESSION_COOKIE_NAME>', token, {
       sameSite: 'None',  // Allow cross-domain
       secure: true,      // HTTPS only
       domain: '<YOUR_DOMAIN>' // Shared across subdomains
   })
   ```

3. **Iframe**: React app embeds IDE iframe
   ```jsx
   <iframe src="https://<YOUR_DOMAIN>" />
   ```

---

## Authentication System

### Google ID Token (RS256)

```json
{
  "header": { "alg": "RS256", "kid": "unique-key-id", "typ": "JWT" },
  "payload": {
    "iss": "https://accounts.google.com",
    "aud": "<GOOGLE_CLIENT_ID>",
    "sub": "1234567890",
    "email": "user@example.com",
    "email_verified": true,
    "name": "User Name",
    "picture": "https://lh3.googleusercontent.com/...",
    "iat": 1705315800,
    "exp": 1705319400
  },
  "signature": "base64url(RS256(header.payload))"
}
```

### ID Token Verification (google-auth-library)

```javascript
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);

const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: GOOGLE_CLIENT_ID,   // verifies aud claim
});
const payload = ticket.getPayload();
// payload.email, payload.name, payload.picture, payload.email_verified
```

**What google-auth-library verifies automatically**:
- RS256 signature against Google's public JWKS
- `aud` matches our `GOOGLE_CLIENT_ID`
- `iss` is `accounts.google.com`
- `exp` not expired

### Session (Stateless Signed JWT Cookie)

```javascript
// Create session — signed JWT stored in HttpOnly cookie
function createSessionToken({ email, name, picture }) {
    return jwt.sign({ email, name, picture }, SESSION_SECRET, { expiresIn: '8h' });
}

// Verify session (called on every /auth/verify request)
function verifySessionToken(token) {
    return jwt.verify(token, SESSION_SECRET); // throws if invalid or expired
}
```

**Limitations**:
- Not persisted (restart = all sessions lost)
- Not shared across multiple auth-service instances
- Future: migrate to Redis

---

## File Synchronization

### rclone Configuration

**Token Format** (`RCLONE_GDRIVE_TOKEN`):
```json
{
  "access_token": "ya29.a0AfH6SMBx...",
  "token_type": "Bearer",
  "refresh_token": "1//0eX...",
  "expiry": "2024-01-15T12:00:00Z"
}
```

**Generated with**:
```bash
rclone config
# 1. New remote → "gdrive"
# 2. Choose "drive"
# 3. OAuth flow (opens browser)
# 4. Copy token from ~/.config/rclone/rclone.conf
```

**Runtime Configuration** ([entrypoint.sh:28-36](./entrypoint.sh#L28-L36)):
```bash
cat > /home/coder/.config/rclone/rclone.conf <<EOF
[gdrive]
type = drive
client_id = ${RCLONE_GDRIVE_CLIENT_ID}
client_secret = ${RCLONE_GDRIVE_CLIENT_SECRET}
scope = drive
token = ${RCLONE_GDRIVE_TOKEN}
root_folder_id = ${RCLONE_GDRIVE_ROOT_FOLDER_ID}
EOF
```

### Sync Strategy

**Initial Sync** (on container startup):
```bash
rclone sync gdrive: /home/coder/project \
    --create-empty-src-dirs \
    --log-file /tmp/rclone.log \
    --log-level INFO
```

**Background Download** (every 30 seconds):
```bash
while true; do
    sleep 30
    flock -n /tmp/rclone-sync.lock \
        rclone sync gdrive: /home/coder/project \
            --create-empty-src-dirs \
            --log-file /tmp/rclone-download.log \
            --log-level INFO
done
```

**Instant Upload** (on file change):
```bash
while true; do
    inotifywait -r -q \
        -e modify,create,delete,move \
        /home/coder/project

    sleep 3  # Debounce rapid changes

    flock /tmp/rclone-sync.lock \
        rclone sync /home/coder/project gdrive: \
            --create-empty-src-dirs \
            --log-file /tmp/rclone-upload.log \
            --log-level INFO
done
```

**Graceful Shutdown** ([entrypoint.sh:87-97](./entrypoint.sh#L87-L97)):
```bash
cleanup() {
    kill $DOWNLOAD_PID $UPLOAD_PID

    # Final sync before exit
    rclone sync /home/coder/project gdrive: \
        --create-empty-src-dirs \
        --log-file /tmp/rclone-shutdown.log
}
trap cleanup SIGTERM SIGINT
```

### Conflict Resolution

**rclone behavior**:
- Newer file wins (based on modification time)
- No automatic merging (last write wins)

**Edge case**: User edits file in IDE, someone else edits in Drive simultaneously
- One change will be lost
- Future: add conflict detection (file watcher + Drive API polling)

---

## Frontend Architecture

The frontend is a single-page React 19 + Vite 7 app served by nginx. Two UIs coexist: the custom **WorkspacePage** (three-column: Sidebar / EditorPane / ChatPane — the default) and a legacy **IdeFrame** that wraps the code-server iframe for power users.

For the component tree, view registry, chat streaming, source pills, welcome flow, and theming, see [`frontend/src/components/workspace/README.md`](../ide-template/frontend/src/components/workspace/README.md).

Auth state lives in `AuthContext` ([context/AuthContext.jsx](../ide-template/frontend/src/context/AuthContext.jsx)) which calls `/auth/me` on mount to verify the HttpOnly session cookie. Below 768 px the layout switches to mobile mode via a `useMobile` hook.

The build is a multi-stage Dockerfile (`node:20-slim` → `nginx:alpine`); production bundles ship without source maps.

---

## Backend Services

### Workspace API (Node.js + Express)

Lives at `ide-template/workspace-api/`, started by PM2 (`workspace-api` process), listens on `127.0.0.1:3001` inside the container. nginx proxies `/api/*` here behind `auth_request /auth/verify`.

**Endpoints**:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/files/{tree,read,raw,watch}` | GET | Sidebar file tree, per-file content, image bytes, FS-event SSE stream |
| `/api/files/download` | GET | Download as attachment — single file streams with original `Content-Disposition`, folder streams as a zip (lazy via `archiver`, flat memory). RFC 5987 `filename*` form for non-ASCII names. Backs the file-tree right-click → Download menu item. |
| `/api/files/{create,write,mkdir,move,delete}` | POST/DELETE | Mutations gated by `resolveSafePath` (rejects `..`, absolute paths, hidden-set leaves) |
| `/api/chat` | POST (SSE) | One chat turn against an explicit `sessionId` (falls back to most-recent session for older clients). Wraps `claude -p --output-format stream-json`, forwards text/tool deltas to the browser. **Interrupt + auto-relay**: a new POST with `interrupt: true` mid-turn sends SIGTERM to the in-flight `claude`, persists the partial assistant text to that session's jsonl with `state:'interrupted'`, then spawns a fresh turn `--resume`-ing the same Claude session plus the new user message — the partial stays visible in the UI instead of being cleared. Plain mid-turn POST (no interrupt flag) still kills-and-replaces for legacy clients. Per-session `activeBySession` map + generation counter keeps the dying turn's `onClose` from wiping the fresh entry. Text deltas across multiple `content_block`s are joined with `\n\n` so paragraphs after a tool call don't run together. Tool-result images are interleaved with text in arrival order via an SSE `image` event. |
| `/api/chat/sessions` | GET / POST | List sessions (sidebar source-of-truth) / create new session. Returns `id`, `title`, `titleSource`, `createdAt`, `lastMessageAt`, `messageCount`, `pinned`, `archived`. `?include=archived` shows the soft-deleted archive accordion. |
| `/api/chat/sessions/:id` | PATCH / DELETE | Rename / pin / archive (PATCH any subset of `title`/`pinned`/`archived`), or soft-delete (DELETE moves the jsonl to `archive/{YYYY-MM}/` and trims the manifest; recoverable for 30d). |
| `/api/chat/sessions/:id/stop` | POST | Interrupt without follow-up — SIGTERMs the active claude proc for that session, persists the partial assistant text with `state:'interrupted'`. |
| `/api/chat/sessions/:id/forward-to-telegram` | POST | Forward selected messages from a web session to the bot's Telegram thread. Phase 6 — currently stub (501) pending TG send wiring. |
| `/api/chat/history` | GET | Page of history for a session (`?sessionId&before&limit`). Backward-compatible: omitted `sessionId` resolves to the most-recent non-archived session. |
| `/api/chat/reset` | POST | Append `--- new topic ---` marker and clear `claudeSessionId` on a session (`{sessionId}` in body — defaults to current). |
| `/api/integrations` | GET | Catalog + active state (redacted summaries — never plaintext, plus non-secret `globalFieldValues` for pre-filling the Settings modal) |
| `/api/integrations/:id` | PUT/PATCH/DELETE | Self-service activate / partial-update / remove. PUT and DELETE encrypt-and-store / wipe credentials end-to-end. **PATCH** is partial-update of an active integration — flips a `globalForMulti` permission toggle (e.g. `EMAIL_ALLOW_SEND`) without rotating credentials, used by the Settings modal so the user doesn't re-paste a password to switch from "drafts only" to "send". All paths AES-256-GCM with the master key from `/run/secrets/integrations.key`, materialise required config files, hot-patch `~/.claude.json` mcpServers, and conditionally `pm2 restart` the bot — PUT/DELETE only when `mcpServers` actually diffs (or for Telegram); PATCH always restarts because the bot caches `writeFile` outputs at process start. Idempotent re-saves keep the bot session alive. See [INTEGRATIONS.md](INTEGRATIONS.md). |
| `/api/skills` | GET | Project + global skill listing merged with origin metadata + frontmatter description |
| `/api/skills/raw` | GET | Read-only fetch of one global skill's SKILL.md |
| `/api/team` | GET/POST/PATCH/DELETE | Team whitelist CRUD — admin-gated, lockout-protected, audit-logged |
| `/api/branding` | GET (public) / PUT/POST | Workspace title + bot name + avatar + personality + backstory; PUT/POST admin-gated |
| `/api/setup/*` | GET/POST/DELETE | First-run onboarding wizard endpoints — open pre-bootstrap, admin-gated post-onboarding, rate-limited 10/min/IP, every write audited |

**Self-validating session** — `lib/auth.js` middleware reads the `ide_session` cookie, verifies the JWT against `SESSION_SECRET` (shared with auth-service via env), and cross-checks against the `X-IDE-User` header from nginx auth_request. Header alone is never trusted: defense-in-depth against in-container forgery (e.g. compromised MCP server talking to localhost:3001). On cookie/header mismatch, the actor is dropped and admin gates reject.

**Encrypted store** lives at `PROJECT_DIR/.integrations/credentials.json` (mode 0600, `HARD_HIDDEN` so the file API never returns it). Append-only audit log at `.integrations/audit.log` records every activate/remove with timestamp + IP.

**Onboarding store** — `PROJECT_DIR/.platform.json` (metadata) + `.platform.token.enc` (AES-256-GCM-encrypted Claude OAuth token, mode 0600) + `.platform.audit.log` (JSONL of every wizard write). Token format pre-validated against `^sk-ant-oat0[0-9]+-`. All HARD_HIDDEN.

**Auto-migration on startup** — `lib/integrations/migration.js` reads legacy env vars and bind-mounted config files, encrypts what it finds, and writes the store + the `mcpServers` block. Idempotent (skips anything the user already activated). After a non-zero migration, logs a per-env-var **PLAINTEXT CLEANUP banner** to PM2 stderr so the operator knows which `.env` lines to remove. Existing clients see their integrations as Active right after the first redeploy with this code, no manual entry needed.

### Auth-Service (Node.js + Express)

**Stack**:
- Express 4.18
- jsonwebtoken 9.0
- jwks-rsa 3.1 (JWKS client)
- cookie-parser 1.4
- express-rate-limit 7.1
- cors 2.8

**Endpoints**:

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/auth/session` | POST | Bearer JWT | Exchange JWT for session cookie |
| `/auth/verify` | GET | Cookie | Verify session (called by nginx) |
| `/auth/session` | DELETE | Cookie | Logout (invalidate session) |
| `/auth/health` | GET | None | Health check |

**Key Features**:
1. **Dual JWT support** (ES256 + HS256)
2. **JWKS caching** (24-hour cache)
3. **Rate limiting** (10 req/15min per IP)
4. **Strict CORS** (explicit origin whitelist)
5. **Generic error messages** (no info leak)

### Code-Server

**Version**: 4.x (latest from Docker image)

**Configuration**:
```bash
code-server \
    --bind-addr 0.0.0.0:8080 \    # Listen on all interfaces (Docker internal)
    --auth none \                  # No authentication (handled by nginx)
    --disable-telemetry \          # Privacy
    --disable-update-check \       # Prevent update nags
    /home/coder/project            # Workspace directory
```

**Extensions**:
- ✅ Anthropic.claude-code (pre-installed)
- ✅ cweijan.vscode-office (PDF, Excel viewer)
- ✅ ide.branding (custom startup behavior)
- ❌ GitHub.copilot (uninstalled)
- ❌ GitHub.copilot-chat (uninstalled)

**Settings Override** ([settings.json](./settings.json)):
- Forced from image on every startup (not persisted in volume)
- Prevents users from changing settings that would break UX

**Claude Authentication**: Claude Code authenticates via `CLAUDE_CODE_OAUTH_TOKEN` (long-lived token, valid 1 year, generated with `claude setup-token`). No `ANTHROPIC_API_KEY` required. The token is injected as an env var via `docker-compose.yml` and inherited by the bot's tmux session.

---


## Deployment Architecture

### Production Stack

```
┌──────────────────────────────────────────────────────────────┐
│                         Internet                             │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     ┌────────────────────┐
                     │   Hetzner VPS      │
                     │                    │
                     │ - Docker host      │
                     │ - Ubuntu 24.04     │
                     │ - 4 GB RAM         │
                     │ - 2 vCPUs          │
                     │ - React SPA +      │
                     │   backend, served  │
                     │   in-container     │
                     └────────────────────┘
                              │
                              ▼
                                       ┌────────────────┐
                                       │ Docker Compose │
                                       │                │
                                       │ ┌────────────┐ │
                                       │ │   Caddy    │ │
                                       │ └────────────┘ │
                                       │ ┌────────────┐ │
                                       │ │  Frontend  │ │
                                       │ │  (nginx)   │ │
                                       │ └────────────┘ │
                                       │ ┌────────────┐ │
                                       │ │Auth-Service│ │
                                       │ └────────────┘ │
                                       │ ┌────────────┐ │
                                       │ │Code-Server │ │
                                       │ └────────────┘ │
                                       └────────────────┘
```

### Deployment Process

**Automated** ([deploy.sh](./deploy.sh)):
```bash
#!/bin/bash
HETZNER_HOST="root@203.0.113.10"
REMOTE_PATH="/root/<IDE_NAME>"

# 1. Upload changed files
scp auth-service/index.js "$HETZNER_HOST:$REMOTE_PATH/auth-service/"
scp Caddyfile "$HETZNER_HOST:$REMOTE_PATH/"

# 2. Stop containers
ssh "$HETZNER_HOST" "cd $REMOTE_PATH && docker compose down"

# 3. Rebuild services
ssh "$HETZNER_HOST" "cd $REMOTE_PATH && docker compose build --no-cache auth-service"

# 4. Start services
ssh "$HETZNER_HOST" "cd $REMOTE_PATH && docker compose up -d"

# 5. Show logs
ssh "$HETZNER_HOST" "cd $REMOTE_PATH && docker logs <IDE_NAME>-auth --tail=50 -f"
```

**Manual**:
```bash
# Connect to server
ssh root@203.0.113.10

# Pull latest code
cd /root/<IDE_NAME>
git pull

# Rebuild and restart
docker compose down
docker compose build --no-cache
docker compose up -d

# Check logs
docker logs <IDE_NAME>-auth -f
docker logs <IDE_NAME> -f
```

---

## Performance & Scalability

### Current Limitations

| Resource | Current | Bottleneck |
|----------|---------|------------|
| **Sessions** | RAM only | Lost on restart, not shared across instances |
| **Auth-service** | 1 instance | Single point of failure |
| **Code-server** | 1 per user | Heavy resource usage (500 MB RAM each) |
| **File sync** | Polling (legacy clients) | High API quota usage |

### Scalability Roadmap

Designed but not implemented — see [docs/future-plans/](future-plans/) for the active drafts. Major items: session persistence to Redis, multi-instance auth-service behind a load balancer, per-user code-server containers, Drive API push notifications instead of rclone polling, zero-downtime deploys via blue-green.

### Performance Metrics

**Current Performance** (1 user, Hetzner CPX21):
- Login time: ~2s (Google OAuth)
- IDE load time: ~3s (first load), ~1s (cached)
- File sync latency: <5s (instant upload), <30s (background download)
- Auth verification: <10ms (in-memory session lookup)

**Resource Usage** (1 user):
- code-server: ~500 MB RAM, ~10% CPU (idle), ~50% CPU (active)
- auth-service: ~50 MB RAM, <1% CPU
- frontend (nginx): ~20 MB RAM, <1% CPU
- caddy: ~30 MB RAM, <1% CPU
- **Total**: ~600 MB RAM (4 GB available)

**Estimated Capacity**:
- Current server: ~5-7 concurrent users
- With optimizations: ~10-15 users
- With per-user containers + autoscaling: 50+ users

---

## References

### Code Documentation

- [Dockerfile](./Dockerfile) - Code-server image
- [docker-compose.yml](./docker-compose.yml) - Service orchestration
- [entrypoint.sh](./entrypoint.sh) - Code-server startup + rclone sync
- [auth-service/index.js](./auth-service/index.js) - Authentication service
- [frontend/nginx.conf](./frontend/nginx.conf) - nginx configuration
- [Caddyfile](./Caddyfile) - Reverse proxy configuration
- [settings.json](./settings.json) - VS Code settings

### External Documentation

- [code-server](https://github.com/coder/code-server)
- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)
- [rclone](https://rclone.org/docs/)
- [nginx auth_request](http://nginx.org/en/docs/http/ngx_http_auth_request_module.html)
- [Caddy Reverse Proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Docker Compose](https://docs.docker.com/compose/)

