# workspace-api

Express server that wraps the Claude Code CLI in an HTTP/SSE API and exposes the project filesystem to the custom React workspace. Lives **inside** the IDE container alongside `claude` (started by PM2 — see `bot/ecosystem.config.js`). nginx in the `frontend` service reverse-proxies `/api/*` here, gated by `auth_request /auth/verify`.

```
browser ── /app/?view=workspace ──▶ frontend (nginx, React SPA)
        ── /api/* ──▶ frontend (nginx, auth-gated) ──▶ code-server:3001 (this process) ──▶ spawn claude -p
                                                                                       └▶ readdir / readFile (~/project/)
                                                                                       └▶ chokidar watcher
```

## Endpoints

The full surface area is documented in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#backend-services) — what follows is the chat + file group, which is what most readers come here for. Integrations / skills / team / branding / setup live alongside in `routes/` and follow the same auth model.

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Liveness check. Returns `{ ok, project_dir, sessions }`. |
| `POST /api/chat` | One chat turn (SSE). Body `{ thread_id, message }`. Streams text deltas from `claude -p`, then `event: done` with `session_id`. One in-flight turn per thread (concurrent → 409). |
| `GET /api/files/tree?path=&include_hidden=` | Lazy directory listing. Folders first, then files alphabetically. Each entry: `{ name, type, size?, mtime?, technical? }`. |
| `GET /api/files/read?path=` | Small text file content as JSON. ≤1 MiB; refuses files with null bytes (use `/raw`). |
| `GET /api/files/raw?path=` | Streamed bytes with proper `Content-Type`. ≤25 MiB. Used by `ImageViewer`. |
| `GET /api/files/download?path=` | Same bytes as `/raw` but with `Content-Disposition: attachment` so the browser saves to disk. For directories, streams a zip via `archiver` (lazy, flat memory). RFC 5987 `filename*` form keeps non-ASCII names intact. Backs the file-tree right-click → Download menu item. |
| `POST /api/files/{create,write,mkdir,move}` | Mutations — gated by `resolveSafePath` (rejects `..`, absolute paths, hidden-set leaves). `write` accepts text only and refuses binary. `move` is also used by inline rename in the file tree. |
| `DELETE /api/files/delete?path=` | Recursive delete; `resolveSafePath` + HARD_HIDDEN guards apply. |
| `GET /api/files/watch` | Long-lived SSE stream of FS change events from chokidar (`add`/`change`/`unlink`/`addDir`/`unlinkDir`), batched in 100 ms. Heartbeat `: keep-alive` every 30 s so proxies don't close idle. |

## Module layout

Each file is small and single-purpose; nothing here should grow past ~200 lines.

```
workspace-api/
├── index.js                 # Express setup, route mounting, server start, graceful shutdown
├── package.json
├── lib/
│   ├── config.js            # PORT, PROJECT_DIR, CLAUDE_BIN, size limits, visibility sets
│   ├── files.js             # resolveSafePath, isVisibleEntry, listDir, readTextFile, openRawFile, mimeFor
│   ├── sessions.js          # thread_id ↔ claude session_id JSON-mapping
│   ├── claude.js            # runClaudeTurn — spawn `claude -p`, parse stream-json, fire callbacks
│   └── watcher.js           # chokidar + SSE pub/sub (subscribe(res), batched broadcasts)
└── routes/
    ├── health.js            # GET /api/health
    ├── chat.js              # POST /api/chat — busy-set per thread, SIGTERM on client abort
    └── files.js             # the /api/files/* group
```

### `lib/config.js` — visibility tiers

```js
HARD_HIDDEN  // never shown or readable. Credentials. Even include_hidden=true won't surface.
SOFT_HIDDEN  // technical / build dirs (node_modules, .git, dist, .cache…). Hidden by default;
             // shown when the UI passes ?include_hidden=true (the eye toggle in Sidebar).
VISIBLE_DOT  // dot-prefixed entries that are always visible. Currently just `.claude`.
             // Other dot-prefixed (.chat, etc.) are soft-hidden via the default rule.
```

The frontend exposes the SOFT_HIDDEN tier via the **eye** toggle in the sidebar header. HARD_HIDDEN is invisible to the UI by construction — the entries are filtered server-side and never reach the client.

### `lib/files.js` — path safety

`resolveSafePath(rel)` is the only path-handling helper that touches `..`/absolute paths. It returns `null` if the resolved absolute path escapes `PROJECT_DIR`. Every route handler that takes a `path` query param **must** pass it through this function before doing any filesystem call.

### `lib/claude.js` — Claude turn lifecycle

`runClaudeTurn({ message, sessionId, onText, onError, onDone })` spawns `claude -p --output-format stream-json --include-partial-messages --verbose`. It writes the user message to stdin, parses JSON-per-line from stdout, and fires:

- `onText(delta)` for every `stream_event` of type `content_block_delta` with `text_delta` payload.
- `onError(message)` on spawn failure or non-zero exit.
- `onDone({ sessionId })` on clean exit. The session_id is captured from the `system/init` event (or any other event carrying it).

Iter 2 will also surface `tool_use` / `tool_result` for the chip UI.

### `lib/watcher.js` — file events

One process-wide `chokidar` watcher on `PROJECT_DIR`. Filtered with the same `isVisibleEntry` predicate as the tree listing (default visibility — technical/hidden file changes don't generate events even when `include_hidden` mode is on in the UI). Events are batched in a 100 ms window, then `data: { events: [...] }` is fanned out to every subscriber.

`subscribe(res)` returns a detacher; routes/files.js calls it on the `/watch` request and detaches on `req.close`.

## Auth model

workspace-api itself has **no auth check**. nginx in the frontend service auth-gates `/api/*` via `auth_request /auth/verify` before any byte reaches this process — see `frontend/nginx.conf`. The container network is closed (workspace-api binds to the docker bridge, not the host), so the gate is load-bearing for security.

If you ever expose workspace-api outside the auth-gated path, add API-key checks here.

## Frontend ↔ backend coupling

See `frontend/src/components/workspace/README.md` for the React side. In short:

- `ChatPanel` POSTs to `/api/chat` and parses SSE chunks via `fetch` + `ReadableStream` (so the body can carry the JSON payload).
- `FileTree` calls `/api/files/tree` recursively (one fetch per opened directory) and includes `?include_hidden=true` when the eye toggle is on.
- `FileViewer` calls `/api/files/read`; `ImageViewer` uses `/api/files/raw` directly as an `<img src=…>`.
- `useFileWatcher` opens an `EventSource` on `/api/files/watch`; every event bumps a nonce that components include in their fetch deps to refresh.

## Local dev

```bash
cd ide-template/workspace-api
PROJECT_DIR=/tmp/some-test-dir node index.js   # listens on :3001
```

Then run the React dev server (`cd ../frontend && npm run dev`) — `vite.config.js` proxies `/api` to `localhost:3001`.

## Deploy

`ide-template/deploy.sh` SCPs `index.js`, `package.json`, `lib/`, `routes/` to the server. The Dockerfile copies the whole directory and runs `npm install --production`. PM2 starts it from `bot/ecosystem.config.js` (see the `workspace-api` app block).
