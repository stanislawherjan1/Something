---
name: capability-tour
description: Show the user what tools/MCPs are configured and what they can actually do for this business. Use when someone asks what you can do or which tools are wired up, and proactively once after a new integration is activated. Diffs the active MCP set against the CLAUDE.md "Context" section and offers to fill the gap. Ends a tour with at most one fitting routine suggestion and a pointer that more is under Integrations.
allowed-tools: Read, Bash, Write, Edit
---

# Capability Tour Protocol

Non-technical users often don't know what's wired up. Even technical users forget. This skill is the antidote: a quick, business-flavored summary of what's available right now, plus active surfacing of gaps in the user's own documentation.

## Step 1 — list active MCPs

```bash
python3 -c "
import json
with open('/home/bot/.claude.json') as f:
    cfg = json.load(f)
servers = cfg.get('mcpServers', {})
for name in sorted(servers.keys()):
    print(name)
"
```

Filter out infrastructure-level MCPs that aren't user-facing capabilities: `memory`, `playwright`, `reminders`, `tasks`, `web-channel`. Those are plumbing, not features. (`workspace-api` stays — `memory_search` / `memory_timeline` are real capabilities.)

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

Use the description sources + tour message format + infrastructure filter rules in [references/mcp-defaults.md](references/mcp-defaults.md). Override defaults with whatever the user wrote in their CLAUDE.md `## Context` section (per-MCP).

End the tour with **at most one** routine suggestion that fits what they have wired up (e.g. a stale-tasks check when tasks are in use) — offered in a plain sentence, set up through the `routines` skill only on a yes — and one line that more integrations can be connected under Integrations.

## Step 5 — proactively surface gaps

If Step 3 found gaps (configured-but-undocumented or documented-but-deactivated), follow the conversation templates and per-edit approval rules in [references/gap-handling.md](references/gap-handling.md).

**Never edit CLAUDE.md without explicit per-edit approval.** This is the user's manifesto.

## Triggering modes

**Manual** — the user asks what you can do or what is wired up. Run full Step 1–5.

**Post-activation surfacing** — when you notice (during normal session work) that `/home/bot/.claude.json` mcpServers contains an entry that wasn't there last session AND isn't documented in CLAUDE.md Context, mention ONCE at a natural break in conversation:
```
Heads up — I see <integration> was added today. If you want, I can run a mini-tour or help describe it in CLAUDE.md Context. Or skip it and continue what we were doing.
```
Don't push if user moves on. There is no state file: the conversation is filed automatically, so before surfacing again run `memory_search "capability tour"` and check what this person was already offered or declined (in a team, that search is scoped to them, so one teammate's dismissal doesn't suppress the tour for everyone). Once-per-fortnight cap on proactive surfacing — see [references/gap-handling.md](references/gap-handling.md).

## Why this exists

Without active surfacing, integrations sit unused — non-technical users don't know what's available, so they keep working around tools the bot already has. The diff against CLAUDE.md fixes a second problem: tools without business context become tools the bot uses generically rather than in a way that fits this specific operation.
