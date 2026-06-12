---
name: gsheets
description: How to use the Google Sheets MCP — search Drive for sheets, read ranges or whole tabs, append rows, update cells, create new spreadsheets. Triggers on phrases like "spreadsheet", "google sheet", "arkusz", "spreadsheet URL pasted in chat", "add a row to my tracker", "wyciągnij dane z arkusza", "stwórz arkusz". Reads always available; appends/updates/creates need the workspace write toggle.
requires: google-workspace
allowed-tools: mcp__gsheets__list_spreadsheets, mcp__gsheets__read_range, mcp__gsheets__read_sheet, mcp__gsheets__append_rows, mcp__gsheets__update_range, mcp__gsheets__create_spreadsheet
---

# Google Sheets Protocol

Sheets is where structured data lives — trackers, weekly logs, exports. When the user says "the tracker", "weekly numbers", or pastes a `docs.google.com/spreadsheets/d/<id>` URL, pull the actual cells instead of asking them to retype.

## Pre-flight

If `mcp__gsheets__*` tools aren't available, the integration isn't active. Tell the user to open **Integrations → Google Workspace**. If the refresh token is missing scopes, the refresh token may not include the `spreadsheets` scope — symptom is a 403 with "regenerate refresh token" hint. Tell them to **Remove → Activate** Google Workspace again, paste the full scope list shown in step 3.

## Resolving sheet references

User phrasing → tool:
1. **Pasted URL** — `docs.google.com/spreadsheets/d/<ID>/edit`. ID goes straight into any tool.
2. **By name** — `list_spreadsheets { query: "X" }`. Match on case-insensitive substring.
3. **No name given** — `list_spreadsheets {}` for most-recently-modified.

Multiple matches → list candidates with `modified_at` and ask. Zero matches → say so.

## Reading cells

Two paths:

- **`read_range`** when you know the A1 range — `Sheet1!A1:C10`, `'My Sheet'!A:B`, or `Sheet1` for the whole tab. Returns 2D array of values. Empty trailing cells are omitted by Google — don't assume rectangles.
- **`read_sheet`** when you want everything in one tab. Pass `sheet_name` (or omit for the first tab). Returns title + dimensions + 2D values.

For range strings: wrap names with spaces or punctuation in single quotes (`'Q1 2026 plan'!A1:D20`). Doubled `''` escapes a literal apostrophe.

`value_render` defaults to `FORMATTED_VALUE` (strings as the user sees). Use `UNFORMATTED_VALUE` if you need typed numbers/booleans for math, `FORMULA` to read formulas back as `=SUM(A:A)`.

## Appending rows

`append_rows { spreadsheet_id, range, values }` — `range` is usually just the sheet name (`Sheet1`); the API finds the existing data table and appends below its last row. Doesn't touch rows below the table because INSERT_ROWS mode is on.

`values` is a 2D array — outer = rows, inner = cells.

**Confirm before appending.** Sheets has no undo for API writes (the user has to use Ctrl+Z in the actual sheet, which they may not be in). Show what you're about to add and wait for "yes" / "ok" / "go ahead":

> Going to add this row to **Q1 Sales / Sheet1**:
> | 2026-05-08 | Acme Corp | 12 000 € | won |
> Confirm?

## Updating specific cells

`update_range { spreadsheet_id, range, values }` — `range` must be explicit (`Sheet1!B5:B5` for one cell, `Sheet1!A1:C3` for a 3×3 block). `values` dimensions must match the range.

Values use `USER_ENTERED` parsing — `=SUM(A:A)` becomes a formula, `2026-05-08` becomes a date, `42%` becomes a percentage. Pass strings.

**Confirm before overwriting.** Especially when replacing existing data — show the user what's being replaced.

## Creating a spreadsheet

`create_spreadsheet { title, sheet_names? }` — `sheet_names` is optional list of tab names. Default = single "Sheet1".

Confirm the title and tab list before creating. Once made, the sheet shows up in the user's Drive.

## Defensive defaults

- **Always confirm writes** (append, update, create) with the actual values you'll write. Read-only ops fire freely.
- **Never invent rows** — if the user said "add the figures from yesterday", verify the figures from another source (the conversation, another sheet) before writing. Don't guess.
- **Sheet name with spaces** → wrap in single quotes in A1 ranges. Most parse errors come from missing quotes.
- **Wrong scope?** Symptom is 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT. Tell the user to re-activate Google Workspace to refresh the token.
