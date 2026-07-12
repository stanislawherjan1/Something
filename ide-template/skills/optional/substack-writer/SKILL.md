---
name: substack-writer
description: Write, edit, and (when allowed) publish on the owner's own Substack — draft a newsletter post, revise a draft, add a cover image, publish or schedule a post, or post a Note. Triggers on "draft a Substack post", "write a newsletter about X", "schedule my Substack post", "post a Note", "publish the draft", "put this on my Substack". Draft-first by default; publishing is gated behind an owner setting.
allowed-tools: Read, mcp__substack__whoami, mcp__substack__create_draft, mcp__substack__update_draft, mcp__substack__list_drafts, mcp__substack__get_draft, mcp__substack__delete_draft, mcp__substack__upload_image, mcp__substack__publish_draft, mcp__substack__schedule_draft, mcp__substack__unschedule_draft, mcp__substack__publish_note
requires: substack
---

# Write & publish on Substack

Compose and manage posts on the **owner's own** publication. These tools only
work when a session cookie is configured; if a call reports that sign-in is
needed, tell the user to paste their `substack.sid` cookie in the Substack
integration settings.

## Golden rule: draft first

**Default to `create_draft`.** A draft is private — it goes nowhere public and
emails no one. Prepare the post, share the editor URL, and let the human hit
Publish. Only `publish_draft` / `schedule_draft` / `publish_note` go live, and
they are refused unless the owner turned on **"Allow publishing"**. Never
publish or email subscribers unless the user explicitly asks for it in this
turn.

## Workflow

1. **Confirm the account** with `whoami` when unsure which publication you'd
   write to, or whether publishing is enabled. Report it back before writing.
2. **Draft** with `create_draft` (title required; `subtitle`, `body` optional).
   Body is plain text / light markdown — blank lines separate paragraphs.
   Return the `editor_url` so the user can review.
3. **Revise** with `update_draft` (pass only the fields that change). Iterate on
   copy in the draft; don't delete and recreate.
4. **Cover image**: `upload_image` (public URL or data URI) → take the returned
   `url` → pass it as `cover_image` to `create_draft` / `update_draft`.
5. **Go live only on request**:
   - `publish_draft` — makes it public now. `send_email` defaults to **false**
     (web-only). Set `send_email: true` **only** when the user says to email the
     list. This is irreversible from here; confirm intent first.
   - `schedule_draft` — publishes automatically at an ISO 8601 `post_date`. Use
     the user's timezone and state the resolved UTC time back to them.
   - `publish_note` — posts a short public Note immediately.

## Notes & limits

- If publishing is off, say so plainly and offer to leave a draft ready — don't
  imply it published.
- Substack's write API is unofficial and can change; if a write fails, report
  the exact error rather than retrying blindly.
- Egress only reaches `substack.com` / `*.substack.com`. Custom-domain
  publications may not be writable through the proxy — fall back to the
  `*.substack.com` address or note the limit.
- Keep drafts in the user's voice; don't invent facts, links, or quotes.
