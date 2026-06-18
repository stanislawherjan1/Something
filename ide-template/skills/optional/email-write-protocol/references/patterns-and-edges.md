# Email write — patterns, edge cases, audit trail

## Patterns

### "Reply to X"

1. `read_message` to fetch the original. Show user: from, subject, body (snippet if long, full if short).
2. Compose reply body in chat, **not in tool args yet**.
3. Show user: *"Replying to <from>, subject 'Re: ...', body below. Send? (yes/no)"*
4. On `yes` → call `reply` with the exact body.
5. After: confirm with `message_id` from the response.

### "Send to X"

1. Confirm recipient(s) explicitly. *"Sending to alice@acme.com — correct?"* If user gave just a first name, look up via `search` or ask for full address.
2. Compose subject + body in chat.
3. Show preview, ask for explicit confirmation.
4. Send. Echo `message_id`.

### "Forward to X"

1. `read_message` to verify which message — easy mistake to forward the wrong one.
2. Show the original + proposed `intro` text (if any) + recipient(s).
3. Confirm. Send.

### "Archive these" / "Mark these read"

For batch low-risk ops, list what's affected, single confirm at the top, then announce results:

> User: "ogarnij newsletter z dzisiaj"
> Bot: *"Found 4 newsletter messages from today. Mark them all read and archive? (yes/no)"*
> User: "tak"
> Bot: *"Done — 4 marked as read, 4 archived to All Mail."*

## Edge cases — bot must handle, not silently fail

- **Recipient typo or missing @** → halt, ask. *"'alice' isn't a full email address — should I use alice@acme.com?"*
- **Empty subject or body** → halt, ask. *"Subject is empty — what should it say?"*
- **Sender is one of the recipients** → flag. *"This goes back to your own address (you@acme.com is in `to`) — intended?"*
- **Body looks like template placeholder** (`{{name}}`, `[INSERT HERE]`, `TODO`) → halt. *"Body still has placeholders — fill them in before sending?"*
- **No SMTP credentials configured** for the account → tell the user explicitly, don't pretend the send happened. Suggest re-saving the IMAP password in Integrations.
- **Send fails (network / auth / rate limit)** → say so, do NOT log success in chat. Relay the error message verbatim from the tool response.

## Audit trail

Every successful write is appended to `~/project/.email-audit.jsonl`:

```json
{"ts":"2026-05-08T12:34:56Z","action":"send","account":"alex","to":["alice@acme.com"],"cc":[],"subject":"Q3 deck","snippet":"Hey Alice — here's the Q3 …","message_id":"<abc@…>"}
```

The user can grep this file any time to see what the bot did on their behalf. **Never tamper with this file** — it's append-only by design.

If the user asks "co wysłałem ostatnio" / "what mails went out today" — read `.email-audit.jsonl`, summarise. Don't speculate.

## Sending disabled — fall back to draft

The user controls outbound send via the **Permissions** accordion at the bottom of the Email modal. Default is **drafts-only**. When sending is off, `send_email` / `reply` / `forward` return:

> `sending is disabled for "<account>". Open Integrations → Email and switch "Allow bot to send" to Yes for this account, OR use create_draft to prepare a draft in your Drafts folder for manual review/send.`

When this happens, **don't try again** with the same tool — fall back to `create_draft` and tell the user:

> *"Sending is off for this account. I drafted the reply in your Drafts folder — open your mail client to review and send. (You can flip 'Allow bot to send' in Integrations → Email if you'd rather I send directly.)"*

`create_draft` mirrors the same fields plus an optional `in_reply_to_uid` for proper threading.
