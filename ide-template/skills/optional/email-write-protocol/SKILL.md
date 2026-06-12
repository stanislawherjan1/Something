---
name: email-write-protocol
requires: email-imap
description: How to send, reply, forward, archive, move, mark, or delete email on the user's behalf. Triggers on phrases like "send", "reply", "forward", "wyślij", "odpowiedz", "przekaż", "archive", "delete", "mark as read", or any request that mutates a mailbox. CRITICAL — every mutation requires explicit confirmation from the user before the tool fires. Read tools (`list_recent`, `search`, `read_message`, `download_attachment`) are NOT covered here and don't need confirmation. This skill governs only the write tools (`send_email`, `reply`, `forward`, `create_draft`, `archive`, `move`, `delete`, `mark_read`, `mark_unread`).
allowed-tools: mcp__email__list_accounts, mcp__email__list_recent, mcp__email__search, mcp__email__read_message, mcp__email__download_attachment, mcp__email__send_email, mcp__email__reply, mcp__email__forward, mcp__email__create_draft, mcp__email__mark_read, mcp__email__mark_unread, mcp__email__archive, mcp__email__move, mcp__email__delete
---

# Email Write Protocol

Sending mail on someone's behalf is high-stakes. A typo in a recipient field, a half-finished draft fired by mistake, an "archive" interpreted as "delete" — any of these damages trust faster than dozens of correct sends rebuild it. **The contract: read freely, but never mutate without explicit confirmation.**

## Pre-flight

If `mcp__email__list_accounts` returns no accounts, the integration isn't active. Tell the user: *"Open Integrations → Email (IMAP) and add the account whose mail I should reach."* Don't attempt sends.

If sending fails with `535` (auth), the app password no longer works for SMTP. Tell the user to regenerate the app password in their provider's settings — same password covers IMAP + SMTP, so re-pasting it in the Integrations form fixes both.

## Sending may be disabled

The user can switch outbound send off per account (Permissions accordion in the Email modal — default is **drafts-only**). When sending is off, write tools return a clear error and you should fall back to `create_draft` instead of retrying. Full error message + fallback wording → `references/patterns-and-edges.md` (sending-disabled section).

## The confirmation hierarchy

Different writes carry different risk. Confirm proportionately:

| Level | Tools | Why |
|---|---|---|
| **HARD** | `send_email`, `reply`, `forward` | Irreversible. Show full message, wait for explicit `yes/wyślij/send`, one send per yes. |
| **LIGHT-STRONG** | `delete` | Soft-delete (Trash, ~30d recoverable). |
| **LIGHT** | `archive`, `move` | Reversible, one-sentence confirm. |
| **SOFT** | `mark_read`, `mark_unread` | Cosmetic, announce-and-do, batchable. |
| **NONE** | `create_draft` | Never leaves the server; user reviews in mail client. |

Full rules for each level (exact wording, what to surface, anti-batch-send protection for HARD, reply-all recipient surfacing) → `references/confirmation-hierarchy.md`.

## Patterns

Reply / Send / Forward / batch low-risk ops — each has a step-by-step flow in `references/patterns-and-edges.md` (patterns section).

## Edge cases

Recipient typos, empty subject/body, sender == recipient, placeholder tokens in body, no SMTP creds, send failures — handling rules in `references/patterns-and-edges.md` (edge cases section). Bot must handle each, not silently fail.

## Audit trail

Every successful write is appended to `~/project/.email-audit.jsonl`. User can grep it any time. **Never tamper.** Shape + how to use when user asks "co wysłałem dzisiaj" → `references/patterns-and-edges.md` (audit trail section).

## What this skill does NOT cover

- **Reading mail** (`list_recent`, `search`, `read_message`, `download_attachment`) — read tools are unrestricted. No confirmation needed. Use freely.
- **Permanent delete** — there is no `permanent_delete` tool. Delete is always recoverable. If the user demands true erasure, tell them to do it from their mail client (Gmail Trash → "Delete forever") — outside the bot's reach by design.

## When the user says "wyślij" with full intent

The bot doesn't need to be paranoid about every step. If the user has clearly authored the email themselves and asks "wyślij to do X", you can preview once and send. The point: **the user must be the one making the send decision** — not the bot inferring it from a vague directive.
