# substack-mcp

Read-only MCP server for Substack. **No credentials** — it only reads public
content. Activating the integration also installs a `substack-research` skill
that teaches the assistant how to find and synthesise posts.

## Tools

| Tool | Notes |
|---|---|
| `read_publication_archive` | recent posts; accepts slug / custom domain / URL |
| `read_post`                | full post by URL (public content only) |
| `get_author`               | profile + publications + external links |
| `list_recent_notes`        | Notes (short posts) by author |
| `list_comments`            | comments on a public post |

There's **no public search API** on Substack. To "find posts about X", use a
web-search integration (e.g. Grok) to surface candidate Substack URLs, then
read them with these tools — see the `substack-research` skill.

## Egress

The host allow-list must cover both `substack.com` (author/profile/Notes
endpoints) **and** `*.substack.com` (publication subdomains for archive /
posts / comments). Custom-domain publications (e.g. `noahpinion.blog`) can't
be statically allow-listed, so they aren't reachable through the proxy.

## Caveats

- **Unofficial endpoints.** Substack's only official API (since Apr 2026)
  returns LinkedIn-keyed profile metadata only. Every endpoint this MCP uses
  is one the Substack website itself calls; they can change without notice.
- **ToS.** The Substack Acceptable Use Policy prohibits scraping and automated
  access. Enforcement risk for reading public posts is low, but real for
  products that aggregate other publications at scale.

## Endpoint reference

Verified live May 2026. Subject to change.

```
GET  {pub}.substack.com/api/v1/archive?sort=new&limit=&offset=
GET  {pub}.substack.com/api/v1/posts/{slug}
GET  {pub}.substack.com/api/v1/post/{id}/comments
GET  substack.com/api/v1/user/{handle}/public_profile
GET  substack.com/api/v1/reader/feed/profile/{user_id}    (Notes feed)
```
