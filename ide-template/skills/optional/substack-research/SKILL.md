---
name: substack-research
description: Find and research things on Substack — a publication's recent posts, an author and what they write, their recent Notes, comments on a post, or the gist of a specific URL. Triggers when the user asks to "what's <author> writing on Substack", "research the <publication> newsletter", "find Substack posts about X", "summarise <author>'s recent posts", "monitor <publication>", "co piszą o X na Substacku". Substack has no search API, so for open-ended topics it surfaces candidate URLs via a web-search integration, then reads them with the Substack tools.
allowed-tools: Read, mcp__substack__read_publication_archive, mcp__substack__read_post, mcp__substack__get_author, mcp__substack__list_recent_notes, mcp__substack__list_comments
requires: substack
---

# Research & find things on Substack

This integration is **read-only** — read public posts, archives, authors,
Notes, and comments. There is no publishing or commenting.

## When this applies

✅ "What's Noah Smith writing on Substack lately?"
✅ "Research the Stratechery newsletter / summarise its last 5 posts"
✅ "Find Substack posts about <topic>"
✅ "What are people saying about <author>'s latest post?"
✅ "Monitor <publication> and tell me when something relevant drops"
❌ Publish / comment / restack — not supported (read-only).

## The one constraint: there is no search API

You **cannot** query "posts about X" directly. Two paths:

- **You know the publication or author** → go straight to the tools below.
- **Open-ended topic** → use whatever **web-search integration is active**
  (e.g. Grok web/x_search, Gemini, or a web-fetch tool) to surface candidate
  Substack URLs (`site:substack.com <topic>`), **then** read them with the
  Substack tools. Never invent or guess URLs — read only ones you found.

  If no web-search integration is active, say so: you can still work from any
  publication or author the user names, but not from a bare topic.

## Recipes

**Catch up on a publication** — `read_publication_archive(publication)` →
skim titles/subtitles → `read_post(url)` only the ones that matter → synthesise.
`publication` accepts a slug (`noahpinion`), custom domain (`noahpinion.blog`),
or full URL.

**Profile an author** — `get_author(handle)` for bio + the publications they
write for + external links. `list_recent_notes(handle)` for their short takes.
Then `read_publication_archive` on their main publication for long-form.

**Find posts about a topic** — discover URLs via the active web-search tool →
`read_post` each promising one → synthesise, always citing the `canonical_url`.

**Gauge a post's reception** — `list_comments(url)` plus the reaction/comment
counts that come back on the archive entries.

## Output

- **Quick ask** → a short summary in chat with links. No files.
- **"Research / monitor" ask** → write a markdown digest. Use the
  **file-placement skill** to choose where (default `Research/Substack/<publication-or-topic>/`).
  The digest itself is the durable record: keeping it on disk (one file per
  publication or topic) is what lets a future session rediscover prior research
  with `memory_grep` or the INDEX map — no separate memory write needed.

## Edge cases

- **Paid / subscriber-only post** → `read_post` returns `truncated: true` and a
  note. Report that only public content is available; never fabricate the body.
- **Custom-domain publication** (e.g. `noahpinion.blog`) → may be blocked by
  egress (only `*.substack.com` is reachable through the proxy). If a read
  fails, try the publication's `*.substack.com` address, or note the limit.
- **Handle not found** → `get_author` errors. Check spelling — it's the handle,
  not the display name (e.g. `noahpinion`, not "Noah Smith").
