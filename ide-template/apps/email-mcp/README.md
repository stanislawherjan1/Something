# email-mcp

Read-only multi-account IMAP MCP server. Backs Gmail (via App Passwords) and
any other IMAP host with the same code path. One process, N accounts; every
tool takes an `account` id, and `account: "*"` fans out across all accounts.

## Why this design

- **Read-only by exposure.** No `send`, `delete`, `flag`, or `move` tool exists
  in the source. The bot runs with `--dangerously-skip-permissions`, so every
  MCP tool runs without confirmation. Hard read-only is enforced at the
  contract layer, not by config flags.
- **No persistent storage.** Every tool call is a fresh IMAP query. The
  mailbox itself (Gmail/IMAP) is the source of truth — no cache to invalidate
  when the user deletes a message in Gmail, no SQLite to keep in sync.
- **On-demand connections.** Each account gets a lazy IMAP connection on
  first use, closed after 5 min of inactivity. No persistent IDLE pollers
  per account; we spin up only when asked.
- **Lazy attachments.** `read_message` returns attachment *metadata* only
  (filename, size, mime). Bytes are fetched only when `download_attachment`
  is called, written to `/tmp/email-mcp/`, and never cached in the project
  tree (so Drive sync doesn't accidentally export private docs).

## Tools

| Tool | What it returns |
|------|-----------------|
| `list_accounts` | Every configured account + its IMAP folders. Always start here. |
| `list_recent` | Recent messages (default: last 7 days, 20 messages, INBOX). Metadata + 200-char snippet. |
| `search` | Gmail search syntax (X-GM-RAW) for Gmail accounts; field prefixes (`from:`, `to:`, `subject:`, `body:`) for non-Gmail. |
| `read_message` | Full message: headers, body_text, body_html, attachment metadata. |
| `download_attachment` | Stream one attachment to `/tmp/email-mcp/<account>/<uid>/<filename>`. Returns the path. |

`list_recent`, `search`: pass `account: "*"` to query all accounts in parallel.
`read_message`, `download_attachment`: require an explicit `account` (UIDs are per-account).

## Configuration

Single JSON file. Default path: `/home/coder/.email/accounts.json` (override
with `EMAIL_ACCOUNTS_FILE`). Bind-mount this read-only into the container —
the file holds App Passwords and must not be writable by the bot.

```json
[
  {
    "id": "press",
    "label": "Press / PR",
    "host": "imap.gmail.com",
    "port": 993,
    "user": "press@example.com",
    "pass": "xxxx-xxxx-xxxx-xxxx"
  },
  {
    "id": "info",
    "label": "General",
    "host": "imap.gmail.com",
    "port": 993,
    "user": "info@example.com",
    "pass": "yyyy-yyyy-yyyy-yyyy"
  },
  {
    "id": "support",
    "label": "Support (custom IMAP)",
    "host": "mail.example.com",
    "port": 993,
    "tls": true,
    "user": "support@example.com",
    "pass": "real-imap-password"
  }
]
```

Required fields per account: `id`, `host`, `port`, `user`, `pass`.
Optional: `label` (defaults to `id`), `tls` (defaults to true when port=993).

## Gmail App Password

App Passwords work over IMAP and are the simplest path for Gmail (no Google
Cloud OAuth project, no consent flow per customer). The customer must:

1. Have **2-Step Verification enabled** on the Google account.
2. Generate an App Password at <https://myaccount.google.com/apppasswords>.
3. Paste the 16-character password into `accounts.json` under that account.

Notes:
- Workspace admins can disable App Passwords org-wide via Admin Console.
  If the customer's domain blocks them, fall back to OAuth (a separate
  integration we haven't built yet).
- App Passwords give full IMAP access (read + write + delete). Our MCP only
  exposes read tools, so the bot can't actually mutate the mailbox even
  though the credential could.

## Search syntax

**Gmail accounts** (host = `imap.gmail.com`): `query` is passed verbatim to
Gmail via `X-GM-RAW`. Use anything Gmail's web search accepts:

```
from:bartek@vendor.com has:attachment after:2026/04/01
subject:invoice -from:noreply
label:work newer_than:7d
```

**Non-Gmail accounts**: a small subset of `field:value` prefixes is supported
and translated to native IMAP SEARCH:

```
from:alice subject:"contract"   →  FROM "alice" SUBJECT "contract"
faktura                         →  BODY "faktura"
```

Supported prefixes: `from:`, `to:`, `cc:`, `subject:`, `body:`. Anything not
matching a prefix is matched as body text.

## Connection lifecycle

- First tool call against an account opens an IMAP connection and authenticates.
- Subsequent calls reuse the connection (locked per-mailbox via `getMailboxLock`).
- After 5 min idle, the connection is closed (`logout`).
- On any error event, the connection is dropped and the next call reconnects fresh.

This avoids both the per-call connection cost (~500ms TLS+AUTH on Gmail)
and the cost of persistent IDLE pollers we don't currently need.

## Limits and trade-offs

- **No IDLE / push notifications.** A V2 could opt-in per-account with a
  `"watch": true` flag to alert on new mail in real time, but that's not
  built. For now the bot only "knows" what's in the mailbox when asked.
- **No cache.** Listing 100 messages always re-fetches their envelopes from
  the server. Gmail handles this in ~200-400 ms; on slow custom IMAP hosts
  this can be visible. Tighten the `since` window to mitigate.
- **Date defaults to 7 days.** `list_recent` without `since` only walks the
  last week. This is intentional — full-mailbox scans on a Gmail account
  with 100k messages are slow and almost never what the user wants.

## Output formats

All tool results are JSON inside an MCP `text` content block (so they show
cleanly in Claude's tool output panel). Schema is stable:

```json
{
  "account": "press",
  "folder": "INBOX",
  "messages": [
    {
      "account": "press",
      "folder": "INBOX",
      "uid": 12345,
      "seq": 4711,
      "date": "2026-04-26T10:32:00.000Z",
      "subject": "Invoice #2026-04-12 from Vendor Co",
      "from": "Billing <billing@vendor.com>",
      "to": ["press@example.com"],
      "cc": [],
      "snippet": "Hi, please find attached your invoice for...",
      "has_attachments": true,
      "labels": ["\\Important", "invoices"],
      "thread_id": "1827384..."
    }
  ]
}
```

For cross-account calls (`account: "*"`), the top-level shape is `{ results: [...] }`
with one entry per account. Failures of individual accounts surface as
`{ account, error }` rather than aborting the whole call.

## Local development

```bash
EMAIL_ACCOUNTS_FILE=./accounts.dev.json node index.js
```

The server speaks MCP over stdio. To exercise it manually, pair with the
`@modelcontextprotocol/inspector` CLI or call it from Claude Code via
`.mcp.json`.
