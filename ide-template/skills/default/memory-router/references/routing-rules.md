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

## Depth doesn't live on cards — it accretes on concept pages

Cards are **tight summary surfaces**, not containers. When depth on a recurring
person/project/topic outgrows a card line, it belongs on a **concept page**
(`memory/concepts/<slug>.md`) — an accreting list of atomic, cited claims under
`## Claims`. The card keeps a one-line pointer, never the depth:

```
## Sam (cofounder)
→ concepts/sam.md
- Direct, Polish
```

**Emergence is heat-driven, not a line-count.** A slug earns a concept page once
it recurs across **≥ `REFLECT_CONCEPT_HEAT` (default 3) distinct verdict
threads** — a computable squeeze-point. Two ways a page is born:

1. **Automatic (the common path).** `reflect-distill` watches verdict-card
   `entities:` heat and proposes the page + its first claims through the normal
   `_drafts → /memory review` approval flow. You don't have to do anything — the
   operator approves and the page appears.
2. **By hand (when you feel the squeeze mid-turn).** If you're about to cram a
   third or fourth durable fact about the same entity onto a card, create
   `memory/concepts/<slug>.md` instead (frontmatter `kind: concept` + a
   `## Claims` list), move the depth there, and leave the card pointer above.
   One atomic, cited claim per line: `- <claim>  [Source: who, channel, date]`.

**Never delete a claim — strike it** `~~…~~ (retired YYYY-MM-DD)` when superseded
(invalidate-don't-delete; the graph thins the edge, history stays legible).

**Team mode — scope follows the entity.** A concept built from **shared** verdicts
is shared (`memory/concepts/<slug>.md`). A concept that is **private** to one
teammate (their personal context) is private → `memory/users/<actor>/concepts/<slug>.md`,
and its index pointer goes in that actor's private `INDEX.md`, NOT the shared one
(the shared index loads into every teammate's prompt — a private title there is a
leak). If you cannot attribute a concept to a scope, leave it on the card; never
guess.

> **Concept page vs topic page.** A `concepts/<slug>.md` is an *accreting,
> machine-fed claim list* (atomic + cited, grows via distill). A `topics/<slug>.md`
> is a *hand-authored long-form narrative*. Prefer a concept page for a recurring
> entity that collects discrete facts; reach for a topic page only when you're
> writing prose. Don't create both for the same slug — pick one home.

Cards stay summary surfaces; concept (and topic) pages absorb the depth, loaded
lazily when the conversation names that entity. They are **never** in the cached
prefix.

## Confidence guardrail (ambiguous routing)

If the fact is genuinely ambiguous (multiple cards plausible, e.g. *"I like working in the morning"* — preference? reflection? schedule?), pick the **highest-numbered card** from the main decision tree (= the more specific one wins) AND include a one-line cross-reference note in the runner-up card pointing to where the canonical entry lives.
