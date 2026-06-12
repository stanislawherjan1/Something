---
name: RECENT_TELEGRAM
purpose: Rolling snapshot of the most recent ~50 Telegram messages. Auto-maintained by workspace-api — do NOT hand-edit (your edits will be overwritten on the next snapshot tick).
write_when: workspace-api recent-snapshot-monitor fires (every 60s while the Telegram source JSONL is idle ≥10 min). Never written by the agent.
write_how: Atomic rewrite. Old content replaced wholesale with the new tail.
do_not_write_here: Don't add observations, summaries, or commentary. This is the raw transcript window — keep it boring.
---

# Recent Telegram conversation

This card is empty on a fresh workspace. The recent-snapshot-monitor populates it after the first idle window of Telegram activity.

When populated, the format is:

```
## <iso-timestamp> [chat <chat_id>] — <role> (<user>)
<message text>

## <iso-timestamp> [chat <chat_id>] — <role> (<user>)
<message text>
...
```

Older messages first, newer at the bottom. Maximum ~50 messages or ~4000 tokens (whichever hits first; older messages trimmed).

The Telegram source is `/home/bot/.telegram/conversation.jsonl` (written by the bot's grammy middleware + API transformer — see `bot.sh` Patch 4). This card is the model-facing view of its tail.

**When the user asks about prior Telegram messages, consult this card before claiming no context.**
