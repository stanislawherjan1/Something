# workspace/ — custom React workspace

The Obsidian × Lovable replacement for the code-server iframe. Three columns: file vault on the left, file/image/Kanban/dashboard view in the middle, chat panel on the right. Lives behind the existing Google-OAuth auth gate.

```
┌── Sidebar (280px) ────┬── EditorPane ────────┬── ChatPane (460px) ─┐
│ Workspace (icon+name) │ Welcome / view       │ Bot avatar + name   │
│ ─────────────────     │                      │ ─────────────────   │
│ Files [eye toggle]    │ <selected file>      │ messages…           │
│   FileTree (lazy)     │ or dashboard         │ composer            │
│ Configuration ▸       │                      │                     │
└───────────────────────┴──────────────────────┴─────────────────────┘
```

The grid resizes smoothly when sidebar/chat collapse — `grid-template-columns` has a `cubic-bezier` transition on the shell. Both panels can hide entirely; small floating buttons (hamburger top-left of EditorPane, bot avatar top-right of the page) bring them back.

## Module layout

### Shell + layout

| File | What it does |
|---|---|
| `WorkspacePage.jsx` | Layout shell. Holds cross-cutting state: `selected`, `showHidden`, `sidebarOpen`, `chatOpen`, `hasStarted`, `pendingMsg`, `pendingThread`, `fileEventNonce`. Manages the welcome → workspace transition. |
| `identity.jsx` | `BrandingProvider` + `useBranding()` hook. Hydrates once from `GET /api/branding` (workspace-api resolves file → env → defaults). Exposes `{ title, botName, botDisplayName, hideIdeText, botAvatarUrl, iconUrl, loaded, reload }`. The `reload` function lets the wizard / onboarding refresh after mutating `PUT /api/branding`. |
| `useFileWatcher.js` | Subscribes to `/api/files/watch` (Server-Sent Events). Returns a `nonce` that bumps on every event batch. Consumers refetch when the nonce changes. EventSource auto-reconnects on transient drops. |
| `SpinningAvatar.jsx` | Reusable bot avatar with a slow-spinning conic-gradient ring. Used in WelcomeScreen, ChatHeader, and the floating "open chat" button. |
| `WelcomeScreen.jsx` | Big centred input shown on every page load before the user does anything. Supports text + attachments; lists the last 5 chat threads as resume cards. Submit transitions to the full workspace. |

### Sidebar

| File | What it does |
|---|---|
| `Sidebar.jsx` | Left column shell: WorkspaceHeader, eye toggle, FileTree, pinned shortcuts (Tasks, Reminders, Gallery, Configuration). |
| `WorkspaceHeader.jsx` | icon.png + brand name + collapse button. Logo uses `rounded-sm` for a tighter look. |
| `FileTree.jsx` | Recursive lazy listing of `/api/files/tree`. Each `DirNode` fetches on first open, refetches when `fileEventNonce` bumps. Right-click on any row opens a `ContextMenu` with **Rename** (inline `RenameInput` replaces the label, optimistic update via `pendingLabel` with rollback on 4xx), **Download** (anchor click on `/api/files/download` so browser handles the save), **Delete** — and on folders also **New file** / **New folder**, which auto-open the folder and render `InlineCreateRow` at the right depth. Long names truncate with ellipsis (`min-w-0` on row + label, `pr-2 → group-hover:pr-9` reserves trash room only on hover). |
| `ContextMenu.jsx` | Lightweight portal-positioned popover used by the file tree right-click menu. Closes on Escape, mousedown outside, scroll, resize, or any item click; reflows itself away from viewport edges. |
| `InlineCreateRow.jsx` | Inline input for new file/folder names. Minimal styling — bottom border that brightens on focus. Used at root via the toolbar's New buttons and inside any `DirNode` when the file-tree context menu fires "New file/folder". Optimistic entry threaded through `optimisticEntry.parentPath` so creating in a sub-folder also paints the new row immediately. |
| `UserMenu.jsx` | Account dropdown at the bottom of the sidebar — theme picker (Light / Dark / System) + Sign out. |

### Centre column

| File | What it does |
|---|---|
| `EditorPane.jsx` | Centre column. View router (`<ActiveView key={viewKey} />`) that picks the right view component for `selected = { path, type }`. The `key` forces a fresh remount when the path changes, avoiding stale state when navigating between files. |
| `EditorHeader.jsx` | Sticky title bar shared across views: icon + title + optional subtitle (next line) + optional meta (right-aligned, e.g. file size, save status, Tasks view toggle). 60px tall, font 16px bold; matches the Sidebar/Chat headers visually. **Path-aware truncation** — if the title looks like a path (`Foo/bar/file.md`), the dir prefix uses `direction: rtl` so `text-overflow: ellipsis` truncates from the **start** (`…/bar/file.md`); the filename (stem + ext) is `flex-shrink-0` so it never gets cut. Trailing slash is rendered as a separate shrink-0 span so RTL bidi can't push it around. |
| `FileViewer.jsx` | Plain-text view of a file via `/api/files/read`. Mono font, refreshes on watcher events. Uses `AbortController` to cancel in-flight fetches when the path changes. |
| `MarkdownEditor.jsx` | BlockNote-based WYSIWYG editor for `.md` files. Loads via `/api/files/read`, debounced save via `/api/files/write` (600ms). Watcher events refresh content only if the local buffer is clean — never clobbers in-progress edits. Save status badge in the header (`Saving…`/`Saved`/`Updated by AI` flash on external edits). Lazy-loaded via `React.lazy` (~500 KB gzip). |
| `ImageViewer.jsx` | `<img src="/api/files/raw?path=…&v=<nonce>">` — busts the browser cache via the nonce when the file changes. |
| `SkeletonLoader.jsx` | Skeleton shimmers for header + body — used as the Suspense fallback while MarkdownEditor lazy-loads, and as a generic loading state in folder views. |

### Views (registered in EditorPane)

| File | When it renders |
|---|---|
| `views/KanbanView.jsx` | `path === 'Tasks.md'`. Reads markdown formatted per the `task-management` skill (`## Column`, `### Card`, `**Owner:** … · **Priority:** …`) and renders it two ways via a header toggle: **List** (default — sections with rounded tile rows, todo dot or `CheckCircle2` for done) and **Board** (kanban columns of cards). View choice persists per-device in `localStorage` (`tasks-view-mode`). Priority is a bare arrow icon (↑ high, — medium, ↓ low) on the far right; owner uses `CircleUserRound`. Meta on Board cards (date / owner / priority) sits in subtle outline-only pills (`rounded-[3px]`, hairline ring, no fill) below the description. Both views share `px-6` so the first column lines up identically; the Board's horizontal scroll happens edge-to-edge inside the same padded container. |
| `views/GalleryView.jsx` | `type === 'dir'` and basename `'generated'`. Thumbnail grid via `/api/files/raw`. Click a tile → ImageViewer. |
| `views/ClaudeDashboard.jsx` | `type === 'dashboard'` (set by the **Configuration** sidebar shortcut). Surfaces project instructions (`CLAUDE.md`), available skills (`.claude/skills/*`), and integration tiles. Skills click through to `SkillsDashboard`. |
| `views/SkillsDashboard.jsx` | `type === 'skills'`. Tile grid of project + global skills with create / edit / delete. Project skills (`PROJECT_DIR/.claude/skills/<name>/`) are editable; global skills (`$HOME/.claude/skills/<name>/`) read-only with a "copy into project to override" banner. SKILL.md lookup is case-insensitive so older `SKILL.MD` skills work too. |
| `views/IntegrationsDashboard.jsx` | `type === 'integrations'`. Self-service activation of every third-party integration (Grok/xAI, Gemini, Seedream, Telegram, Shopify, Meta Ads, Google Ads, Email IMAP+SMTP, GA4, SignWell, Trello, Google Docs, X/Twitter) via an encrypted credentials store. Activate modal renders catalog `steps[]` as markdown with copyable code chips on the left, fields on the right. Active tiles get a **gear → Settings modal** that calls `PATCH /api/integrations/:id` to flip `globalForMulti` permission toggles (e.g. Email "Allow sending") without re-pasting credentials. "Ask bot for help" escape hatch on each step pastes the integration's instructions verbatim into the chat. See `docs/INTEGRATIONS.md`. |
| `views/RemindersDashboard.jsx` | `type === 'reminders'` (sidebar shortcut, just below Tasks). Reads `.reminders.json` (the bot's own scheduling list, written by `mcp__reminders__set_reminder` and polled by the `<bot>-reminders` PM2 process). Each entry now has a structured `title` + optional `description`; legacy single-`message` reminders auto-split on render (`\n` → `" — "` → `": "`). One flat list sorted by due date. Each row leads with the bot avatar (every reminder is something the bot scheduled for itself) + relative due chip · absolute date with timezone · expanded repeat (`every Tuesday at 11:00`) · monospace id. Hover-revealed trash with a top-level confirm modal that filters the entry out of the JSON file. Auto-refresh every 30 s. |
| `views/TeamDashboard.jsx` | `type === 'team'` (sidebar shortcut next to Integrations). Reads `/api/team` for the file-based whitelist (`PROJECT_DIR/.allowed-emails.json`). Members see a read-only list; admins get an "Invite member" button, an inline role selector, and a hover-revealed trash with confirm modal. Lockout-protected: refuses self-delete and demoting/removing the only remaining admin. |

### Right column — chat

| File | What it does |
|---|---|
| `ChatPane.jsx` | Right column shell: ChatHeader + ChatPanel. Owns `threadId` (with `localStorage` persistence via `STORAGE_KEY`) so refresh restores the same conversation. Supports `startFresh` (forced new thread, used from WelcomeScreen) and `initialThreadId` (resume a specific thread from the recent list). |
| `ChatHeader.jsx` | bot avatar (SpinningAvatar) + bot name + thread switcher dropdown + new-thread button + collapse. |
| `ChatPanel.jsx` | Composer + bubble list + SSE streaming. POSTs to `/api/chat`, parses SSE manually (`fetch` + `ReadableStream`, because EventSource only supports GET). Handles `message`/`tool_start`/`tool_end`/`image`/`done`/`error` events. **Send-while-busy** — sending a new message while the assistant is mid-reply aborts the in-flight `fetch` (and the backend kills the corresponding `claude` process via the generation counter in `routes/chat.js`); the textarea stays enabled and Enter always sends. The square Stop button only appears when busy AND the textarea is empty. **Ordered content** — text deltas and image events both append to a single `content[]` array per assistant bubble, so a screenshot returned mid-reply renders inline at the position it arrived (not pushed to the bottom). Legacy history bubbles without `content[]` fall back to the old `text + images[]` rendering. |
| `ToolChip.jsx` | Small pill that represents an in-flight tool call (`Read`, `Write`, `Bash`, etc.). Streams in via `tool_start`, flips to `done` or `error` on `tool_end`, fades out 1.5s later. |

## State flow

```
WorkspacePage
├── useFileWatcher() ──▶ fileEventNonce  (bumps on FS events)
│
├── selected = { path, type } | null
│   └── Sidebar → FileTree → onSelect(...) ──▶ setSelected
│       (clicking a folder both selects and expands it; EditorPane can
│        render a folder view like Gallery while the tree shows children)
│
├── showHidden state
│   └── eye toggle ──▶ FileTree fetches with ?include_hidden=true
│
├── sidebarOpen / chatOpen
│   └── grid-template-columns animates between {sidebar?} {centre} {chat?}
│
├── hasStarted (false on every fresh load)
│   ├── false → WelcomeScreen replaces EditorPane
│   └── true  → EditorPane + ChatPane (if open)
│
├── pendingMsg     — first message typed in WelcomeScreen, auto-sent on chat mount
└── pendingThread  — thread id when the user resumed from the WelcomeScreen list
```

Children read these via props. No Redux, no context, no router — for one route this is right-sized.

### EditorPane view registry

`EditorPane.jsx` picks the view component top-down by matching against `{ path, type }`:

| Match | Component |
|---|---|
| `type === 'dashboard'` | `views/ClaudeDashboard` |
| `type === 'skills'` | `views/SkillsDashboard` |
| `type === 'integrations'` | `views/IntegrationsDashboard` |
| `type === 'reminders'` | `views/RemindersDashboard` |
| `path === 'Tasks.md'` | `views/KanbanView` |
| `type === 'dir'` and basename `'generated'` | `views/GalleryView` |
| `type === 'file'` and image extension | `ImageViewer` |
| `type === 'file'` and markdown extension | `MarkdownEditor` (lazy) |
| `type === 'file'` (any other) | `FileViewer` |
| `type === 'dir'` (fallback) | `FolderView` (grid of children) |
| `null` | `EmptyState` |

`<ActiveView key={viewKey}>` — keyed on `${type}:${path}` — forces a fresh remount on path change so views don't carry state across files.

The non-filesystem types (`dashboard`, `skills`, `integrations`, `reminders`) are dispatched by sidebar shortcuts via `onSelect({ path, type })`.

Adding a new view: drop the component in `views/`, register one match line in `ActiveView()`. Don't grow `EditorPane.jsx` itself.

### Sidebar pinning

Root-level entries listed in `PINNED_AT_BOTTOM` (currently `.claude`) are split out of the main file listing and rendered after a divider at the bottom — they stay in place when the user scrolls the tree. Server side, `lib/config.js#VISIBLE_DOT` keeps them visible in `/api/files/tree`; the client decides where to put them.

## Welcome screen flow

The first thing the user sees on every page load. `hasStarted` is *not* persisted — refresh = welcome again.

```
WelcomeScreen
  ├── textarea (auto-grow, attach button, send arrow)
  └── Recent conversations (last 5 threads from /api/chat/threads)

User types + Send →  handleWelcomeSend(msg)
                     ├── setHasStarted(true)
                     ├── setChatOpen(true)
                     └── setPendingMsg(msg)
                         └── ChatPane mounts with startFresh=true → new threadId
                              └── ChatPanel auto-fires pendingMsg in a fresh useEffect

User clicks a recent thread →  handleWelcomeThread(threadId)
                               ├── setHasStarted(true)
                               ├── setChatOpen(true)
                               └── setPendingThread(threadId)
                                   └── ChatPane mounts with initialThreadId=threadId

User opens a file from sidebar →  handleSelect(item)
                                  ├── setHasStarted(true)
                                  └── setChatOpen(false)   (file-first flow, chat collapsed)
```

The auto-send hand-off is implemented carefully in `ChatPanel.jsx` — `initialSentRef` (a `useRef`) prevents double-sends across React.StrictMode's setup→cleanup→setup cycle, and `sendRef.current(msg)` is called synchronously inside the effect (no `setTimeout`, which a StrictMode cleanup would kill before it fires).

## Chat streaming model

`ChatPanel.jsx` POSTs to `/api/chat` and consumes the SSE stream manually. Each turn produces one optimistic `user` bubble and one `assistant` bubble that mutates over time:

| State | Meaning |
|---|---|
| `streaming` (no `text`) | The "Thinking" indicator with a CSS shimmer is shown; tool chips, if any, render inline next to it. |
| `streaming` (with `text`) | Markdown body renders progressively, with a small blinking dot suffix until `done`. |
| `done` | Final answer; markdown rendered with `remark-gfm` (GFM autolinks, tables). |
| `error` | An `<ErrorBubble>` with friendly product copy + a **Try again** button (when retryable). |
| `aborted` | A muted *Stopped* line (no body). |

### Error UX

Raw HTTP/network/stream errors are converted by `friendlyError()` into `{ icon, title, body, retryable }`:

| Cause | Title | Body |
|---|---|---|
| `kind: 'network'` (catch JS error) | Couldn't reach the assistant | Check your internet connection and try again. |
| `kind: 'http'`, status 401/403 | Not authorized | Your session may have expired. Refresh the page and try again. |
| `kind: 'http'`, status 429 | Slow down a bit | You're sending messages too quickly. Wait a few seconds and try again. |
| `kind: 'http'`, status ≥ 500 | Something went wrong on our end | We hit an unexpected error. Try again in a moment — if it keeps happening, the service may be temporarily down. |
| `kind: 'http'`, other | Couldn't send your message | (server-provided detail or generic fallback) |
| `kind: 'stream'` (mid-reply error) | The reply was interrupted | The assistant stopped mid-reply (...). Try again. |

**Retry**: removes the failed assistant bubble + the original user prompt from `messages` and calls `sendRef.current(prior.text)`. Disabled while `busy`.

### Sources rendering

Replies that end with a trailing `Sources:` / `Źródła:` / `References:` block (one source per line) are split client-side: the body renders as normal markdown, the source lines render below as a wrapped row of pillchips. Each line is parsed by `parseSource()`:

- `[Title](https://...)` → label = "Title", clickable
- `Title - https://...` or `Title (https://...)` → label = title, clickable
- bare URL → label = hostname (without `www.`), clickable
- plain text → unstyled fallback (no link)

Pills with a URL are `<a target="_blank">` with a `Globe` icon on the left and an `ArrowUpRight` on the right; plain ones are `<span>`.

### Composer

`Composer` (inline in ChatPanel.jsx) — auto-growing textarea (`field-sizing-content`, max 140px), attach button (file picker stub — UI only for now), send button. Same UI lives in WelcomeScreen for consistency.

## Integrations dashboard

[`views/IntegrationsDashboard.jsx`](views/IntegrationsDashboard.jsx) is the
front-end side of the self-service integrations system. The dashboard reads
`/api/integrations` (catalog + active state), renders one tile per
integration in a responsive grid (`auto-fill, minmax(260px, 1fr)`) split
into **Active** and **Available** sections, and pops a wide modal on
**Activate**.

The activate modal is two-column on desktop:

- Left (muted background) — numbered "How to get your key" walkthrough with a vertical connector line between step circles. Steps come from `catalog.steps[]` and explain how to obtain credentials end-to-end (where to click in the provider's dashboard, what to copy, etc.).
- Right (white) — the form. Field types include `text`, `secret` (rendered as `password`), `select` (provider preset dropdown), and `json` (textarea for paste-the-whole-file fields like GA4 service-account credentials). `showIf` makes fields appear conditionally (e.g. custom IMAP host only when provider = `custom`). `optional` skips the required-check. Multi-account integrations (currently just Email IMAP) replace the form with an accordion: each item collapses to a one-line summary with provider + email; `+ Add another account` appends a fresh blank entry and auto-expands it.

When the user hits **Activate**, the request flows
`PUT /api/integrations/:id` → AES-256-GCM encrypt every field → write
`PROJECT_DIR/.integrations/credentials.json` (mode 0600, atomic via tempfile
+ rename) → write any declared `writeFiles` (multi-account JSON, GA4 JSON
paste, Telegram env file) → patch `~/.claude.json`'s `mcpServers` block →
optionally `pm2 restart` for Telegram.

Removing an integration is destructive: the dialog warns "This deactivates
the integration and erases the stored credentials. To use it again, you'll
need to enter a new key." Rotation = remove + activate again. No edit-in-place
endpoint exists by design — keeps the audit log clean and avoids
"partial-update with old key still valid" states.

For the threat model, encryption details, key handling, and per-plugin
walkthroughs see [`docs/INTEGRATIONS.md`](../../../../../docs/INTEGRATIONS.md).

## Skills dashboard

[`views/SkillsDashboard.jsx`](views/SkillsDashboard.jsx) is the editing
surface for markdown playbooks the assistant follows for recurring tasks.
Same visual language as Integrations — tile grid, modal-based editor, slim
section headers ("Project skills", "Global skills").

The backend endpoint `/api/skills` merges two directory sources:

- **Project skills** — `PROJECT_DIR/.claude/skills/<name>/SKILL.md`. Per-client, fully editable + deletable from the dashboard. Adding a project skill of the same name as a global skill overrides the global (mirrors claude's own precedence).
- **Global skills** — `$HOME/.claude/skills/<name>/SKILL.md`. User-level, read-only from the dashboard so a stray click can't wipe one another client also relies on.

`findSkillFile()` in `routes/skills.js` matches `SKILL.md` case-insensitively — older skills that shipped with `SKILL.MD` (uppercase, common pre-2026 convention) work without rename. The editor's Save button writes back to lowercase `SKILL.md`, gradually canonicalising the casing across the catalog. Folders without any `SKILL.*` file are skipped from the listing entirely (they aren't real skills, just empty directories).

Each entry includes the `description:` line parsed from the YAML
frontmatter so the tile shows a one-line summary without a separate fetch.

**Tile interactions:**

- Hover on a project tile reveals a small trash icon in the top-right (vertically centred with the hexagon plate). Click → top-level confirm modal that DELETEs the entire `.claude/skills/<name>/` directory recursively.
- Click anywhere else → opens the edit modal.
- Last tile in the project section is `+ Add skill` — opens the create modal (slug-validated name + optional description; on submit, creates the dir + a starter SKILL.md and auto-opens it in the editor).

**Edit modal** is intentionally writing-first: `max-w-6xl`, slim header
(hexagon icon + name + optional description as caption), prose-width
(`max-w-3xl`) centred textarea inside a much wider modal so long lines
don't stretch but the canvas itself is huge. Mono 14px / line-height 1.75,
`autoFocus`, `⌘S` saves, `Esc` closes. Globals get a read-only banner at
the top explaining how to override (copy the contents into a project skill
of the same name) and the Save / Delete buttons are hidden.

## Theming + animation

- **Tailwind v4** + a small set of custom keyframes in [`src/index.css`](../../index.css):
  - `cursor-blink` — the streaming "still typing" dot.
  - `text-shimmer` — the "Thinking" indicator (slow horizontal gradient through clipped text).
  - `spin` (used by `SpinningAvatar`'s ring at 8s linear infinite).
- Bubble margin reset: `[&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0` on the user bubble keeps padding visually symmetric regardless of paragraph count.
- The whole shell transitions `grid-template-columns` with `cubic-bezier(0.22, 1, 0.36, 1)` over 220ms when sidebar/chat open or close.

### Dark mode

Picker (Light / Dark / System) lives in `UserMenu` at the bottom of the sidebar. Choice is persisted in `localStorage` and applied by toggling `.dark` on `<html>`. `index.css` declares `@custom-variant dark (&:is(.dark *))` so every `dark:` Tailwind class composes through that single class.

The dark palette is warm graphite (not pure black): body `#1b1b1a`, sidebar `#1d1d1c`, card `#252524`, border `#303030`. Cards stay one shade lighter than body so they pop. Logo tiles in the Integrations dashboard intentionally stay solid white in both modes — brand marks are designed for white backgrounds and dimming them looks broken.

### `scrollbar-hidden` utility

Opt-in CSS class in `index.css` for panes where the system scrollbar looks heavy (chat list, sidebar tree). Hides the bar entirely (`scrollbar-width: none` + zeroed `::-webkit-scrollbar` with `!important` because Tailwind's `overflow-y-auto` defaults otherwise win on specificity, and macOS overlay scrollbars insist on appearing on hover). Wheel/touch scroll continues to work; this is purely visual.

Used sparingly — for editors and file content the bar stays so users can see scroll position.

## Per-client branding

Three knobs, all build-time via `VITE_*` injected from docker-compose's `args`:

| Var | Used for |
|---|---|
| `VITE_APP_TITLE` | Workspace name in sidebar. ` IDE` suffix is stripped (`Acme IDE` → `Acme`). |
| `VITE_BOT_NAME` | Capitalised for the chat header (`luna` → `Luna`). Sourced from `BOT_NAME` in `.env`. |
| `BASE_URL/icon.png` and `BASE_URL/bot.png` | Image assets in `frontend/public/`. Per-client overrides via `clients/<client>/overrides/public/icon.png` (workspace mark, square) and `bot.png` (bot avatar). |

Both icon and bot avatar gracefully hide themselves via `onError` if missing — the layout still works without the assets.

## Auth + dev mode

`App.jsx` decides whether to render `<WorkspacePage />`:

- **Production**: only after the existing AuthProvider says `isAllowed=true` (Google OAuth + JWT cookie + email whitelist).
- **Dev**: an `import.meta.env.DEV && ?view=workspace` short-circuit so we can iterate locally without standing up `auth-service`. This branch never ships in the production bundle.

## Dev loop

```bash
# Terminal 1 — workspace-api (Express on :3001)
cd ide-template/workspace-api
PROJECT_DIR=/tmp/test-project node index.js

# Terminal 2 — frontend (Vite on :5173)
cd ide-template/frontend
npm run dev
```

Open `http://localhost:5173/app/?view=workspace`. The Vite dev server proxies `/api/*` to `localhost:3001` (see `vite.config.js`). The chat reaches your local `claude` CLI, project files come from whatever directory you point `PROJECT_DIR` to. Auth is bypassed in dev mode.

If Vite returns `504 Outdated Optimize Dep` after installing a new dependency, clear its cache and restart:

```bash
rm -rf ide-template/frontend/node_modules/.vite
```

## Deploy

The whole frontend builds into a static bundle served by nginx (see `frontend/Dockerfile.frontend` and `frontend/nginx.conf`). `ide-template/deploy.sh` SCPs the source tree to the server; nginx config and routing live in `frontend/nginx.conf` and the top-level `Caddyfile`.

When the workspace stabilises and we promote it to default (iter 5 in `workspace (todo).md`), the toggle in `App.jsx` is removed and code-server moves to `/legacy`.

## See also

- Backend reference: [`ide-template/workspace-api/README.md`](../../../../workspace-api/README.md)
- Roadmap and iteration plan: [`workspace (todo).md`](../../../../../workspace%20(todo).md) at repo root
- Architecture overview: [`docs/ARCHITECTURE.md`](../../../../../docs/ARCHITECTURE.md)
- SaaS / longer-term direction: [`docs/future-plans/SAAS.md`](../../../../../docs/future-plans/SAAS.md)
