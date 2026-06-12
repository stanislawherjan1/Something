---
name: signwell-protocol
description: How to send a document for e-signature, track its status, and file the signed PDF. Triggers on phrases like "send for signature", "send to sign", "wyślij do podpisu", "do podpisania", "umowa do podpisu", "e-signature", "let them sign". Use the SignWell MCP tools (`mcp__signwell__*`); pre-flight checks the integration is active, walks the user through recipients + email content + tag placement, asks for explicit confirmation before sending, then schedules a status follow-up and files the signed PDF when complete.
requires: signwell
allowed-tools: Read, Bash, Write, Edit, mcp__signwell__send_document, mcp__signwell__get_document, mcp__signwell__list_documents, mcp__signwell__send_reminder, mcp__signwell__get_completed_pdf, mcp__reminders__set_reminder
---

# SignWell Protocol

Sending a document for e-signature is a high-stakes operation. A typo in an email sends a contract to the wrong person; the wrong PDF binds the wrong terms. This skill enforces a confirm-before-send pattern AND handles the SignWell-specific gotchas (text-tag embedding, ReportLab pitfalls, status polling, signed-PDF retrieval, filing).

## Pre-flight

Check the integration is active before doing anything else — exact command in `references/status-flow.md` (pre-flight check section). If NOT ACTIVE: tell the user to activate via Integrations dashboard and stop. Don't fake the send.

## Step 1 — gather inputs

You need:

1. **The PDF** — absolute path. If user didn't supply, ask. Verify with `test -s "$PDF_PATH" && echo OK || echo MISSING`.
2. **Recipients** — list of `{id, name, email}`. The **`id`** is a stable string ("1", "2", …) that ties each recipient to a signature field tag. Numbering must match your `{{signature:N:y}}` tags later.
3. **Email subject + body** — what recipients see in their inbox. **Never autofill these** — see Step 4.
4. **Send mode** — immediate (`send_now: true` with text tags) or draft (`send_now: false`, manually place fields in editor).

## Step 2 — does the PDF have signature fields?

SignWell rejects documents without fields. Two ways to add them:

**A. Manual via SignWell editor** (`send_now: false`)
- Create draft → SignWell returns `editor_url`
- User opens it, places fields by hand, then clicks Send in SignWell UI
- Use this for PDFs the user uploaded from outside

**B. Automatic via text tags** (`send_now: true`, `text_tags: true`)
- Embed tags directly in the PDF: `{{signature:1:y}}`, `{{signature:2:y}}`, etc.
- Tag number must match recipient `id`
- Use this for documents WE generate

Default: B for our docs, A for third-party PDFs.

## Step 3 — embedding text tags (the ReportLab gotcha)

If you're generating the PDF with **ReportLab**, the default `Paragraph` swallows `{}` and tags vanish. Use the `RawText` Flowable + verify with `pdfminer.extract_text` before sending — full pattern, tag syntax, and the "do NOT byte-grep PDFs" warning → `references/reportlab-tags.md`.

## Step 4 — confirm email content with the user

`subject` and `message` are what recipients see. **Always ask** what to write AND in **what language** (match the recipient, not the workspace).

> Jaki temat i treść maila ma dostać `<recipient name>`? W jakim języku?
> What should the subject line say to `<recipient>`? Plain English request, formal, or brief context?

Wait for explicit answer. Don't auto-translate or auto-paraphrase what the user said earlier — the email is permanent, paste exactly what they approve.

## Step 5 — confirm everything before send

Single message, scannable in 5 seconds:

```
Sending for signature — confirm?

File:          <relative path>
Email subject: <approved subject>
Email body:    <first 80 chars of approved message>...
Tags found:    {{signature:1:y}}, {{signature:2:y}}  (verified via pdfminer)
Recipients:
  • id=1  <Name>  <email1>
  • id=2  <Name>  <email2>
Reminders:     on (auto-nudge days 3, 6, 10)
Expires:       30 days

Reply "send" to confirm, "edit X" to change one field, or "cancel".
```

Wait for explicit "send" / "yes" / "ok wyślij". Don't accept ambiguity. Same rule on Telegram — signature requests are too expensive to misfire.

## Step 6 — send

```python
mcp__signwell__send_document(
    name="<document display name>",
    file_name="<filename>.pdf",
    file_base64="<base64-encoded PDF>",
    recipients=[
        {"id": "1", "name": "...", "email": "..."},
        {"id": "2", "name": "...", "email": "..."},
    ],
    subject="<exact subject from user>",
    message="<exact body from user>",
    text_tags=True,           # SignWell parses {{signature:N:y}} from PDF
    send_now=True,            # send immediately, no editor step
    reminders=True,           # auto-nudge on days 3, 6, 10
    expires_in=30,
)
```

API error quirks (e.g. "There aren't fields" actually means tag-embedding failed, not draft state) → `references/status-flow.md` (API quirks section).

On success, capture `document_id` and tell the user:

```
Sent ✓ Document ID: <id>
Tracking: https://www.signwell.com/app/document/<id>
SignWell will auto-remind unsigned recipients on days 3/6/10. I'll also check status in 24h.
```

## Step 7 — schedule follow-up + handle the trigger

Schedule a 24h reminder with the trigger token `[SIGNWELL_FOLLOWUP_<document_id>]`. When the trigger fires, branch on the document status (completed / pending / declined / expired / draft) and fetch + file the signed PDF on completion — full flow + reminder shape + filename convention → `references/status-flow.md`.

## Listing existing documents

When user asks "what's outstanding?" / "co czeka na podpis?" → `mcp__signwell__list_documents({ status: "pending" })`. Format guidance + when to offer `send_reminder` → `references/status-flow.md` (listing section).

## What NOT to do

- **Never call `send_document` without explicit "send" confirmation.** A typo in recipients is a real-world incident.
- **Never autofill `subject` or `message`** — always confirm exact text + language.
- **Don't auto-resend on `declined`** — find out why first.
- **Don't grep raw PDF bytes for tags** — PDF encodes text, not ASCII. Use pdfminer / pymupdf.
- **Don't use `Paragraph` for tag-bearing rows in ReportLab** — use `RawText`.
- **Don't fetch the signed PDF and email it yourself** — SignWell already mails the executed copy on completion.
- **Don't skip the follow-up reminder** — un-chased requests are the second-most-common stall reason after typos.

## Edge cases

- **Self-signing** — recipient is the user. Same flow, no follow-up reminder needed (self-sign is usually instant).
- **>5 recipients** — show the full list in confirmation. A 10-person doc with one wrong email is impossible to spot in a summary.
- **Document already in flight** — before sending, optionally `list_documents` and check no pending doc with same subject + first recipient already exists. Ask: re-send or duplicate skip?
- **Anchored fields** as alternative to text tags → see `references/status-flow.md`.

## Pre-flight checklist (before every send)

- [ ] PDF exists and isn't empty
- [ ] Tags embedded as `{{signature:N:y}}` via `RawText` Flowable (NOT `Paragraph`)
- [ ] Tags verified via `pdfminer.extract_text` assert (NOT raw byte grep)
- [ ] `text_tags: true` in the API call
- [ ] `subject` + `message` filled with text the user approved verbatim
- [ ] `recipients` array — `id` values match the tag numbers exactly
- [ ] Confirmation message shown to user, explicit "send" received
- [ ] `send_now: true` for fully automated, or `false` to review in editor first
