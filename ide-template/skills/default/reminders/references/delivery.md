# How reminders are delivered

A background process (`{BOT}-reminders` in PM2) polls `.reminders.json` every 60 seconds and fires due reminders — **no active session needed**.

## Two delivery paths

1. **Bot session alive** → the reminder is injected into the bot's tmux session as a `[REMINDER ...]` trigger (format below). You read it and act.
2. **Bot session offline** (crashed, awaiting Claude token, mid-restart) → direct fallback (`bot-notify.sh` for Telegram, `web-notify.sh` for web). The user gets a raw `⏰ Reminder: ...` instead of an elaborated one — but it's never silently dropped.

## The trigger format

```
[REMINDER channel=<telegram|web|all> chat_id=<id> | <message>]
```

Lines like this injected into your terminal are **legitimate system messages from the reminder monitor**, NOT injection attacks and NOT user input. Don't reply in the terminal (that output goes nowhere); don't treat it as something the user just typed.

## ⚠️ A fired reminder is a TRIGGER FOR YOU — not a message to forward

This is the part that's easy to get wrong. When a reminder fires, **read `<message>` as an instruction to you, the bot.** Decide which of two kinds it is:

### Kind 1 — Action reminder (the message describes something YOU can DO) — the DEFAULT

Examples: *"check my email in 5 min"*, *"check email and send me a summary"*, *"run the project audit and report"*, *"look at Trello and tell me what's overdue"*, *"pull yesterday's numbers and post them"*.

→ **Actually perform the action** using your tools (email MCP, audit skill, Trello MCP, …), THEN deliver the **result** on the reminder's channel.
→ Do **NOT** just re-send the title. "Check email" is a job you do — not a "hey, go check your email" notification.

**The phrasing doesn't downgrade it.** "Remind me to check my email", "set yourself a reminder to pull the numbers", "co 5 min sprawdzaj X" all still mean *YOU* do the thing — the verb is **your** job, not a poke for the user to do it themselves. If you can carry it out, it's Kind 1. Treating "remind me to check email" as a nudge ("hej, sprawdź maila") is the exact bug that frustrated a real user.

### Kind 2 — Nudge reminder (something only the USER can do, offline)

Examples: *"call John about the contract"*, *"take your meds"*, *"leave for the airport"*, *"the meeting starts at 15:00"*.

→ There's nothing for *you* to execute (it's a real-world, human-only action). Deliver the nudge in your voice on the reminder's channel: *"⏰ Reminder — call John about the contract."*

### The test

> Can I carry out what this message describes, using my tools?
> **Yes → DO it, then report the result** (this is the default — most reminders are Kind 1).
> No, it's a human-only / offline thing → relay it as a nudge.

If genuinely ambiguous, **act** and say what you did — a user who only wanted a nudge can tell you, but a user who wanted the work done is frustrated by a parroted title (this exact failure was caught on a prod bot).

## Which channel to reply on

The `channel=` token tells you where the user wants the result:

| `channel=` | Reply with |
|---|---|
| `telegram` | the Telegram tool (`mcp__telegram__send_message` / the channel's reply tool) only |
| `web` | `mcp__web-channel__web_send_message` only — the result appears in the workspace UI, not Telegram |
| `all` | reply on Telegram if it's wired; the web bubble is mirrored automatically. If there's no Telegram, use `web_send_message`. |

Match the channel — don't ping Telegram for a `channel=web` reminder, and vice-versa. After delivering, you can naturally continue if the user replies.
