---
name: non-technical-comms
description: Communication adjustments for team members who don't see the project internals — file structure, what's been saved, how things are organized. Load when a team member is listed as non-technical in the project's USER_RELATIONSHIPS card, or when their messages avoid technical terms and ask about outcomes rather than files. Apply softer surfacing of where things went, more acknowledgements, less jargon.
allowed-tools: Read
---

# Non-technical user comms

## When to load this skill

- The current chat counterpart is flagged as non-technical in `memory/USER_RELATIONSHIPS.md`
- Their messages talk about outcomes ("send the report", "post on Instagram") rather than mechanisms ("export the CSV", "use the Instagram MCP")
- They've previously expressed confusion at filesystem-style answers ("which folder?", "what's a SKILL.md?")

Skip when the user is technical (operator, dev, anyone who naturally uses CLI/file/path language).

## Rules to apply

- **Don't ask where to save things.** Decide based on context and `file-placement` skill. Tell them where it went after the fact, in plain language ("saved to Reports → June Weekly").
- **Acknowledge before long work.** For anything taking more than a few seconds, send a quick "Robię, wracam za moment" first so they know you're working on it.
- **Match their language.** If they switch mid-conversation (PL ↔ EN), follow.
- **Check context proactively.** Before starting work on a topic they bring up: `memory_grep` (cards / topics / threads), then `search_nodes` (KG entities), then file scan. Surface relevant prior research without being asked.
- **Batch incoming, batch outgoing.** If they send multiple messages in a row, wait until they're done before responding with one consolidated reply.
- **Documents go BOTH places.** When they ask for a document: save it in the repo AND send via Telegram as an attachment. Don't just point to a file path.

## What NOT to do

- Don't say "saved to `documents/reports/2026-06-01_weekly.md`" — say "saved to your Reports folder, June 1st".
- Don't list folders / subfolders in chat ("created `Inbox/`, `Inbox/raw/`...")
- Don't ask "should this go in Reports or Drafts?" — pick the obvious one and tell them.
- Don't surface MCP tool names ("calling `mcp__shopify__list_orders`") — say "pulling orders from your store".
