# Claude Code Skills

## User guide

A **skill** is a how-to your coworker follows for a kind of task: how you like
a weekly report written, the steps of your month-end close, what to check
before an email goes to a client. Open **Skills** in the sidebar to see them,
read one, change it, or write a new one in plain language. No installing,
no restart: a skill takes effect as soon as it is saved.

The coworker picks a skill up by itself when a task matches it, or you can ask
for one by name. Connecting a service adds the skill for it, so the coworker
knows that service's habits from day one, and the same skills are what its
routines run on.

**The team's and yours.** In a team workspace the Skills screen has two tabs.
**Team** skills are followed in everyone's conversations; an admin adds and
changes them. **Yours** are followed only in your own conversations — anyone
can add one, and nobody else sees it. Ask your coworker for a new skill and it
lands in Yours; an admin is asked whether it is for the whole team or just for
them. A service you connect for yourself brings its skill to Yours; one
connected for the team brings it to Team. In a group conversation no new
skills are made. A workspace without a team has one list.

---

Skills are instruction files that tell Claude how to handle specific tasks. Unlike MCP servers (which provide tools), skills provide **behavioral guidelines** — rules, workflows, and constraints that shape how Claude acts when a particular topic comes up.

| | Skills | MCP servers |
|---|---|---|
| What | Instructions for Claude | API tools Claude can call |
| When loaded | Description always; content on invoke | Only when Claude calls them |
| Who triggers | Claude automatically (matches description) or user via `/skill-name` | Claude on demand |

> **Skills dashboard.** The workspace exposes a **Skills** view in the sidebar where the user can browse, edit, create, and delete project skills directly — markdown editor, frontmatter-aware, no SSH required. Global skills appear in a read-only section. The backend lives at `/api/skills` (merged listing with origin metadata) and `/api/skills/raw` (read-only fetch of one global skill).

---

## Where skills live

**Team and personal (team mode).** The team's skills are `PROJECT_DIR/.claude/skills/<name>/`;
a person's own are `users/<slug>/.skills/<name>/` in their private tree. `priv-tree assign`
links the person's turn home `~/.claude/skills` to their `.skills` (the CLI loads skills from
the project and from HOME), and `bin/turn-slots.mjs` links the operator brain's to the primary
admin's at boot. Writes to `.claude/skills` and `.claude/CLAUDE.md` are an admin's in team mode:
the scope-guard hook refuses a member's or a group turn's write tools there, and the files API
refuses a member's. `GET /api/skills` lists the team's (`scope: team`, `editable` for an admin
or in solo) and the caller's own (`scope: personal`), with `teamMode` and `canEditTeam`;
`/api/skills/raw?origin=personal` reads the caller's own. An integration's optional skill is
installed by the connection's reach — a personal connection's into the owner's `.skills`, its
`mcp__<server>__` tool names rewritten to `mcp__<server>-mine__` (`personaliseSkill`).

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
- Security floor: anything that reaches outside the platform (an email, a post, a change over an API) happens only after an explicit go-ahead from the person; until then the bot suggests or prepares it
- Scheduling: `set_reminder` for anything timed; never the CLI's own schedulers or its built-in `schedule` skill. `CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup` and `RemoteTrigger` are denied outright in `bootstrap/claude-settings.json` (merged into every home, so the deny holds on every turn and the bot, `--dangerously-skip-permissions` included): they need a live session or Anthropic's cloud, and a job set with them never fires here
- Routines: "Routines" (the sidebar view) is the person's routines (the `ROUTINES` block in the prefix) — a Marketplace one is added with `add_routine` after a yes, one of the bot's own with `memory_write` into `RESPONSIBILITIES` (recorded as a routine on that screen), then `morning-planner` runs in the same turn so it is folded into today's reminders
- Memory on request: a preference, a fact about the person, a team rule or what the company does goes on its card with `memory_write` in that turn; anything else with `memory_note`; never "it will be saved later"
- Capability surfacing (proactively offer relevant tools)
- Session Notes and Pending Reminders conventions
- Session Handoff — read previous session notes on start, write summary on end
- File routing (read `PROJECT_STRUCTURE.md` before saving)

Client-specific behavior (persona, project context, integrations) goes in `project/CLAUDE.md`.

### Skill fence (built-in `schedule` blocked)

The CLI ships a built-in `schedule` skill for Anthropic's cloud routines. A self-hosted container cannot reach that service, and its description ("scheduled cloud agents (routines)") matches the word users type for this product's Routines view. A `PreToolUse` hook on the `Skill` tool (`ide-template/hooks/skill-fence.mjs`, registered in `ide-template/bootstrap/claude-settings.json`) denies `schedule` and `cron` (exact name, plugin prefix ignored) and a plugin's `…:routines`, and tells the model the real sequence instead: `add_routine` for a Marketplace routine or `memory_write` into `RESPONSIBILITIES` for its own, then `morning-planner` in the same turn, with the `routines` skill for details — without describing it as a fallback or claiming a scheduler is down. The bare name `routines` is our own skill (`skills/default/routines`) and passes: blocking it kept the bot from the very skill its instructions send it to. Any other skill passes through; the hook fails open on unparseable input.

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
│   ├── make-pdf/                   ← markdown → PDF, delivered as a file
│   ├── memory-notes/               ← how the bot writes memory itself: whole notes, one note per meeting, ask when unsure
│   ├── mini-apps/                  ← small interactive tabs (start_tab + tab state)
│   ├── morning-planner/            ← plans one person's day as timed reminders for the bot to act on, written in one replace_plan call; reads how the last days' reminders landed, suggests a routine now and then; run after any routine change
│   ├── playwright-protocol/        ← safe browser automation
│   ├── project-backup/             ← tar.gz of the shared project (no memory, no others' private folders)
│   ├── reminders/                  ← set_reminder MCP + [REMINDER] trigger handling
│   ├── routines/                   ← suggests Marketplace routines in conversation, adds them (add_routine)
│   ├── repo-audit/                 ← weekly structure review
│   ├── security/                   ← untrusted-content discipline (5 rules)
│   ├── skill-authoring/            ← how to write a new SKILL.md (reference + 3 examples)
│   └── task-management/            ← structured task board (HTTP API, no Tasks.md)
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
    ├── email-imap/                            ← reading mail (pairs with email-write-protocol)
    ├── <one folder per hosted integration>/   ← notion, linear, todoist, monday, airtable, clickup, atlassian, miro,
    │                                            calcom, calendly, granola, tally, stripe, paypal, klaviyo,
    │                                            mailchimp, wix, webflow, github, sentry, supabase, neon, netlify,
    │                                            cloudflare, amplitude, ga4, zapier, deepl,
    │                                            parallel, firecrawl, cryptocom, fireflies, fathom, otter,
    │                                            readai, krisp — tools, write rules, gotchas, routines
    └── trello/
```

**INDEX.md autogen at boot.** Entrypoint walks both skill trees, parses each `SKILL.md` frontmatter, and writes a one-line-per-skill `~/project/.claude/skills/INDEX.md`. The model uses `cat INDEX.md | grep -i <keyword>` to verify skill existence before claiming absence (per the **Before claiming absence** rule in global-claude.md). Eliminates "I don't have a skill for X" hallucinations.

**Every integration has a skill.** An optional skill is installed when its `requires:` names an active integration — by its catalog id (`email-imap`, `ga4`, `meta-ads`) or by its MCP server's name (`email`, `analytics`, `meta`); both installers accept either. Each integration skill lists the server's real tools (from the vendor's docs or source), marks what sends, pays, publishes or deletes, and says which routines rely on it. A routine written by the bot may start with an emoji or an icon name in braces (`{bell}`); a known emoji is mapped to an icon.

**Progressive disclosure via `references/`.** Per Anthropic Skills spec, larger skills (>~100 lines) split static reference content into `references/<topic>.md` files loaded on-demand. Currently applied to: `skill-authoring/references/{yaml-fields, anti-patterns, checklist, examples/*}`, `capability-tour/references/{mcp-defaults, gap-handling}`, `file-placement/references/decision-tree.md`, `project-backup/references/rules.md`, `reminders/references/{delivery, set-params}`, `repo-audit/references/{bash-commands, exclusions}`, `security/references/coverage-status.md`, `task-management/references/{reminder-rules, templates}`, `routines/references/catalog.md` (generated from `workspace-api/routines.catalog.json` by `lib/routines-reference.js`; a test fails when it is stale).

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
