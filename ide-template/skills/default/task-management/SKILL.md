---
name: task-management
description: Use this when the user wants to add, update, move, assign, or review tasks. Tasks live on a structured board (Backlog / In Progress / Done) served by the workspace API over HTTP at http://localhost:3001/api/tasks — read and write it with the Bash tool (curl). There are no mcp__tasks__* tools; don't look for them. Each task can be assigned to a teammate.
allowed-tools: Bash, Read, mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder
---

# Task Management Protocol

## The board is the workspace API — reach it over HTTP with curl

Tasks are a structured board — the SAME one the user sees under the **Tasks**
shortcut in the workspace UI. It is **not** a Markdown file, and there are **no
`mcp__tasks__*` tools** (an older version of this skill named MCP tools that
don't exist — don't search for them). You read and change the board by calling
the workspace API on loopback with the **Bash tool (`curl`)**:

| Action | Call |
|---|---|
| **List** | `curl -s http://localhost:3001/api/tasks` |
| **Add** | `curl -s -X POST http://localhost:3001/api/tasks -H 'Content-Type: application/json' -d '{"title":"…"}'` |
| **Update / move** | `curl -s -X PATCH http://localhost:3001/api/tasks/<id> -H 'Content-Type: application/json' -d '{"status":"done"}'` |

- **List returns** `{ ok, teamMode, me, people: {slug→{name,avatar}}, tasks: [...] }`.
  **Always list before adding or changing** — find an existing task to update
  instead of duplicating, and to read a task's `id`.
- **Add** — only `title` is required; `description`, `status`, `owner`,
  `priority`, `deadline` are optional. Defaults to the Backlog. Returns
  `{ ok, task }` with the new `id`.
- **Update / move** — PATCH only the fields that change. Changing columns = PATCH
  `status`. Returns the updated task.
- **No delete** — tasks move to `done`, they are never removed.

**Loopback, no auth, no file edits.** `localhost:3001` is reachable from inside
the workspace without a login — don't add auth headers. Never `Read`/`Write`
`.tasks.json` yourself; the API owns the file, the column ordering, and the
`completed` stamp. If you ever see a `Tasks.md` in the project, it's a
pre-migration leftover — ignore it; the board is the API.

## Task shape

`id` (e.g. `t_a1b2c3d4`) · `title` · `description` · `status` (`backlog` /
`in_progress` / `done`) · `owner` (a teammate slug or `null`) · `priority`
(`high` / `medium` / `low` or `null`) · `deadline` (`YYYY-MM-DD` or `null`) ·
`completed` (auto-stamped when status → `done`, cleared when moved back — **never
set it yourself**). Full field + writing guidance → `references/templates.md`.

## Tasks vs Reminders

| What the user means | System |
|---|---|
| "I need to do X" / "add X to the list" — a unit of work to track | **the task board** (this skill) |
| "Remind me at \<time\>" — a timed action the bot performs | **set a reminder** (the reminders skill) |

The board is for work items with no firing time. A timed alert is a reminder —
don't put it on the board. (A reminder can *target* a teammate without it being a
task; a task can be *assigned* to a teammate without notifying them — see below.)

## Assigning a task — `owner`

`owner` is **who's responsible**, not who created it. Pass a teammate's roster
**slug** — valid slugs are in the `people` map of the list response. Default the
owner to the person asking, and **resolve their slug yourself from context**: the
HTTP call carries no logged-in identity, so the API can't expand "me" or auto-fill
a creator. Only assign someone else when the user says so ("assign this to Jan" →
`"owner":"jan"`). Leave `owner` out if nobody owns it yet. **Assigning does NOT
notify the teammate** — it just records ownership; to ping them, that's a relay or
a reminder with a recipient, separate from the board. Full rules →
`references/templates.md`.

## Adding a task

1. `curl -s http://localhost:3001/api/tasks` — check for an existing task to update instead.
2. POST → Backlog, unless work has already started (`"status":"in_progress"`).
3. `title` is imperative and self-contained; `priority` and `deadline` when known (omit otherwise); `owner` per above.
4. Set reminders per `references/reminder-rules.md` (deadline within 14d → silent day-before; beyond 14d → ask; blocker → ask when to remind).

## Moving a task

- **Backlog → In Progress**: work has started → `PATCH {"status":"in_progress"}`. Check + offer a deadline reminder per `references/reminder-rules.md`.
- **In Progress → Done**: `PATCH {"status":"done"}` — the completion date is stamped for you. Cancel any deadline reminder for the task.
- **Never delete tasks** — move them to Done.

## Updating a task

`PATCH /api/tasks/<id>` with only the changed fields when the deadline changes,
owner changes, a blocker resolves, or new info arrives. A deadline change triggers
cancel-old-reminder + set-new-reminder (see `references/reminder-rules.md`); other
field changes don't need reminder updates.

## When to add tasks automatically

**Add when:** someone commits to a clear next step · a decision creates follow-up work · a deadline or dependency is mentioned.

**Don't add when:** vague ideas with no owner or action · timed alerts the bot should send (set a reminder instead) · completed work with no follow-up.

## Weekly board review

When the first In Progress task is added: offer to set a weekly board-review reminder. Full rule in `references/reminder-rules.md` (don't double-offer, respect prior declines).

## Overdue check — on session start

After reading session notes, list the board (`curl -s http://localhost:3001/api/tasks`) and scan for tasks whose `deadline` has passed while status is still `backlog` or `in_progress`. If any — flag immediately:
> "Overdue: [task title] — deadline was [date]. Still relevant?"

## Summarizing the board

When asked "what's open?" / "what do we have?": list the board, then summarize In Progress + high-priority Backlog items (and flag overdue). Don't dump the whole board.
