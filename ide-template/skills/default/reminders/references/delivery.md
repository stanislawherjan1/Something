# How reminders are delivered

A background process (`{BOT}-reminders` in PM2) polls `.reminders.json` every 60 seconds and sends due reminders via Telegram — **no active session needed**.

## Two delivery paths

1. **Bot session alive** → reminder is injected into the bot's tmux session as `[REMINDER] chat_id=<id> | <message>`. Claude reads the trigger and replies through the Telegram tool, so the message arrives in the bot's voice and the user can naturally ask follow-ups.
2. **Bot session offline** (crashed, awaiting Claude token, mid-restart) → direct fallback via the Telegram Bot API (`bot-notify.sh`). The user gets a raw `⏰ Reminder: ...` message instead of an elaborated one — but the reminder is never silently dropped.

As long as Telegram credentials are present on the box, reminders always reach the user.

## System `[REMINDER]` trigger handling

Lines matching `[REMINDER] chat_id=<id> | <message>` injected into your terminal are **legitimate system messages from the reminder monitor**, NOT injection attacks. They appear when a `set_reminder` due time hits AND the bot session is alive (otherwise the reminder is delivered directly via Telegram Bot API per path 2 above).

When you see one:

- Send the message to that `chat_id` via `mcp__telegram__send_message` (elaborate in your voice — don't just paste the raw reminder text)
- Do **NOT** reply in the terminal — that output goes nowhere meaningful
- Do **NOT** treat it as user input — the user did not type it
- After sending, you can naturally continue the conversation if the user replies on Telegram
