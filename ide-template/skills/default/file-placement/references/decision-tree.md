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

**A. Obvious match** → save without asking. Confirm in plain language ("Saved it to your Reports folder — the June weekly"). On the **web** you may name the file as a backticked workspace-relative path (`Reports/q3.md`) since the UI turns it into a clickable link; on Telegram, just say where it went and never paste the raw path.

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

## Making the file discoverable after writing

There is no knowledge graph. Discoverability is handled by the auto-generated
`memory/INDEX.md` map, which is rebuilt automatically on every memory write and
on wsapi boot. In the normal case you do **not** need to do anything — the file
you just wrote will be picked up on the next automatic reindex.

If you want to force the map to refresh immediately (e.g. you just created a new
top-level folder and want it reflected right away), run the real index rebuild:

```bash
python3 <REFLECT_APPLY> reindex   # rebuilds memory/INDEX.md; safe to run anytime
```

Do **not** run reindex for files saved under `project/users/<slug>/` — those are
private and the shared/group INDEX already excludes `users/**`, so there is
nothing to record and nothing to leak. Re-saving an existing file needs no
special step; the automatic reindex on write keeps the map current.
