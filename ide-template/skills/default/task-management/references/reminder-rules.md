# Task-management — reminder integration rules

## When adding a task

If deadline is set (not TBD):

| Distance | Action |
|---|---|
| ≤14 days | **Silently** `set_reminder` for the day before, at a working-hours time in the person's zone (`MY_SETTINGS`, converted to UTC): title `"Deadline tomorrow: [task title]"`, description telling you to check the task first and stay silent if it's already Done. No confirmation needed. |
| >14 days | **Ask once**: "Set a reminder a week before the deadline?" |

If the task has a blocker: ask "When should I remind you about this blocker?" then `set_reminder` with that time.

## When moving Backlog → In Progress

1. Run `list_reminders` and check if a deadline reminder already exists for this task title.
2. If none **and** deadline is set → offer to set one. Default: day-before for ≤14d deadlines, week-before for >14d.
3. If a reminder already exists, leave it alone — don't duplicate.

## When moving In Progress → Done

1. `PATCH /api/tasks/<id> -d '{"status":"done"}'` — the completion date is stamped automatically.
2. `list_reminders` → find any reminder whose message contains the task title → `cancel_reminder`.
3. Don't delete finished work — `done` is the archive. Deleting is only for mistakes, tests, duplicates, or when the user asks.

## When updating an existing task

Only the deadline change matters for reminders:

1. `list_reminders` → find existing deadline reminder by task title.
2. `cancel_reminder` on the old one.
3. `set_reminder` for the new deadline (same day-before/week-before rules as adding).

Owner, priority, blocker text changes don't need reminder updates.

## Regular board review — a routine, not a reminder

Don't set a weekly board-review reminder yourself. When the first In Progress task is added, you may suggest a Marketplace routine via the `routines` skill (`stale-tasks`, `weekly-plan`, or `deadline-at-risk`), once, in plain words.

- Skip it if they already have one (`ROUTINES` / `memory_now`).
- A decline needs no logging: the conversation is filed automatically. `memory_search` before offering again, and don't if they said no.
