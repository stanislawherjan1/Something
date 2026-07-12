# substack-mcp

MCP server for Substack. **Reads need no credentials** (public content only).
**Writing** needs one credential — the `substack.sid` session cookie — and lets
the bot draft, edit, upload images, publish, schedule, and post Notes on the
owner's own publication.

## Tools

### Read (no credentials)
| Tool | Notes |
|---|---|
| `read_publication_archive` | recent posts; accepts slug / custom domain / URL |
| `read_post`                | full post by URL (public content only) |
| `get_author`               | profile + publications + external links |
| `list_recent_notes`        | Notes (short posts) by author |
| `list_comments`            | comments on a public post |

### Write (session cookie required)
| Tool | Notes |
|---|---|
| `whoami`          | which account/publication the cookie owns; publishing on/off |
| `create_draft`    | new private draft (safe default) |
| `update_draft`    | edit an existing draft |
| `list_drafts` / `get_draft` / `delete_draft` | manage drafts |
| `upload_image`    | upload to Substack CDN → hosted URL (covers, inline) |
| `publish_draft`   | **public**; `send_email` defaults false — gated |
| `schedule_draft` / `unschedule_draft` | schedule a future publish — gated |
| `publish_note`    | post a public Note — gated |

There's **no public search API** on Substack. To "find posts about X", use a
web-search integration to surface candidate Substack URLs, then read them with
these tools — see the `substack-research` skill. Writing is covered by the
`substack-writer` skill (draft-first).

## Auth & configuration

Env vars (mapped from catalog fields, injected via the broker at spawn):

| Var | Required | Meaning |
|---|---|---|
| `SUBSTACK_SID` | for writes | the `substack.sid` cookie value. Equivalent to a password — full account access. Reads work without it. |
| `SUBSTACK_PUBLICATION_URL` | optional | override; else the writable publication is auto-detected from the cookie via `/user/profile/self`. |
| `SUBSTACK_ALLOW_PUBLISH` | optional | `yes` unlocks `publish_draft` / `schedule_draft` / `unschedule_draft` / `publish_note`. Default `no` — drafts only. |

Write tools are only advertised (listed) when `SUBSTACK_SID` is set. When it's
absent the server is read-only, exactly as before.

### Getting the cookie
Sign in at substack.com → DevTools (F12) → Application/Storage → Cookies →
`https://substack.com` → copy the **Value** of `substack.sid`. It stays valid
for months unless you sign out.

## Safety model

- Reads never require the cookie (backward-compatible, zero-risk).
- The cookie is stored encrypted in the workspace secret store and delivered to
  the process over the broker UDS — never in plaintext env or git.
- Publishing to the public is **off by default**. Drafts are always allowed
  (a draft is private); publishing/scheduling/Notes need the owner to set
  `SUBSTACK_ALLOW_PUBLISH=yes`.
- `publish_draft` defaults to `send_email=false` so a mistake can't blast the
  subscriber list.

## Egress

The host allow-list must cover both `substack.com` (profile / Notes / self /
image-on-substack.com) **and** `*.substack.com` (publication subdomains for
archive / posts / comments / drafts / publish / image). Custom-domain
publications can't be statically allow-listed, so they aren't reachable through
the proxy.

## Caveats

- **Unofficial endpoints.** Substack's only official API (Apr 2026) returns
  LinkedIn-keyed public profile metadata only. Every endpoint this MCP uses —
  read and write — is one the Substack website itself calls; they can change
  without notice.
- **ToS.** The Substack Acceptable Use Policy prohibits scraping and automated
  access. Enforcement risk is low for reading public posts, but higher for
  automated publishing — which is why publishing is gated and off by default.

## Endpoint reference

Read verified live May 2026; write mirrored from `python-substack` + live curl.
Subject to change.

```
READ
  GET    {pub}.substack.com/api/v1/archive?sort=new&limit=&offset=
  GET    {pub}.substack.com/api/v1/posts/{slug}
  GET    {pub}.substack.com/api/v1/post/{id}/comments
  GET    substack.com/api/v1/user/{handle}/public_profile
  GET    substack.com/api/v1/reader/feed/profile/{user_id}       (Notes feed)
WRITE (cookie)
  GET    substack.com/api/v1/user/profile/self                   (whoami)
  GET    {pub}/api/v1/drafts?filter=&offset=&limit=
  POST   {pub}/api/v1/drafts
  GET    {pub}/api/v1/drafts/{id}
  PUT    {pub}/api/v1/drafts/{id}
  DELETE {pub}/api/v1/drafts/{id}
  GET    {pub}/api/v1/drafts/{id}/prepublish
  POST   {pub}/api/v1/drafts/{id}/publish                        {send, share_automatically}
  POST   {pub}/api/v1/drafts/{id}/schedule                       {post_date}
  POST   {pub}/api/v1/image                                      {image}
  POST   substack.com/api/v1/comment/feed                        (Note; best-effort)
```
