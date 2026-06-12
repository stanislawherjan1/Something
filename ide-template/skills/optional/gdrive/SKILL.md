---
name: gdrive
description: How to use the Google Drive MCP — search files, list recent, download files, export Google-native files (Docs/Sheets/Slides) to PDF/DOCX/etc, upload files, move between folders, share with others, trash. Triggers on "drive", "find the file", "share this with X", "send me the PDF of the doc", "upload to Drive". Reads/downloads always; uploads/moves/shares/trash need the workspace write toggle.
requires: google-workspace
allowed-tools: mcp__gdrive__search_files, mcp__gdrive__list_recent, mcp__gdrive__get_file_metadata, mcp__gdrive__download_file, mcp__gdrive__export_doc_file, mcp__gdrive__upload_file, mcp__gdrive__move_file, mcp__gdrive__share_file, mcp__gdrive__trash_file
---

# Google Drive Protocol

Drive is the file system for everything that doesn't live in code. When the user says "find the contract", "send me the PDF of the brief", "upload this to the Q1 folder" — go to Drive, don't ask them to attach.

## Pre-flight

If `mcp__gdrive__*` aren't available, activate **Integrations → Google Workspace**.

## Searching

`search_files { q, limit? }` uses Drive's native query language. Common patterns:

- `name contains 'invoice'` — name match (case-insensitive substring)
- `mimeType = 'application/pdf'` — by type
- `'<folderId>' in parents` — files inside a folder
- `modifiedTime > '2026-05-01T00:00:00'` — recent
- combine with `and` / `or` / `not`

`trashed=false` is auto-appended. Always single-quote string literals in `q`.

For "show me my recent files" → `list_recent { limit }`.

## Getting metadata

`get_file_metadata { file_id }` — id, name, mime, size, parents, owner, url, modifiedTime, capabilities. Quick check before download/share/move to make sure you've got the right file.

## Downloading

Two paths depending on the file type:

- **Non-Google-native** (PDF, image, ZIP, DOCX uploaded as-is, etc.) → `download_file { file_id }`. Returns `{ local_path, name, mime_type, size }`. The bot can then `Read` the local path.
- **Google-native** (Docs/Sheets/Slides — `mimeType` starts with `application/vnd.google-apps.`) → `export_doc_file { file_id, mime_type }` with the target type:
  - Doc → `application/pdf`, `text/plain`, `text/markdown`, or DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
  - Sheet → `application/pdf`, `text/csv` (first tab only!), or XLSX
  - Slides → `application/pdf`, `text/plain`, or PPTX

`download_file` will refuse Google-native types with a clear hint pointing to `export_doc_file`. Trust it.

## Uploading

`upload_file { local_path, name?, parent_id?, mime_type? }` — local file → Drive. `name` defaults to basename; `parent_id` defaults to the user's "My Drive" root (omit for root); `mime_type` is inferred from extension if not provided.

**Confirm before uploading.** Show the user the resolved filename + destination folder:

> Going to upload **`/tmp/q1-report.pdf`** as **`Q1 Sales Report.pdf`** to folder **`Reports/2026/`** (id: 1ABC…).
> Confirm?

## Moving files

`move_file { file_id, new_parent_id }` — reads current parents, removes them, adds the new one.

If the user said "move X to Y" and Y is a folder name not an ID, search first to resolve, then confirm before moving.

## Sharing

`share_file { file_id, email, role?, send_notification? }` — `role` defaults to `writer`. `send_notification` defaults to **false** (silent share — no email to the recipient).

For "share with X" → confirm role explicitly:

> Going to share **`Q1 Sales Report.pdf`** with **anna@acme.com** as **writer** (no email notification). Confirm?

If the user expects an email to land in the recipient's inbox, pass `send_notification: true`.

## Trashing

`trash_file { file_id }` — soft delete, recoverable for ~30 days from Drive's Trash. There is no permanent-delete tool in this MCP by design (the rare case can be done from Drive's UI).

Always confirm before trashing.

## Defensive defaults

- **Confirm writes** (upload, move, share, trash) with the resolved name + target. Drive doesn't have undo for API ops.
- **Search before acting on a name** — "share the brief" → search to disambiguate, list candidates if multiple match, ask if zero.
- **Native vs uploaded** — get metadata first if unsure; the wrong tool returns a clear error but it's a wasted round trip.
- **`send_notification` defaults to false** — if the user expects an email, set it true.
- **CSV exports of Sheets** are first-tab only. Use XLSX if the deck has multiple tabs.
