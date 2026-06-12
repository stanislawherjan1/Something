---
name: gtasks
description: How to use the Google Tasks MCP — list task lists, list tasks (with show_completed toggle), create/update/delete items, mark complete or uncomplete. Triggers on "google tasks", "to-do list", "moja lista zadań", "add to my tasks", "co mam dziś do zrobienia".
requires: google-workspace
allowed-tools: mcp__gtasks__list_task_lists, mcp__gtasks__list_tasks, mcp__gtasks__create_task, mcp__gtasks__update_task, mcp__gtasks__delete_task
---

# Google Tasks Protocol

Google Tasks is the user's personal todo list — separate from the project's `Tasks.md` which is shared. Don't conflate. When the user says "add to my Google tasks" or pastes a Tasks reference, this is the right MCP.

## Pre-flight

If `mcp__gtasks__*` aren't available, activate **Integrations → Google Workspace**. Token needs the `tasks` scope.

Default tasklist alias is `"@default"` — most users don't need to specify a list explicitly.

## Reading

- **`list_task_lists`** — every list the user owns. Returns id (use as `tasklist_id`), title, updated.
- **`list_tasks { tasklist_id?, show_completed?, max_results? }`** — items in one list. `show_completed` defaults to `true` (Google's default). Pass `false` for "what's still open".

## Creating

`create_task { tasklist_id?, title, notes?, due?, parent? }`:
- `due` is **date-only** (YYYY-MM-DD). Even if you pass a full RFC 3339 timestamp with hours, Google silently truncates to date in UTC. There's no way to set "due at 3pm" — Tasks doesn't support due-times.
- `parent` makes the new task a subtask of an existing task id.
- `previous` controls sibling order — new task is inserted right after the given task id.

Confirm title + due before creating.

## Updating

`update_task { tasklist_id?, task_id, ...patch }` — patch fields. Only what you specify changes.

To complete: `{ status: "completed" }` — Tasks auto-stamps the completed time.
To uncomplete: `{ status: "needsAction" }` — the MCP also clears `completed` automatically (if you don't, the task ends up in a contradictory state).

## Deleting

`delete_task` — **permanent**. Tasks API has no trash. Unlike Drive/Calendar/Gmail, this is irreversible. Confirm explicitly.

## Defensive defaults

- **Confirm writes**, especially deletes (no recovery).
- **`due` is date-only** — don't try to encode times. If the user said "remind me at 3pm", Tasks isn't the right place; use the reminder MCP instead.
- **"My Google Tasks" ≠ project Tasks.md** — don't sync between them automatically. Ask which the user means if ambiguous.
- **Wrong scope?** Re-activate Google Workspace to refresh the token.
