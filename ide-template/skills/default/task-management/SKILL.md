---
name: task-management
description: Use this when the user wants to add, update, move, assign, delete, or review tasks. Tasks live on a structured board (Backlog / In Progress / Done) served by the workspace API over HTTP at http://localhost:3001/api/tasks — read and write it with the Bash tool (curl). There are no mcp__tasks__* tools; don't look for them. In a team, a task is on the person's own list or on the team board; each task can be assigned to a teammate.
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
| **List** | `curl -s -H "X-IDE-Turn: $IDE_TURN_ID" http://localhost:3001/api/tasks` |
| **Add** | `curl -s -X POST -H "X-IDE-Turn: $IDE_TURN_ID" http://localhost:3001/api/tasks -H 'Content-Type: application/json' -d '{"title":"…"}'` |
| **Update / move** | `curl -s -X PATCH -H "X-IDE-Turn: $IDE_TURN_ID" http://localhost:3001/api/tasks/<id> -H 'Content-Type: application/json' -d '{"status":"done"}'` |
| **Delete** | `curl -s -X DELETE -H "X-IDE-Turn: $IDE_TURN_ID" http://localhost:3001/api/tasks/<id>` |

The `X-IDE-Turn` header tells the API whose turn this is (the person you are
talking to); always send it, exactly as written.

- **List returns** `{ ok, teamMode, me, people: {slug→{name,avatar}}, tasks: [...] }`:
  the team board plus the person's own list, each task saying which with
  `scope` (`shared` = the team board, `user:<slug>` = their own list). You never
  get anyone else's own list, and an id from it is "not found" to you.
  **Always list before adding or changing** — find an existing task to update
  instead of duplicating, and to read a task's `id`.
- **Add** — only `title` is required; `description`, `status`, `owner`,
  `priority`, `deadline`, `scope` are optional. Defaults to the Backlog and,
  in a team, to the person's own list (see **Two lists** below). Returns
  `{ ok, task }` with the new `id`.
- **Update / move** — PATCH only the fields that change. Changing columns = PATCH
  `status`. Returns the updated task.
- **Delete** — removes a task for good. For what should never have been on the
  board: a mistake, a test, a duplicate — or when the user asks to delete one.
  Finished work goes to `done`, not here. Say which task you are deleting
  before you do it. Returns `{ ok, deleted }`; 404 if the id is gone.

**Loopback, no auth, no file edits.** `localhost:3001` is reachable from inside
the workspace without a login — don't add auth headers. Never `Read`/`Write`
`.tasks.json` yourself; the API owns the file, the column ordering, and the
`completed` stamp. If you ever see a `Tasks.md` in the project, it's a
pre-migration leftover — ignore it; the board is the API.

## Two lists, one board (team mode)

In a team each person has **their own list** and everyone shares **the team
board**. Both are on the same Tasks screen; only the person sees their own
list, and no admin can look into it.

- **Talking to one person in their own chat (a DM, the web chat):** a task goes
  on **their own list** unless they want it on the team board ("add it to the
  team's tasks", "put it on the board"), **assign it to someone else**
  (`owner` naming a teammate → the team board, since that person must see
  it), or leave it **unowned on purpose** (`"owner": null` → the team's
  backlog). Pass `"scope": "shared"` when they want the team board; pass
  nothing for their own list. `"scope": "mine"` asks for their own list
  explicitly.
- **In a group or channel:** every task goes on the team board; a room has no
  own list and may not ask for one (the API refuses `mine` there).
- **Say where it went, in plain words:** "added it to your list" vs. "put it on
  the team board" — never the field or the scope name. When someone adds a task
  for themselves that the team clearly waits on, say it is on their own list
  and offer the team board once; don't move it on your own.
- **Moving between the lists:** `PATCH {"scope":"shared"}` puts the person's
  own task on the team board; `PATCH {"scope":"mine"}` takes a team task **they
  own or created** to their own list (an unowned team task is claimed with
  `{"scope":"mine","owner":"<their slug>"}` in the same call — never taken
  quietly). Giving an own task to someone (`owner` = a teammate) moves it to
  the team board. Nobody can move anyone else's task to or from a private
  list; a request to do so is declined in one sentence.
- **A reminder for the whole team** (admin only) names only tasks on the team
  board, never one from your own list.
- Solo workspace: one list, the board; `scope` has no meaning there.

## Task shape

`id` (e.g. `t_a1b2c3d4`) · `title` · `description` · `status` (`backlog` /
`in_progress` / `done`) · `owner` (a teammate slug or `null`) · `priority`
(`high` / `medium` / `low` or `null`) · `deadline` (`YYYY-MM-DD` or `null`) ·
`scope` (`shared` = the team board, `user:<slug>` = that person's own list; an
own task's owner is always that person) ·
`completed` (auto-stamped when status → `done`, cleared when moved back — **never
set it yourself**). Full field + writing guidance → `references/templates.md`.

**Talk about tasks by the board, not the tool.** The API calls, the task `id`s, and the status tokens (`in_progress`) are internal. Say *"moved it to In Progress and gave it to Jan"* or *"added it to the backlog"* — never *"PATCHed the task"*, *"called move_task"*, an id, or an endpoint. The user thinks in the board's plain columns.

## Tasks vs Reminders

| What the user means | System |
|---|---|
| "I need to do X" / "add X to the list" — a unit of work to track | **the task board** (this skill) |
| "Remind me at \<time\>" — a timed action the bot performs | **set a reminder** (the reminders skill) |

The board is for work items with no firing time. A timed alert is a reminder —
don't put it on the board. (A reminder can *target* a teammate without it being a
task; a task can be *assigned* to a teammate without notifying them — see below.)

## Assigning a task — `owner`

`owner` is **who's responsible**, not who created it. **Leave `owner` out and the
task is the person asking's** — the API fills it in from the turn header, and in
a team the task is then on their own list. Pass a
teammate's roster **slug** (valid slugs are in the `people` map of the list
response) only when the user assigns someone else ("assign this to Jan" →
`"owner":"jan"`, which puts it on the team board), and `"owner": null` only when
they say nobody owns it yet (the team's backlog). In a
group conversation nothing is filled in: name the owner or leave it unowned.
**Assigning does NOT
notify the teammate** — it just records ownership; to ping them, that's a relay or
a reminder with a recipient, separate from the board. Full rules →
`references/templates.md`.

## Linking a task to what memory holds — `record` / `fact`

When the task comes from something remembered — a request, a decision, a
deadline in your memory block or in `memory_search` results — pass the
excerpt's id: `"record": "<id from the [… · id …] line>"` (or `"fact": "<fact id>"`
when you have one). The board and memory then point at each other: the Memory
screen shows the task and its state under the fact, the board shows where the
task came from, and when the task is done that fact is closed by itself. Leave it
out when the task is new.

## Whether something got done: the board decides

Memory excerpts carry the state of the task they led to (`↳ task "…": done on
… / in progress / not started`). A fact that something was asked for never
means it is still open. When someone asks whether a thing was done, sent or
finished and no excerpt says, list the board before answering — and answer from
the board, never "I don't know" while a task for it exists.

## Adding a task

1. `curl -s -H "X-IDE-Turn: $IDE_TURN_ID" http://localhost:3001/api/tasks` — check for an existing task to update instead.
2. POST → Backlog, unless work has already started (`"status":"in_progress"`).
   In a team: their own list unless it is for someone else, unowned on
   purpose, or they want it on the team board (`"scope":"shared"`) — see **Two
   lists** above. Say which list it went on.
3. `title` is imperative and self-contained; **`description` carries the full context** — the board shows only the title, so write in the description what was asked and by whom, the decision or request behind it, the numbers, dates, names and links from the conversation, what "done" looks like, blockers and who is waiting; a few sentences to a few short paragraphs, never empty (`references/templates.md`). `priority` and `deadline` when known (omit otherwise); `owner` per above.
   **`record` whenever memory is where the task comes from:** if the request,
   decision or deadline behind this task is in your memory block or in a
   `memory_search` result, copy that excerpt's id (the `id …` in its header
   line) into `"record"`. This is not optional: without it the board and memory
   drift apart and you will later be asked about work that is done. A brand-new
   request with nothing in memory → no `record`.
4. Set reminders per `references/reminder-rules.md` (deadline within 14d → silent day-before; beyond 14d → ask; blocker → ask when to remind).
5. **The board is the only record of a task.** Never `memory_note` it, never file it as a status or a "keeping track of" item: memory would keep asking about a task the board already shows as done. Memory keeps the fact or decision behind it, if there is one ("the client wants the deck by Friday"), and the nightly filing does that by itself.

## Moving a task

- **Backlog → In Progress**: work has started → `PATCH {"status":"in_progress"}`. Check + offer a deadline reminder per `references/reminder-rules.md`.
- **In Progress → Done**: `PATCH {"status":"done"}` — the completion date is stamped for you. Cancel any deadline reminder for the task.
- **Finished work → Done**, never deleted. Delete only a mistake, a test or a duplicate, or when the user asks (see Delete above).

## Updating a task

`PATCH /api/tasks/<id>` with only the changed fields when the deadline changes,
owner changes, a blocker resolves, or new info arrives. New context from a
later conversation (a decision, a number, a file, a blocker) goes into the
`description` — extend it, keep what was there; the description is the task's
whole story. A deadline change triggers
cancel-old-reminder + set-new-reminder (see `references/reminder-rules.md`); other
field changes don't need reminder updates.

## When to add tasks automatically

**Add when:** someone commits to a clear next step · a decision creates follow-up work · a deadline or dependency is mentioned.

**Don't add when:** vague ideas with no owner or action · timed alerts the bot should send (set a reminder instead) · completed work with no follow-up.

## Regular board upkeep — suggest a routine

Don't set your own weekly-review or overdue-scan reminders. When the board starts being used for real (the first In Progress task) and it fits the conversation, suggest one Marketplace routine via the `routines` skill: `stale-tasks` (sweep stuck tasks), `weekly-plan` (plan the week), or `deadline-at-risk` (warn ahead of deadlines). Once, in plain words; if they let it pass, don't offer again (`memory_search` before offering — earlier conversations are filed).

## Overdue check — at session start

Unless they have the `deadline-at-risk` routine, at session start list the board (`curl -s http://localhost:3001/api/tasks`) and scan for tasks whose `deadline` has passed while status is still `backlog` or `in_progress`. If any — flag immediately:
> "Overdue: [task title] — deadline was [date]. Still relevant?"

## Summarizing the board

When asked "what's open?" / "what do we have?": list the board, then summarize In Progress + high-priority Backlog items (and flag overdue). Don't dump the whole board. In a team, keep the two lists apart in the answer ("on your list: … · on the team board: …"); "what is everyone working on" is the team board alone.
