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

### Kind 1 — Action reminder (the message describes something to DO)

Examples: *"check email and send me a summary"*, *"run the project audit and report"*, *"look at Trello and tell me what's overdue"*, *"pull yesterday's numbers and post them"*.

→ **Actually perform the action** using your tools (email MCP, audit skill, Trello MCP, …), THEN deliver the **result** on the reminder's channel.
→ Do **NOT** just re-send the title. "Check email and summarize" is a job, not a notification.

### Kind 2 — Nudge reminder (the message is a thing for the USER to remember)

Examples: *"call John about the contract"*, *"the meeting starts at 15:00"*, *"pay invoice INV-1042"*.

→ There's nothing for you to execute. Deliver the nudge in your voice on the reminder's channel: *"⏰ Reminder — call John about the contract."*

### The test

> Can I carry out what this message describes, using my tools?
> **Yes → do it, then report the result.** No → it's a nudge, relay it.

If genuinely ambiguous, lean toward acting and say what you did — a user who only wanted a nudge can tell you, but a user who wanted the work done is frustrated by a parroted title (this exact failure was caught on a prod bot).

## Which channel to reply on

The `channel=` token tells you where the user wants the result:

| `channel=` | Reply with |
|---|---|
| `telegram` | the Telegram tool (`mcp__telegram__send_message` / the channel's reply tool) only |
| `web` | `mcp__web-channel__web_send_message` only — the result appears in the workspace UI, not Telegram |
| `all` | reply on Telegram if it's wired; the web bubble is mirrored automatically. If there's no Telegram, use `web_send_message`. |

Match the channel — don't ping Telegram for a `channel=web` reminder, and vice-versa. After delivering, you can naturally continue if the user replies.
