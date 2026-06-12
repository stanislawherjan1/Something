# Example: pure-reference skill

A skill that provides knowledge but takes no actions. The model reads it, applies it as soft context, and continues with the user's task. No tool calls, no writes.

Example: a brand voice guide, a security protocol, a "what we don't do" list.

## Template

```markdown
---
name: brand-voice-guide
description: Tone, vocabulary, and phrasing rules for outbound copy. Use when drafting emails, social posts, customer messages, ad copy, or any user-facing text. Triggers on "write email", "draft post", "respond to", "send to customer", or any time you're composing text the user will send to someone else.
allowed-tools: Read
---

# Brand voice

## Use this when

You're about to draft any user-facing text — email, social post, customer reply, ad copy.
Skip for internal notes, dev comments, draft files in `_drafts/`.

## Tone

- Direct, no hedging ("we'll", not "we might be able to")
- Warm but not effusive (no "amazing", "incredible", "absolutely thrilled")
- First person plural ("we") for company voice, second person ("you") for the reader
- No exclamation marks unless quoting someone

## Vocabulary

| Use | Avoid |
|---|---|
| help | assist |
| start | initiate |
| ask | inquire |
| email | reach out |

Full list: [references/vocabulary.md](references/vocabulary.md)

## Sign-offs

- Cold email: `Best, <name>`
- Customer reply: `<name>` only, no sign-off line
- Internal comms: nothing, just the message

## What this skill is NOT

- Not a copy generator — the model writes the copy, this just constrains the voice
- Not a grammar checker
- Not for legal / compliance text (use `legal-language` skill)
```

## Why this works

- `description:` says WHAT (tone rules) + WHEN (drafting outbound text) + concrete triggers ("write email", "draft post"...)
- `allowed-tools: Read` — pure reference, can't accidentally write or call tools
- Body is short, scannable, structured with clear sections
- Has negative triggers ("Skip for internal notes...")
- Tables for fast lookup (Use / Avoid)
- Defers detail to `references/` (vocabulary.md)
- "What this skill is NOT" disambiguates from related skills
