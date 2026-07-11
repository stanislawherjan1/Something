---
card: INDEX
purpose: Auto-generated MAP of a memory scope — every card, topic, and concept as a `[[stem]] — blurb` line under ## Cards / ## Topics / ## Concepts. Machine-owned; never hand-edited.
---

# Memory index

This file is the **auto-generated MAP** of a memory scope. The reflect pipeline
(`hooks/reflect-apply.py` → `rebuild_scope_index`) regenerates it **wholesale** on
every memory change:

- when the bot writes a card/topic/concept itself (the `post-write-memory.sh` hook),
- when the pipeline creates or graduates a concept/topic (`apply` / `graduate`),
- on `reflect-apply.py reindex`,
- and on wsapi startup.

**Do not hand-edit it: your changes are overwritten.** Navigate *from* it: each
entry is `[[<stem>]]` followed by a one-line blurb, grouped under `## Cards` / `## Topics` /
`## Concepts`. In team mode there are two indexes, both loaded into the prefix: the
shared `memory/INDEX.md` and a private `memory/users/<slug>/INDEX.md` per user. The
memory conventions live in the system-prompt preamble, so this file is only the map.

<!-- On a fresh install this placeholder is replaced by the generated map on the
     first reindex, which runs at wsapi startup. Nothing here is authored by hand. -->
