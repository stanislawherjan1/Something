---
name: capability-tour
description: Show the user what tools/MCPs are configured and what they can actually do for this business. Triggered manually by phrases "what can you do", "show me your tools", "show capabilities", "what tools do I have", "what's wired up". Also runs proactively after a new integration is activated. Diffs the active MCP set against CLAUDE.md "Context" section and offers to fill the gap.
allowed-tools: Read, Bash, Write, Edit
---

# Capability Tour Protocol

Non-technical users often don't know what's wired up. Even technical users forget. This skill is the antidote: a quick, business-flavored summary of what's available right now, plus active surfacing of gaps in the user's own documentation.

## Step 1 — list active MCPs

```bash
python3 -c "
import json
with open('/home/coder/.claude.json') as f:
    cfg = json.load(f)
servers = cfg.get('mcpServers', {})
for name in sorted(servers.keys()):
    print(name)
"
```

Filter out infrastructure-level MCPs that aren't user-facing capabilities: `memory`, `playwright`, `reminders`. Those are plumbing, not features.

## Step 2 — read the user's own description

Open `~/project/.claude/CLAUDE.md` and find the `## Context` section. Extract which integrations the user described and what they wrote about each.

If `CLAUDE.md` doesn't exist or has no Context section: skip to Step 4 with empty context — you'll be working from defaults only.

## Step 3 — diff: configured vs documented

For each active MCP from Step 1, check if it's mentioned in the Context section:

| State | Meaning | Action |
|---|---|---|
| Configured + described | User wrote what it does for this biz | Use the description verbatim |
| Configured + not described | Active but no business context | Default description + flag for "want me to help write Context?" |
| Described + not configured | User wrote about it but it's not active anymore (deactivated) | Flag for "remove from Context?" |

## Step 4 — compose the tour

Use the MCP → human-readable mappings + tour message format + infrastructure filter rules in [references/mcp-defaults.md](references/mcp-defaults.md). Override defaults with whatever the user wrote in their CLAUDE.md `## Context` section (per-MCP).

## Step 5 — proactively surface gaps

If Step 3 found gaps (configured-but-undocumented or documented-but-deactivated), follow the conversation templates and per-edit approval rules in [references/gap-handling.md](references/gap-handling.md).

**Never edit CLAUDE.md without explicit per-edit approval.** This is the user's manifesto.

## Triggering modes

**Manual** — user asks "what can you do", "show me your tools", etc. Run full Step 1–5.

**Post-activation surfacing** — when you notice (during normal session work) that `~/.claude.json` mcpServers contains an entry that wasn't there last session AND isn't documented in CLAUDE.md Context, mention ONCE at a natural break in conversation:
```
Heads up — I see <integration> was added today. If you want, I can run a mini-tour or help describe it in CLAUDE.md Context. Or skip it and continue what we were doing.
```
Don't push if user moves on. Track in memory `capability-tour-state` so you don't repeat. Once-per-fortnight cap on proactive surfacing — see [references/gap-handling.md](references/gap-handling.md) for the throttle pattern.

## Why this exists

Without active surfacing, integrations sit unused — non-technical users don't know what's available, so they keep working around tools the bot already has. The diff against CLAUDE.md fixes a second problem: tools without business context become tools the bot uses generically rather than in a way that fits this specific operation.
