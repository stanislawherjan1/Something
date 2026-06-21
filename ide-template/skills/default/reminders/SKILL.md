---
name: reminders
description: Use this when the user wants to set a timed reminder, list pending reminders, or cancel one. Reminders fire on Telegram, the web UI, or both — even when no session is active — and can repeat on a schedule (hourly/daily/weekly/monthly or a custom interval, with an optional end date or fire count).
allowed-tools: mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder
---

# Reminders Protocol

## What a reminder is

A reminder is a **timed action that YOU (the bot) perform** — at the due time *you* do something: send a nudge, or carry out an action and deliver the result. It is **not** a to-do item parked on a board.

In team mode every reminder is **tied to a person** — by default the asker, optionally a teammate or everyone. Targeting someone means *at the due time you reach out to them* (notify them, or do something and hand them the result). It does **NOT** assign them a task or write anything to their `Tasks.md`. The reminder stays *your* scheduled job; the recipient is simply who it concerns. "Remind Jan about the deadline at 3pm" = *at 3pm, you ping Jan* — not "give Jan a to-do."

## Tasks vs Reminders — don't conflate them

| What the user means | System |
|---|---|
| "I need to do X" / "add X to the list" — a to-do, no fire time | **Tasks.md** (task-management skill) |
| "At \<time\>, remind/notify \<someone\> about X" — a timed action | **set_reminder** (this skill) |

- **No time mentioned → it's a task, not a reminder.**
- **A reminder aimed at a teammate is still a reminder** — you deliver it at the fire time. Never turn "remind Jan at 3" into a `Tasks.md` entry Jan owns, and don't promote a Tasks.md item into a reminder unless the user gives a fire time.

## Who it's for (team mode)

Infer the recipient from wording, exactly like a relay. Default = the asker → omit `recipient`. Named people → their roster **slugs** (`["jan","kasia"]`, never display names/emails). "everyone"/"the team" → `"everyone"`. This only sets **who you notify / act for** at fire time — it never assigns work. Full param + permission rules → `references/set-params.md`.

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
