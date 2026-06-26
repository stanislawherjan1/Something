---
name: reminders
description: Use this when the user wants to set a timed reminder, list pending reminders, or cancel one. Reminders fire on Telegram, the web UI, or both — even when no session is active — and can repeat on a schedule (hourly/daily/weekly/monthly or a custom interval, with an optional end date or fire count).
allowed-tools: mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder
---

# Reminders Protocol

## What a reminder is — an action FOR YOU, by default

A reminder is a **scheduled action that YOU (the bot) carry out** at the due time. The default is that *you do the thing and deliver the result* — NOT that you ping the user to go do it themselves.

"Remind me to check my email in 5 min", "set yourself a reminder to pull yesterday's numbers at 9", "every morning summarise my inbox" → these schedule **work for you**: at the due time you actually check the email / pull the numbers / summarise, then report what you found. Phrasings like "set *yourself* a reminder to…" make it doubly clear *you* are the actor. **Re-sending the title ("hey, check your email") instead of checking it is the failure mode** — it frustrated a real user who wanted the work done.

A reminder is only a plain **nudge** when the thing is something **only the user can do** in the offline world — "call John", "take your meds", "leave for the airport". Then there's nothing for you to execute, so you relay it in your voice.

> The test, at fire time: **can I do this with my tools? → yes → DO it and report. Only if it's genuinely human-only → relay a nudge.** When unsure, act.

This is also what separates reminders from tasks: a **task** is the user's own to-do tracked on a board; a **reminder** is a timed job *the bot* runs (or, rarely, a nudge it relays).

In team mode every reminder is **tied to a person** — by default the asker, optionally a teammate or everyone. Targeting someone means *at the due time you act for them / reach out to them* (run the job and hand them the result, or relay the nudge). It does **NOT** assign them a task or write anything to a board.

## Tasks vs Reminders — don't conflate them

| What the user means | System |
|---|---|
| "I need to do X" / "add X to the list" — a to-do, no fire time | **the task board** (task-management skill) |
| "At \<time\>, remind/notify \<someone\> about X" — a timed action | **set_reminder** (this skill) |

- **No time mentioned → it's a task, not a reminder.**
- **A reminder aimed at a teammate is still a reminder** — you deliver it at the fire time. Never turn "remind Jan at 3" into a task board entry Jan owns, and don't promote a task board item into a reminder unless the user gives a fire time.

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

## After setting — confirm clearly (and in the right frame)

Confirm the **time** AND, for an action reminder, that **you'll do it** — not that you'll nag the user:

- Action (Kind 1): *"Done — in 5 min I'll check your email and report back (09:35 Warsaw)."* — NOT "I'll remind you to check your email." You're the one acting.
- Nudge (Kind 2): *"Done — I'll ping you to call John at 15:00 UTC (17:00 Warsaw)."*

Always echo both UTC and the user's local time when their timezone is known, plus the ID for cancelling. For a **recurring** reminder, also state the cadence and the next fire — e.g. "every Mon/Wed/Fri at 09:00 UTC (11:00 Warsaw), next this Friday. ID: r_a1b2c3."
