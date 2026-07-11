---
name: memory-cards
description: Stable 8-card memory model (RULES, RESPONSIBILITIES, USER_PROFILE, USER_PREFERENCES, USER_RELATIONSHIPS, USER_REFLECTIONS, AGENT_IDENTITY, AGENT_TOOLS) — the tight, role-keyed SUMMARY surfaces. Read them at session start to ground responses in the user's profile, preferences, relationships, agent identity, available tools, hard rules, and the bot's own standing duties. Write back here when the user shares a fact, preference, rule, or standing duty worth remembering — `memory-router` skill picks the destination card. Depth about a recurring entity accretes on a concept page (concepts/<slug>.md), not crammed onto a card.
allowed-tools: Read, Edit, Write
---

# Memory cards — the workspace's 8-card model

The bot keeps a small, stable knowledge base of **eight cards**. Content evolves over time; the card set is fixed.

| Card | Holds | Scope |
|---|---|---|
| `USER_PROFILE.md` | Facts about the user — role, locations, dates, languages spoken, biographical context that doesn't change weekly | **private** |
| `USER_PREFERENCES.md` | Soft preferences — tools, communication style, working hours, what to surface vs. silence | **private** |
| `USER_RELATIONSHIPS.md` | People in the user's life — colleagues, family, clients, with role + how they prefer to be communicated with | **private** |
| `USER_REFLECTIONS.md` | Introspections, observed patterns, recurring themes the user has noted about themselves | **private** |
| `AGENT_IDENTITY.md` | The agent's character — voice, mood, default disposition. Owned by the agent, refined over time. | shared |
| `AGENT_TOOLS.md` | Tools, accounts, integrations the agent has access to in this workspace, plus per-tool gotchas learnt the hard way | shared |
| `RESPONSIBILITIES.md` | The bot's standing duties **toward this user** — what it does FOR them on a cadence + what it watches for, without being asked. Read daily by the `morning-planner` to plan their day into reminders. | **private** |
| `RULES.md` | Hard rules — never/always commitments. Tightly worded. The bot reads these last; they override everything else when in conflict. | shared |

## The cards are summaries — depth lives on concept pages

The 8 cards are **fixed, tight summary surfaces**, not containers. They hold WHO
the user is, their preferences, the people/tools/rules — one terse line each. When
durable facts about ONE **recurring entity** (a client, project, or person) start
to accrete, the depth does NOT pile onto a card — it goes on a **concept page**:

| Layer | Holds | Grows? | Written by |
|---|---|---|---|
| **8 cards** | role-keyed summary facts (a person's one-liner, a preference, a rule, a standing duty) | no — stays tight | bot (via `memory-router`) + distiller (auto-applied in background) |
| **`concepts/<slug>.md`** | an accreting `## Claims` list — every durable fact about one entity, atomic + cited | yes, unbounded | **mostly automatic** (`reflect-distill` proposes once a slug recurs, auto-applied in the background at ≥0.75); bot by hand when it feels the squeeze |
| **`topics/<slug>.md`** | hand-written long-form prose / narrative on a subject | yes | bot by hand |
| **`documents/…`** | full artifacts (briefs, research, drafts) | — | bot / `file-placement` |

A card keeps a one-line `→ concepts/<slug>.md` pointer; the concept page absorbs
the detail. Pick ONE home per slug — a concept page (accreting facts) OR a topic
page (prose), never both. Concept pages are NOT in the cached prefix — `Read` /
`memory_grep` them on demand when a turn is about that entity. `memory-router`
owns the routing call; see its `references/routing-rules.md` for the full
procedure (heat-driven emergence, by-hand creation, team-mode scope).

## Where the cards live — solo vs team

- **Solo workspace** (no `[ACTOR …]` line): all eight cards are flat in `project/memory/` — `memory/USER_PROFILE.md`, etc. Use the bare paths everywhere below.
- **Team workspace** (`[ACTOR name (slug: <slug>)]` line present): the five **private** cards belong to ONE person and live in that person's private memory — `memory/users/<actor-slug>/RESPONSIBILITIES.md` (the bot's duties toward them), `…/USER_PROFILE.md`, `…/USER_PREFERENCES.md`, `…/USER_RELATIONSHIPS.md`, `…/USER_REFLECTIONS.md`. The three **shared** cards (`AGENT_IDENTITY`, `AGENT_TOOLS`, `RULES`) plus `INDEX` stay flat in `memory/`. Read and write the CURRENT actor's private cards — **never** another teammate's `memory/users/<other-slug>/` (the tool-guard blocks it). Folding a private card into the shared `memory/` root leaks it into every teammate's prompt — don't.

## Reading

**Six of the eight cards are already in your cached system prompt** — `RULES`, `RESPONSIBILITIES`, `USER_PROFILE`, `USER_PREFERENCES`, `AGENT_IDENTITY`, `AGENT_TOOLS` (plus `INDEX` and the two `RECENT_*` conversation tails). The loader (`workspace-api/lib/memory-loader.js`) builds this prefix deterministically every turn so prompt caching fires. In team mode the loader pulls `RESPONSIBILITIES` + `USER_PROFILE` + `USER_PREFERENCES` from the CURRENT user's `memory/users/<slug>/`, so the duties/profile/preferences you already have are *this* user's. You have them — don't re-read at session start.

**Two cards are NOT preloaded** and you should `Read` them when a turn needs them — in team mode from the current actor's private dir (`memory/users/<actor-slug>/<CARD>.md`), in solo from flat `memory/`:

- `USER_RELATIONSHIPS.md` — pull when the conversation names or is about a specific person
- `USER_REFLECTIONS.md` — pull when the user references their own past introspection or you need their self-noted patterns

Both are excluded from the cached prefix on purpose: they can grow long (one section per person; dated entries on top), and re-loading them every turn would bloat the prefix without consistent payoff. Pull on demand.

## Writing

Use the `memory-router` skill to decide which card a new fact belongs in (in team mode it also returns the fully-resolved path — the private cards land in `memory/users/<actor-slug>/`). Then `Edit` or `Write` to that file. Rules of engagement, by card:

| Card | Append vs tighten | Conflict resolution |
|---|---|---|
| USER_PROFILE | tighten — replace stale facts in place, don't accrete | new fact contradicts old → replace, add `[was: …, since YYYY-MM-DD]` if non-trivial |
| USER_PREFERENCES | tighten | same |
| USER_RELATIONSHIPS | append per-person section; tighten within a person | add new person at end; updates within their section |
| USER_REFLECTIONS | append (each entry dated) | rarely conflicts — different observations are different |
| AGENT_IDENTITY | tighten | the agent picks one self; conflicting traits get merged |
| AGENT_TOOLS | tighten | per-tool sections; replace per-tool when a gotcha is superseded |
| RESPONSIBILITIES | append per duty; retire stale | one line under `## Responsibilities` as `{icon} **Title** — desc #tags` (a bot duty toward THIS user); strike/remove when it no longer holds |
| RULES | tighten and label | each rule is one short bullet; never silently delete a rule — strike-through with date if retired |

**Universal rules:**

- One fact per line. No prose paragraphs.
- Departed entries get a date stamp + reason rather than deletion (recovery is cheap, regret is dear).
- Cite source for non-obvious facts: `[Source: who, channel, date]`.
- File-naming convention for ANY documents created in `project/documents/` from a memory write: `YYYY-MM-DD_Brief_Description.md`.
- Don't write the same fact to two cards. Pick one home (`memory-router` decides) and cross-reference if needed.

## YAML contracts in each card

Every card opens with a YAML frontmatter block that's the operational directive for THIS card — when to write here, when not to, how to merge. The contract is for the bot, not the user. Don't strip the frontmatter on edits.

## When to NOT use memory cards

- **Accreting depth about a recurring entity** (a client/project/person whose durable facts keep growing) → a **concept page** `memory/concepts/<slug>.md` (the card keeps a one-line `→ concepts/<slug>.md` pointer). Mostly created automatically by `reflect-distill`; see the table above.
- **Project work** (a specific task, a research note, a draft) → `project/documents/` with `YYYY-MM-DD_*.md`
- **Ephemeral scratch** (mid-session reasoning, one-off computations) → `project/session/` (TTL ~14 days)
- **Workflow recipes** (how to do X end-to-end) → `project/.claude/skills/<name>/`
- **Accreting facts about one recurring entity** (a client/project/person the bot will reason about repeatedly) → a **concept page** `memory/concepts/<slug>.md` — an accreting `## Claims` list, NOT a separate database. There is no `mcp__memory` / graph store: your memory is these markdown files and nothing else.

The 8 cards are the **stable, narrative core**. Everything else is supporting material.

## Drift check

Before acting on a fact recalled from memory, verify it's still current. Memory cards age — a "user prefers email over Slack" entry from six months ago may be stale. If acting would matter, ask: "I have on record that you prefer email — still true?"
