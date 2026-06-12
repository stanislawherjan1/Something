---
name: gdocs
description: How to use the Google Docs MCP — search Drive, read doc bodies, create new docs, append text, find/replace. Triggers on phrases like "google docs", "the doc", "moje docsy", "summarise the meeting notes", "draft a doc", "stwórz dokument", a docs.google.com URL pasted in chat. Read-mostly by default; create/append/replace require explicit user intent.
requires: google-workspace
allowed-tools: mcp__gdocs__search_docs, mcp__gdocs__list_recent_docs, mcp__gdocs__read_doc, mcp__gdocs__create_doc, mcp__gdocs__append_to_doc, mcp__gdocs__replace_in_doc
---

# Google Docs Protocol

Google Docs is where the user keeps prose: meeting notes, briefs, plans, drafts. When they reference "the brief", "Monday's notes", or paste a docs.google.com URL — pull the actual content instead of asking them to paraphrase.

## Pre-flight — is Google Docs available?

If the tools aren't there, the integration isn't active. Tell the user to open **Integrations → Google Docs** in the workspace, paste OAuth client ID + secret + refresh token (steps in the integration walkthrough), save. Don't fake the answer.

## Resolving doc references from user phrasing

The user usually says "the X doc" or "the Y notes" — not the doc ID. To resolve:

1. **Pasted URL** — `docs.google.com/document/d/<ID>/edit`. The 44-char `<ID>` goes straight into `read_doc`.
2. **By name** — call `search_docs { query: "X" }` first. Match by case-insensitive substring on `name`.
3. **"My recent docs"** — `list_recent_docs` for chronological view across all of Drive.

If exactly one match, use it. If multiple, list the candidates with their `modified_at` and ask. Zero matches → say so, don't fabricate.

## Reading

`read_doc { doc_id }` returns plaintext body + title + URL + character count. Use it to answer "what's in the X doc?" — but **summarise**. Don't dump 2000 words back to chat verbatim. The user wants a takeaway, not a copy-paste.

For long docs, surface: title, key points, action items, a few quotes if needed.

## Creating

`create_doc { title, content? }` makes a new doc owned by the authenticated user. Confirm the title before creating — once made, it's a real doc that shows up in their Drive.

If the user says "draft a X doc" and you don't have the body yet, draft it in chat first, get their sign-off, THEN create.

## Appending

`append_to_doc { doc_id, text }` adds at the end. A leading newline is added automatically when the doc isn't empty.

Common pattern: meeting note dumps. User says "add my standup notes to the team doc" → `search_docs` → `read_doc` to confirm it's the right one → `append_to_doc` with formatted notes (date heading + bullets).

## Find / replace

`replace_in_doc { doc_id, find, replace, match_case? }` replaces every occurrence. Idempotent: returns 0 occurrences if `find` isn't there. Confirm before destructive replacements ("rename Project Alpha → Project Beta everywhere?").

## Don't

- Don't `list_recent_docs` if the user named a specific doc — search instead.
- Don't paste raw doc bodies into Telegram; summarise.
- Don't auto-create docs without explicit user intent. "Note this" usually means append to an existing notes doc, not spawn a new file.
- Don't replace text without showing the user the find/replace pair first when it's more than a few characters.
