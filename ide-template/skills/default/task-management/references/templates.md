# Task fields, assignment & priority definitions

Tasks are structured records on the board — managed via the workspace API at
`http://localhost:3001/api/tasks` (curl; there are no `mcp__tasks__*` tools), not
Markdown. Each task has these fields:

| Field | Meaning |
|---|---|
| `title` | Short imperative heading — self-contained. "Send Q3 report to acme". |
| `description` | Optional context: why it matters, what's needed, blockers, file paths. |
| `status` | `backlog` / `in_progress` / `done`. |
| `owner` | Who's responsible — a teammate slug, or none. See below. |
| `priority` | `high` / `medium` / `low`, or none. |
| `deadline` | `YYYY-MM-DD`, or none. |
| `scope` | Team mode only. `shared` = the team board, everyone's; `user:<slug>` = that person's own list, which only they see. On create pass `shared` for the team board or `mine` for the person's own list (the default in their own chat); on update `shared` / `mine` moves the task between the lists. See below. |

`completed` is stamped automatically when a task moves to `done` — never set it
yourself.

## Writing a good title + description

**Title** — imperative and self-contained; the user should know what to do from
the title alone.

- ✅ "Send Q3 report to acme" · "Call John about the contract" · "Pay invoice INV-1042"
- ❌ "Q3" (too vague) · cramming the whole story into the title (that's `description`).

**Description** — the "why now / what to include / who's waiting". One or two
sentences. Skip it when the title is self-explanatory.

## `owner` — who the task is assigned to

`owner` is **who's responsible for the task**, not who created it.

- **Team mode →** the teammate's roster **slug** (e.g. `alex`). The board resolves it to their profile picture + name. The tool also accepts a name or "me" and resolves it; never pass a display name where you mean a different person, and never an email.
- **Default = the person asking.** Only assign someone else when the user says so ("assign this to Jan" → `owner: "jan"`).
- **Unassigned** is fine — omit `owner` if nobody owns it yet. Don't invent one.
- **Solo workspace →** a plain name (or "me") is fine; there's no roster to resolve.

Assigning a task to a teammate does **not** notify them — it just records
ownership. If the user wants the teammate pinged, that's a relay or a
`set_reminder` with `recipient`, separate from the board.

## `scope` — the person's own list or the team board

A task on a person's **own list** is theirs alone: it is in their own tree on
the server, no teammate or admin gets it back from the board, and its `owner`
is always that person. A task on the **team board** is everyone's.

- **Default in the person's own chat:** their own list. The team board when
  they ask for it, when `owner` names someone else, or when `owner` is `null`
  on purpose.
- **In a room:** always the team board; `mine` is refused there.
- **Moves:** `{"scope":"shared"}` on an own task; `{"scope":"mine"}` on a team
  task the person owns or created (claim an unowned one with `owner` in the
  same call). An own task given an `owner` other than its person moves to the
  team board. Nobody moves anyone else's task into or out of a private list.
- A task on an own list may still be linked to a shared memory fact; the team
  then sees that the fact has a task somewhere, nothing of what it says.

## Priority definitions

| Priority | Criteria |
|---|---|
| High | Blocks other work, deadline within 2 weeks, or direct revenue/legal impact |
| Medium | Important but not urgent — can wait 2–4 weeks |
| Low | Nice to have, no deadline pressure |

## Column order & meaning

Columns read left-to-right (board) / top-to-bottom (list) as the natural flow:

- **Backlog** — not yet started.
- **In Progress** — actively being worked.
- **Done** — completed; a log, not a focus area.
