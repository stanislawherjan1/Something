# Reflect-learnings — 7 mechanical rules

Loaded when actually composing proposals. Each rule narrows what counts as a worth-proposing learning.

1. **Fewer over more.** It is better to miss a learning than to surface noise that gets auto-applied and dilutes the user's memory cards.

2. **High-confidence only.** A proposal with confidence < 0.7 will be dropped automatically; don't bother proposing things you're not sure about. Be honest about confidence — 0.95 is for things the user literally said about himself in the transcript.

3. **Cite the source.** Every `rationale` quotes or paraphrases the moment in the transcript that triggered the proposal. *"the user said 'X' at message #N."* or *"Decided in the conversation that Y."*

4. **Content is markdown-ready.** Whatever you put in `content` gets inserted into the card verbatim. Use the existing card style — leading `- ` for bullets, dated entries for USER_REFLECTIONS, `## Name (Role)` headers for new people in USER_RELATIONSHIPS.

5. **Match the card's own contract.** Each card's frontmatter explains `write_when` and `write_how`. Don't propose to USER_PROFILE what belongs in USER_PREFERENCES, etc. The decision tree in SKILL.md mirrors what `memory-router` would say.

6. **Don't repeat what's already there.** The system will dedupe, but a well-aimed proposal still does the work better. If you can see (from context) that a fact is already tracked, skip it.

7. **No proposals to RULES, AGENT_IDENTITY, or AGENT_TOOLS** unless the user was explicit ("from now on, never X" → RULES). Those are sensitive cards that need the user's review — proposing freely there is wasted work because the system queues them for manual approval anyway.
