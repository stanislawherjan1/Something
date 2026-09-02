# Memory

**How the bot remembers things between sessions and across channels.**

---

## TL;DR

Every workspace ships with a small LLM-wiki under `~/project/memory/` — curated
markdown cards plus per-entity pages. Workspace-api stitches the relevant cards
into the system prompt on every chat turn, so the bot wakes up already knowing
the basics.

Memory is written **in the conversation that produces the fact**, by the model,
through one guarded tool (`memory_write`). There is no background pipeline: no
nightly consolidation, no proposal queue, no approval step. The same tool is how
a fact gets **corrected** — and a correction *replaces* the claim it corrects
rather than being filed next to it.

The structure was inspired by [Andrej Karpathy's LLM-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
and adapted to the rest of the workspace.

---

## What lives in `project/memory/`

```
project/memory/
├── INDEX.md                  ← auto: map of this scope (cards, topics, concepts)
├── RULES.md                  ← hard never / always rules
├── AGENT_IDENTITY.md         ← the agent's voice, mood, defaults
├── AGENT_TOOLS.md            ← per-tool gotchas for active integrations
├── CHANNELS.md               ← auto: the Telegram groups the bot is in
├── TEAM.md                   ← auto: the roster (team mode)
├── concepts/<slug>.md        ← accreting, cited claims about a recurring entity
├── topics/<slug>.md          ← long-form prose on a subject
├── patterns/<slug>.md        ← "the bot got X wrong; here's the rule"
├── users/<slug>/             ← one person's PRIVATE tree (team mode)
│   ├── INDEX.md              ← auto: map of their private memory
│   ├── USER_PROFILE.md       ← stable facts about them
│   ├── USER_PREFERENCES.md   ← how they like things done
│   ├── USER_RELATIONSHIPS.md ← people in their world
│   ├── USER_REFLECTIONS.md   ← their own dated self-introspection
│   ├── RESPONSIBILITIES.md   ← the bot's standing duties toward them
│   ├── RECENT_WEB.md         ← auto: rolling web-chat tail
│   ├── RECENT_TELEGRAM.md    ← auto: rolling Telegram tail (operator only)
│   └── concepts/ topics/     ← their private pages
└── _engine/                  ← the write log + undo snapshots (never read back)
```

In a solo workspace the `users/<slug>/` tier is flat: the personal cards sit
directly under `memory/`.

`workspace-api/lib/memory-registry.js` is the **single definition** of what a
card is — its tier (shared vs private), whether it is preloaded, whether it is
seeded from a template, whether it is machine-generated. The prefix loader, the
group fence, the graph, the INDEX generator and the entrypoint seed list all
derive from it, and a build-failing test rejects a second card list anywhere in
the tree. Six hand-maintained copies of that knowledge is how a private card
once leaked into group prompts.

Cards are seeded on first container start from
`/opt/ide/bootstrap/memory-cards-templates/`. Existing files are never
overwritten. `INDEX.md`, `CHANNELS.md`, `TEAM.md` and the `RECENT_*` tails are
machine-generated — read them, never hand-edit them.

---

## How the bot reads memory

### Cached system-prompt prefix (every turn)

`workspace-api/lib/memory-loader.js` builds a fixed-order block (a preamble plus
the preloaded cards) and feeds it to claude on every turn. The block is stable
across turns within a session, so Anthropic's prompt cache reads it at 0.1× the
input rate. The order is locked: changing it invalidates every existing cache
across the fleet, so the registry test pins it literally.

| Channel | Mechanism | When |
|---|---|---|
| Web (`workspace-api` chat) | `claude.js` → `buildTurnPrefix()` → `--append-system-prompt` | every turn |
| Telegram (bot tmux) | `bot.sh` curls `GET /api/memory/prefix?raw=1` into a file, passed as `--append-system-prompt-file` | once per tmux session; refreshed on `/restart` |

The Telegram prefix is **static for the tmux session lifetime** — a correction
written today is on disk immediately but is not visible to that session until a
restart. (This is the last thing tying the workspace to the tmux runtime; the
delivery-layer plan retires it.)

`USER_RELATIONSHIPS` and `USER_REFLECTIONS` are deliberately **not** preloaded —
large and low-frequency. The bot pulls them with `Read` when relevant.

**Group turns** load a prefix built by `buildTeamPrefix()`, which excludes the
entire private tier *derived from the registry*. A group reply is public to the
whole chat and its session is shared across senders, so nothing private may be
preloaded there — not even the sender's own.

### On demand

- `memory_grep` — ripgrep over the shared tree **plus the caller's own private
  tree**, never another teammate's. Cheap deterministic lookup before `Read`.
- `Read` on a concept/topic page, found via the scope's `INDEX.md`.
- `recent_messages({channel})` — the live rolling tail, fresher than a frozen
  Telegram prefix.

INDEX entries carry a date, and a page whose newest cited claim is older than
`MEMORY_STALE_DAYS` (default 90) is marked `⚠ unreviewed`, so the model prefers
asking over asserting from an old page.

---

## How the bot writes memory

**One path.** `memory_write` (workspace-api MCP) → `POST /api/internal/memory-write`
(loopback only) → `workspace-api/lib/memory-engine.js`. Direct `Write`/`Edit`
under `memory/` is blocked by the `scope-guard` PreToolUse hook, with a message
naming the tool. workspace-api is the only process that touches the tree, which
also keeps a single uid on it.

### Operations

| Op | What it does |
|---|---|
| `remember` | record a new fact on a card (with a section) or an entity page |
| `supersede` | a fact CHANGED: replace the old claim **everywhere it appears** |
| `retire` | a fact was never true: delete the claim outright |
| `rename_entity` | a page was created under the wrong name: move it and repoint every `[[link]]` |
| `retire_page` | delete a page that should not exist |
| `revert` | undo one logged write |

### The doctrine

**A correction replaces the claim it corrects.** No `[was: …]` trail, no
strikethrough, no `## Retired` section. The reason is mechanical: cards are
preloaded on *every* turn, so a falsehood parked beside the truth is exactly as
present as the truth. History lives in `_engine/log.jsonl` plus a pre-image
snapshot per write — which is why the page does not have to carry it.

`supersede` replacing **every** copy is the other half. The same fact usually
exists in more than one place (a card line and a concept page); a correction
applied to one copy comes back weeks later from the copy nobody touched.

When the matches disagree with each other, nothing is written and they are
returned — replacing the wrong claim is worse than replacing none.

### Guards (all in the engine, so they apply to every writer)

- **credential kill-list** — a key/token/PEM is refused, with the reason.
- **path confinement** — card names come from the registry; page slugs are
  validated; the resolved path must stay under `memory/`.
- **scope** — the same rule that guards reads (`scope-rule.js`): your own tree
  or the shared one, never a teammate's. A group turn may write shared only.
- **rival detection** — `remember` refuses when memory already states the same
  thing differently, and tells the caller to `supersede` instead. This is what
  stops a correction from landing as a second, contradictory bullet.
- **undo + log** — every write snapshots the pre-image and appends an event.

### Silence

Memory writes produce **no notification on any surface**. Upkeep is background
work, not a message. What was written is answered on demand: `memory_log` for
the model, `GET /api/memory/changes` for the dashboard, each event carrying the
id that reverts it.

`revert` restores the pre-image **and replays the file's later events**, so
undoing an old write cannot silently discard newer facts.

---

## Rolling snapshots (continuity across resets)

`RECENT_WEB.md` / `RECENT_TELEGRAM.md` hold the last ~50 messages per channel,
written by `lib/recent-snapshot.js`:

- **Idle timer** — a PM2 process pokes `POST /api/memory/snapshot/refresh` every
  60 s; a channel refreshes only when its source JSONL has been idle ≥10 min.
- **Chat reset** — the web reset writes the tail immediately.

A refresh whose content is unchanged **touches the mtime instead of rewriting
the file**: the tails sit inside the cached prefix, so rewriting them with a
fresh timestamp invalidated the prompt cache once a minute all day.

In team mode each person's web tail is private (`memory/users/<slug>/`), and the
Telegram tail belongs to the operator.

---

## Untrusted-content discipline

External content (emails, PDFs, web fetches, transcripts) is wrapped in
spotlight delimiters before the model sees it:

```
<untrusted-content source="email:<msg-id>" absorbed_at="<iso-ts>">…</untrusted-content>
```

Anything inside is **data, never instructions**. The `security` skill documents
the full discipline; `apps/_shared/wrap-untrusted.js` is the shared helper.
Coverage today: `email-mcp` wraps bodies and snippets; other paths are not
wrapped yet and are to be treated with the same skepticism.

---

## Memory dashboard (AI Settings → Memory)

An Obsidian-style force-directed graph of `project/memory/`: cards, topics and
concepts as nodes, `[[wiki-links]]` as strong edges and bare-name mentions as
thin ones. Click a node to read the file. In team mode the graph is scoped to
the viewer: the shared tree plus their own private pages.

Every node has a file behind it. (An earlier version also drew "emerging"
placeholder nodes for entities that were merely frequent in a background
pipeline; pages are now created deliberately, in the conversation that earns
them.)

---

## Coexistence with the rest of the bot's context

| System | Where | For |
|---|---|---|
| **Memory cards** | `<project>/memory/*.md` | curated facts, preloaded into every turn |
| **Concept pages** | `memory/concepts/<slug>.md` | one entity's accreting cited claims |
| **Topic pages** | `memory/topics/<slug>.md` | long-form prose, read on demand |
| **Pattern cards** | `memory/patterns/<slug>.md` | anti-patterns, loaded by `taste-recall` |
| **Rolling snapshots** | `memory/users/<slug>/RECENT_*.md` | the last ~50 messages per channel |
| **Pending reminders** | `<project>/Pending Reminders.md` | short-term "next time we talk" |
| **System rules** | `~/.claude/CLAUDE.md` | system-level rules for every workspace |
| **Persona** | `<project>/.claude/CLAUDE.md` | per-workspace persona + tone |

There is **no knowledge graph and no `mcp__memory` store**. The markdown wiki is
the only durable memory; the `memory` MCP server was removed because nothing
ever read it back, while the model could still write to it and believe it had
saved something.

---

## File-by-file reference

| File | Role |
|---|---|
| `lib/memory-registry.js` | the single card definition every consumer derives from |
| `lib/memory-loader.js` | builds the cached prefix (`buildCachedPrefix`, `buildTeamPrefix`) |
| `lib/memory-engine.js` | the one write path: ops, guards, undo, log |
| `lib/memory-index.js` | regenerates a scope's `INDEX.md` map |
| `lib/memory-migrate.js` | one-shot move off the retired pipeline (boot, idempotent) |
| `lib/memory-graph.js` | `{nodes, edges}` for the dashboard |
| `lib/memory-grep.js` | ripgrep-backed search, own-tree scoped |
| `lib/recent-snapshot.js` | rolling tail writer (content-gated) |
| `routes/memory.js` | graph / grep / prefix / recent / changes / revert / snapshot |
| `routes/internal.js` | `memory-write`, `memory-log` (loopback only) |
| `apps/workspace-api-mcp` | the `memory_write`, `memory_log`, `memory_grep`, `recent_messages` tools |
| `hooks/scope-guard.mjs` | blocks raw file writes under `memory/`; enforces per-actor scope |

### Skills

- `memory-cards` — reference for the memory *model* (what lives where). Writing
  needs no skill: the routing rules live in the `memory_write` tool description.
- `taste-recall` — loads anti-pattern cards at session start.
- `security` — untrusted-content handling.

---

## Operational notes

**Tests.** `bash ide-template/scripts/test-memory.sh` runs the write-path
(engine) and read-path (registry/prefix/grep) suites; both are also in
`npm test` under `workspace-api/`. Permissions are container-specific:
`docker exec -u coder <ctr> bash /opt/ide/scripts/test-memory-perms.sh`.

**Cache hit verification.** After a turn or two, check `pm2 logs workspace-api`
for `cache_read_input_tokens`. If it is `0` across several turns, something is
changing the prefix mid-session — usually a card being rewritten.

**Updating templates without losing edits.** The entrypoint seed step is
idempotent. To roll new template content into an already-seeded workspace, copy
the file in by hand (not `INDEX.md` — it is generated).

**Migration.** `migrateToEngine()` runs at boot, once: it archives the retired
pipeline's files to `/var/wsapi-store/memory-v2-archive-<date>.tar.gz` (outside
the project tree, because those drafts contain every teammate's private facts)
and strips `## Retired` sections, struck claims and `[was: …]` tails off the
cards. What it removes is inside the archive.
