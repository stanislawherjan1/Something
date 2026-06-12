---
name: RECENT_WEB
purpose: Rolling snapshot of the most recent ~50 messages from the web chat. Auto-maintained by workspace-api — do NOT hand-edit (your edits will be overwritten on the next snapshot tick).
write_when: workspace-api recent-snapshot-monitor fires (every 60s while the web chat is idle ≥10 min, or immediately on `Reset chat`). Never written by the agent.
write_how: Atomic rewrite. Old content replaced wholesale with the new tail.
do_not_write_here: Don't add observations, summaries, or commentary. This is the raw transcript window — keep it boring.
---

# Recent web-chat conversation

This card is empty on a fresh workspace. The recent-snapshot-monitor populates it after the first idle window or chat reset.

When populated, the format is:

```
## <iso-timestamp> — <role>
<message text>

## <iso-timestamp> — <role>
<message text>
...
```

Older messages first, newer at the bottom. Maximum ~50 messages or ~4000 tokens (whichever hits first; older messages trimmed).

The web chat lives at `<workspace>/.chat/conversation.jsonl`. This card is the model-facing view of its tail.
