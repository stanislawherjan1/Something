# SignWell — status polling, completion, listing

## Follow-up reminder shape

After a successful `send_document`, schedule a 24-hour check:

```python
mcp__reminders__set_reminder(
    message=f"[SIGNWELL_FOLLOWUP_{document_id}] Check signature status. If pending and >48h, nudge non-signers via send_reminder.",
    due="in 24 hours",
    repeat="none",
)
```

Capture the reminder ID in your session journal.

## When the trigger fires

Look for `[SIGNWELL_FOLLOWUP_<document_id>]` in chat (injected by reminder-monitor).

1. Call `mcp__signwell__get_document({ document_id })`.
2. Branch on `status`:

| Status | Action |
|---|---|
| `completed` | Go to "Fetch + file" below |
| `pending`, age >48h | `mcp__signwell__send_reminder({ document_id })` to nudge non-signers, schedule another 24h follow-up |
| `pending`, age <48h | Schedule another 24h follow-up, no nudge yet |
| `declined` | Surface to user, ask whether to re-send (different doc?) or drop. **Never auto-resend.** |
| `expired` | Surface to user, ask whether to re-create |
| `draft` | Something went wrong with `send_now`; surface and offer to send again |

3. Send a one-line Telegram update. Don't spam — only when status changed since last check.

## Completed — fetch + file

```python
mcp__signwell__get_completed_pdf({ document_id })
```

Returns the signed PDF as base64. Decode and save. **Use the file-placement skill** to pick the destination — typically `Operations/Legal/` or wherever `CLAUDE.md` "Where to Save" maps signed legal docs.

Filename convention:

```
<original-name>-SIGNED-YYYY-MM-DD.pdf
```

Final Telegram update:

```
Signed ✓ <subject> — all parties signed.
Filed at: <relative path>
```

Cancel the follow-up reminder for this document — it's no longer needed.

## Listing existing documents

When user asks "what's outstanding?" / "co czeka na podpis?":

```python
mcp__signwell__list_documents({ status: "pending" })
```

Format as a short list with status + age + last action. Offer `send_reminder` for anything >48h old.

## Pre-flight check (before sending)

Verify the SignWell MCP is actually wired in:

```bash
python3 -c "
import json
with open('/home/coder/.claude.json') as f: d = json.load(f)
print('signwell active' if 'signwell' in d.get('mcpServers',{}) else 'NOT ACTIVE')
"
```

If NOT ACTIVE, tell the user to activate via Integrations dashboard and stop. **Don't fake the send.**

## API quirks worth knowing

- **`send_email: false` in the response** — when `send_now: true` at the document level, SignWell sends signing invitations regardless of the per-recipient `send_email` field. That field is for per-recipient suppression, not the default.
- **Error: "There aren't fields in the document" + "isn't draft"** — this is NOT a draft-state problem; the tags didn't embed. Fix the PDF (see `reportlab-tags.md`), regenerate, retry.
- **Anchored fields** — SignWell supports `anchor` strings per recipient as an alternative to text tags. Use when the PDF has natural anchor phrases ("Client signs here") and you can't embed tags. Default is text-tag mode.
