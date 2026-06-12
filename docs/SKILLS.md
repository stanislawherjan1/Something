# Claude Code Skills

Skills are instruction files that tell Claude how to handle specific tasks. Unlike MCP servers (which provide tools), skills provide **behavioral guidelines** — rules, workflows, and constraints that shape how Claude acts when a particular topic comes up.

| | Skills | MCP servers |
|---|---|---|
| What | Instructions for Claude | API tools Claude can call |
| When loaded | Description always; content on invoke | Only when Claude calls them |
| Who triggers | Claude automatically (matches description) or user via `/skill-name` | Claude on demand |

> **Skills dashboard.** The workspace exposes a **Skills** view in the sidebar where the user can browse, edit, create, and delete project skills directly — markdown editor, frontmatter-aware, no SSH required. Global skills appear in a read-only section. The backend lives at `/api/skills` (merged listing with origin metadata) and `/api/skills/raw` (read-only fetch of one global skill).

---

## Where skills live

Skills can exist in two locations — Claude checks both:

| Location | Scope | How to update |
|---|---|---|
| `~/.claude/skills/` | Server-level — all sessions on this container | Edit via IDE terminal **or** the Skills dashboard (read-only there — copy into project skills to override). |
| `project/.claude/skills/` | Project-level — synced with Google Drive | Edit via the Skills dashboard, the in-IDE file viewer, or directly in Google Drive. Picked up by the next chat turn. |

`bot.sh` copies `~/.claude/` to the bot's isolated home on each start, so server-level skills are always available.
Project-level skills live inside the Drive-synced project folder — useful for client-specific workflows that travel with the project.

> **Discovery depth:** Claude Code discovers skills one level deep only — `~/.claude/skills/<skill-name>/SKILL.md`. When copying from the template, always copy the **inner** folder, not the parent category folder.
>
> Correct — copies the skill folder directly under `skills/`:
> ```
> cp -r ide-template/skills/optional/shopify/shopify-orders ~/.claude/skills/
> # result: ~/.claude/skills/shopify-orders/SKILL.md  ✓
> ```
>
> Wrong — copies the category folder, creating an extra nesting level Claude won't find:
> ```
> cp -r ide-template/skills/optional/shopify ~/.claude/skills/
> # result: ~/.claude/skills/shopify/shopify-orders/SKILL.md  ✗
> ```

> **Case-insensitive file lookup**: the dashboard accepts both `SKILL.md` (lowercase) and `SKILL.MD` (uppercase) — older skills shipped with the latter. Save from the editor canonicalises to lowercase. A folder without a `SKILL.md` (any case) is skipped from the listing entirely.

## Skills dashboard — create / edit / delete from the UI

The workspace exposes the **Skills** view in the sidebar with full CRUD:

- **Create** — the last tile in the Project section is `+ Add skill`. Slug-validated name (lowercase, dashes), optional description; on submit creates the directory + a starter SKILL.md (frontmatter scaffold + body stub) and auto-opens the editor.
- **Edit** — click any tile → modal opens with a wide writing surface (max-w-6xl, prose-width centred textarea, mono 14px, `⌘S` saves, `Esc` closes).
- **Delete** — hover a project tile to reveal a small trash icon top-right. Click → top-level confirm modal that recursively removes `.claude/skills/<name>/`.
- **View global** — global skills (under `~/.claude/skills/`) appear in a separate section with a "Global" badge. The editor opens in read-only mode with a banner explaining how to override (copy contents into a same-named project skill — that takes precedence, mirroring claude's own override semantics). Save / Delete buttons hidden.

API endpoints behind it:

- `GET /api/skills` — merged listing of project + global skills with `origin` and `description` parsed from each frontmatter.
- `GET /api/skills/raw?name=&origin=` — read-only fetch of one skill's SKILL.md content (case-insensitive lookup; works for both project and global).
- Writes go through the regular `/api/files/write`; deletes through `/api/files/delete?path=...` (recursive on directories).

---

## System-level Claude instructions (global-claude.md)

Beyond skills, the system deploys a global `~/.claude/CLAUDE.md` on every container start (`entrypoint.sh` copies it from `ide-template/global-claude.md`). This file contains operational rules inherited by all bots:

- Telegram formatting (no Markdown, plain text only)
- Google Drive verification (always read-back after edits)
- Error handling protocol
- Cron creation pattern (CronList check before creating)
- Capability surfacing (proactively offer relevant tools)
- Session Notes and Pending Reminders conventions
- Session Handoff — read previous session notes on start, write summary on end
- File routing (read `PROJECT_STRUCTURE.md` before saving)

Client-specific behavior (persona, project context, integrations) goes in `project/CLAUDE.md`.

---

## Skill catalog

Skills in `ide-template/skills/` are organized in two tiers:

```
ide-template/skills/
│
├── default/                        ← install on every container, no keys needed
│   ├── capability-tour/            ← surfaces wired-up MCPs to the user
│   ├── environment/                ← sealed-container constraints (no runtime installs)
│   ├── file-placement/             ← where-to-save decision tree
│   ├── legacy-drive-sync/          ← only when LEGACY_DRIVE_SYNC=true (rclone reliability)
│   ├── memory-cards/               ← 7-card memory model (read at session start)
│   ├── memory-reindex/             ← weekly knowledge graph refresh
│   ├── memory-router/              ← routes a fact to the right card on write
│   ├── non-technical-comms/        ← business-language framing for non-technical users
│   ├── playwright-protocol/        ← safe browser automation
│   ├── project-backup/             ← tar.gz + Telegram delivery
│   ├── reflect-learnings/          ← proposes memory updates (queued in _drafts/ for /memory approve)
│   ├── reflect-organizer/          ← documents/ tidying proposals
│   ├── reflect-summary/            ← thread title + summary generation
│   ├── reminders/                  ← set_reminder MCP + [REMINDER] trigger handling
│   ├── repo-audit/                 ← weekly structure review
│   ├── security/                   ← untrusted-content discipline (5 rules)
│   ├── skill-authoring/            ← how to write a new SKILL.md (reference + 3 examples)
│   ├── task-management/            ← Tasks.md curator
│   └── taste-recall/               ← loads anti-pattern memory at session start
│
└── optional/                       ← installed conditionally per active integration
    ├── ask-gemini/, ask-gpt/, ask-grok/    ← per-model "ask the AI" wrappers
    ├── email-write-protocol/                ← email send/reply confirmation hierarchy
    ├── gcalendar/, gdocs/, gdrive/, gsheets/, gslides/, gtasks/  ← Google Workspace
    ├── google-ads/{campaigns,copy,negatives,report}/
    ├── image-generation-{nano-banana,seedream}/   ← BYTEPLUS_API_KEY or GEMINI_API_KEY
    ├── meta/{ads-campaigns,ads-report,ads-audiences}/
    ├── research-twitter-account/, x-research/     ← X (Twitter) research
    ├── docs-comments/                          ← shipped to all clients
    ├── shopify/{catalog-sync,edits,orders,products,store}/
    ├── signwell-protocol/                     ← e-signature workflow
    └── trello/, substack/
```

**INDEX.md autogen at boot.** Entrypoint walks both skill trees, parses each `SKILL.md` frontmatter, and writes a one-line-per-skill `~/project/.claude/skills/INDEX.md`. The model uses `cat INDEX.md | grep -i <keyword>` to verify skill existence before claiming absence (per the **Before claiming absence** rule in global-claude.md). Eliminates "I don't have a skill for X" hallucinations.

**Progressive disclosure via `references/`.** Per Anthropic Skills spec, larger skills (>~100 lines) split static reference content into `references/<topic>.md` files loaded on-demand. Currently applied to: `skill-authoring/references/{yaml-fields, anti-patterns, checklist, examples/*}`, `memory-router/references/routing-rules.md`, `reflect-learnings/references/{rules, proposal-examples}`, `capability-tour/references/{mcp-defaults, gap-handling}`. The remaining 7 default split candidates (repo-audit, memory-reindex, task-management, security, reminders, file-placement, project-backup) are queued for Phase 2.

**`allowed-tools` field is mandatory** for new skills — declares the minimum tool scope. Pure-reference skills get `Read`. Memory skills get `Read, Edit, Write`. Integration skills get tight MCP wildcards (`mcp__shopify__*`). Defaults to full access if omitted — only do that for orchestration skills that genuinely need everything.

---

## Installing skills

### Default skills (install once on every new container)

```bash
for skill in playwright-protocol reminders project-backup task-management; do
  mkdir -p ~/.claude/skills/$skill
  cp ide-template/skills/default/$skill/SKILL.md ~/.claude/skills/$skill/SKILL.md
done
pm2 restart <BOT_NAME>
```

Or install to the project (Drive-synced, survives container rebuilds):

```bash
for skill in playwright-protocol reminders project-backup task-management; do
  mkdir -p project/.claude/skills/$skill
  cp ide-template/skills/default/$skill/SKILL.md project/.claude/skills/$skill/SKILL.md
done
pm2 restart <BOT_NAME>
```

---

### Image generation skills (when `BYTEPLUS_API_KEY` or `GEMINI_API_KEY` is set)

```bash
mkdir -p ~/.claude/skills/image-generation
cp ide-template/skills/optional/image-generation/SKILL.md ~/.claude/skills/image-generation/SKILL.md
pm2 restart <BOT_NAME>
```

---

### Google Ads skills (when `GOOGLE_ADS_DEVELOPER_TOKEN` is set)

```bash
for skill in google-ads-campaigns google-ads-report google-ads-negatives google-ads-copy; do
  mkdir -p ~/.claude/skills/$skill
  cp ide-template/skills/optional/google-ads/$skill/SKILL.md ~/.claude/skills/$skill/SKILL.md
done
pm2 restart <BOT_NAME>
```

| Skill | When to use |
|---|---|
| `google-ads-campaigns` | Creating or modifying campaigns, ad groups, keywords, RSAs |
| `google-ads-report` | Performance analysis, CTR/CPC/ROAS reporting |
| `google-ads-negatives` | Managing negative keywords |
| `google-ads-copy` | Writing and optimizing ad headlines and descriptions |

---

### Meta Ads skills (when `META_ACCESS_TOKEN` is set)

```bash
for skill in meta-ads-campaigns meta-ads-report meta-ads-audiences; do
  mkdir -p ~/.claude/skills/$skill
  cp ide-template/skills/optional/meta/$skill/SKILL.md ~/.claude/skills/$skill/SKILL.md
done
pm2 restart <BOT_NAME>
```

| Skill | When to use |
|---|---|
| `meta-ads-campaigns` | Create/update/pause campaigns, ad sets, ads |
| `meta-ads-report` | Performance reports, anomaly detection, ROAS analysis |
| `meta-ads-audiences` | Custom audiences, lookalikes, interest research |

---

### Shopify skills (when `SHOPIFY_STORE_DOMAIN` is set)

```bash
for skill in shopify-products shopify-orders shopify-store; do
  mkdir -p ~/.claude/skills/$skill
  cp ide-template/skills/optional/shopify/$skill/SKILL.md ~/.claude/skills/$skill/SKILL.md
done
pm2 restart <BOT_NAME>
```

| Skill | When to use |
|---|---|
| `shopify-products` | Create, edit, delete products — variants, pricing, media, metafields, publish/unpublish |
| `shopify-orders` | Order lookup, fulfillments, cancellations, draft orders |
| `shopify-store` | Collections, discounts, bulk operations, store analytics |

---

## Writing a new skill

```
~/.claude/skills/my-skill/
└── SKILL.md
```

**SKILL.md structure:**

```markdown
---
name: my-skill
description: Precise trigger description — Claude reads this to decide when to invoke the skill. Be specific.
allowed-tools: Read, Bash, mcp__shopify__get_product
---

# Instructions

1. Do X
2. Then do Y
3. Always verify Z
```

The `description` field is the trigger — Claude matches it against the user's request. The more precise it is, the less likely it fires incorrectly.

The `allowed-tools` field is optional but recommended for write operations — it limits what Claude can call while the skill is active.

### When an MCP tool fails — report, don't improvise

Post-broker the container is locked down — no runtime downloads, no `npx install`, no shell-spawning external binaries from skills. If an `mcp__*` tool returns "not available", "browser not reachable", "ENETUNREACH", or any infra-shaped error, the right move is to:

1. **Stop the current path.** Don't try to recover by spawning the underlying CLI (`npx playwright`, `pip install`, `git clone`, etc.) — egress allow-list will block the download and the bot will spend turns retrying.
2. **Report to the operator with the exact error** — e.g. "Playwright MCP returned 'browser not reachable' — looks like a container-side misconfiguration, can't auto-fix from this session".
3. **Degrade gracefully if possible** — work from screenshots the user pastes, use Grok web search instead of Playwright for lookups, ask the user to run the action themselves.

`docs/SKILLS.md` and individual skill files (especially `playwright-protocol/SKILL.md`) carry the specific rules. The general principle: **the bot's container is curated, not configurable from inside**. Skills should treat infra problems as bug reports, not as obstacles to work around.

---

## Skill vs MCP — when to use which

**Use a skill** when you want Claude to follow a specific workflow, ask clarifying questions in a particular order, or apply constraints to how it uses existing tools.

**Use an MCP server** when you need Claude to access live data from an external system (Shopify, GA4, etc.).

They compose well: a skill can instruct Claude to use specific MCP tools in a specific way.
