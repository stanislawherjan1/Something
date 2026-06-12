# Task-management — reminder integration rules

## When adding a task

If deadline is set (not TBD):

| Distance | Action |
|---|---|
| ≤14 days | **Silently** `set_reminder` for the day before: `"Deadline tomorrow: [task title]"`. No confirmation needed. |
| >14 days | **Ask once**: "Set a reminder a week before the deadline?" |

If the task has a blocker: ask "When should I remind you about this blocker?" then `set_reminder` with that time.

## When moving Backlog → In Progress

1. Run `list_reminders` and check if a deadline reminder already exists for this task title.
2. If none **and** deadline is set → offer to set one. Default: day-before for ≤14d deadlines, week-before for >14d.
3. If a reminder already exists, leave it alone — don't duplicate.

## When moving In Progress → Done

1. Append `**Completed:** YYYY-MM-DD` to the task entry.
2. `list_reminders` → find any reminder whose message contains the task title → `cancel_reminder`.
3. Never delete the task — move to `## Done` section.

## When updating an existing task

Only the deadline change matters for reminders:

1. `list_reminders` → find existing deadline reminder by task title.
2. `cancel_reminder` on the old one.
3. `set_reminder` for the new deadline (same day-before/week-before rules as adding).

Owner, priority, blocker text changes don't need reminder updates.

## Weekly board review reminder

When the first In Progress task is added in a project:

1. `list_reminders` → check for an existing weekly board-review reminder.
2. If none — offer once: "Want a weekly reminder to review the task board? (e.g. Mondays at 9:00)"
3. If user accepts: `set_reminder` with `repeat: weekly`.
4. Don't offer again if one exists (or the user already declined — log that decline to memory so future runs respect it).
