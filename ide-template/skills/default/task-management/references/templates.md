# Task fields, assignment & priority definitions

Tasks are structured records on the board — managed via the workspace API at
`http://localhost:3001/api/tasks` (curl; there are no `mcp__tasks__*` tools), not
Markdown. Each task has these fields:

| Field | Meaning |
|---|---|
| `title` | Short imperative heading — self-contained. "Send Q3 report to acme". |
| `description` | The whole context, in full — the board shows only the title; everything a person needs when they open the task lives here. See below. |
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

**Description** — write it every time, and write it in full. The list and the
board show the title alone; the description is what a person reads when they
open the task, days later, without the conversation in front of them. Put in
it what you know from the conversation, as a short brief:

- what was asked and by whom, and what "done" looks like;
- the context: the decision or request behind it, the numbers, dates, names,
  amounts and places that were mentioned, the thread or meeting it came from;
- what is needed to do it: files or links (paths in the workspace, a document, a
  ticket), who to involve, what to check first;
- blockers, dependencies, what is waiting on it and who is waiting.

Several sentences or a few short paragraphs; plain prose, no headings. Never
leave it empty because the title "says it all", and never a bare phrase that
repeats the title — a week later the person no longer remembers what it was
about, and the description is all they have.

- ❌ "Pricing sheet for the client." · "Follow up." · "" (empty)
- ✅ "Orbis asked on Tuesday's call for a pricing sheet for the wholesale tier
  before their board meets on 20 October; Ann promised it by the 18th. Base it
  on the September price list (Sales/pricing-2026-09.xlsx) with the 8% volume
  discount Nora approved for orders above 500 units. Jonas still has to confirm
  the shipping surcharge for Portugal, which the sheet needs. Send it to Marta
  Reyes at Orbis and copy Nora; the deal is about €40k a year." Keep out what should not be there: on the team board,
nothing from a person's private conversations or memory beyond what they asked
to put on the board; secrets never.

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
