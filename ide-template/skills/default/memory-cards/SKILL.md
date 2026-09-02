---
name: memory-cards
description: Reference for the workspace memory model — which card or page holds which kind of fact, and what shared vs private means. Load when you need to understand the SHAPE of memory (what lives where, why a card stays tight). Writing is done with the memory_write tool, whose description carries the routing rules; you do not need this skill to write.
allowed-tools: Read
---

# The memory model

Durable memory is a small markdown wiki under `~/project/memory/`. It is the
bot's ONLY durable memory: there is no knowledge graph and no separate store.

## Three shapes, three jobs

| Shape | Holds | Loaded |
|---|---|---|
| **Cards** (`memory/<NAME>.md`) | role-keyed summary facts, kept tight | preloaded into every turn's system prompt |
| **Concept pages** (`concepts/<slug>.md`) | one recurring entity's accreting claims, one atomic cited claim per line | on demand — `memory_grep` or `Read` |
| **Topic pages** (`topics/<slug>.md`) | long-form prose on a subject that outgrew a claim list | on demand |

Cards are preloaded, so they must stay short: a card holds the one-line version
and points at the page (`→ concepts/<slug>.md`) where the depth lives. Pick ONE
home per fact — a fact written in two places is a fact that can be corrected in
one and survive in the other.

## The cards

| Card | Holds | Scope |
|---|---|---|
| `RULES` | hard never/always commitments; override everything on conflict | shared |
| `AGENT_IDENTITY` | the bot's voice, mood, defaults | shared |
| `AGENT_TOOLS` | per-tool gotchas for active integrations | shared |
| `RESPONSIBILITIES` | standing duties the bot owes THIS person | private |
| `USER_PROFILE` | stable facts (role, location, languages, focus) | private |
| `USER_PREFERENCES` | soft preferences (tone, format, channel, style) | private |
| `USER_RELATIONSHIPS` | people in this person's world, one section each | private |
| `USER_REFLECTIONS` | this person's own dated self-introspection | private |

`INDEX.md`, `CHANNELS.md`, `TEAM.md` and the `RECENT_*` tails are
machine-generated — read them, never write them.

## Shared vs private

One test: **would this help a DIFFERENT teammate?** Yes → shared. No — it is
about this person, their taste, their contacts, their schedule → private
(`memory/users/<slug>/`). Anything sensitive is private, full stop. In a group
conversation only shared memory can be written.

## The one rule that matters most

**A correction replaces the claim it corrects.** When a fact changes, supersede
it — the old claim is removed everywhere it appears. When a fact was never true,
retire it. Never leave the old version behind as a second bullet, a
strikethrough, or a `[was: …]` note: a card is read on every single turn, so a
falsehood parked there is as present as the truth beside it. The engine keeps
the full history (every write has a snapshot and a log entry), which is why the
page does not have to.

Writes go through the `memory_write` tool. Editing files under `memory/`
directly is blocked — that path has no credential check, no undo, no audit, and
no way to correct a claim in more than one place at once.
