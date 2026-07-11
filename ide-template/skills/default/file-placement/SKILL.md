---
name: file-placement
description: Use this BEFORE writing or saving a new file when the destination path is not explicitly given by the user. Reads the project's "Where to Save" decision tree and the current folder structure, then either picks a folder confidently or asks one short question. Triggers on phrases like "save this", "make a note", "write down", "jot this", "record this" — but only when the user did NOT specify a path.
allowed-tools: Read, Bash, Write
---

# File Placement Protocol

You are about to save content to a file. Before calling Write, decide WHERE that file goes. **Don't dump in `~/project/` root** unless the file is explicitly project-level (`CLAUDE.md`, `README.md`).

## Step 0 — Shared or private? (team workspace)

If an `[ACTOR name (slug: <slug>)]` line is present, decide the **root** before the folder:

- **Personal to this user** — they said "save privately / my CV / a note just for me", or it's clearly about them alone → root is their private space `project/users/<their-slug>/` (then apply the normal folder logic *inside* it). The shared-root write would otherwise be visible to the whole team (the tool-guard allows shared-root writes, so nothing else stops it).
- **Shared / company / project content** → the project root, as usual.
- **Never** write into another teammate's `project/users/<other-slug>/`.

Solo workspace (no `[ACTOR]` / no `users/` split) → ignore this; one flat tree as today.

## When this skill applies

✅ "Save this brief"
✅ "Make a note about Q3 strategy"
✅ "Write down what we decided"
✅ "Save this conversation"

❌ "Save it to `<folder>/<file>.md`" — explicit path, just write
❌ "Update `CLAUDE.md`" — file exists, just edit

## Step 1 — read the rulebook

Read `~/project/.claude/CLAUDE.md` and find the "Where to Save" section. That's the user's own decision tree for this workspace. It always wins over your guess. Defaults if missing → see `references/decision-tree.md`.

## Step 2 — see the current shape

Use the `find` command in `references/decision-tree.md` to list existing folders. Don't invent ones the user hasn't created.

## Step 3 — decide

Match content to rulebook + existing structure. Three branches (obvious match / two options / propose subfolder) + audience-aware rule (ask in IDE, decide on Telegram) → `references/decision-tree.md`.

## Step 4 — write the file

Use the Write tool with the full chosen path. Filename conventions (kebab-case, dated only for time-bound content) → `references/decision-tree.md`.

## Step 5 — make it discoverable

There is no knowledge graph. Files are made discoverable by the auto-generated `memory/INDEX.md` map, which is rebuilt automatically on every memory write and on wsapi boot — so in the normal case, after writing you do **nothing**; the file is picked up on the next automatic reindex. Only if you need the map refreshed immediately (e.g. you just created a brand-new top-level folder), force a rebuild → `references/decision-tree.md` (reindex command).

**Team mode — never reindex for private files.** If the file you just saved lives under `project/users/<slug>/` (a personal file), do **not** trigger a reindex on its behalf. The shared/group `INDEX.md` excludes `users/**`, so a private file's existence, location, and topic never surface in another teammate's prompt — leave it to the automatic per-write reindex, which already applies the same exclusion. Only shared project-root files belong in the team-wide map.

## Cluster detection — propose a subfolder

If during Step 2 you notice **3+ files in the same folder share an obvious subtopic**, propose a subfolder reorganisation in your reply (don't execute). Exact wording → `references/decision-tree.md` (cluster-detection rule section).

## What NOT to do

- Don't save to `~/project/` root. Anything that doesn't fit a folder goes to `Inbox/` and waits for the next audit.
- Don't create a folder "just in case" — only when you'll put content into it now.
- Don't use timestamped filenames for evergreen content.
- Don't ask multiple questions in a row. One question, wait, then act.
