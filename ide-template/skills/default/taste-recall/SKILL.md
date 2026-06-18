---
name: taste-recall
description: Load relevant anti-pattern memory at session start. Read memory/patterns/ABOUT.md, then glob memory/patterns/*.md (and, in a team workspace, the current user's private memory/users/<slug>/patterns/*.md) and pull in any whose `trigger:` frontmatter matches the current task. Use those rules as soft priors during the session. NOT user-facing — agent-facing memory primitive.
allowed-tools: Read, Glob, Grep
---

# Taste recall

You are working on a task. Some of the user's past tasks went wrong in ways he flagged; those failures got captured as **pattern cards** under `memory/patterns/<slug>.md`. Each card has a `trigger:` frontmatter field describing when it applies.

**Team workspace:** pattern cards are mostly **personal taste** (one person's "warmer, less corporate Polish") — which is private. So in a team workspace (an `[ACTOR slug]` line is present) load from **two** places: the shared `memory/patterns/` (team-wide anti-patterns everyone should respect) **and** the current user's private `memory/users/<their-slug>/patterns/` (their own taste). **Never** glob another teammate's `memory/users/<other-slug>/patterns/` — that loads their private taste into your reasoning for someone else. Solo workspace → just `memory/patterns/`.

Your job at session start:

1. **Read `memory/patterns/ABOUT.md`** — it describes the format.
2. **Glob `memory/patterns/*.md`** (or use the `Glob` tool — your skill set has it). **Team mode:** also glob `memory/users/<your-actor-slug>/patterns/*.md` for this user's private taste.
3. **For each card, judge whether its `trigger:` matches your current task.** This is a human-readable match — you decide, not a regex. Be inclusive: if a pattern *might* apply, load it. Token cost of being wrong is tiny (a few hundred tokens); cost of skipping a relevant pattern is repeating a known mistake.
4. **Treat loaded pattern bullets as soft constraints.** They say "avoid X" — respect them unless the user explicitly overrides in the current turn. If a pattern conflicts with a the user instruction, follow the user; mention the pattern's conflict in your response so the user can decide whether to update the pattern.

## What to do when you spot a new pattern

If during a session you notice yourself making a mistake you've made before — or the user explicitly rejects an output for a reason that doesn't fit an existing pattern — propose a new pattern card via the `reflect-learnings` chain on close. (Reflect-learnings will surface the proposal for the user to accept or skip.) In team mode a personal-taste pattern is the current user's own → it belongs in their private `memory/users/<slug>/patterns/`, not the shared root; only a genuinely team-wide anti-pattern goes to shared `memory/patterns/`.

**Don't auto-write to `memory/patterns/`** during a session. Patterns are Tier-3 (review only) by default — they're rules that shape future work, so they deserve the user's eye before landing.

## Output

No specific output format — this skill modifies how you reason, not what you return. The patterns affect your drafting / classification / planning decisions.

## When to skip this skill

For tasks that obviously don't touch any pattern's `trigger` (e.g. "what time is it"), don't bother globbing. Use judgement.

## Cost expectation

`memory/patterns/` is bounded by the user's actual usage. Empty at first; typically 5-15 cards after a few weeks. Load is ~200-1000 tokens, dwarfed by the rest of the session prompt.
