---
name: memory-router
description: Decide where a fact, preference, person, or rule belongs when the user asks to remember, save, note, or commit something. Routes to one of the 7 memory cards (RULES, USER_PROFILE, USER_PREFERENCES, USER_RELATIONSHIPS, USER_REFLECTIONS, AGENT_IDENTITY, AGENT_TOOLS), an accreting concept page (concepts/<slug>.md, for a recurring entity's growing facts), or to documents/ / session/ / skills/. In a team workspace it also decides Shared vs Private — personal cards (profile, preferences, relationships, reflections) route to the CURRENT user's private memory at memory/users/<slug>/, shared facts to the flat memory/ root. Triggers on "remember that…", "save…", "note that…", "from now on…", "always…", "never…", "I prefer…", "X likes…", "X is now…", and similar memory-write phrasings. Skip on ephemeral chat ("today is sunny") or task-execution ("draft the email").
allowed-tools: Read, Edit, Write
---

# Memory router — where does this fact go?

When the user shares something worth keeping, this skill picks the destination. The structure of memory is fixed (`memory-cards` skill describes the seven cards); this skill applies the routing rules.

## Step 0 — Shared or private? (team workspace)

Check this turn's context for an `[ACTOR name (slug: <slug>)]` line:

- **No `[ACTOR]` line → solo workspace.** There is only `memory/` and `documents/`. Ignore this step; use the bare paths in the tree below exactly as written.
- **`[ACTOR]` line present → team mode.** Every destination is **Shared** or **Private**. Apply the test:
  > **"Would this fact be useful to a DIFFERENT teammate?"**
  - **No** — it's about *this* person, their taste, their contacts, or their introspection → **Private**: prefix the destination with `memory/users/<their-slug>/` (cards) or `users/<their-slug>/` (documents). Personal preferences and individual working style are **ALWAYS** private.
  - **Yes** — a company fact, a shared project, a team-wide rule or convention → **Shared**: use the flat `memory/` / `documents/` path.
- **Hard boundary:** only ever write the CURRENT actor's private space or the shared space — never another teammate's `memory/users/<other-slug>/` or `users/<other-slug>/`.

Each card in the tree is tagged **[private]** (per-user in team mode) or **[shared]** (always flat). In solo mode every entry is flat.

## Routing decision tree

Walk these in order. **Stop at the first match.**

1. **Hard rule** — phrases like "from now on never", "always", "never", "must", "don't ever", or a correction the user explicitly wants to stick.
   → `memory/RULES.md` **[shared]**. Add one short bullet under `## Never` or `## Always`. Max ~10 words. No preamble. *(A rule the user wants only for THEMSELVES — "always greet me in Polish" — is a preference: route to card 3 instead.)*

2. **Stable fact about the user** — role, location, language, tools they use professionally, dates that don't change weekly.
   → `memory/USER_PROFILE.md` **[private]** — in team mode `memory/users/<their-slug>/USER_PROFILE.md`. Place under the matching subsection (Identity / Background / Currently focused on / Schedule). Tighten existing entries — don't accrete duplicates.

3. **Soft preference** — how the user likes to be communicated with, formatting, tone, what to surface vs silence, channel preference, working style.
   → `memory/USER_PREFERENCES.md` **[private — ALWAYS]** — in team mode `memory/users/<their-slug>/USER_PREFERENCES.md`. One line per preference. Replace when a preference is updated. Never put one person's preference in the shared root — it would steer every teammate's turns.

4. **Person** — anyone whose context will recur (colleague, family, client, friend). Includes the person's role, communication preference, things to avoid, recurring themes.
   → `memory/USER_RELATIONSHIPS.md` **[private]** — in team mode `memory/users/<their-slug>/USER_RELATIONSHIPS.md`. Append a new `## Name (Role)` section if the person is new; tighten within their section if they exist. When their durable facts start to accrete past a line or two, move the depth to a **concept page** `concepts/<their-slug>.md` and leave the card section a `→ concepts/<their-slug>.md` pointer (see "Accreting depth" below). Link from the card when relevant. **Carve-out:** a genuinely shared team contact (a client the whole team deals with) may go Shared — gate on the "useful to a DIFFERENT teammate?" test.

5. **Self-introspection** — the user noting a pattern about themselves (energy, mood, productivity, tendency).
   → `memory/USER_REFLECTIONS.md` **[private — strictly]** — in team mode `memory/users/<their-slug>/USER_REFLECTIONS.md`. Append dated entry. Newer on top. This is the most personal card; never shared.

6. **Tool / integration / account context** — auth method, gotcha, "use this not that", caveat learned the hard way.
   → `memory/AGENT_TOOLS.md` **[shared]**. One section per tool. Replace within a section when superseded.

7. **Agent character** — voice, default disposition, what to lean into, what to flag back to the user.
   → `memory/AGENT_IDENTITY.md` **[shared]**. Tighten — the agent picks one self.

8. **Workflow recipe** — how to do X end-to-end, repeatable procedure, multi-step playbook.
   → `project/.claude/skills/<name>/SKILL.md`. Skills, not memory cards.

9. **Persistent document** — research, brief, decision rationale, anything the user might re-open later.
   → `project/documents/<topic>/YYYY-MM-DD_Brief_Description.md` **[shared by default]**. In team mode, if it's personal to one teammate ("my CV", "save this privately", a personal note) → `project/users/<their-slug>/documents/<topic>/…` instead. Free-form file. Cross-link from the relevant memory card if there's a connection worth surfacing. *(`file-placement` skill owns the full save-location logic — defer to it for documents.)*

10. **Ephemeral / scratch** — mid-task reasoning, a one-off computation, draft that won't survive past this conversation.
    → `project/session/<filename>.md`. Session has TTL ~14 days; the bot may purge stale entries.

## Accreting depth → concept pages (`concepts/<slug>.md`)

The cards above are tight **summary** surfaces, not containers. When durable facts
about ONE recurring entity (a client, project, or person) start piling up, the
DEPTH belongs on a **concept page** — `memory/concepts/<slug>.md`, an accreting
`## Claims` list (one atomic, cited claim per line) — and the card keeps a single
`→ concepts/<slug>.md` pointer. This sits ON TOP of the tree: route the one-line
SUMMARY to its card (a person → USER_RELATIONSHIPS, a tool → AGENT_TOOLS), but put
the growing detail on the concept page. Concept page = accreting facts;
`topics/<slug>.md` = hand-written long-form prose; pick one home per slug, never both.

**You usually don't do this by hand.** The `reflect-distill` pass watches recurring
entities and automatically proposes a concept page + its first claims once a slug
recurs across ≥ 3 verdict threads, routed through the normal `/memory review`
approval — so concept pages accrete on their own. Create one by hand ONLY when
you're mid-conversation and about to cram a 3rd/4th durable fact about the same
entity onto a card: make `concepts/<slug>.md` (frontmatter `kind: concept` + a
`## Claims` list), move the depth there, leave the card pointer. **Team mode:** a
private entity's concept page is private (`memory/users/<actor>/concepts/<slug>.md`)
and its index pointer goes in the actor's private INDEX — never put private depth in
shared `concepts/`. Full procedure + scope rules: references/routing-rules.md.

## Mechanical rules + overflow + conflict resolution

See [references/routing-rules.md](references/routing-rules.md) for:
- Per-write mechanical rules (one fact per line, citation format, retire-don't-delete, frontmatter preservation, drift check)
- Depth accretion → concept-page emergence (heat-driven auto + by-hand), card-keeps-a-pointer discipline, scope rules
- Per-card conflict resolution (newer-wins / replace / append per card semantics)
- Ambiguous-routing confidence guardrail

Load when applying a routing decision. Skip when the decision tree above resolved cleanly to one card with no conflict.

## When NOT to invoke this skill

- The user is asking the agent to **do** something ("draft an email", "schedule a meeting"). That's task execution, not memory routing.
- The fact is captured implicitly in a file the user just saved. Don't double-record.
- The user is making small talk ("the weather's nice today"). Skip.
- The agent is mid-flow on another tool call. Don't interrupt to route memory mid-stream.

## Output shape

The skill doesn't write the file directly — it returns the routing decision so the agent uses normal `Edit` / `Write` tools to apply it. The `ROUTE` is the **fully-resolved path** (with the `memory/users/<slug>/` prefix already applied in team mode), and `SCOPE` records the Shared/Private call. Skill output to the agent looks like:

```
SCOPE → private (actor: alex) — relationship is about this user
ROUTE → memory/users/alex/USER_RELATIONSHIPS.md → Jordan section
ACTION → tighten (existing line "Jordan dislikes early meetings" → replace with new line "Jordan dislikes morning meetings")
SOURCE → [Source: the user, voice note, 2026-05-10]
```

In solo mode the same write resolves to the flat `memory/USER_RELATIONSHIPS.md` and `SCOPE → solo`. The agent then opens the target file with Edit and applies the change verbatim, preserving YAML frontmatter at the top.
