# substack-mcp

MCP server for Substack. Two tiers:

- **Read-only** (default, no credentials): list archives, read public posts,
  search across Substack, look up authors, list comments.
- **Authenticated** (paste `substack.sid` session cookie in Integrations →
  Substack → Settings): publish posts, post Notes, comment, restack, plus
  read paid posts you subscribe to.

## Tools

| Tool | Auth | Notes |
|---|---|---|
| `read_publication_archive` | no | accepts slug / custom domain / URL |
| `read_post`                | no | paid posts require subscriber cookie |
| `get_author`               | no | profile + publications + external links |
| `list_recent_notes`        | no | Notes (short posts) by author |
| `list_comments`            | no | public posts |
| `publish_post`             | **yes** | draft → prepublish → publish |
| `post_note`                | **yes** | Substack Notes (short posts) |
| `comment_on_post`          | **yes** | |
| `restack_post`             | **yes** | with optional comment |

There's no public search API on Substack — for "find posts about X" use the
Grok integration with web search, or scrape via the Notes feed of a curator.

## Auth

Substack has no developer OAuth. The single session cookie `substack.sid`
acts as full account credential and is long-lived (rotates only on password
change or "sign out everywhere").

To get it: log in to substack.com in a browser, open DevTools → Application
→ Cookies → `substack.com` → copy the `substack.sid` value.

Paste into the workspace IDE: Integrations → Substack → Settings.

## Caveats

- **Unofficial endpoints.** Substack's only official API (since Apr 2026)
  returns LinkedIn-keyed profile metadata only. Every endpoint this MCP
  uses is one the Substack website itself calls; they can change without
  notice.
- **ToS.** The Substack Acceptable Use Policy prohibits scraping and
  automated access. Enforcement risk for personal/own-publication use is
  low; for products aggregating other publications it is real.
- **Cookie = full account.** A leaked `substack.sid` lets anyone act as
  your account. Stored encrypted in the workspace store; never logged.

## Endpoint reference

Verified live May 2026. Subject to change.

```
GET  {pub}.substack.com/api/v1/archive?sort=new&limit=&offset=
GET  {pub}.substack.com/api/v1/posts/{slug}
GET  substack.com/api/v1/user/{handle}/public_profile
GET  substack.com/api/v1/reader/feed/profile/{user_id}
GET  {pub}.substack.com/api/v1/post/{id}/comments
POST {pub}.substack.com/api/v1/drafts                  (auth)
POST {pub}.substack.com/api/v1/drafts/{id}/prepublish  (auth)
POST {pub}.substack.com/api/v1/drafts/{id}/publish     (auth)
POST substack.com/api/v1/comment/feed                  (auth, Notes)
POST {pub}.substack.com/api/v1/post/{id}/comment       (auth)
POST {pub}.substack.com/api/v1/post/{id}/restack       (auth)
```
