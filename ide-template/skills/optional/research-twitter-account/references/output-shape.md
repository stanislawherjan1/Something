# Output shape — twitter research

## Folder layout

Default save root (file-placement skill can override via `CLAUDE.md` "Where to Save"):

```
Research/Twitter/<handle>/
├── target-accounts.md      ← 10-account summary table
├── @account-1/
│   ├── bio.md              ← who they are, what they care about, recent context
│   └── post-style.md       ← how they write, tone, recurring formats
├── @account-2/
│   ├── bio.md
│   └── post-style.md
└── …
```

Filename rule: subfolder name is the handle **with** the `@` prefix, exactly as it appears on X. The leading `@` makes it sortable + visually obvious these are accounts, not topics.

## `target-accounts.md` template

```markdown
# Target Accounts — @<handle>

Research generated: <YYYY-MM-DD> · Source: Grok x_search

## Similar accounts (frequent interaction)

| # | Account | Name | Focus | Why they interact | Notes |
|---|---------|------|-------|-------------------|-------|
| 1 | @h1 | Real name | Topic | Reason | Optional context |
| 2 | @h2 | Real name | Topic | Reason | … |
| … (10 rows) |

## Adjacent accounts (same topic, less frequent)

[If Grok surfaced any, list them in a 5-row table with the same shape; otherwise omit this section.]

## Notes

[Anything Grok flagged that's relevant beyond the table — e.g. "this account recently went private", "two of these are alts of the same person", recurring controversies, etc.]
```

## Memory-index entity shape

```
mcp__memory__create_entities([
  {
    name: "twitter-research-<handle>",
    entityType: "research_index",
    observations: [
      "target: @<handle>",
      "generated: <ISO date>",
      "similar_accounts: @h1, @h2, …",
      "path: Research/Twitter/<handle>/"
    ]
  }
])
```

## Summary message to user

```
Research complete — @<handle>

Saved to: Research/Twitter/<handle>/
- target-accounts.md (10 similar accounts, ranked by interaction)
- 10 subfolders (bio.md + post-style.md each)

Top 3 by interaction:
  1. @<h1> — <focus>
  2. @<h2> — <focus>
  3. @<h3> — <focus>

Want me to dig deeper into any specific one, or pull recent posts from the top of the list?
```
