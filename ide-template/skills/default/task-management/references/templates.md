# Task fields, assignment & priority definitions

Tasks are structured records on the board (managed via the tasks MCP), not
Markdown. Each task has these fields:

| Field | Meaning |
|---|---|
| `title` | Short imperative heading — self-contained. "Send Q3 report to acme". |
| `description` | Optional context: why it matters, what's needed, blockers, file paths. |
| `status` | `backlog` / `in_progress` / `done`. |
| `owner` | Who's responsible — a teammate slug, or none. See below. |
| `priority` | `high` / `medium` / `low`, or none. |
| `deadline` | `YYYY-MM-DD`, or none. |

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
