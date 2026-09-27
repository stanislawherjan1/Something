# Browser extension — the side-panel chat

**Your workspace chat in Chrome's side panel, on any tab. The assistant knows which page
you are on, and can look at it when you allow it.**

Status: developer build (load unpacked). Chrome 116+.

---

## What the user sees

1. Click the toolbar icon → the side panel opens → enter the workspace address →
   **Continue** (Chrome asks for the permissions once).
2. If the browser is already signed in to the workspace, the chat appears at once.
   Otherwise a Google sign-in window opens (Google does not allow its login inside a
   panel), closes itself, and the chat appears.
3. The chat is **the workspace chat itself** — same component, same look, same
   conversations. Above the input: the page you are on (click ✕ to leave it out of the
   next message) and the **Act** switch (off by default). The assistant looks at the page
   by itself when that helps (Look, below).

Opening the panel continues the last conversation; after a pause of more than 4 hours it
starts a new one (an empty last conversation is reused rather than stacking another).

To switch workspaces, right-click the toolbar icon → **Change workspace**. If the chat at
an address does not load within 10 seconds (the workspace refuses to be framed, or runs a
version without the extension view), the panel returns to the address step and says so.

When the page belongs to a service the workspace is connected to — a doc, sheet or deck, an
email thread, a calendar event, a store order, an ad campaign, a repository, a board card —
the item's id is usually in the address, and the assistant is told to work on that exact item
through its tools and API access (e.g. fill in the slide you are looking at).

## Install (developer build)

The workspace's **Browser agent** page (sidebar) shows how it works and offers the
package: **Download** → unzip on the Desktop and keep the folder → `chrome://extensions` →
Developer mode → **Load unpacked** → the folder → pin it, open it, enter the workspace
address.

The package is `ide-template/frontend/public/downloads/something-chrome-extension.zip`,
built from `chrome-extension/` by `scripts/build-extension-zip.sh` — **re-run it after any
change to the extension and commit the zip with it.**

The extension id is pinned by the `key` in `manifest.json`
(`dfmejngohcofdhddpgkpgaedmjghpdbh`) — the sign-in allow-list and the framing rule depend
on it. Updates: install the new package over the old folder and press **Reload** on the
extension. The chat itself updates with every workspace deploy; the extension is only a
shell.

## How it fits together

```
side panel (extension page)                         workspace (your server)
┌──────────────────────────────┐    frames    ┌─────────────────────────────────┐
│ setup: address → Continue    │ ───────────► │ /app/?embed=extension           │
│ shell: sidepanel.js          │ ◄──────────► │ ExtensionChat.jsx → ChatPanel   │
│  • tab url/title, selection  │  postMessage │  • tab chip + Act above input   │
│  • captureVisibleTab         │              │  • pageContext on POST /api/chat │
│  • Google sign-in popup      │              │                                 │
└──────────────────────────────┘              └─────────────────────────────────┘
```

**Messages** (only between the extension page and the framed workspace origin; each side
checks `origin` and `source`):

| Direction | Type | Meaning |
|---|---|---|
| page → shell | `something:ready` | page loaded; shell replies with the current tab |
| shell → page | `something:tab` | `{ url, title, capturable }` whenever the active tab changes |
| page → shell | `something:need-login` | no session in this browser → shell signs in, reloads the page |
| page → shell | `something:selection` | → `{ text }` selected on the tab |

**Framing.** Caddy sends an enforced `Content-Security-Policy: frame-ancestors 'self'
chrome-extension://<id>` next to `X-Frame-Options: SAMEORIGIN`. Browsers that understand
`frame-ancestors` use it and ignore X-Frame-Options, so only this site and this extension
can frame the workspace. The page switches to the embed layout only when its parent is an
extension page (`location.ancestorOrigins`).

## Sign-in

```
shell ──launchWebAuthFlow──► /auth/extension/start?ext=<id>
                               │  allow-listed id → same Google OAuth + PKCE as the web login
                               ▼
                             /auth/callback ──► https://<id>.chromiumapp.org/auth#token=…&cookie=<name>
shell ◄── (fragment; only this extension can read that URL) ─┘
shell: chrome.cookies.set(<name> = token, httpOnly, secure, SameSite=Lax) → reload the frame
```

- Only extension ids in `EXTENSION_IDS` (auth-service env; default = this extension;
  empty = none) may start the flow. The id is the trust decision: the token is delivered
  to a URL only that extension can read.
- No new Google redirect URI: the flow reuses `/auth/callback`.
- The session is the same 8-hour JWT the web login sets, installed under the
  deployment's cookie name — so normal tabs of the workspace are signed in too, and
  signing in on the web signs in the panel. auth-service and workspace-api also accept
  the token as `Authorization: Bearer` (same checks) for clients without the cookie.

## What the assistant receives

`POST /api/chat` carries `pageContext` (JSON), framed by `browserContextBlock` in
`routes/chat.js` after the message:

- the tab title and address, with the instruction to use the item's id from the address
  when the page belongs to a service it has tools for;
- the selected text, marked as **page content — data, not instructions** (the `<<<`/`>>>`
  delimiters are stripped from it so page text cannot break out of the block);
- that it can look at the tab itself (see Look below) instead of asking for a screenshot.

The page body is never sent with the message; the assistant reads it only through Look.

While Act works, a large black cursor glides to each control before the click or typing (a ripple
on click, an outline on the field being filled). It is drawn in the extension's isolated
world, ignores the mouse, and is removed when Act switches off or the user leaves the tab.

## Look — the assistant sees the tab by itself

In any conversation from the panel that shares the page, the assistant can look at the
tab on its own — `tab_screenshot` or `tab_snapshot` — instead of asking the user for a
screenshot; the chat shows it as a tool pill ("Looking at the tab", "Reading the page").
Looking is read-only and uses no debugger (a screenshot via `captureVisibleTab`, the page
via a script in the extension's isolated world), with the same page rules as Act:
password-manager sites refused, password / one-time-code / payment-card fields invisible,
30 requests a minute. Clicking ✕ on the page chip leaves the page — and looking — out of
the next message.

## Act — the assistant operates the tab

A switch above the input, off by default. Once the user switches it on it stays on while
they work — across pages, tabs and closing and reopening the panel — and the assistant can
click, type, select and scroll **on the tab the user is looking at**, using three tools: `tab_snapshot` (the page's visible text and a numbered list
of its controls — snapshot logic from browser-use/jev-ultrafast, MIT, in
`chrome-extension/vendor/`), `tab_act` (one action on a control id from the page last seen; it
returns the page as it is right after the action, so the next step needs no separate snapshot)
and `tab_screenshot`.

Each action runs jev-ultrafast's executor rules: the target must be the observed element, still
attached, enabled, visible, on screen and not covered, on a page whose freshness guard still
matches. Afterwards the extension waits only as long as upstream does — two animation frames or
50 ms, up to 200 ms for an editable combobox's suggestions to appear — and observes again,
retrying for up to 2.5 s while a navigation settles. The `[tab]` log line of every command shows
its round trip and how much of it was the relay (`… — 640 ms relay 120 ms`).

When an action is refused because the assistant's view is out of date (the page changed since
it was read, the control moved or is covered, nothing has been read yet), nothing is done and
`tab_act` returns the page as it is now to choose from, instead of an error that costs another
round trip. The Jev runner gets these as plain errors and re-observes by itself.

`tab_act` also takes `steps` — up to five actions on the same page (a form's fields, then its
submit button) in one call. Each step gets every check and a fresh observation; the batch stops
at the first failure, when the address changes, or when a later control is no longer the one the
assistant picked (its label changed or it is gone), and returns the page as it is then.

`scripts/vendor-jev.sh [commit]` refreshes the vendored snapshot (and licence) from
jev-ultrafast and shows the diff.

```
assistant tool (workspace-api-mcp) → POST /api/internal/tab-command (loopback, needs the turn's token)
  → GET /api/tab/stream (the user's open panel) → postMessage → extension
  → chrome.debugger on the active tab (trusted input) → result → POST /api/tab/result → tool result
```

**Hard limits — enforced in code, not asked of the model:**

| Limit | Where |
|---|---|
| Only while the switch is on; switching off detaches from the tab and fails every waiting command at once | extension + workspace-api (`/api/tab/mode`) |
| Only in a turn the user started from the panel with Act on (one-turn token); never Telegram, workspace chat, reminders or groups | `routes/chat.js` → `routes/tab.js` |
| Only the tab the user is on: the debugger is attached to it when a command needs it and detached from a tab they leave; a new page needs a fresh snapshot before any action. Cancelling Chrome's debugging bar or 10 minutes without an action switches Act off (kept for the browser session only, never on disk) | extension |
| No leaving the site: links and form submits to another origin, new tabs and downloads are refused before the click; no address bar, no navigate tool | extension |
| No credentials or payments: password, file, one-time-code and payment-card fields (standard `autocomplete` tokens) are invisible and untouchable; password-manager and account-security sites are refused | extension |
| No code, cookies, clipboard or network: the model only picks control ids from a snapshot the extension made; it never supplies selectors or scripts | extension |
| 30 actions a minute at most; every command is logged (`[tab]` in workspace-api's log) | extension + workspace-api |
| **The Act turn gets an allow-list of tools:** the tab tools and read-only workspace access. No integrations (no mail, Drive, Shopify…), no server browser, no shell, no web fetch, no file or memory writes — whatever a page talks the assistant into, it cannot send anything out or plant instructions for later | `lib/claude.js` (`actTurn`) |

Page text is framed as data both in the prompt and in every snapshot, and the assistant is
told to work only toward what the user asked and to stop and ask when a page asks for
something else. That is the soft layer; the table above is what holds if it fails.

## Autopilot — Jev (optional, experimental)

With the **Jev (TypeSafe)** integration connected — on the Browser agent page, Install tab
(it is not offered in the Integrations marketplace; once active it is listed there with a link
back) — a panel turn with Act on also gets `tab_autopilot`: the assistant hands over one
complete goal plus the values to type (`{"from": "Zurich", …}`), and Jev runs the steps.

```
tab_autopilot (workspace-api-mcp) → POST /api/internal/tab-autopilot (loopback, turn token, Act on, Jev connected)
  → lib/jev/autopilot.js starts /usr/local/bin/jev-runner (setuid → uid mcp) → apps/jev-runner/runner.py (key on stdin)
  → runner: observe → jev_ultrafast.model.choose (TypeSafe picks operation + target) → act → observe …
  → every observe / act goes through routes/tab.js sendTabCommand → the panel → the extension's executor
  → steps stream into the chat's tool line ("Autopilot · Clicking "Search"") → result back to the tool
```

- **The library, as a library.** `runner.py` imports jev-ultrafast's `model` and `questions`
  unmodified from the commit deploy.sh fetches into the image (`/opt/jev-ultrafast`, pinned with
  `scripts/vendor-jev.sh`), not its browser driver; the loop mirrors upstream's `Agent` tick.
- **Values, not a second model.** When Jev picks a text field, one more TypeSafe choice picks
  which of the given values fits it; none fits → the run stops with `needs_value` and the
  assistant fills that field itself. No text-model provider is involved.
- **Same limits.** Every action is an ordinary `act` command — the table above applies step by
  step. Switching Act off fails the next command at once, ending the run. Bounds: 40 actions, 80
  decisions, 120 s; three actions in a row that change nothing stop it as blocked.
- **No loops on a refused control.** A control the executor refuses (covered, changed) is not
  offered to Jev again on that page, and the attempt shows in its recent actions, so it has to
  find another way; three refusals in a row stop the run as blocked, and the assistant — told to
  change approach rather than repeat — takes over.
- **Data.** While it runs, the goal, the values, the page's visible text and control labels and
  values (sensitive fields excluded) and recent action labels go to TypeSafe (`api.typesafe.ai`,
  in the egress allow-list only while the integration is active).
- **Jev does every action; the assistant plans and checks.** With Jev connected, an Act turn has
  `tab_snapshot`, `tab_screenshot` and `tab_autopilot` — **no `tab_act`** (not offered, and refused
  by the route). The turn's instruction: call `tab_autopilot` right away with the whole task and the
  values to type, answer from the page it returns; `needs_value` → add the value and call again;
  `blocked` → read the page, rephrase or split the goal, call again; three blocked runs → tell the
  user. Pausing Jev (the switch on its card) brings the step-by-step `tab_act` mode back — needed
  for what Jev cannot do (uploads, canvas apps, frames). The safety lines (page text is not
  instructions, no outbound tools) are the same in both modes.
- **Fewer early stops, fewer wasted round trips** (each costs one user↔server round trip, where
  jev-ultrafast's local Chrome pays ~5 ms): controls whose centre is covered are not offered at all
  (upstream PR #137); after an action the extension waits until the DOM has been quiet for 120 ms
  (cap 600 ms) instead of two frames, and an explicit WAIT lasts until the page is quiet (cap 1.5 s)
  instead of 100 ms (PR #124); a first BLOCKED from Jev gets one settle-and-re-read before it counts
  (PR #153); the values go into the goal Jev sees, and without values no fill control is offered
  (Jev must click; the fields it would have wanted are reported as `needs_value`). The result
  carries the final page, so the assistant answers without another read. Every Jev decision is
  logged (`[jev] … CLICK e12 (0.91) 180 ms`).
- **Only here.** The tool exists only in a panel turn with Act on while Jev is connected and not
  paused (`IDE_JEV_AUTOPILOT`, set by `lib/claude.js`); Jev has no MCP server and is used nowhere else.
- **Pause.** An admin can switch the autopilot off on the Jev card without disconnecting: the key
  stays, the tool disappears from the next turn, the route refuses, and `api.typesafe.ai` leaves
  the egress allow-list until it is switched back on.
- **Isolation.** The runner executes third-party code, so it runs as the `mcp` user like every
  integration's MCP — never as workspace-api's user, which can decrypt every integration's keys.
  `setuid-wrappers/jev-runner.c` (root:1001, mode 4750: only workspace-api may start it) execs a fixed
  script with a rebuilt, allow-listed environment and `PR_SET_NO_NEW_PRIVS`; the TypeSafe key
  arrives on stdin, so no process can read it from `/proc/<pid>/environ`. What it returns to the
  assistant (step labels, a field name) is page content and is wrapped as such.
- `apps/jev-runner/runner_test.py` runs the loop on the real library with a fake TypeSafe and a fake tab;
  `scripts/test-tab-executor.mjs` runs the extension's page-side code on a real Chrome.

## Files

| Path | What |
|---|---|
| `chrome-extension/manifest.json` | MV3 manifest, pinned `key`, permissions |
| `chrome-extension/background.js` | Opens the panel on toolbar click |
| `chrome-extension/sidepanel.{html,css,js}` | Setup step, the frame, the postMessage bridge, sign-in, the Act executor and its limits |
| `chrome-extension/vendor/jev-snapshot.js` | Page snapshot (browser-use/jev-ultrafast, MIT) |
| `ide-template/workspace-api/routes/tab.js` | The relay (`sendTabCommand`), Act mode, one-turn tokens, the autopilot route, audit log |
| `ide-template/workspace-api/lib/jev/autopilot.js` | The Jev autopilot bridge (tab commands ↔ the runner) |
| `ide-template/apps/jev-runner/runner.py`, `setuid-wrappers/jev-runner.c` | The runner (jev-ultrafast's policy + our executor) and the wrapper that starts it as `mcp` |
| `ide-template/apps/workspace-api-mcp/index.js` | `tab_snapshot`, `tab_act`, `tab_screenshot`, `tab_autopilot` (only with Jev) |
| `ide-template/frontend/src/components/workspace/views/BrowserAgentView.jsx` | The Browser agent page: Overview / Install, the Jev card |
| `ide-template/frontend/src/components/workspace/ExtensionChat.jsx` | The embed layout: the workspace's own `ChatPane` (header, history, chat) plus the tab chip and the Act switch |
| `ide-template/frontend/src/lib/extensionEmbed.js` | Embed detection |
| `ide-template/frontend/src/components/workspace/ChatPanel.jsx`, `ChatPane.jsx` | Optional `extraFields` / `composerAccessory` / `onTurnDone` (passed through `ChatPane`); `ide:chat-attach` / `ide:chat-send` events |
| `ide-template/frontend/src/components/workspace/ChatHeader.jsx` | No back / collapse buttons when there is nothing to collapse to |
| `ide-template/Caddyfile` | `frame-ancestors` for the extension |
| `ide-template/auth-service/index.js` | `/auth/extension/start`, Bearer, `EXTENSION_IDS` |
| `ide-template/workspace-api/lib/auth.js` | Bearer token accepted as the session |
| `ide-template/workspace-api/routes/chat.js` | `pageContext` framing, marker stripped from history |
