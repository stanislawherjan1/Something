# Workspace — UI Reference

This file describes what the user sees and how the interface is structured.
Reference it when a user reports a UI problem, asks about a missing feature, or mentions something "not working."

---

## What this platform actually is

This is not a chatbot. It's an **agent that lives inside a workspace**.

The chatbot model — ask a question, get an answer, the answer evaporates — is the wrong frame. A chatbot has no continuity, no growing knowledge of the user's business, no tools, no place to put what it learns. After 100 conversations it knows exactly as much about you as after the first one.

This platform inverts that. Every conversation happens *inside* a project repository the user owns. The assistant has hands on real tools (Shopify, Meta, Google Ads, GA4, email, image generation, e-signature, web search…) and it has a place to write things down — `Tasks.md`, the daily journal at `${BOT_NAME}/YYYY-MM-DD/`, the user's growing folder structure for briefs, research, decisions, outputs. None of that is throwaway. Every saved file is visible to the assistant in every future conversation.

**Context compounds.** Week one the assistant knows what the user typed. Week four it has read every brief, indexed every decision, watched the folder structure evolve from `Inbox/` chaos into the user's own taxonomy (`Brand/`, `Marketing/`, `Products/`, whatever fits). By week twelve the assistant answers "what should we do about Q3?" with the user's own past reasoning surfaced — because the user's manifesto is in `CLAUDE.md`, the relevant briefs are indexed in the memory graph, and the bot's last twelve session notes link them together.

The job of this platform is to make context-building **frictionless and automatic**:

- The bot proposes folder structure rather than waiting for the user to design one
- The bot suggests where each new file should live rather than dumping everything in root
- The bot writes its own journal so a non-technical user has proof of work
- The bot runs weekly self-audits to keep the repo from rotting
- The bot rebuilds its memory graph on a quiet schedule so search stays useful
- The bot proactively tells the user what tools are wired up, because integrations the user forgot exist might as well not exist

The user doesn't need to know any of that machinery. They just see: a workspace that gets smarter the more they use it, run by an assistant that remembers.

---

## Layout

The workspace has three columns:

```
┌──────────────┬───────────────────┬──────────────┐
│   Sidebar    │   Editor Pane     │  Chat Panel  │
│              │                   │              │
│  File tree   │  File / Dashboard │  Messages +  │
│  + shortcuts │  / Gallery        │  input box   │
│              │  / Kanban         │              │
│  [UserMenu]  │                   │              │
└──────────────┴───────────────────┴──────────────┘
```

Above all three columns sits a **TopBar** with the workspace logo and user avatar.

---

## Sidebar (left column)

- **WorkspaceHeader** — brand logo + workspace name at the top
- **FileTree** — hierarchical file/folder browser; supports create, upload, delete, drag-drop
  - Technical folders (`.claude`, `node_modules`, etc.) are hidden by default; toggle with "Show technical files"
- **Shortcuts** — pinned links below the file tree: AI Settings, Tasks, Gallery
- **UserMenu** — user avatar + name at the bottom; click to sign out

---

## Editor Pane (center column)

The editor pane routes to different views depending on what's selected:

| Selected item | View rendered |
|---|---|
| Markdown / text file | **MarkdownEditor** — BlockNote WYSIWYG editor |
| Image file | **ImageViewer** |
| `Tasks.md` | **KanbanView** — columns = `##` headings, cards = `###` items |
| `generated/` folder | **GalleryView** — image grid |
| AI Settings shortcut | **ClaudeDashboard** |
| Team shortcut | **TeamDashboard** |

When nothing is selected, the **WelcomeScreen** is shown with a message input and recent threads.

---

## Chat Panel (right column)

- **ChatPanel** — message list + input field at the bottom
- Messages stream via SSE from `/api/chat`
- While Claude is running tools, **ToolChip** badges appear showing what's executing
- The input supports file attachments (drag-drop or clip icon)
- **ChatHeader** shows the current thread title and settings

---

## AI Settings (ClaudeDashboard)

Accessed via the "AI Settings" shortcut in the sidebar. Four tabs:

- **Instructions** — shows and edits `CLAUDE.md` directly; this is Claude's system prompt for this workspace
- **Skills** — tile grid of available skills (`.claude/skills/*.md`); click a tile to open the skill editor modal; "Add skill" button creates a new one
- **Reminders** — list of scheduled reminders backed by `.reminders.json`; create / delete from here
- **Integrations** — credential management for external services (Slack, GitHub, email, etc.); activate with an API key, deactivate to wipe the credential

---

## Team (TeamDashboard)

Accessed via the "Team" shortcut. Manages the workspace whitelist:

- Add a team member by email → they can sign in
- Assign role: `admin` or `member`
- Remove a member to revoke access

---

## Settings & Branding

Branding (workspace name, bot name, avatar, personality) is configured via the **Setup Wizard** on first run, and editable afterwards from workspace settings. Changes write to `.branding.json` and regenerate `CLAUDE.md` automatically.

---

## First-run bootstrap (every fresh workspace)

When the container starts for the first time AND `~/project/.claude/CLAUDE.md` doesn't already exist (i.e. this isn't a legacy migration), `bootstrap-project.sh` scaffolds:

- **Folder structure** — `Inbox/` (universal drawer), `Research/` (references), `${BOT_NAME}/` (bot's daily journal root)
- **Project files** — `README.md`, `Tasks.md` from English templates
- **System reminders** — three weekly recurring reminders seeded into `.reminders.json` (see "System rituals" below)
- A `.bootstrapped` flag so the script never runs twice

Legacy clients (with their own existing CLAUDE.md) skip bootstrap entirely — their structure is sacred.

---

## System rituals (built-in weekly reminders)

Three recurring reminders run autonomously to keep the workspace healthy. They have `kind: "system"` in `.reminders.json`, are listed under **System rituals** in the Reminders panel, and are protected from MCP-side cancellation (the assistant won't delete them — the user can disable via UI toggle).

| Schedule (UTC) | Trigger phrase | Skill loaded | What it does |
|---|---|---|---|
| Monday 09:00 weekly | `[REPO_AUDIT_TRIGGER]` | `repo-audit` | Reviews project structure, auto-cleans obvious things (empty folders, twin-folder casing, `.playwright-mcp` wipe), surfaces judgment calls |
| Friday 14:00 weekly | `[BACKUP_TRIGGER]` | `project-backup` | Creates tar.gz of `~/project`, sends via Telegram |
| Sunday 22:00 weekly | `[MEMORY_INDEX_TRIGGER]` | `memory-reindex` | Silent re-scan of new/modified files into memory MCP knowledge graph |

Reminders fire via Telegram (`reminder-monitor.sh` PM2 process polls every 60 s). **Without an active Telegram integration there's no delivery channel** — the Reminders UI dims entries and shows a setup banner when this is the case.

---

## Default skills (every workspace gets these)

These skills are baked into every container and available in every session out of the box:

| Skill | Trigger | Purpose |
|---|---|---|
| `task-management` | "add task", "to do" | Maintains `Tasks.md` Backlog/In Progress/Done |
| `reminders` | "remind me at X" | Wraps `set_reminder` MCP for time-based alerts |
| `project-backup` | "back up", `[BACKUP_TRIGGER]` | Tar.gz snapshot via Telegram |
| `playwright-protocol` | browser automation requests | Best practices for Playwright MCP usage |
| `skill-authoring` | "create a skill" | How to author a new project skill |
| `file-placement` | "save this", "write down" (no path) | Decides WHERE a new file goes; reads CLAUDE.md "Where to Save", scans existing folders, asks one short question if ambiguous, writes + indexes in memory |
| `repo-audit` | `[REPO_AUDIT_TRIGGER]`, "/audit" | Weekly structure review (above) |
| `memory-reindex` | `[MEMORY_INDEX_TRIGGER]`, "/reindex" | Weekly silent memory graph rebuild |
| `capability-tour` | "what can you do", post-activation | Lists active MCPs in human-readable form; diffs against CLAUDE.md `Context` section, offers to fill gaps |

Project-level skills (`.claude/skills/<name>/SKILL.md`) live alongside default skills and override them when names collide. Use the AI Settings → Skills tab in the workspace UI to scaffold one.

---

## Capability surfacing (the bot proactively tells the user what's available)

The `capability-tour` skill runs in three modes:

1. **Manual** — "what can you do" / "show me your tools" → lists all active MCPs with business-flavored descriptions, ≤8 lines
2. **Post-activation** — when the bot notices a new entry in `~/.claude.json` mcpServers that wasn't there last session, it mentions it once at a natural break: "Heads up — `<integration>` was added today; want a mini-tour?"
3. **Gap detection** — diffs active MCPs against the `## Context` section in `CLAUDE.md`. If an integration is active but not described, offers to help write the description (asking the user 1–3 short questions, then editing CLAUDE.md with explicit approval). If something is described but no longer configured, offers to remove the stale section.

The bot **never edits `CLAUDE.md` without per-edit approval**. Capability tour proposes; the user accepts or declines.

---

## Key file locations

| What | Where |
|---|---|
| Claude's instructions | `.claude/CLAUDE.md` |
| Skills | `.claude/skills/*.md` |
| Scheduled reminders | `.reminders.json` |
| Bootstrap-complete flag | `.bootstrapped` |
| Memory cards (cached prefix) | `memory/*.md` |
| Branding config | `.branding.json` |
| Uploaded bot avatar | `.branding/bot.png` |
| Encrypted credentials | `.integrations/` |
| Team whitelist | `.allowed-emails.json` |
| Chat history | `.chat/` |
| File attachments | `.attachments/` |
| Memory graph | `~/.claude/memory.jsonl` (outside project — survives container rebuild) |
