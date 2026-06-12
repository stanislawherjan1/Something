# Routing rules — mechanical write discipline, overflow promotion, conflict resolution

Loaded by the `memory-router` skill when applying a routing decision. Keep this open while writing — these rules are easy to get wrong from memory.

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

1. Pick a slug for the new topic page (e.g. `krystian` for the long-form Krystian dossier).
2. Move the existing section content into `project/memory/topics/<slug>.md` (keep the same shape; this is a free-form long-form page).
3. Leave a short pointer in the original card:

   ```
   ## Krystian (cofounder)
   → Full context: topics/krystian.md
   - Direct, Polish
   - Recurring themes: pricing, churn
   ```

4. Add a one-line entry under `## Topics` in `memory/INDEX.md`.

Cards stay summary surfaces; topic pages absorb the depth. The agent's session-start load reads INDEX + RULES + USER_PROFILE + USER_PREFERENCES — topic pages are loaded lazily when the conversation demands.

## Confidence guardrail (ambiguous routing)

If the fact is genuinely ambiguous (multiple cards plausible, e.g. *"I like working in the morning"* — preference? reflection? schedule?), pick the **highest-numbered card** from the main decision tree (= the more specific one wins) AND include a one-line cross-reference note in the runner-up card pointing to where the canonical entry lives.
