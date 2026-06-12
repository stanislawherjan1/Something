---
name: memory-reindex
description: Weekly silent re-scan of project files into the memory knowledge graph. Picks up new/modified files since the last run, reads enough of each to extract topic keywords, and creates or updates `file_index` entities. Triggered weekly by reminder `[MEMORY_INDEX_TRIGGER]`, or manually via "/reindex", "reindex memory", "rebuild the index".
allowed-tools: Read, Bash, mcp__memory__search_nodes, mcp__memory__create_entities, mcp__memory__add_observations, mcp__memory__open_nodes
---

# Memory Reindex Protocol

Quietly. The point of this skill is that the memory graph stays useful even when nobody explicitly told the bot "remember this file." Run weekly, no Telegram noise unless something dramatic happens.

## Step 1 — find the last index timestamp

```
mcp__memory__search_nodes("memory-index-log")
```

Look for an entity named `memory-index-log` (entityType: `system`) with an observation like `lastIndexed: 2026-04-28T22:00:00Z`. If the entity doesn't exist (first run ever), use `1970-01-01T00:00:00Z` as the floor and create the entity at the end of this run.

## Step 2 — list candidates

Run the `find` query in `references/scan-command.md`, using the date portion of the last `lastIndexed` observation. Handle `0` and `>200` cases per that file.

## Step 3 — index each file

For each candidate file:

1. Read first ~500 chars. Skip binaries by extension (`.png`, `.jpg`, `.pdf`, `.zip`, `.tar.gz`, `.bin`).
2. Pick 2–5 topic keywords from filename + first paragraph (see `references/entity-shapes.md` for guidance).
3. Build the relative path: `${absolute_path#/home/coder/project/}`.
4. Check if entity exists via `mcp__memory__search_nodes("<relative-path>")`.
5. **If new** → create a `file_index` entity per the shape in `references/entity-shapes.md`.
6. **If exists** and mtime is newer than the entity's last `indexed:` observation → append a `reindexed:` + `topic-update:` observation. Don't replace; the graph keeps history.

## Step 4 — update the log

Append `lastIndexed:` + `indexedThisRun:` observations to `memory-index-log` (create the entity if missing). Full shape in `references/entity-shapes.md`.

## Step 5 — surface only if interesting

Default: silent. No Telegram message.

Send a short Telegram **only** when:
- Indexed 20+ new files in one run (worth knowing — bulk import or long absence)
- Any file failed to read (permissions, encoding) — surface so user can fix
- The graph has 1000+ total `file_index` entities **and** project root has >50 files (memory bloat — propose `/audit` to consolidate)

Format (match user's working language):

```
Memory reindex: N new files indexed. All good 👌
```

## What NOT to index

- Binary files (images, archives, PDFs) — no extractable text-topic keywords
- `.session-handoff.md` — overwritten every session, indexing it just creates churn
- `Tasks.md`, `Pending Reminders.md` — change constantly, indexing them once is enough
- `.env`, `.env.*`, `accounts.json` — credentials. Never read these from any skill.

## Why this exists

Memory MCP is your fastest path to "find that thing about X" — but only if entities are populated. Without periodic reindex, only files the bot explicitly chose to remember are searchable, and the bot forgets half the time. This skill closes the gap without bothering the user.
