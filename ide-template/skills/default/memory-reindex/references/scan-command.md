# Memory-reindex — candidate file scan

Use the date portion of the last `lastIndexed` observation (from the `memory-index-log` entity) as the floor. On first run ever, use `1970-01-01`.

```bash
LAST_INDEXED="2026-04-28"   # date portion of lastIndexed observation
find ~/project -type f -newer <(date -d "$LAST_INDEXED" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo) \
  ! -path '*/.git/*' \
  ! -path '*/node_modules/*' \
  ! -path '*/.playwright-mcp/*' \
  ! -path '*/.chat/*' \
  ! -path '*/.claude/sessions/*' \
  ! -path '*/.claude/cache/*' \
  ! -path '*/.integrations/*' \
  ! -name '.DS_Store' \
  ! -name '*.tmp' ! -name '*.bak' \
  | head -200
```

## Result handling

- **0 files** → skip indexing, jump straight to the log update step.
- **>200 files** → bulk import or long absence. Index the first 200, mention the cap in the log observation (`bulkImportDetected: true`), and the next weekly run picks up the rest.

## Exclusion rationale

| Path | Why excluded |
|---|---|
| `.git/`, `node_modules/` | Build/source-control noise, never user content |
| `.playwright-mcp/` | Ephemeral screenshots, wiped weekly by repo-audit |
| `.chat/`, `.claude/sessions/`, `.claude/cache/` | Per-session conversation state, not durable knowledge |
| `.integrations/` | Encrypted credential store (Phase-2 broker), never indexable |
| `.DS_Store`, `*.tmp`, `*.bak` | OS/editor artifacts |
