# workspace-api

Express server that wraps the Claude Code CLI in an HTTP/SSE API and exposes the project filesystem to the custom React workspace. Lives **inside** the IDE container alongside `claude` (started by PM2 — see `bot/ecosystem.config.js`). nginx in the `frontend` service reverse-proxies `/api/*` here, gated by `auth_request /auth/verify`.

```
browser ── /app/?view=workspace ──▶ frontend (nginx, React SPA)
        ── /api/* ──▶ frontend (nginx, auth-gated) ──▶ code-server:3001 (this process) ──▶ spawn claude -p
                                                                                       └▶ readdir / readFile (~/project/)
                                                                                       └▶ chokidar watcher
                                                                                       └▶ SSE: chat stream · file events · notifications
```

This process also backs the **web side of the bot's cross-surface presence**: it stores per-session chat transcripts, fans out server-pushed notifications (reminders, proactive bot messages), and relays web messages into the bot's tmux session. See the main README's [**Talk to them anywhere**](../../README.md#talk-to-them-anywhere) for the product view.

## Endpoints

The full surface area is documented in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#backend-services) — what follows is the **chat + file group**, which is what most readers come here for. The other route groups follow the same auth model and live alongside in `routes/`: `integrations`, `skills`, `memory`, `team`, `branding`, `setup`, `notifications`, `bot`, `internal`, `docs-comments`.

### Chat (multi-session)

Web chat is **per-session**: each conversation is its own thread with its own Claude `--resume` id, stored append-only under `PROJECT_DIR/.team/users/{actor}/chats/{sessionId}.jsonl` (with an `_index.json` manifest). `actor` is the user's team **slug** (resolved from the auth cookie in `routes/chat.js`), so each user gets their own sessions; the legacy single-user `'default'` history is adopted under the primary admin's slug at startup. Each session resumes its *own* Claude context, so one thread can't bleed into another — see the cross-surface note under `lib/claude.js`.

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Liveness check. Returns `{ ok, project_dir, sessions }`. |
| `POST /api/chat` | One chat turn (SSE over `multipart/form-data`). Fields: `message`, optional `sessionId` (defaults to the most-recently-touched), optional `interrupt`, optional `files[]` uploads. Streams `data:` text deltas plus named events — `session`, `tool_start`, `tool_end`, `image` — then a terminal `done` (carries `session_id` + `sessionId`) or `error`. One in-flight turn per session; `interrupt` SIGTERMs the active turn and replaces it. |
| `GET /api/chat/sessions` | List the actor's chat sessions (id, title, pinned, archived, message count). |
| `POST /api/chat/sessions` | Create a new empty session. Body `{ title? }`. |
| `PATCH /api/chat/sessions/:id` | Rename / pin / archive. Body `{ title?, pinned?, archived? }`. |
| `DELETE /api/chat/sessions/:id` | Archive-delete a session (transcript moved to `chats/archive/`). |
| `GET /api/chat/history?sessionId=&before=&limit=` | Paged transcript for one session (newest-first window). |
| `POST /api/chat/reset` | Writes a topic-break marker and clears the session's stored Claude id, so the next turn starts a fresh context. Body `{ sessionId? }`. |
| `POST /api/chat/sessions/:id/stop` | SIGTERM the in-flight `claude` for that session. |
| `POST /api/chat/sessions/:id/forward-to-telegram` | Push selected assistant messages to the user's Telegram. Body `{ messageIds, note? }`. |

### Files

| Endpoint | What it does |
|---|---|
| `GET /api/files/tree?path=&include_hidden=` | Lazy directory listing. Folders first, then files alphabetically. Each entry: `{ name, type, size?, mtime?, technical? }`. |
| `GET /api/files/read?path=` | Small text file content as JSON. ≤5 MiB; refuses files with null bytes (use `/raw`). |
| `GET /api/files/raw?path=` | Streamed bytes with proper `Content-Type`. ≤25 MiB. Used by `ImageViewer`. |
| `GET /api/files/download?path=` | Same bytes as `/raw` but with `Content-Disposition: attachment` so the browser saves to disk. For directories, streams a zip via `archiver` (lazy, flat memory). RFC 5987 `filename*` form keeps non-ASCII names intact. Backs the file-tree right-click → Download menu item. |
| `POST /api/files/{create,write,mkdir,move}` | Mutations — gated by `resolveSafePath` (rejects `..`, absolute paths, hidden-set leaves). `write` accepts text only and refuses binary. `move` also backs inline rename in the file tree. |
| `DELETE /api/files/delete?path=` | Recursive delete; `resolveSafePath` + HARD_HIDDEN guards apply. |
| `GET /api/files/watch` | Long-lived SSE stream of FS change events from chokidar (`add`/`change`/`unlink`/`addDir`/`unlinkDir`), batched in 100 ms. Heartbeat `: keep-alive` every 30 s so proxies don't close idle. |

## Module layout

Most files stay small and single-purpose; the integration engine under `lib/integrations/` is the one larger subsystem.

```
workspace-api/
├── index.js                 # Express setup, helmet, cookie/actor middleware, route mounting, graceful shutdown
├── package.json
├── lib/
│   ├── config.js            # PORT, PROJECT_DIR, CLAUDE_BIN, size limits, visibility sets
│   ├── files.js             # resolveSafePath, isVisibleEntry, listDir, readTextFile, openRawFile, mimeFor
│   ├── auth.js              # attachActor / requireActor / requireAdmin (reads the auth-service identity)
│   ├── sessions.js          # per-actor session manifest (_index.json): id ↔ title ↔ claudeSessionId
│   ├── chatHistory.js       # append-only per-session JSONL transcripts (+ legacy .chat migration)
│   ├── claude.js            # runClaudeTurn — spawn `claude -p`, parse stream-json, fire text/tool/image callbacks
│   ├── memory-loader.js     # buildCachedPrefix — assembles the cached system-prompt block from memory/
│   ├── recent-snapshot.js   # rolling RECENT_WEB / RECENT_TELEGRAM snapshots (cross-surface awareness)
│   ├── memory-graph.js      # memory wiki → graph (cards, topics, links) for the Memory dashboard
│   ├── memory-grep.js       # search across memory/
│   ├── notify.js            # notifications pub/sub + ring buffer (SSE fan-out)
│   ├── attachments.js       # chat file-upload handling → .attachments/
│   ├── branding.js          # bot name / avatar / logo metadata
│   ├── team.js              # allowed-emails whitelist + audit log
│   ├── setup.js             # first-run wizard state + encrypted Claude token
│   ├── watcher.js           # chokidar + SSE pub/sub (subscribe(res), batched broadcasts)
│   ├── atomic-write.js      # write-tmp-then-rename helper
│   ├── verdict-card-{reader,writer}.js  # structured reminder / verdict card I/O
│   └── integrations/        # broker · catalog · crypto · egress · runtime · store — the integration engine
└── routes/
    ├── health.js            # GET /api/health
    ├── chat.js              # the /api/chat group (turn + sessions, history, reset, stop, forward)
    ├── files.js             # the /api/files/* group
    ├── integrations.js      # /api/integrations — activate / configure / remove (encrypted at rest)
    ├── skills.js            # /api/skills — list / read skill markdown
    ├── memory.js            # /api/memory — graph, grep, prefix, threads, snapshot refresh
    ├── team.js              # /api/team — whitelist CRUD (admin only)
    ├── branding.js          # /api/branding — name / avatar / logo
    ├── setup.js             # /api/setup — first-run wizard, Claude token rotation
    ├── notifications.js     # GET /api/notifications/stream — SSE notification feed
    ├── bot.js               # POST /api/bot/{restart,send} — lifecycle + web→tmux relay
    ├── internal.js          # loopback-only: sync-mcp, notify, chat-session (in-container callers)
    └── docs-comments-login.js  # OAuth/VNC bridge for the Docs Comments integration
```

### `lib/config.js` — visibility tiers

```js
HARD_HIDDEN  // never listed or readable, even with ?include_hidden=true. Credentials + internal state:
             // .integrations, .branding(.json), .platform.* , .allowed-emails* , .email, .google, .env,
             // and .chat (legacy chat store, kept hidden after migration).
SOFT_HIDDEN  // technical / build dirs. Hidden by default; shown when the UI passes ?include_hidden=true:
             // node_modules, .git, dist, .cache, .attachments (chat uploads), the per-bot working folder,
             // memory/ (surfaced via the Memory dashboard), and .claude (surfaced via Configuration).
VISIBLE_DOT  // dot-prefixed entries pinned always-visible. Currently EMPTY — .claude moved to SOFT_HIDDEN
             // once it got its own Configuration dashboard.
```

Any other dot-prefixed entry (e.g. `.team`, where chat transcripts live) falls under the default rule: hidden unless `?include_hidden=true`. HARD_HIDDEN is invisible to the UI by construction — the entries are filtered server-side and never reach the client.

The frontend exposes the SOFT_HIDDEN tier via the **eye** toggle in the sidebar header.

### `lib/files.js` — path safety

`resolveSafePath(rel)` is the only path-handling helper that touches `..`/absolute paths. It returns `null` if the resolved absolute path escapes `PROJECT_DIR`. Every route handler that takes a `path` query param **must** pass it through this function before doing any filesystem call.

### `lib/claude.js` — Claude turn lifecycle

`runClaudeTurn({ message, sessionId, onText, onToolStart, onToolEnd, onImage, onError, onDone })` spawns:

```
claude -p --dangerously-skip-permissions --output-format stream-json \
       --include-partial-messages --verbose \
       --append-system-prompt <cached prefix> --mcp-config /home/bot/.claude.json \
       [--resume <sessionId>]
```

It writes the user message to stdin, parses JSON-per-line from stdout, and fires:

- `onText(delta)` — text deltas (`content_block_delta` / `text_delta`).
- `onToolStart({ id, name })` / `onToolEnd({ id, ok, error })` — drive the tool-chip UI (the old "Iter 2" TODO — now shipped).
- `onImage({ mediaType, data })` — images a tool returns (e.g. Playwright screenshots), rendered inline in the chat. Images from the `Read` tool are skipped — the user already has that file open.
- `onError(message)` on spawn failure or non-zero exit; `onDone({ sessionId })` on clean exit. The session id is captured from the `system/init` event.

Before spawning, it prepends a **cached system-prompt prefix** via `buildCachedPrefix()` (from `lib/memory-loader.js`) — the memory wiki plus the rolling recent-conversation snapshots, assembled so Anthropic prompt-caching hits on every turn. `RECENT_WEB` is **excluded** from the web prefix so one web thread can't bleed into another; `RECENT_TELEGRAM` stays in for cross-surface awareness (the bot can draw on what just happened over Telegram). See `lib/recent-snapshot.js` and [docs/MEMORY.md](../../docs/MEMORY.md).

### `lib/watcher.js` — file events

One process-wide `chokidar` watcher on `PROJECT_DIR`. Filtered with the same `isVisibleEntry` predicate as the tree listing (default visibility — technical/hidden file changes don't generate events even when `include_hidden` mode is on in the UI). Events are batched in a 100 ms window, then `data: { events: [...] }` is fanned out to every subscriber. `subscribe(res)` returns a detacher; routes/files.js calls it on the `/watch` request and detaches on `req.close`.

### Sessions, history & cross-surface snapshots

- `lib/sessions.js` owns the per-actor `_index.json` manifest — each session's id, title, pin/archive flags, message count, and the `claudeSessionId` used for `--resume`.
- `lib/chatHistory.js` appends every turn to `chats/{sessionId}.jsonl` and migrates any legacy `.chat/conversation.jsonl` into the per-session layout on first touch.
- `lib/recent-snapshot.js` rolls the recent tail of each surface into `memory/RECENT_WEB.md` and `memory/RECENT_TELEGRAM.md` (web is aggregated across all per-session files, ordered by timestamp), refreshed on idle (≥10 min) or chat reset — never mid-turn, which would bust the prompt cache.

## Auth model

workspace-api trusts the gateway: nginx in the frontend service auth-gates `/api/*` via `auth_request /auth/verify` before any byte reaches this process — see `frontend/nginx.conf`. Inside, `attachActor` reads the verified identity and `requireActor` / `requireAdmin` (lib/auth.js) gate the route groups; `/api/internal/*` is **loopback-only** (called by in-container helpers like `bot.sh` and `reminder-monitor.sh`, never by a browser). The container network is closed (workspace-api binds to the docker bridge, not the host), so the gate is load-bearing for security.

If you ever expose workspace-api outside the auth-gated path, add API-key checks here.

## Frontend ↔ backend coupling

See `frontend/src/components/workspace/README.md` for the React side. In short:

- `ChatPanel` POSTs to `/api/chat` as multipart (so pasted/attached files ride along) and parses the SSE stream via `fetch` + `ReadableStream` — `data:` lines are text deltas; named events drive the tool chips, inline images, and the terminal `done`/`error`.
- `FileTree` calls `/api/files/tree` recursively (one fetch per opened directory) and includes `?include_hidden=true` when the eye toggle is on.
- `FileViewer` calls `/api/files/read`; `ImageViewer` uses `/api/files/raw` directly as an `<img src=…>`.
- `useFileWatcher` opens an `EventSource` on `/api/files/watch`; `useNotifications` opens a single shared one on `/api/notifications/stream` (mounted once at the workspace shell, feeding the toasts + the Notifications inbox) for reminders and proactive bot messages. Every file event bumps a nonce that components include in their fetch deps to refresh.

## Local dev

```bash
cd ide-template/workspace-api
PROJECT_DIR=/tmp/some-test-dir node index.js   # listens on :3001
```

Then run the React dev server (`cd ../frontend && npm run dev`) — `vite.config.js` proxies `/api` to `localhost:3001`. (For UI-only work, `npm run dev:mock` serves fixtures without a backend.)

## Deploy

`ide-template/deploy.sh` SCPs `index.js`, `package.json`, `lib/`, `routes/` to the server. The Dockerfile copies the whole directory and runs `npm install --production`. PM2 starts it from `bot/ecosystem.config.js` (see the `workspace-api` app block).
