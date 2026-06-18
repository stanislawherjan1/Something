# Reflect-learnings — proposal examples

Three example outputs showing what good, better-than-good, and wrong proposals look like. Refer to these when shaping your JSON.

## Good — well-scoped person addition

```json
{
  "proposals": [
    {
      "card": "USER_RELATIONSHIPS",
      "section": "",
      "content": "## Sam (cofounder) — works with the user on the SaaS\n- Communication preference: direct, Polish\n- Recurring themes: pricing strategy, customer churn\n- Notes: based in Warsaw, runs the commercial side.",
      "rationale": "the user mentioned Sam three times as his cofounder at messages #4, #11, #18.",
      "confidence": 0.85,
      "scope": "private",
      "owner": "alex"
    }
  ]
}
```

What makes this good: real person mentioned multiple times, content matches USER_RELATIONSHIPS shape (`## Name (Role)` header + bullet lines), rationale cites specific transcript references, confidence honest (not 0.99 — could be a one-conversation acquaintance). **In team mode it carries `scope: private` + `owner: <slug>` (here `alex`, the current actor)** so the applier writes it to that teammate's `memory/users/alex/USER_RELATIONSHIPS.md` — omitting them on a USER_* card would route it to the shared root, leaking one person's relationships to the whole team. (Solo workspace → omit both.)

## Better — empty proposals

```json
{"proposals": []}
```

The conversation was about debugging a config file. Nothing about the user, his preferences, or new people. The right answer is no proposals.

**Empty is the most common correct answer.** Reflect runs after every session — most sessions don't surface new persistent facts.

## Wrong — everything we don't want

```json
{"proposals": [{"card":"USER_PROFILE","section":"Background","content":"Likes coding","rationale":"vibe","confidence":0.4}]}
```

Why this is wrong:
- Low confidence (0.4) — should have been dropped
- Vague rationale ("vibe") — no transcript citation
- Generic content ("Likes coding") — adds nothing useful, pollutes USER_PROFILE
- Wrong card — "likes coding" is a preference / soft observation, not stable biographical fact

The operator would have to clean it up. Don't propose this.

## Boilerplate JSON sample (copy-paste base)

```json
{
  "proposals": [
    {
      "card": "<CARD_NAME>",
      "section": "<section_header_or_empty>",
      "content": "<markdown_ready_content>",
      "rationale": "<transcript citation: message # or quote>",
      "confidence": 0.85,
      "scope": "private",
      "owner": "<actor-slug>"
    }
  ]
}
```

`scope` + `owner` are **team-mode only**: include them (`"scope":"private"`, `"owner":"<slug>"`) for a USER_* card so it lands in that teammate's `memory/users/<slug>/`. Omit both in solo, or set `"scope":"shared"` for a shared card. If `proposals` is empty, return `{"proposals": []}` and stop.
