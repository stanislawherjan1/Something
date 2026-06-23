/**
 * Substack MCP — read-only.
 *
 * Reads public Substack content with NO credentials: list a publication's
 * archive, read a post, look up an author, follow Notes, list comments.
 * There is no write tier and no session cookie — publishing/commenting were
 * intentionally dropped (see git history) to keep this a zero-credential,
 * low-risk reader.
 *
 * Substack has no official API for posts. We hit the same unauthenticated
 * `/api/v1/*` endpoints the website itself uses. This technically brushes
 * Substack ToS (Acceptable Use § scraping); enforcement risk for reading
 * public posts is low, but the endpoints are unofficial and can change.
 *
 * Endpoint reference (verified live May 2026 via curl):
 *   GET  {pub}.substack.com/api/v1/archive?sort=new&limit=&offset=
 *   GET  {pub}.substack.com/api/v1/posts/{slug}
 *   GET  {pub}.substack.com/api/v1/post/{id}/comments
 *   GET  substack.com/api/v1/user/{handle}/public_profile
 *   GET  substack.com/api/v1/reader/feed/profile/{user_id}    (Notes feed)
 *
 * Egress: the host allow-list must cover `substack.com` AND `*.substack.com`
 * (publication subdomains). Custom-domain publications (e.g. noahpinion.blog)
 * can't be statically allow-listed and won't be reachable through the proxy.
 *
 * NOTE: there is no public search endpoint on Substack's JSON API. Discovery
 * is via known publication/author lookups (or a web-search integration that
 * surfaces Substack URLs, which these tools then read) — see the
 * `substack-research` skill.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const UA = 'substack-mcp/2.0 (+https://github.com/anthropics/claude-code)';

// ─── HTTP helper ───────────────────────────────────────────────────────────

const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };

async function httpGet(url) {
  let resp = await fetch(url, { headers: HEADERS });

  // Custom-domain Substacks often canonicalise on `www.` and 404 on the
  // bare host (noahpinion.blog → www.noahpinion.blog). If we hit 404 on a
  // bare custom domain, retry once with www. prepended.
  if (resp.status === 404) {
    try {
      const u = new URL(url);
      const isBareCustom =
        u.hostname.includes('.') &&
        !u.hostname.startsWith('www.') &&
        !u.hostname.endsWith('substack.com');
      if (isBareCustom) {
        u.hostname = `www.${u.hostname}`;
        resp = await fetch(u.toString(), { headers: HEADERS });
      }
    } catch { /* malformed URL, fall through to error path */ }
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('This Substack resource is not public (it may be subscriber-only). This integration only reads public content.');
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 400); } catch {}
    throw new Error(`Substack ${resp.status} ${resp.statusText} for ${url}: ${detail}`);
  }
  return resp.json();
}

// ─── URL / handle normalisers ──────────────────────────────────────────────

/**
 * Accept either:
 *   - "stratechery"           → "https://stratechery.substack.com"
 *   - "noahpinion.blog"       → "https://noahpinion.blog"  (custom domain)
 *   - "https://x.substack.com" / "https://x.substack.com/" → same, normalised
 *   - "https://x.substack.com/p/post-slug" → "https://x.substack.com"
 *
 * Custom domain detection: any value containing a dot that isn't the
 * substack.com suffix is treated as the full origin.
 */
function publicationOrigin(input) {
  if (!input || typeof input !== 'string') throw new Error('`publication` is required.');
  const s = input.trim();

  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  }
  if (s.includes('.')) {
    // looks like a custom domain (e.g. noahpinion.blog, stratechery.com)
    return `https://${s.replace(/\/+$/, '')}`;
  }
  // bare slug → substack subdomain
  return `https://${s}.substack.com`;
}

/**
 * Extract { origin, slug } from a post URL. Accepts:
 *   - https://stratechery.com/2024/post-slug/      (custom domain)
 *   - https://x.substack.com/p/post-slug           (substack subdomain)
 *   - https://x.substack.com/p/post-slug?ref=...
 */
function parsePostUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('`url` is required.');
  const u = new URL(input.trim());
  const origin = `${u.protocol}//${u.host}`;

  const parts = u.pathname.split('/').filter(Boolean);
  // /p/{slug}  (substack subdomains and most custom domains)
  if (parts[0] === 'p' && parts[1]) return { origin, slug: parts[1] };
  // some old custom domains use /{year}/{slug}
  if (parts.length >= 2) return { origin, slug: parts[parts.length - 1] };
  throw new Error(`Cannot extract post slug from URL: ${input}`);
}

function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Tool implementations ──────────────────────────────────────────────────

async function readArchive({ publication, limit, offset, type }) {
  const origin = publicationOrigin(publication);
  const url = new URL(`${origin}/api/v1/archive`);
  url.searchParams.set('sort', 'new');
  url.searchParams.set('limit', String(Math.min(Math.max(limit || 20, 1), 50)));
  if (offset) url.searchParams.set('offset', String(offset));
  if (type)   url.searchParams.set('type', type);

  const data = await httpGet(url.toString());
  const posts = Array.isArray(data) ? data : (data.posts || []);
  return posts.map(p => ({
    title:           p.title,
    subtitle:        p.subtitle,
    slug:            p.slug,
    url:             p.canonical_url,
    audience:        p.audience,
    type:            p.type,
    post_date:       p.post_date,
    wordcount:       p.wordcount,
    description:     p.description || p.social_title || null,
    reaction_count:  p.reaction_count,
    comment_count:   p.comment_count,
    is_paid_preview: p.audience === 'only_paid',
  }));
}

async function readPost({ url }) {
  const { origin, slug } = parsePostUrl(url);
  const data = await httpGet(`${origin}/api/v1/posts/${encodeURIComponent(slug)}`);
  const body_html = data.body_html || data.body || '';
  const truncated = !body_html && (data.audience === 'only_paid' || data.audience === 'only_free');
  return {
    title:        data.title,
    subtitle:     data.subtitle,
    author:       data.publishedBylines?.[0]?.name || data.publication_name || null,
    url:          data.canonical_url,
    audience:     data.audience,
    post_date:    data.post_date,
    wordcount:    data.wordcount,
    body_html:    body_html || null,
    body_text:    body_html ? stripHtml(body_html) : null,
    truncated,
    paywalled_message: truncated
      ? 'This is a paid/subscriber-only post; only public content is available to this integration.'
      : null,
  };
}

async function getAuthor({ handle }) {
  const h = handle.replace(/^@/, '').trim();
  const data = await httpGet(`https://substack.com/api/v1/user/${encodeURIComponent(h)}/public_profile`);
  return {
    name:             data.name,
    handle:           data.handle,
    bio:              data.bio,
    photo_url:        data.photo_url,
    user_id:          data.id,
    subscriber_count: data.subscriber_count ?? null,
    publications: (data.publicationUsers || data.publications || []).map(p => ({
      name:    p.publication?.name || p.name,
      url:     p.publication?.subdomain
        ? `https://${p.publication.subdomain}.substack.com`
        : (p.publication?.custom_domain ? `https://${p.publication.custom_domain}` : null),
      role:    p.role,
    })),
    links: (data.userLinks || []).map(l => ({ type: l.type, url: l.url, label: l.label || null })),
  };
}

async function listRecentNotes({ handle, limit }) {
  const h = handle.replace(/^@/, '').trim();
  // Step 1 — resolve handle → user_id (Notes feed is id-keyed).
  const profile = await httpGet(`https://substack.com/api/v1/user/${encodeURIComponent(h)}/public_profile`);
  const userId = profile.id;
  if (!userId) throw new Error(`Could not resolve handle "${handle}" to a user id.`);

  const data = await httpGet(`https://substack.com/api/v1/reader/feed/profile/${userId}`);
  const items = Array.isArray(data) ? data : (data.items || data.notes || []);
  return items.slice(0, limit || 20).map(item => {
    const c = item.comment || item.context?.comment || item;
    return {
      id:        c.id,
      date:      c.date,
      body:      typeof c.body === 'string' ? c.body : (c.body?.text || null),
      reactions: c.reactions_count ?? c.reaction_count ?? 0,
      restacks:  c.restacks ?? 0,
      url:       c.url || null,
    };
  });
}

async function listComments({ url, limit }) {
  const { origin, slug } = parsePostUrl(url);
  // First resolve post → post_id; then fetch comments.
  const post = await httpGet(`${origin}/api/v1/posts/${encodeURIComponent(slug)}`);
  const postId = post.id;
  if (!postId) throw new Error('Could not resolve post id.');
  const data = await httpGet(`${origin}/api/v1/post/${postId}/comments?limit=${Math.min(limit || 30, 100)}`);
  const items = Array.isArray(data) ? data : (data.comments || []);
  return items.map(c => ({
    id:        c.id,
    author:    c.name || c.author?.name,
    body:      c.body,
    date:      c.date,
    reactions: c.reactions_count ?? c.reaction_count ?? 0,
    replies:   c.children_count ?? 0,
  }));
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_publication_archive',
    description: 'List recent posts from a Substack publication. Works without authentication for any public publication. Use this to monitor a specific author or pull a recent-posts list for a research synthesis.',
    inputSchema: {
      type: 'object',
      required: ['publication'],
      properties: {
        publication: {
          type: 'string',
          description: 'Publication identifier. Three accepted forms: bare slug ("noahpinion"), custom domain ("noahpinion.blog"), or full URL ("https://www.noahpinion.blog").',
        },
        limit:  { type: 'integer', minimum: 1, maximum: 50, description: 'Posts to return (default 20, max 50).' },
        offset: { type: 'integer', minimum: 0, description: 'Pagination offset.' },
        type:   { type: 'string', enum: ['newsletter', 'podcast', 'thread'], description: 'Filter by post type.' },
      },
    },
  },
  {
    name: 'read_post',
    description: 'Read the full content of a single public Substack post by URL. Returns title, body as HTML and plain text, audience flag, and a note if the post is subscriber-only (only public content is available).',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Full post URL (e.g. https://example.substack.com/p/some-slug).' },
      },
    },
  },
  {
    name: 'get_author',
    description: 'Look up a Substack author by handle. Returns bio, photo, the list of publications they write for, and their external links (X/Twitter, web).',
    inputSchema: {
      type: 'object',
      required: ['handle'],
      properties: {
        handle: { type: 'string', description: 'Author handle (e.g. "noahpinion" or "@noahpinion").' },
      },
    },
  },
  {
    name: 'list_recent_notes',
    description: "List recent Substack Notes (short posts, like tweets) from an author's feed. Resolves handle to user id under the hood.",
    inputSchema: {
      type: 'object',
      required: ['handle'],
      properties: {
        handle: { type: 'string', description: 'Author handle (e.g. "noahpinion").' },
        limit:  { type: 'integer', minimum: 1, maximum: 50, description: 'Max notes (default 20).' },
      },
    },
  },
  {
    name: 'list_comments',
    description: 'List comments on a public Substack post.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url:   { type: 'string', description: 'Post URL.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max comments (default 30).' },
      },
    },
  },
];

// ─── MCP wiring ────────────────────────────────────────────────────────────

const HANDLERS = {
  read_publication_archive: readArchive,
  read_post:                readPost,
  get_author:               getAuthor,
  list_recent_notes:        listRecentNotes,
  list_comments:            listComments,
};

const server = new Server(
  { name: 'substack', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const fn = HANDLERS[name];
  if (!fn) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  try {
    const result = await fn(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `substack error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[substack-mcp] ready (read-only)\n');
