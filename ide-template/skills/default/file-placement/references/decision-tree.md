# File-placement — decision tree

## Sources of truth, in order

1. **Explicit path in the user's request** — just write there, skip this skill.
2. **`~/project/.claude/CLAUDE.md` → "Where to Save" section** — the user's per-workspace decision tree. Always wins over your guess.
3. **Existing folder shape** — see what's already there, don't invent new structure.
4. **Defaults** if `CLAUDE.md` missing or no "Where to Save" section:
   - References / research material → `Research/`
   - Anything unsorted / no clear home → `Inbox/` (waits for next audit)

## See the current shape

```bash
find ~/project -maxdepth 2 -type d \
  ! -path '*/.git*' ! -path '*/node_modules*' ! -path '*/.playwright-mcp*' \
  ! -path '*/.claude*' ! -path '*/.integrations*' ! -path '*/.chat*' \
  | sort
```

Don't invent folders the user hasn't created.

## Three branches after reading the shape

**A. Obvious match** → save without asking. State the destination in the reply ("Saved to `<folder>/<file>.md`").

**B. Two reasonable destinations OR no clear match** → ask **one** short question, then wait:
- "Brief — should it go in `<folder-A>/` or `<folder-B>/`?"
- "Reference doc — `Research/` or session journal?"

**C. New folder is the right answer** → propose explicitly:
> "I see 4 related files in `<folder>/` already. Want me to make a `<folder>/<subtopic>/` subfolder for these?"

## Audience-aware behavior

| Channel | Default |
|---|---|
| IDE / web chat (technical operator) | Always ask if non-obvious. They'll answer in seconds. |
| Telegram (non-technical team member) | Decide yourself, mention destination in reply, never block on a question. |

## Filename conventions

- Lowercase-with-dashes
- Descriptive (`brand-voice.md`, not `notes.md`)
- Dated **only** when time-bound: `2026-05-08-launch-recap.md`
- **No timestamps for evergreen content** — `brand-voice.md`, not `brand-voice-2026-05-05.md`

## Cluster-detection rule

If you notice **3+ files in the same folder share an obvious subtopic**, propose a subfolder reorg in your reply (don't execute):

> Heads up: I see N files in `<folder>/` that share `<subtopic>`. Want me to move them into `<folder>/<subtopic>/` next time we touch the folder?

Propose, wait, execute on approval. Never reorganize unilaterally.

## Memory-index shape after writing

```
mcp__memory__create_entities([{
  name: "<relative-path-from-project-root>",
  entityType: "file_index",
  observations: [
    "saved: <ISO date>",
    "topic: <2-3 keywords from content>",
    "trigger: <what the user asked for>"
  ]
}])
```

Re-save of an existing file → `mcp__memory__add_observations` with `["updated: <date>", "change: <what changed>"]` instead.
