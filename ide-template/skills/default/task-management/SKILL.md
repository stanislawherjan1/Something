---
name: task-management
description: Use this when the user wants to add, update, move, assign, or review tasks. Tasks live on a structured board (Backlog / In Progress / Done) managed through the tasks MCP — list_tasks, add_task, update_task, move_task. Each task can be assigned to a teammate.
allowed-tools: mcp__tasks__list_tasks, mcp__tasks__add_task, mcp__tasks__update_task, mcp__tasks__move_task, mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder
---

# Task Management Protocol

## Storage — a structured board, NOT a Markdown file

Tasks live in a structured store the workspace board reads/writes. **You manage it through the tasks MCP, never by editing a file.** There is no `Tasks.md` to Read or Write — don't look for one, don't create one. Every change goes through a tool:

- `list_tasks` — the whole board grouped by status, each task with its `id`. **Always call this before adding or changing anything** — check for an existing task to update instead of duplicating.
- `add_task` — `{ title, description?, status?, owner?, priority?, deadline? }`. Defaults to Backlog.
- `update_task` — `{ id, ...fields to change }`. Pass only what changes.
- `move_task` — `{ id, status }`. Shortcut for changing the column.

A task has: `title`, `description`, `status` (backlog / in_progress / done), `owner` (a teammate slug or none), `priority` (high / medium / low), `deadline` (YYYY-MM-DD or none). Moving a task to `done` stamps the completion date automatically — you never set it by hand.

**Talk about tasks by the board, not the tool.** The MCP calls, the task `id`s, and the status tokens (`in_progress`) are internal. Say *"moved it to In Progress and gave it to Jan"* or *"added it to the backlog"* — never *"PATCHed the task"*, *"called move_task"*, an id, or an endpoint. The user thinks in the board's plain columns.

## Tasks vs Reminders

| What the user means | System |
|---|---|
| "I need to do X" / "add X to the list" — a unit of work to track | **the task board** (this skill) |
| "Remind me at \<time\>" — a timed action the bot performs | **set_reminder** (reminders skill) |

The board is for work items with no firing time. A timed alert is a reminder — don't put it on the board, and don't turn a board task into a reminder unless the user gives a fire time. (A reminder can *target* a teammate without it being a task; a task can be *assigned* to a teammate without notifying them — see below.)

## Assigning a task — `owner`

`owner` is **who's responsible**, not who created it. In team mode pass the teammate's roster **slug** (or a name / "me" — the tool resolves it); the board shows their profile picture. Default the owner to the person asking; only assign someone else when the user says so ("assign this to Jan"). Leave it unset if nobody owns it yet. **Assigning does NOT notify the teammate** — it just records ownership. If they should be pinged, that's a relay or a `set_reminder` with `recipient`, separate from the board. Full rules → `references/templates.md`.

## Adding a task

1. `list_tasks` — check for an existing task to update instead.
2. `add_task` → Backlog, unless work has already started (`status: "in_progress"`).
3. `title` is imperative and self-contained; `priority` and `deadline` when known (omit otherwise); `owner` per above.
4. Set reminders per `references/reminder-rules.md` (deadline within 14d → silent day-before; beyond 14d → ask; blocker → ask when to remind).

## Moving a task

- **Backlog → In Progress**: work has started. `move_task`. Check + offer a deadline reminder per `references/reminder-rules.md`.
- **In Progress → Done**: `update_task { id, status: "done" }` — completion date is stamped for you. Cancel any deadline reminder for the task.
- **Never delete tasks** — move them to Done.

## Updating a task

`update_task` when the deadline changes, owner changes, a blocker resolves, or new info arrives. Pass only the changed fields. A deadline change triggers cancel-old-reminder + set-new-reminder (see `references/reminder-rules.md`); other field changes don't need reminder updates.

## When to add tasks automatically

**Add when:** someone commits to a clear next step · a decision creates follow-up work · a deadline or dependency is mentioned.

**Don't add when:** vague ideas with no owner or action · timed alerts the bot should send (use `set_reminder`) · completed work with no follow-up.

## Weekly board review

When the first In Progress task is added: offer to set a weekly board-review reminder. Full rule in `references/reminder-rules.md` (don't double-offer, respect prior declines).

## Overdue check — on session start

After reading session notes: `list_tasks` and scan for tasks whose `deadline` has passed while status is still Backlog or In Progress. If any — flag immediately:
> "Overdue: [task title] — deadline was [date]. Still relevant?"

## Summarizing the board

When asked "what's open?" / "what do we have?": `list_tasks`, then summarize In Progress + high-priority Backlog items (and flag overdue). Don't dump the whole board.
