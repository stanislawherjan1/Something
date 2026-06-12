---
name: task-management
description: Use this when the user wants to add, update, move, or review tasks. Tasks are tracked in Tasks.md at the project root with Backlog / In Progress / Done columns.
allowed-tools: Read, Write, mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder
---

# Task Management Protocol

## Tasks vs Reminders

| What the user means | System |
|---|---|
| "I need to do X" — their own to-do | **Tasks.md** (this skill) |
| "Remind me at a specific time" — bot sends Telegram alert | **set_reminder** (reminders skill) |

Tasks.md is for the user's own work items — not for scheduling bot alerts.

## Storage

`Tasks.md` at the project root, three sections: `## In Progress`, `## Backlog`, `## Done` (see `references/templates.md` for ordering rationale and full task entry format).

**Always read `Tasks.md` before adding or updating** — check for duplicates first.

## Adding a task

1. Read `Tasks.md` — check for existing task to update instead.
2. Add to `## Backlog` unless work has already started.
3. Use the template in `references/templates.md` — Owner, Priority, Deadline (TBD if unknown) are mandatory.
4. Set reminders per `references/reminder-rules.md` (deadline within 14d → silent day-before; beyond 14d → ask; blocker → ask when to remind).

## Moving a task

- **Backlog → In Progress**: work has started. Check + offer deadline reminder per `references/reminder-rules.md`.
- **In Progress → Done**: append `**Completed:** YYYY-MM-DD`, cancel any deadline reminder for the task.
- **Never delete tasks** — always move to Done.

## Updating a task

Update in place when: deadline changes, owner changes, blocker resolves, new info arrives. Keep history in session notes, not in the task entry.

Deadline change triggers cancel-old-reminder + set-new-reminder (see `references/reminder-rules.md`). Other field changes don't need reminder updates.

## When to add tasks automatically

**Add when:**
- Someone commits to doing something with a clear next step
- A decision creates follow-up work
- A deadline or dependency is mentioned

**Don't add when:**
- Vague ideas without owner or action
- Timed alerts the bot should send — use `set_reminder` instead
- Completed work with no follow-up

## Weekly board review

When the first In Progress task is added: offer to set a weekly board-review reminder. Full rule in `references/reminder-rules.md` (don't double-offer, respect prior declines).

## Overdue check — on session start

After reading session notes: scan `Tasks.md` for tasks where `Deadline` has passed and status is still Backlog or In Progress. If any found — flag immediately:
> "Overdue: [task title] — deadline was [date]. Still relevant?"

## Summarizing the board

When asked "what's open?" or "what do we have?":
- Summarize In Progress + high-priority Backlog items
- Don't paste the full file
- Flag any overdue items
