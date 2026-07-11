---
name: research-twitter-account
description: Research a Twitter/X account and the network around it. Triggers when the user asks to "research @handle", "analyze the X account", "kogo obserwują w sektorze X", "find similar accounts to @handle", "build a profile for @handle". Queries Grok for similar accounts the target frequently interacts with, then drafts a folder of bio + posting-style profiles for each.
allowed-tools: Read, Bash, Write, mcp__grok__ask_grok
---

# Research a Twitter Account

## When this skill applies

✅ "Research @vitalikbuterin"
✅ "Find similar accounts to @username"
✅ "Build a community map around @handle"
✅ "Who does @account interact with most?"
✅ "Sektor X — kto najwięcej dyskutuje?"

❌ User wants to read tweets from one specific account → use ask-grok directly
❌ User wants live trending — that's `mcp__grok__ask_grok` with `x_search: true`, no folder structure needed

## Step 1 — confirm scope

If the user said only `@handle`, confirm in one short message:

> Research @handle — should I build the full profile pack (10 similar accounts, bios, posting styles) or just pull a quick list of who they interact with?

Defaults when user said "research" without elaboration: full pack, 10 accounts. For "quick list" or "who do they follow" — just Step 2 + a short summary, skip the file output.

## Step 2 — query Grok for similar accounts

Use the **similar-accounts** template in `references/grok-queries.md`. Includes broaden-on-thin-results rule + below-5-handle abort path.

## Step 3 — choose where to save

Use the **file-placement skill** to pick the destination root. Default mapping (when `CLAUDE.md` "Where to Save" doesn't override): `Research/Twitter/<handle>/`. If `Research/` doesn't exist yet, file-placement will propose creating one — accept.

Full folder layout + filename rules (handle subfolders carry the `@` prefix) → `references/output-shape.md`.

## Step 4 — write target-accounts.md

Template + sections (similar accounts table, adjacent accounts, notes) → `references/output-shape.md`.

## Step 5 — generate bio + post-style per account

For each of the 10 accounts, run TWO Grok queries — **bio** and **post-style** — in parallel where possible to save wall-time. Both templates + per-file save targets → `references/grok-queries.md`.

## Step 6 — leave a discoverable pointer

Record a concept page (`memory/concepts/twitter-research-<handle>.md`) so future sessions can find the research via `memory_grep` or the INDEX map. Writing the page auto-triggers the INDEX rebuild — no separate step. Page shape → `references/output-shape.md`.

## Step 7 — summary to user

Telegram-ready summary template → `references/output-shape.md`.

## Edge cases

- **Account is private / suspended** — Grok will say so. Don't fabricate; report and ask if the user wants to research an alternative.
- **Handle doesn't exist** — Grok returns "no account found". Ask the user to double-check spelling or pick a similar handle.
- **Handle is high-signal but recent (< 6 months on X)** — bios will be thinner. Note this in the bio.md ("Account active since <date>; profile based on limited public history").
- **More than 10 accounts genuinely fit** — write 12–15. The "10" is a sane default, not a ceiling. Just keep target-accounts.md scannable.
- **User wants this for a non-X platform** (Bluesky, Threads) — Grok x_search only covers X. Tell the user, suggest using the search-the-web variant of ask-grok for adjacent platforms, or fall back to Playwright for direct browsing.
