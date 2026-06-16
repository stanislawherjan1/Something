---
name: reminders
description: Use this when the user wants to set a timed reminder, list pending reminders, or cancel one. Reminders fire on Telegram, the web UI, or both — even when no session is active — and can repeat on a schedule (hourly/daily/weekly/monthly or a custom interval, with an optional end date or fire count).
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

- `set_reminder` — params, title/description guidance, `due` formats, **recurrence** (hourly / every-N interval / specific weekdays / monthly, + `until`/`count` bounds), timezone handling → `references/set-params.md`
- `list_reminders` — no params, returns pending sorted by due time with relative offsets
- `cancel_reminder` — needs `{ "id": "r_..." }`, get id from `list_reminders` first

## Delivery model

Reminders fire via a PM2 background process that polls `.reminders.json` every 60s — even when the bot session is dead.

**When a reminder fires, it's a trigger for YOU, not a message to forward.** If the reminder text describes an action ("check email and summarize", "run the audit and report"), *perform it with your tools and deliver the result* — do not just re-send the title. If it's a plain nudge ("call John at 3"), relay it in your voice. Reply on the reminder's `channel=` (telegram / web / all).

Full trigger format, the action-vs-nudge test, channel routing, and the two delivery paths (live session vs offline fallback) → `references/delivery.md`. **Read it before handling a `[REMINDER ...]` trigger.**

## After setting — confirm clearly

> "Reminder set for 15:00 UTC (17:00 Warsaw): 'Check Meta ads'.
> ID: r_a1b2c3 — use this to cancel if needed."

Always echo both UTC and the user's local time when their timezone is known. For a **recurring** reminder, also state the cadence and the next fire — e.g. "every Mon/Wed/Fri at 09:00 UTC (11:00 Warsaw), next this Friday. ID: r_a1b2c3."
