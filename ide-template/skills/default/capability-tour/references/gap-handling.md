# Gap A + Gap B handling — surface MCP/CLAUDE.md mismatches

Loaded when Step 3 (diff configured vs documented) found gaps. Two gap shapes need two different conversations.

## Gap A — configured but no Context description

The MCP is in `~/.claude.json` mcpServers but the user's `~/project/.claude/CLAUDE.md` `## Context` section doesn't mention it.

After the main tour message, append:

```
PS: <integration> was activated recently, but CLAUDE.md doesn't describe what it does for this business yet.
Want help filling that in? I'll explain what it can do technically, you tell me what it means for your work, and I'll add it to the Context section.
```

If user says yes:
1. Tell user what the MCP technically can do (tools list + 1-line description each).
2. Ask 1-3 short questions tailored to that integration (e.g. Shopify: "What product categories matter most? What metrics do you watch weekly? Who handles fulfilment?").
3. Wait for answers.
4. Use Edit tool to insert a new bullet under `## Context` in `CLAUDE.md`. Format matching existing entries (one bullet per integration).
5. Confirm: *"Added to CLAUDE.md. Take a look — edit anything that doesn't sound right."*

**Never edit CLAUDE.md without explicit per-edit approval.** This is the user's manifesto. Touch it only with green light.

## Gap B — described but no longer configured

The user's CLAUDE.md `## Context` section mentions an integration that's no longer in `~/.claude.json` mcpServers (was deactivated).

After the main tour message, append:

```
PS: CLAUDE.md still describes <integration> but it's been deactivated. Should I remove it from the Context section, or leave it there for now?
```

- If user says **yes** → use Edit to remove that bullet from Context.
- If user says **leave** → respect, don't ask again for 30 days. Nothing to write down: the conversation is filed automatically, and `memory_search "capability tour"` finds the dismissal later.
- If user says **no** (no explicit dismissal period) → respect, but you may ask again next month.

> **Team mode — per person.** A dismissal or a past tour belongs to the person who had that conversation; `memory_search` in their turn sees their own history, so one teammate's "leave it" never suppresses the tour for someone else.

## Repeated reminders cap

Don't run capability-tour proactively more than once per fortnight on the same user. Trust them to ask. There is no state file: before surfacing, run `memory_search "capability tour"` (or `memory_timeline` for the last two weeks) and skip if this person was already offered a tour or declined one recently.
