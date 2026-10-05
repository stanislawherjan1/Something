---
name: file-placement
description: Use this BEFORE writing or saving a new file when the destination path is not explicitly given by the user — e.g. "save this", "write this up", "save this brief". Reads the project's "Where to Save" decision tree, PROJECT_STRUCTURE.md and the current folder structure, then either picks a folder confidently or asks one short question. Not for "remember this" (a fact or preference) — that is memory_note, not a file. Also covers how to tell people where things went in plain language.
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
✅ "Write up the Q3 strategy"
✅ "Write down what we decided" (as a document)
✅ "Save this conversation"

❌ "Save it to `<folder>/<file>.md`" — explicit path, just write
❌ "Update `CLAUDE.md`" — file exists, just edit
❌ "Remember that we bill net 30" — a fact, not a file → `memory_note`

## Step 1 — read the rulebook

Read `~/project/.claude/CLAUDE.md` and find the "Where to Save" section. That's the user's own decision tree for this workspace. It always wins over your guess. Then read `~/project/PROJECT_STRUCTURE.md` — the map of what each folder is for (create it if missing; add a line whenever you create, rename or delete a folder). Defaults if missing → see `references/decision-tree.md`.

## Step 2 — see the current shape

Use the `find` command in `references/decision-tree.md` to list existing folders. Don't invent ones the user hasn't created.

## Step 3 — decide

Match content to rulebook + existing structure. Three branches (obvious match / two options / propose subfolder) + audience-aware rule (ask in IDE, decide on Telegram) → `references/decision-tree.md`.

## Step 4 — write the file

Use the Write tool with the full chosen path. Filename conventions (kebab-case, dated only for time-bound content) → `references/decision-tree.md`.

After writing there is **nothing else to do** — files are found later by file search. If you created a new folder, add its line to `PROJECT_STRUCTURE.md`.

## Cluster detection — propose a subfolder

If during Step 2 you notice **3+ files in the same folder share an obvious subtopic**, propose a subfolder reorganisation in your reply (don't execute). Exact wording → `references/decision-tree.md` (cluster-detection rule section).

## What NOT to do

- Don't save to `~/project/` root. Anything that doesn't fit a folder goes to `Inbox/` and waits for the next audit.
- Don't create a folder "just in case" — only when you'll put content into it now.
- Don't use timestamped filenames for evergreen content.
- Don't ask multiple questions in a row. One question, wait, then act.
- Don't ask a non-technical person "Reports or Drafts?" — pick the obvious one and tell them where it went.
- Don't paste raw paths to a non-technical person ("saved to `documents/reports/2026-06-01_weekly.md`") — say "saved to your Reports folder, June 1st".
- Don't list the folders or subfolders you created ("created `Inbox/`, `Inbox/raw/`…").
- Don't surface tool names ("calling `mcp__shopify__list_orders`") — say what you're doing ("pulling orders from your store").
