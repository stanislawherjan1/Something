# Memory-reindex — entity shapes

## file_index (new entity)

```
mcp__memory__create_entities([{
  name: "<relative-path>",
  entityType: "file_index",
  observations: [
    "topic: <2–5 keywords>",
    "indexed: <today's ISO date>",
    "path: <relative-path>"
  ]
}])
```

Relative path = `${absolute_path#/home/coder/project/}`.

## file_index (update existing)

When the file's mtime is newer than the entity's last `indexed:` observation:

```
mcp__memory__add_observations("<relative-path>", [
  "reindexed: <today>",
  "topic-update: <new keywords>"
])
```

Append, don't replace. The graph keeps history of how topic-keywords evolved as the file was edited.

## memory-index-log (system entity)

Updated at the end of every run:

```
mcp__memory__add_observations("memory-index-log", [
  "lastIndexed: <now ISO>",
  "indexedThisRun: <count>"
])
```

Created on first run:

```
mcp__memory__create_entities([{
  name: "memory-index-log",
  entityType: "system",
  observations: [
    "lastIndexed: <now ISO>",
    "indexedThisRun: <count>",
    "purpose: tracks last memory-reindex skill run"
  ]
}])
```

## Topic-keyword guidance

Pick 2–5 from filename + first paragraph. Be **specific**:

- Good: `q3-launch-strategy`, `meta-ads-2026-creative-brief`, `shopify-product-import-spec`
- Bad: `marketing`, `notes`, `project`, `docs`

If filename is opaque (`untitled.md`, `notes-2.md`), weigh first paragraph heavier.
