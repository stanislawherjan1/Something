---
name: context-refresh
description: Sync the bot's picture of reality BEFORE it plans or acts. Check the LIVE sources (email, calendar, tasks, and the org's active integrations) and curated memory, reconcile them, UPDATE memory wherever a source has moved (a status change, decision, resolved item), and leave a short QUIET current-state brief. The morning-planner runs this as its Step 0; it also runs standalone ("catch me up", "refresh context", "what's the current state"). Trust order: live integrations + curated memory are ground truth; reflect summaries are a weak hint that is ALWAYS verified before use. Never messages the user — it only READS sources, WRITES memory, and writes the brief.
allowed-tools: Read, Bash, Write, Edit, mcp__email__list_recent, mcp__email__search, mcp__email__read_message, mcp__gcalendar__list_events, mcp__gtasks__list_task_lists, mcp__gtasks__list_tasks, mcp__trello__list_boards, mcp__trello__list_lists, mcp__trello__list_cards, mcp__shopify__get_sales_summary, mcp__shopify__get_orders, mcp__shopify__get_low_inventory, mcp__meta__get_campaign_performance, mcp__meta__get_ad_account_insights, mcp__google-ads__search, mcp__github__list_issues, mcp__github__list_pull_requests, mcp__gdrive__list_recent, mcp__x__user_mentions, mcp__substack__list_comments
---

# Context refresh — sync with reality before acting

Before the bot plans or says anything time-sensitive, make its picture match reality.
Check the LIVE sources plus curated memory, reconcile them, refresh memory where a
source has moved, and leave a short current-state brief. Runs SILENTLY — it reads
sources, writes memory, and writes the brief; it never messages the user.

## Whose context (team mode)
The invoking turn names the person as `slug=<x>` (the planner passes its own slug through).
Refresh THAT person's context: read/write under `memory/users/<x>/`, check the sources
THEY own (their inbox, their boards), and write their brief. No slug / solo → the operator.

## Trust order — this is the whole point

1. **Live integrations** (email, calendar, tasks, and the org's tools — Trello, Shopify,
   Meta/Google Ads, GitHub, …) — the CURRENT state of the world. **Authoritative.**
2. **Curated memory** (`memory/concepts/` entity pages, `USER_PROFILE`, `RESPONSIBILITIES`,
   topic/brief cards) — durable, human-relevant truth.
3. **Reflect summaries** (`_reflect/threads/*.md`) — a WEAK hint that a thread MIGHT have a
   loose end. **Never ground truth.** Reflect is auto-generated from chats: it goes stale
   the moment a real source moves, and it can misread a thread's name as a real entity. So
   every reflect item is a LEAD to verify against (1) and (2) — never a fact to act on.

## Steps

1. **Understand the org — and pin down WHAT to look for WHERE.** Skim the project
   `CLAUDE.md`, `MISSION`/Scope, `USER_PREFERENCES`, and `memory/concepts/`. Two outputs:
   (a) which integrations are even relevant (ecommerce → Shopify; advertiser → ad spend; dev
   team → repos); and (b) the **specific scopes the context names** — which project maps to
   which board / store / repo / label (e.g. "*a named workstream* → *that* Trello board", "the
   storefront → *that* Shopify account"). You need (b) BEFORE you touch a tool: you go in looking for a
   KNOWN thing in a KNOWN place, never a blind "list everything and see". If the context
   doesn't name a scope for a tool, that tool probably isn't worth a call this run.
2. **Check the live sources — READ, don't skim.** Always email, calendar, tasks, plus the
   integrations the org context points to. Two rules that matter:
   - **Email: check every mailbox you have access to.** Read across all configured accounts
     (`account="*"`) over a generous window (not just the newest few), and `search` by keyword
     for whatever you're specifically tracking — `read_message` the hits to get the CURRENT
     status. A bare recent-list of one inbox isn't enough to verify a particular thread.
   - **Big integrations: query the SCOPE the context named (Step 1).** Use the project→board /
     store / repo map you pinned down in Step 1 — query THAT specific Trello board / Shopify
     store / repo, never a blind "list everything" (a huge payload makes the turn bail with a
     stale "last known" note). A known thing in a known place.
   The goal is the CURRENT state of each thing that matters, not a skim of subject lines.
3. **Reconcile + REFRESH MEMORY (the core job).** Wherever a live source shows an update on
   something memory tracks — a status change, a decision, a new durable fact, a resolved
   item — UPDATE the memory card now (follow `memory-router`: the right `concepts/` or topic
   card, or the person's card). *Example: a source shows something you'd tracked as "pending" is
   now done → edit that item's card from "pending" to "done, <date>".* This closes the loop
   source→memory so the next plan starts from reality. Capture DURABLE facts only — a real
   change, not every message. (Memory-writes preserve file perms — Edit an existing card, or
   `Write` a new one; never `chown`.)
4. **Verify the reflect open-items.** For each `## Open items` line in the reflect cards,
   check it against the live source + memory. Resolved → it's already reflected in memory
   from step 3; mark it closed. Still genuinely open → keep it as a real open loop for the brief.
5. **Write the QUIET brief.** `Write` a short current-state digest to
   `memory/users/<slug>/CONTEXT_BRIEF.md` — the few things that are live, changed, or still
   open today, each grounded in the verified source it came from. Keep it tight (bullets,
   not prose). This is for the bot + the planner, never sent to the user.

## Boundaries

- **Read sources, write memory + the brief. Nothing else.** Do NOT send email, change a
  calendar event, move a card, or message the user — external actions are for the planner to
  PROPOSE, not for this to perform.
- **Ground everything in a verified source.** Never invent an entity, project, or task from a
  reflect thread's name — if it isn't in curated memory or a live source, it does not exist.
- **Silent.** No summary to the user; the output is the refreshed memory + `CONTEXT_BRIEF.md`.
