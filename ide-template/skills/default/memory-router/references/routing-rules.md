# Routing rules — mechanical write discipline, overflow promotion, conflict resolution

Loaded by the `memory-router` skill when applying a routing decision. Keep this open while writing — these rules are easy to get wrong from memory.

## Team workspace — Shared vs Private (read first in team mode)

When an `[ACTOR …]` line is present, the personal cards live in the CURRENT user's private memory:

- **Private cards** (per-user): `USER_PROFILE`, `USER_PREFERENCES`, `USER_RELATIONSHIPS`, `USER_REFLECTIONS` → `memory/users/<actor-slug>/<CARD>.md`. Personal preferences + individual working style are ALWAYS private.
- **Shared cards** (flat, team-wide): `RULES`, `AGENT_TOOLS`, `AGENT_IDENTITY`, `INDEX` (+ the generated `TEAM` roster) → `memory/<CARD>.md`.

> **Carve-out — "how to reach/address me" is SHARED, even though it feels personal.** A person's **preferred language**, **preferred channel**, and **Telegram link** are *contact/relay metadata*: another teammate's bot needs them to message this person correctly, and it can NOT read this person's private memory. So they live in the shared **`TEAM` roster** (managed via `/api/team` + `/api/me`, surfaced in `memory/TEAM.md`) — NOT in private `USER_PREFERENCES`. The test below ("useful to a DIFFERENT teammate?") already classifies these as shared; don't be fooled that they're *about* one person. Genuinely private taste (how *you* like the bot to write for *you*) stays in `USER_PREFERENCES`.

Every rule below applies to the **resolved** path: for a private card that's the actor's own file — never the shared root, never another teammate's `memory/users/<other-slug>/`. Solo workspace (no `[ACTOR]`) → all cards are flat `memory/`; ignore this section.

## Mechanical rules (apply to every write)

- **One fact per line.** No prose paragraphs in cards.
- **Cite source for non-obvious facts:** `[Source: who, channel, YYYY-MM-DD]`.
- **Never silently delete.** Mark retired with date (strike-through with `~~…~~ (retired YYYY-MM-DD)`).
- **Don't write the same fact to two cards.** Pick one home; cross-reference if needed.
- **Preserve the YAML frontmatter** at the top of each card on edit. The contract there is the operational directive — leave it intact.
- **Drift check before recall.** Before acting on a memory you read at session start, sanity-check it's still current; ask once if the action would matter.

## Conflict resolution

When the new fact contradicts an existing entry on the same card:

| Card | Default behaviour |
|---|---|
| RULES | Newer wins. Strike-through old with `~~…~~ (retired YYYY-MM-DD)`. Never silently delete. |
| USER_PROFILE | Replace stale entry. If non-trivial, leave a `[was: …, since YYYY-MM-DD]` trail. |
| USER_PREFERENCES | Replace. |
| USER_RELATIONSHIPS | Within a person's section: replace. Cross-person: append. |
| USER_REFLECTIONS | Rarely conflicts. If it does, the older entry stays — different observations are different data. |
| AGENT_IDENTITY | Reconcile into one voice. Don't keep contradictory traits. |
| AGENT_TOOLS | Per-tool: replace within section when a gotcha is superseded. |

## Card overflow → topic page promotion

If the fact would push the target card past ~60 lines, **propose a promotion** instead of cramming the card:

1. Pick a slug for the new topic page (e.g. `sam` for the long-form Sam dossier).
2. Move the existing section content into `project/memory/topics/<slug>.md` (keep the same shape; this is a free-form long-form page). **Team mode:** if the overflowing card is **private** (a USER_* card under `memory/users/<actor>/`), the topic page is private too → `memory/users/<actor>/topics/<slug>.md`. Never promote a teammate's private content into the shared `memory/topics/`.
3. Leave a short pointer in the original card:

   ```
   ## Sam (cofounder)
   → Full context: topics/sam.md
   - Direct, Polish
   - Recurring themes: pricing, churn
   ```

4. Add a one-line entry under `## Topics` in `memory/INDEX.md`. **Team mode:** for a private topic page, add the pointer to the actor's private index `memory/users/<actor>/INDEX.md` (create if absent), NOT the shared `memory/INDEX.md` — the shared index is loaded into every teammate's prompt, so a private topic title there is a leak.

Cards stay summary surfaces; topic pages absorb the depth. The agent's session-start load reads INDEX + RULES + USER_PROFILE + USER_PREFERENCES (the USER_* cards from the current user's `memory/users/<slug>/` in team mode) — topic pages are loaded lazily when the conversation demands.

## Confidence guardrail (ambiguous routing)

If the fact is genuinely ambiguous (multiple cards plausible, e.g. *"I like working in the morning"* — preference? reflection? schedule?), pick the **highest-numbered card** from the main decision tree (= the more specific one wins) AND include a one-line cross-reference note in the runner-up card pointing to where the canonical entry lives.
