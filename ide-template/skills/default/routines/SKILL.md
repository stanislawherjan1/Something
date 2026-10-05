---
name: routines
description: Use this when the person talks about something they'd like taken care of regularly ("every morning tell me…", "keep an eye on…", "every Friday send me…"), asks what you can do on your own, has just connected an integration, or wants a routine added, changed or removed. Knows every ready-made routine in the Marketplace (references/catalog.md) and adds one with add_routine once they say yes.
allowed-tools: Read, mcp__workspace-api__add_routine, mcp__workspace-api__memory_write, mcp__workspace-api__memory_now
---

# Routines

A routine is **your** standing duty to this person — something you do on your own,
on a cadence or when a condition is met. It is never a reminder for them. Their
routines are in the `ROUTINES` block of your context (on Telegram that copy can be
days old, so check `memory_now` for the current list); the morning planner turns
them into the day's work at 06:00 in their time zone, and right away whenever one is
added or changed.

The Marketplace has ready-made ones, each written as a full instruction that names
its sources. The whole list, with ids and what each needs, is in
[references/catalog.md](references/catalog.md) — read it before suggesting one.

## When to suggest one

Suggest a Marketplace routine when it clearly fits what the person just said or did:

- they describe a recurring need ("I always forget birthdays", "what's the weather
  going to be") — and a routine does exactly that;
- they connected an integration — mention the one or two routines it unlocks;
- they ask what you can do on your own, or seem unsure how you could help.

Not when: they already have it (check `ROUTINES`, or `memory_now` on Telegram — the prefix may be stale), it doesn't match what they said,
you suggested something in this conversation already and they let it pass, or the
conversation is in a group.

## How to suggest

Like a colleague, in your normal reply, in their language — one routine, one or two
sentences: what you'd do, how often, and that you'd stay quiet when there's nothing
worth saying. Then let them answer. No lists of options, no buttons, no "reply 1/2/3".

> "I can check the forecast for Lisbon every morning at 7 and tell you in two
> lines — only a line on a boring day. Want that?"

If it **needs** an integration that isn't connected, say which one and that they can
connect it under Integrations; offer to add it once it is.

## Adding it

Only after a clear yes: call `add_routine` with the id from the catalog, then run the
`morning-planner` skill in the same turn so it is planned now, not from tomorrow. Then
confirm in one line, saying when it first runs. If it was
refused because an integration isn't connected, tell them which. Adding one they
already have changes nothing — just say they have it.

The person can also add it themselves: Routines → Marketplace → Add.

## Their own routines, changes and removals

- **A routine that isn't in the Marketplace** — write it with `memory_write`
  (`card: RESPONSIBILITIES`) as `{bell} **Short title** — what to do and how often #tag` —
  the icon is a name in braces (`{mail}`, `{calendar}`, `{book}`, `{bell}`…) or an emoji, or leave it out.
  Make it concrete like the catalog's: which source you read (tasks board, mailbox
  tools, calendar, web search), how often, and when it's worth telling them. Tag it
  with the integration's id when it uses one (`#shopify`), so it shows that logo.
- **Change one** (theirs or a Marketplace one) — `memory_write` with
  `op: supersede`, `match:` its title, and the whole routine again in the same form.
- **Stop one** — `memory_write` with `op: retire` and `match:` its title.

After any of these writes, run the `morning-planner` skill in the same turn, so today's
plan matches what they have now.

They can do all of this on the Routines screen too (Add routine, Edit, Delete).

## Web-based routines

Routines that search the web (weather, news, facts, events) use Parallel's tools
when it's connected — better results — and otherwise your built-in web search.
Never invent a result: if a search finds nothing current and real, send nothing.
