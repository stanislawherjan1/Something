---
name: reflect-learnings
description: Memory consolidation — propose additions to the 7 memory cards based on recent conversation. Output is ALWAYS a JSON proposal list that the apply-script (/opt/ide/hooks/reflect-apply.py) converts to a `memory/_drafts/learnings-YYYY-MM-DD.md` review file. Proposals NEVER apply directly; operator approves via `/memory review` and `/memory approve <id>` on Telegram. Triggered by `[REFLECT_LEARNINGS_TRIGGER]` (daily reminder + idle-detection from recent-snapshot monitor) or manually via "reflect on learnings", "consolidate memory", "review what we learned".
allowed-tools: Read, Write, mcp__memory__search_nodes, mcp__memory__create_entities, mcp__memory__add_observations
---

# Reflect-bot: memory consolidation with operator approval

You are reading recent conversation history (RECENT_WEB.md + RECENT_TELEGRAM.md, plus the live thread if invoked in-session). Your job: produce a JSON list of **proposed additions** to the memory cards.

**Critical:** proposals NEVER apply directly to canonical cards. The apply-script (`/opt/ide/hooks/reflect-apply.py`) routes your JSON output to `~/project/memory/_drafts/learnings-YYYY-MM-DD.md` as markdown sections, and the operator approves each one via `/memory approve <id>` on Telegram. Autonomous writes to canonical cards are a one-way ratchet — a wrong proposal lives forever, polluting future cached prefixes. `_drafts/` flow keeps human-in-the-loop without losing the consolidation benefit.

## When this skill fires

- `[REFLECT_LEARNINGS_TRIGGER]` arrives (daily reminder, see global-claude.md Periodic Self-Audit Triggers table)
- recent-snapshot monitor detects IDLE on web or Telegram channel and triggers reflect (workspace-api hook)
- User says "reflect on learnings", "consolidate memory", "review what we learned"

## The 7 memory cards

Each lives at `project/memory/<NAME>.md` and is curated as a tight reference. They are:

- `USER_PROFILE` — stable facts about the user (role, location, languages, what he's focused on, schedule)
- `USER_PREFERENCES` — soft preferences (tone, format, channels, working style)
- `USER_RELATIONSHIPS` — people in the user's life (one `## Name (Role)` section per person)
- `USER_REFLECTIONS` — self-introspection the user has shared (dated entries, newer on top)
- `RULES` — hard rules ("always", "never"). Sensitive — Tier 3 (pending review only)
- `AGENT_IDENTITY` — the bot's character / voice. Sensitive — Tier 3
- `AGENT_TOOLS` — tool / integration gotchas. Sensitive — Tier 3

## Output contract

Reply with **one JSON object and nothing else**. No preamble, no commentary, no markdown fences. The workspace-api parses `stdout` as JSON; any "Here are the proposals:" garbage breaks the run.

```
{
  "proposals": [
    {
      "card":       "USER_PROFILE",
      "section":    "Identity",
      "action":     "append",
      "content":    "- Lives in: Warsaw, Poland",
      "rationale":  "the user said \"I'm based in Warsaw\" at message #3.",
      "confidence": 0.95
    }
  ]
}
```

## Actions

The `action` field controls how the applier writes your proposal. Each action has its own confidence floor; the applier rejects below-floor proposals automatically. **Use the least destructive action that fits.**

- `append` (default, floor 0.7) — drop `content` after the section header (creates an `(auto-applied)` section at the bottom if no `section` is given). Safe — worst case is one extra line you can prune later.
- `update_field` (floor 0.85) — replace a single `- <Field>: ...` bullet within a section. Requires `section` + `field` (the label before the colon). Refuses to apply if zero or more-than-one bullet matches — `update_field` is unambiguous-only.
- `replace_section` (floor 0.9) — overwrite the entire `## <section>` block in place. `content` is the new body for the section. Header line is preserved. Use ONLY when the existing section content is stale or wrong and you're rewriting it whole — never to add one line.

Default to `append` unless you have a strong specific reason. The applier captures BEFORE state in the activity log for every non-append action so a future undo path has the data.

### Examples

Updating the user's location when he moved:
```
{
  "card": "USER_PROFILE",
  "section": "Identity",
  "action": "update_field",
  "field": "Lives in",
  "content": "- Lives in: Kraków, Poland",
  "rationale": "the user said \"I moved to Kraków last month\" at message #7.",
  "confidence": 0.95
}
```

Refreshing the Krystian section after a new fact landed:
```
{
  "card": "USER_RELATIONSHIPS",
  "section": "Krystian (cofounder)",
  "action": "replace_section",
  "content": "- Cofounder, commercial lead.\n- Pricing strategy + customer churn his beat.\n- Direct, prefers Polish.",
  "rationale": "Two messages updated multiple facts about Krystian at once.",
  "confidence": 0.93
}
```

Empty list is the correct answer most of the time: `{"proposals": []}`.

## Rules

Seven mechanical rules govern every proposal — see [references/rules.md](references/rules.md) for full text (fewer-over-more, high-confidence only, cite source, content is markdown-ready, match card contract, no duplicates, no RULES/AGENT_* unless explicit).

TL;DR: under-propose by default; cite transcript; format-match the card; skip sensitive cards.

## Decision tree (what goes where)

Walk these in order. **Stop at the first match.**

1. **Hard rule** — phrases like "from now on never", "always", "never", "must", "don't ever"  → `RULES`. Section: `Never` or `Always`. **Tier 3.**
2. **Stable fact about the user** — role, location, languages, family member by name, schedule, big-picture focus  → `USER_PROFILE`. Section: Identity / Background / Currently focused on / Schedule.
3. **Soft preference** — how the user likes to be communicated with, formatting, surfacing, tool preference  → `USER_PREFERENCES`. Section: Communication / Channels / Surfacing / Tools and integrations / Working style.
4. **Person** — a new colleague / client / friend / family member with recurring context  → `USER_RELATIONSHIPS`. Use `## Name (Role) — relationship to user` as a new section.
5. **Self-introspection** — the user noticing a pattern about himself (energy, mood, tendency)  → `USER_REFLECTIONS`. Section: usually a top-of-card dated entry like `## 2026-05-12 — <one-line label>`.
6. **Tool gotcha** — caveat or "use X not Y" about an integration  → `AGENT_TOOLS`. **Tier 3.**
7. **Agent character note** — voice / disposition shift the user asked for  → `AGENT_IDENTITY`. **Tier 3.**

Anything that doesn't fit one of these — don't propose. The memory cards are not a catch-all; long-form goes in `documents/` and is the user's call, not the bot's.

## Examples

Three example outputs — good (well-scoped person), better (empty proposals = the common correct answer), wrong (everything we don't want) — plus a boilerplate JSON sample to copy-paste from: see [references/proposal-examples.md](references/proposal-examples.md).
