# Welcome to your workspace

This is your **second brain** — a project repository where the bot, you, and your team work together. Files saved here are visible to the bot in every conversation; nothing in chat alone persists, but anything saved here does.

## How it's organised

The bot follows the rules in `.claude/CLAUDE.md` (this workspace's manifesto — open it and read once, edit anytime). Default folders:

- **`Inbox/`** — universal drawer. Save things here when you don't yet know where they belong; the weekly audit will help you sort them.
- **`Research/`** — references, articles, exploratory notes, anything you want to look up later.

You'll add your own folders as you go (e.g. `Marketing/`, `Brand/`, `Products/`) — the bot will help suggest where to put new content based on what you've already created.

## Recurring rituals (already configured)

The bot runs three weekly self-maintenance routines on its own:

| When (UTC) | What |
|---|---|
| Monday 09:00 | Repo audit — proposes cleanups, sorts orphans, flags stale files |
| Friday 14:00 | Project backup — sends a `.tar.gz` snapshot via Telegram |
| Sunday 22:00 | Memory reindex — quietly updates the knowledge graph |

You can edit these in the **Reminders** view in the workspace UI, or just tell the bot to change them.

## Scaling up

When you want to give the bot more domain knowledge:
- **For business context** (what your brand is, who's on the team, what each integration means for you) → edit `.claude/CLAUDE.md`
- **For repeatable workflows** (e.g. "every time we launch a campaign, follow these 5 steps") → create a project skill at `.claude/skills/<name>/SKILL.md`. Ask the bot to scaffold one — it knows the format.

## Where to ask for help

Just talk to the bot. If you're not sure what it can do, type **"co potrafisz"** or **"what can you do"** — it'll list the tools currently wired up and explain what each one does for your business.
