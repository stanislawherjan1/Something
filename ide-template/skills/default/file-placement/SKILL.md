---
name: file-placement
description: Use this BEFORE writing or saving a new file when the destination path is not explicitly given by the user. Reads the project's "Where to Save" decision tree and the current folder structure, then either picks a folder confidently or asks one short question. Triggers on phrases like "save this", "make a note", "write down", "jot this", "record this" — but only when the user did NOT specify a path.
allowed-tools: Read, Bash, Write, mcp__memory__create_entities, mcp__memory__add_observations
---

# File Placement Protocol

You are about to save content to a file. Before calling Write, decide WHERE that file goes. **Don't dump in `~/project/` root** unless the file is explicitly project-level (`CLAUDE.md`, `README.md`, `Tasks.md`).

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
❌ "Update `Tasks.md`" — file exists, just edit

## Step 1 — read the rulebook

Read `~/project/.claude/CLAUDE.md` and find the "Where to Save" section. That's the user's own decision tree for this workspace. It always wins over your guess. Defaults if missing → see `references/decision-tree.md`.

## Step 2 — see the current shape

Use the `find` command in `references/decision-tree.md` to list existing folders. Don't invent ones the user hasn't created.

## Step 3 — decide

Match content to rulebook + existing structure. Three branches (obvious match / two options / propose subfolder) + audience-aware rule (ask in IDE, decide on Telegram) → `references/decision-tree.md`.

## Step 4 — write the file

Use the Write tool with the full chosen path. Filename conventions (kebab-case, dated only for time-bound content) → `references/decision-tree.md`.

## Step 5 — index in memory

After writing, log a `file_index` entity in the knowledge graph so the file is discoverable later. Exact shape (create vs add_observations) → `references/decision-tree.md`.

**Team mode — do NOT index private files.** If the file you just saved lives under `project/users/<slug>/` (a personal file), **skip the `file_index` entity entirely**. The knowledge graph is shared and team-wide-searchable (read by `repo-audit` / `memory-reindex`, surfaced in every teammate's prompt), so a `file_index` whose `name` is a `users/<slug>/…` path — plus its topic keywords and the originating "trigger" request — leaks one person's private file (its existence, location, and what it's about) to everyone. Only index files saved to the **shared** project root.

## Cluster detection — propose a subfolder

If during Step 2 you notice **3+ files in the same folder share an obvious subtopic**, propose a subfolder reorganisation in your reply (don't execute). Exact wording → `references/decision-tree.md` (cluster-detection rule section).

## What NOT to do

- Don't save to `~/project/` root. Anything that doesn't fit a folder goes to `Inbox/` and waits for the next audit.
- Don't create a folder "just in case" — only when you'll put content into it now.
- Don't use timestamped filenames for evergreen content.
- Don't ask multiple questions in a row. One question, wait, then act.
