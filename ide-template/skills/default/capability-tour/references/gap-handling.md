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
PS: CLAUDE.md still describes <integration> but it's been deactivated. Remove that section from Context? (yes / no / leave for now)
```

- If user says **yes** → use Edit to remove that bullet from Context.
- If user says **leave** → respect, don't ask again for 30 days. Note dismissal in memory: `add_observations("capability-tour-state:<slug>", ["dismissed-cleanup-<integration>: <date>"])`.
- If user says **no** (no explicit dismissal period) → respect, but you may ask again next month.

> **Team mode — key the state PER USER.** The knowledge graph is shared, so a single `capability-tour-state` entity would make one teammate's dismissal suppress the tour for everyone (and load their interaction history into others' prompts). Use `capability-tour-state:<actor-slug>` (slug from the `[ACTOR …]` line) so dismissals + throttle are per person. Solo workspace → the bare `capability-tour-state` is fine.

## Repeated reminders cap

Don't run capability-tour proactively more than once per fortnight on the same user. Trust them to ask. Track surfacing-attempt dates via the per-user `capability-tour-state:<slug>` observations (bare `capability-tour-state` in solo) so the fortnight cap is evaluated against the CURRENT user's history only — not workspace-global.
