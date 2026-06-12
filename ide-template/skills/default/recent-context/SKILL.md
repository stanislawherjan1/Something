---
name: recent-context
description: Look up older conversation context the user is referring to. Use when the user mentions an earlier message, decision, or topic ("o czym mówiłem wczoraj", "tamta rozmowa o X", "what did we say earlier", "remember when…", "co ostatnio ustaliliśmy", "the thing from before") AND your cached prefix's RECENT_WEB / RECENT_TELEGRAM block doesn't contain it. The Telegram channel's prefix is static from tmux startup — anything posted after that is missing until the bot restarts; this skill bridges that gap by reading the live snapshot from disk.
allowed-tools: mcp__workspace-api__recent_messages, mcp__workspace-api__memory_grep, Read
---

# Recent context — bridging the stale-prefix gap

## When to invoke

User references something from an earlier conversation **and** you don't see it in your prefix's `RECENT_WEB` / `RECENT_TELEGRAM` block. Trigger phrases:

- "o czym mówiłem", "co wczoraj ustaliliśmy", "tamta rozmowa o…"
- "what did we say earlier", "remember when…", "the thing we discussed"
- "co ostatnio", "wcześniej pytałeś"
- Numbers, names, references that you can't ground in your current context

> **Don't invoke for things in your prefix.** If the answer is already in your `RECENT_*` block, just answer. This skill is the fallback when prefix is stale.

## When NOT to invoke

- The reference is to something in the current turn or current session — your in-process conversation history has it.
- The user is asking about a stable fact (their role, preferences, a person) — that's `USER_PROFILE` / `USER_PREFERENCES` / `USER_RELATIONSHIPS` territory.
- The user is asking about an old project or topic — that's a `topics/<slug>.md` lookup, not a transcript lookup.

## How

### Step 1 — Identify channel

You're answering on Telegram → look up `channel: "telegram"`. You're answering on web → look up `channel: "web"`. If the user explicitly says "on Telegram you told me…" while you're on web, look up `"telegram"`.

### Step 2 — Call the tool

```
mcp__workspace-api__recent_messages({
  channel: "telegram",     // or "web"
  limit: 50                // optional; default is full file. Use 30–50 for typical questions, 100+ for "show me everything from yesterday"
})
```

The response includes `snapshot_age_seconds` so you know how fresh the file is. If it's been ≥10 minutes since the last refresh, the very latest messages may not be there yet either — say so honestly ("snapshot is ~12 minutes old, latest messages may not be included") rather than claim certainty.

### Step 3 — Cross-reference if needed

If the user is searching for a specific term and you're not sure which channel: also call `memory_grep` with the term across all memory cards.

### Step 4 — Answer with the citation

Tell the user when the reference is from. Don't recite the snapshot back at them — quote or summarize the relevant exchange and tie it to their question. If you couldn't find it after looking, say so plainly ("no match for X in last 50 Telegram messages or memory grep") and ask them to clarify.

## Worked example

User on Telegram: "wracając do tego co ustaliliśmy z fakturą Hetzner, jakie były końcowe ustalenia?"

Your prefix `RECENT_TELEGRAM` has no Hetzner mention (snapshot from tmux startup, conversation about Hetzner happened after). You:

1. Call `mcp__workspace-api__recent_messages({channel:"telegram", limit:80})`.
2. See messages about Hetzner invoice from earlier today — find the decision ("systemowa, nic do roboty").
3. Reply: "Ustaliliśmy że Hetzner to systemowa faktura — nic nie trzeba robić, idzie automatem."

## Don't do this

- ❌ Don't say "nie mam dostępu do starych wiadomości" without trying the tool. The `verify-denials` Stop hook will block that response anyway.
- ❌ Don't dump the entire raw snapshot into the response. Summarize, quote 1–2 relevant lines max.
- ❌ Don't call this every turn. Only when there's a real reference to bridged-gap context. Most turns don't need it.
- ❌ Don't use this for "what's my name" / "where do I live" type questions — those are stable facts in cards.
