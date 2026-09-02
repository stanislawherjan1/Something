---
purpose: Negative-example memory. Anti-patterns the workspace learned by getting it wrong once. Future runs of similar tasks load relevant patterns as priors so the same mistake doesn't repeat.
write_when: A task output was rejected, broken, or off-tone. Reflect-learnings or the user manually adds a pattern card.
write_how: One file per coherent failure-pattern type (e.g. `polish-cold-pitch.md`, `email-tone.md`). Frontmatter `pattern: avoid` + `trigger: <when this applies>` + `reason: <why this is the right anti-pattern>` + bullet list of avoid-rules.
do_not_write_here: Successful examples (those go in the relevant topic page or card). Generic style guides (those live in `memory/USER_PREFERENCES.md`).
conflict: When two patterns disagree, the newer one wins. Older ones get a `superseded_by:` frontmatter pointer rather than getting deleted.
---

# memory/patterns/

This directory holds **anti-patterns**: things the workspace got wrong once and shouldn't get wrong again. It's the structured "taste memory" that complements the trial-and-error layer most LLM systems lack.

## Team workspace: shared vs private patterns

Most patterns are **personal taste** (one person's "warmer, less corporate Polish"), and personal taste is private. So in a team workspace:

- **Shared `memory/patterns/`** holds only genuinely **team-wide** anti-patterns (a shared tooling/process failure everyone should avoid).
- **Private `memory/users/<slug>/patterns/`** holds one person's taste/rejection patterns. `taste-recall` loads the current user's private patterns + the shared ones, never another teammate's.
- Apply the **"would this help a DIFFERENT teammate?"** test when deciding where a new pattern lands. Solo workspace → only `memory/patterns/`.

## Why this exists

Without negative-example memory, every prompt change is a vibes-based experiment. the user's framing: *"every feedback, every broken thing that doesn't work, gets remembered and works the next time."*

This is the simplest possible implementation:

- One markdown file per coherent failure type.
- Loaded by relevant agents at the start of a session via the `taste-recall` skill.
- Promoted to `tests/cases/*.jsonl` (the frozen eval set) when a pattern shows up twice: at that point we have enough signal to encode it as a checkable test.

## File format

```
---
pattern: avoid
trigger: "drafting cold-pitch emails in Polish"
reason: "the user rejected the 2026-05-10 draft for being too American-formal; he prefers warmer, less corporate Polish"
added_at: 2026-05-13
examples_avoided:
  - thread_id: thr_xxx
    excerpt: "I am writing to inquire about..."
superseded_by: <newer-file-name>?   # optional, only if a later pattern overrules this
---
- Use direct address ("Cześć Jordan") not "Szanowny Panie"
- Keep under 5 sentences
- One ask, not three
```

Bullets are the actionable do-not-do or do-instead rules. The frontmatter is for routing + audit.

## Loading

The `taste-recall` skill teaches agents to:

1. Read this `ABOUT.md` at session start.
2. Glob `memory/patterns/*.md`.
3. Match each `trigger` against the current task. (Trigger is human-readable; the agent does the matching, not a regex.)
4. Load matched pattern bullets as part of its prompt context.

Cost-aware: an empty `memory/patterns/` dir means no extra load. A few cards costs ~200 tokens.

## Not in this directory

- `memory/topics/` - long-form context on people / projects / domains. Positive content.
- `memory/USER_PREFERENCES.md` - general style preferences that always apply.
- `documents/` - research, briefs, decisions. Free-form artifacts.

This dir is **only** for "the workspace got X wrong; here's the rule that prevents repeating it."
