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
   next message), 📷 to attach a screenshot of it, and 👁 to let the assistant take one
   when it needs to (off by default).

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

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → the `chrome-extension/` folder of this repository.
3. Pin the icon, click it, enter the workspace address.

The extension id is pinned by the `key` in `manifest.json`
(`dfmejngohcofdhddpgkpgaedmjghpdbh`) — the sign-in allow-list and the framing rule
depend on it. Updates: pull the repo, press **Reload** on the extension. The chat itself
updates with every workspace deploy; the extension is only a shell.

## How it fits together

```
side panel (extension page)                         workspace (your server)
┌──────────────────────────────┐    frames    ┌─────────────────────────────────┐
│ setup: address → Continue    │ ───────────► │ /app/?embed=extension           │
│ shell: sidepanel.js          │ ◄──────────► │ ExtensionChat.jsx → ChatPanel   │
│  • tab url/title, selection  │  postMessage │  • tab chip + 📷 + 👁 above input│
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
| page → shell | `something:capture` | → `{ dataUrl }` of the visible tab, or `{ error }` |

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
- that it may end a reply with `[[SCREENSHOT]]` to see the tab — taken automatically when
  👁 is on, otherwise offered to the user as a one-click *Share screenshot* button.

The page body is never sent. The marker is hidden in the chat and removed from stored
history.

## Screenshots

- **📷** attaches the visible part of the current tab to the next message.
- **👁 on:** a reply ending in `[[SCREENSHOT]]` makes the panel capture the tab and send it
  back so the assistant continues from it — at most two per message you send.
  **👁 off:** the chat shows "The assistant would like to see this tab" with a
  *Share screenshot* button.
- Never captured: browser pages (`chrome://…`) and the Chrome Web Store.

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

A switch next to 📷 (off after every panel load). When the user switches it on, the
assistant can click, type, select and scroll **on the current site** for the rest of the
conversation, using three tools: `tab_snapshot` (the page's visible text and a numbered list
of its controls — snapshot logic from browser-use/jev-ultrafast, MIT, in
`chrome-extension/vendor/`), `tab_act` (one action on a control id from the latest
snapshot) and `tab_screenshot`.

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
| One site: another tab, leaving the site, closing the tab, cancelling Chrome's debugging bar, 10 minutes idle or closing the panel switches it off | extension |
| No leaving the site: links and form submits to another origin, new tabs and downloads are refused before the click; no address bar, no navigate tool | extension |
| No credentials or payments: password, file, one-time-code and payment-card fields (standard `autocomplete` tokens) are invisible and untouchable; password-manager and account-security sites are refused | extension |
| No code, cookies, clipboard or network: the model only picks control ids from a snapshot the extension made; it never supplies selectors or scripts | extension |
| 30 actions a minute at most; every command is logged (`[tab]` in workspace-api's log) | extension + workspace-api |
| **The Act turn gets an allow-list of tools:** the tab tools and read-only workspace access. No integrations (no mail, Drive, Shopify…), no server browser, no shell, no web fetch, no file or memory writes — whatever a page talks the assistant into, it cannot send anything out or plant instructions for later | `lib/claude.js` (`actTurn`) |

Page text is framed as data both in the prompt and in every snapshot, and the assistant is
told to work only toward what the user asked and to stop and ask when a page asks for
something else. That is the soft layer; the table above is what holds if it fails.

## Files

| Path | What |
|---|---|
| `chrome-extension/manifest.json` | MV3 manifest, pinned `key`, permissions |
| `chrome-extension/background.js` | Opens the panel on toolbar click |
| `chrome-extension/sidepanel.{html,css,js}` | Setup step, the frame, the postMessage bridge, sign-in, the Act executor and its limits |
| `chrome-extension/vendor/jev-snapshot.js` | Page snapshot (browser-use/jev-ultrafast, MIT) |
| `ide-template/workspace-api/routes/tab.js` | The relay, Act mode, one-turn tokens, audit log |
| `ide-template/apps/workspace-api-mcp/index.js` | `tab_snapshot`, `tab_act`, `tab_screenshot` |
| `ide-template/frontend/src/components/workspace/ExtensionChat.jsx` | The embed layout: the workspace's own `ChatPane` (header, history, chat) plus the tab chip and screenshots |
| `ide-template/frontend/src/lib/extensionEmbed.js` | Embed detection |
| `ide-template/frontend/src/components/workspace/ChatPanel.jsx`, `ChatPane.jsx` | Optional `extraFields` / `composerAccessory` / `onTurnDone` (passed through `ChatPane`); `ide:chat-attach` / `ide:chat-send` events |
| `ide-template/frontend/src/components/workspace/ChatHeader.jsx` | No back / collapse buttons when there is nothing to collapse to |
| `ide-template/Caddyfile` | `frame-ancestors` for the extension |
| `ide-template/auth-service/index.js` | `/auth/extension/start`, Bearer, `EXTENSION_IDS` |
| `ide-template/workspace-api/lib/auth.js` | Bearer token accepted as the session |
| `ide-template/workspace-api/routes/chat.js` | `pageContext` framing, marker stripped from history |
