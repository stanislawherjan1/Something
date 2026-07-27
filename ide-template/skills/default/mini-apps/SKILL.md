---
name: mini-apps
description: Build persistent mini apps (dashboards, trackers, widgets) that live as tabs in the workspace sidebar under "Mini Apps". Use whenever the user asks for a dashboard, tracker, overview, widget, "app", or keeps asking for the same summary repeatedly — offer to turn it into a tab instead of another one-off chat answer. The dedicated tool is mcp__miniapps__save_as_tab; NEVER paste UI specs or component code into the chat.
allowed-tools: mcp__miniapps__save_as_tab, mcp__miniapps__list_tabs, mcp__miniapps__delete_tab, Read, Bash
---

# Mini Apps — persistent sidebar tabs

A mini app is a small interactive dashboard the user opens from the sidebar
("Mini Apps"), built once in conversation and used daily. It renders
real widgets — KPI tiles, tables, lists, charts — from data you provide.
This replaces the "AI writes a .md the user reads once" pattern with UI the
user returns to.

## When to build one (and when to propose it)

Build a tab when the user asks for:
- a dashboard / tracker / overview / widget / "app" for anything recurring
- "show me X every day/week" style requests
- the SAME summary for the second or third time — **proactively offer**:
  "Want me to make this a tab in your sidebar so it's always up to date?"

Do NOT build one for a one-off question — answer normally.

## The flow

1. **Call `start_tab` FIRST** (id + name + icon) the moment you commit to
   building — the tab appears in the sidebar immediately with a building
   spinner. Say one short line in chat ("Building *Orders* — a moment…"),
   then work silently.
2. **Gather the data this turn** using your normal tools (Shopify MCP, email,
   Trello, Sheets, files…). Shape it into flat row arrays — e.g.
   `[{ customer, items, status }, ...]`.
3. **Compose the spec** in OpenUI Lang. The full component grammar, argument
   order, and a worked example are in the `save_as_tab` tool description —
   that is the source of truth. Essentials: one statement per line,
   `root = App([...])` first, POSITIONAL args, reference rows via dataKey.
4. **Call `save_as_tab`** (same id) with `spec`, `data` (the snapshot you
   gathered), and `dataSources` — this replaces the building placeholder.
5. **Tell the user it's ready** — "it's in your sidebar under Mini Apps".
   Never paste the spec into the chat; the confirmation is the deliverable.

## Interactive apps (the user clicks, you are the backend)

- **`Button(label, say)`** — a click sends `say` to you in chat, prefixed
  `[Mini app "<name>"]`. Treat it as a user request: act with your tools,
  then update the app (`save_as_tab`, same id) if its data changed.
  Use for: "Mark as shipped", "Approve", "Refresh now", per-app commands.
- **`Form(stateKey, fields, submitLabel?, notify?)`** — submits append
  entries to the app's state INSTANTLY (no turn of yours involved). Pair it
  with a List/DataTable whose data source is `{ "key": stateKey, "source":
  "state" }` so new entries show up as the user types them.
- **Read what the user did with `get_tab_state(id)`** — on demand ("ile
  wydałem?") or from a scheduled reminder that aggregates state, updates the
  app's computed parts (totals, charts) via `save_as_tab`, and alerts the
  user when a threshold is crossed. State survives your turns — it's the
  app's database.

Updating = call `save_as_tab` again with the **same id** (spec and/or fresh
data). Renaming/deleting: the user can do it in the sidebar; you can
`delete_tab` when asked.

## Data: snapshot vs live

- **`embedded`** (default): the rows you gathered this turn ride inside the
  app. Right for anything sourced from MCPs (Shopify, email, ads…) — the
  browser cannot call those directly.
- **`api:/api/...`**: the tab re-fetches a same-origin workspace endpoint on
  every open/refresh. Use ONLY for data the workspace API itself serves
  (e.g. `api:/api/reminders`). When unsure, use `embedded`.

## Keeping a tab fresh (the important part)

An embedded snapshot goes stale. For anything the user checks daily, pair the
tab with a **reminder** (reminders MCP) that re-gathers the data and calls
`save_as_tab` with the same id — e.g. "every morning 07:30: refresh the
`orders` mini app from Shopify". Offer this when you create the tab:
"Should I refresh it every morning?" This is the same watch/refresh pattern
used for other recurring rituals.

## Design guidance (what makes a GOOD app)

- **Pre-format values** — `value` strings arrive display-ready ("2 840 zł",
  "17", "+12%"). Components never compute or format numbers.
- **Top row = 2–4 Stats** with the numbers the user actually checks; details
  below in a List/DataTable; ONE chart only when a trend/comparison genuinely
  helps.
- **Alternate views of the same thing** (two cities, week vs month, per-store)
  → `Tabs`, not two stacked cards and not two separate mini apps.
- **Keep it small** — a tab answers one question ("how are today's orders?"),
  not everything at once. Prefer two focused tabs over one kitchen sink.
- **Empty states matter** — always set the `empty` arg to something human
  ("Nothing to ship 🎉" style, matching the workspace language).
- **Stable ids** — kebab-case, semantic (`orders-today`, `kpi-week`), so
  refresh reminders and updates target the right tab.
- **Distinct icons** — always pass `icon` matching the topic (weather →
  `cloud-sun`, orders → `shopping-cart`, KPI → `trending-up`, tasks →
  `check-square`); never leave two tabs with the same default icon.
