---
name: trello
description: How to read, comment on, label, and move Trello cards through the trello-mcp tools. Triggers on phrases like "trello", "card", "board", "move to done", "add label", "what's on the board", "co jest na boardzie", "przenieś do done", "skomentuj kartę". Discovers boards and columns before acting, prefers the default board, confirms before destructive moves.
requires: trello
allowed-tools: mcp__trello__list_boards, mcp__trello__list_lists, mcp__trello__list_cards, mcp__trello__get_card, mcp__trello__add_comment, mcp__trello__add_label, mcp__trello__remove_label, mcp__trello__move_card
---

# Trello Protocol

Working with Trello means three nested concepts: **board → list (column) → card (task)**. Every action eventually targets a card, but to find the card you usually need to know the board and the column first. The MCP tools mirror that shape.

## Pre-flight — is Trello available?

If the user is asking about Trello and the tools aren't there, the integration isn't active. Tell them to open **Integrations → Trello** in the workspace, paste API key + token, save. Don't fake the answer.

## Default boards (named map)

`TRELLO_BOARDS` accepts either a single bare ID or `name:id,name:id` pairs. Tools that take `board_id` accept either a 24-char hex ID or one of those friendly names (case-insensitive).

- One board configured → tools auto-fill it when `board_id` is omitted.
- Multiple → you must pass `board_id` (use the friendly name, not the hex).
- Unknown name → the tool errors with the list of configured names. Surface that to the user, don't guess.

Always start with `list_boards` if the user references a board you don't recognise — the configured map covers their defaults, but they may have access to others.

## The standard read flow

User asks "what's on the board?" / "co tam wisi?" / "show me cards":

1. `list_lists` — get column names + ids on the default board (or one the user named).
2. `list_cards { list_id }` — for each column the user cares about, or just the active ones.
3. Format reply per column: name + due date + labels. Don't dump full descriptions unless asked — call `get_card` only when the user wants details on a specific card.

## Commenting

`add_comment { card_id, text }` posts as the token owner. Markdown works. Keep comments concise — long bot-generated essays in Trello are noise. If the user wrote the comment text themselves, post verbatim; if you wrote it, read it back to them first if it's longer than a sentence.

## Labels (= "tags")

`add_label { card_id, label_name }` is idempotent and creates the label on the board if it's missing. Pass `color` only when creating a new one (yellow / purple / blue / red / green / orange / black / sky / pink / lime / null). Once created, the color sticks — don't pass it on subsequent calls.

`remove_label { card_id, label_name }` is also idempotent — silently no-ops if the card doesn't have that label.

## Moving cards between columns

`move_card { card_id, list_name }` moves to a column on the same board (default board unless `board_id` is passed). The match is case-insensitive on the column name.

**Confirm before moving** when the move is destructive in the user's workflow:
- Anything → "Done" / "Archive" / "Closed" — confirm.
- Anything → "Backlog" / "On hold" — confirm.
- Within active columns (Todo → In progress, In review → Approved) — just move, then report.

If the column name doesn't exist, the tool errors with the list of available columns. Surface that list to the user verbatim and ask which they meant — don't guess.

## Resolving cards from user phrasing

The user usually says "the X card" or "ta karta o Y" — not the id. To resolve:

1. If they're working with the default board, `list_lists` → `list_cards` over the active columns, scan names.
2. Match by case-insensitive substring on `name`. If exactly one match — use it. If multiple — list them and ask. If zero — say so, don't fabricate.

## Don't

- Don't enumerate every card on a 200-card board. Filter by column or substring first.
- Don't auto-archive (`closed: true` on a card) — there's no tool for that on purpose. Archiving is a human decision.
- Don't post comments on every action. Moving a card already shows up in the activity feed; an extra comment "Moved to Done by bot" is noise.
- Don't assume the default board if the user named another one. Always honour an explicit `board_id` over the default.
- Don't paste raw 24-char hex IDs back to the user — refer to boards by their configured friendly names. If a board isn't in `TRELLO_BOARDS`, use the human name from `list_boards`, not the ID.
