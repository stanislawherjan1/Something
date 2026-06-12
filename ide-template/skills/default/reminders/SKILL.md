---
name: reminders
description: Use this when the user wants to set a timed reminder, list pending reminders, or cancel one. Reminders fire via Telegram even when the user isn't in a session.
allowed-tools: mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder
---

# Reminders Protocol

## Tasks vs Reminders

| What the user means | System |
|---|---|
| "I need to do X" — their own to-do | **Tasks.md** (task-management skill) |
| "Remind me at a specific time" — bot sends Telegram alert | **set_reminder** (this skill) |

**If no time is mentioned → it's a task, not a reminder.**

## Tool usage

- `set_reminder` — params, title/description guidance, `due` formats, timezone handling → `references/set-params.md`
- `list_reminders` — no params, returns pending sorted by due time with relative offsets
- `cancel_reminder` — needs `{ "id": "r_..." }`, get id from `list_reminders` first

## Delivery model

Reminders fire via a PM2 background process that polls `.reminders.json` every 60s — even when the bot session is dead. Details + the two delivery paths (live session vs offline fallback) + how to handle `[REMINDER]` triggers in your terminal → `references/delivery.md`.

## After setting — confirm clearly

> "Reminder set for 15:00 UTC (17:00 Warsaw): 'Check Meta ads'.
> ID: r_a1b2c3 — use this to cancel if needed."

Always echo both UTC and the user's local time when their timezone is known.
