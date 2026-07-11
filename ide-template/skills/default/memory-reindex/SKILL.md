---
name: memory-reindex
description: Weekly rebuild of the memory INDEX map — a safety net on top of the automatic per-write reindex. Regenerates memory/INDEX.md (and each per-user INDEX in team mode) over the markdown memory wiki so recall + search stay accurate. Silent unless something failed. Triggered weekly by reminder `[MEMORY_INDEX_TRIGGER]`, or manually via "/reindex", "reindex memory", "rebuild the index".
allowed-tools: Read, Bash
---

# Memory reindex — rebuild the INDEX map

The memory INDEX (`memory/INDEX.md`, plus each `memory/users/<slug>/INDEX.md` in
team mode) is the auto-generated MAP of the whole memory wiki — it links every
card, topic, and concept page so the bot can find things on demand. It is rebuilt
**automatically** on every memory write and on wsapi boot.

This weekly ritual is a **safety net**: a full rebuild from scratch, in case an
incremental update ever drifted or a page predates the signpost mechanism.

There is no knowledge graph and no `mcp__memory` store — memory is the markdown
wiki, and "reindex" means regenerating the INDEX map over those files. Nothing else.

## What to do

Run the real index rebuild — the exact command the platform runs automatically:

```bash
PROJECT_DIR="$HOME/project" python3 "${REFLECT_APPLY_PY:-/opt/ide/hooks/reflect-apply.py}" reindex
```

That rescans the wiki and regenerates every INDEX.md (shared + per-user). It is
idempotent and safe to run at any time.

## Be quiet

Default: **silent** — this is background hygiene, post nothing.

Surface a short Telegram message **only** if the reindex **failed** (non-zero exit,
or the script/path is missing) — so the operator can look. A successful refresh
needs no announcement.
