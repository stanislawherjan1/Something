/**
 * Substack MCP — read public posts + (with session cookie) publish, Notes,
 * comments, read paid content.
 *
 * Two tiers, single MCP:
 *   - Read-only (no creds):  read_archive, read_post, search_posts,
 *                            get_author, list_comments
 *   - Write + paid (cookie): publish_post, post_note, comment_on_post,
 *                            restack_post + paid bodies in read_post
 *
 * Tier is decided at startup by presence of process.env.SUBSTACK_SID. If
 * absent, write tools still appear in the tool list but return a friendly
 * "Connect your account in Integrations → Substack" error — gives the user
 * (and Claude) a single clean signal instead of a missing-tool 404.
 *
 * Substack has no official API for posts. We hit the same unauthenticated
 * `/api/v1/*` endpoints the website itself uses; with a substack.sid
 * cookie we get the same write surface the web editor uses. Both paths
 * technically violate Substack ToS (Acceptable Use § scraping); enforcement
 * risk for personal/own-publication use is low.
 *
 * Endpoint reference (verified live May 2026 via curl):
 *   GET  {pub}.substack.com/api/v1/archive?sort=new&limit=&offset=
 *   GET  {pub}.substack.com/api/v1/posts/{slug}
 *   GET  {pub}.substack.com/api/v1/post/{id}/comments
 *   GET  substack.com/api/v1/user/{handle}/public_profile
 *   GET  substack.com/api/v1/reader/feed/profile/{user_id}    (Notes feed)
 *   POST {pub}.substack.com/api/v1/drafts
 *   POST {pub}.substack.com/api/v1/drafts/{id}/prepublish
 *   POST {pub}.substack.com/api/v1/drafts/{id}/publish
 *   POST substack.com/api/v1/comment/feed                      (Notes post)
 *   POST {pub}.substack.com/api/v1/post/{id}/comment
 *
 * NOTE: There's no public search endpoint on Substack's JSON API in 2026.
 * Discovery is through RSS / archive / author profile lookups.
 *
 * Auth: single `substack.sid` cookie (long-lived; rotates only on
 * password change / "sign out everywhere"). On any 401 we surface a
 * clear "session expired — re-paste cookie in Integrations" message.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

await loadCredentials();

const SID = (process.env.SUBSTACK_SID || '').trim();
const HAS_AUTH = SID.length > 0;
const UA = 'substack-mcp/1.0 (+https://github.com/anthropics/claude-code)';

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function authHeaders() {
  const h = {
    'User-Agent': UA,
    'Accept':     'application/json',
  };
  if (HAS_AUTH) h.Cookie = `substack.sid=${SID}`;
  return h;
}

async function httpGet(url) {
  let resp = await fetch(url, { headers: authHeaders() });

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
        resp = await fetch(u.toString(), { headers: authHeaders() });
      }
    } catch { /* malformed URL, fall through to error path */ }
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      HAS_AUTH
        ? 'Substack session expired or rejected. Re-paste substack.sid in Integrations → Substack → Settings.'
        : 'This resource requires a connected account. Add your session cookie in Integrations → Substack → Settings.',
    );
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 400); } catch {}
    throw new Error(`Substack ${resp.status} ${resp.statusText} for ${url}: ${detail}`);
  }
  return resp.json();
}

async function httpPost(url, body) {
  if (!HAS_AUTH) {
    throw new Error('This tool requires a connected account. Add your session cookie in Integrations → Substack → Settings.');
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Substack session expired or rejected. Re-paste substack.sid in Integrations → Substack → Settings.');
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
      ? (HAS_AUTH
          ? 'This post is paid and your account does not have access to it.'
          : 'This is a paid post. Connect a subscriber cookie in Integrations → Substack to read it.')
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
  const items = data.items || data.notes || data || [];
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
  const items = data.comments || data || [];
  return items.map(c => ({
    id:        c.id,
    author:    c.name || c.author?.name,
    body:      c.body,
    date:      c.date,
    reactions: c.reactions_count ?? c.reaction_count ?? 0,
    replies:   c.children_count ?? 0,
  }));
}

// ─── Write tools (require SID) ─────────────────────────────────────────────

async function publishPost({ publication, title, subtitle, body_html, audience }) {
  const origin = publicationOrigin(publication);
  const aud = ['everyone', 'only_paid', 'only_free', 'founding'].includes(audience) ? audience : 'everyone';

  // 1. create draft
  const draft = await httpPost(`${origin}/api/v1/drafts`, {
    draft_title:    title,
    draft_subtitle: subtitle || '',
    draft_body:     body_html,
    audience:       aud,
    type:           'newsletter',
  });
  const draftId = draft.id;
  if (!draftId) throw new Error('Draft creation returned no id.');

  // 2. prepublish (validates)
  await httpPost(`${origin}/api/v1/drafts/${draftId}/prepublish`, {});

  // 3. publish
  const published = await httpPost(`${origin}/api/v1/drafts/${draftId}/publish`, {
    send: true,
    share_automatically: false,
  });

  return {
    ok:        true,
    post_url:  published.canonical_url || published.url,
    post_id:   published.id,
    audience:  aud,
    title,
  };
}

async function postNote({ text }) {
  // Substack Notes API. Endpoint shape may evolve — the wire body matches
  // what the web client sends as of May 2026.
  const data = await httpPost('https://substack.com/api/v1/comment/feed', {
    bodyJson: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text }],
      }],
    },
    tabId:        'for-you',
    surface:      'feed',
    replyMinimumRole: 'everyone',
  });
  return {
    ok:       true,
    note_id:  data.id,
    url:      data.url || null,
  };
}

async function commentOnPost({ url, text }) {
  const { origin, slug } = parsePostUrl(url);
  const post = await httpGet(`${origin}/api/v1/posts/${encodeURIComponent(slug)}`);
  const postId = post.id;
  if (!postId) throw new Error('Could not resolve post id.');
  const data = await httpPost(`${origin}/api/v1/post/${postId}/comment`, {
    body: text,
  });
  return { ok: true, comment_id: data.id, post_url: post.canonical_url };
}

async function restackPost({ url, comment }) {
  const { origin, slug } = parsePostUrl(url);
  const post = await httpGet(`${origin}/api/v1/posts/${encodeURIComponent(slug)}`);
  const postId = post.id;
  if (!postId) throw new Error('Could not resolve post id.');
  const data = await httpPost(`${origin}/api/v1/post/${postId}/restack`, {
    body: comment || '',
  });
  return { ok: true, restack_id: data.id };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const READ_TOOLS = [
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
    description: 'Read the full content of a single Substack post by URL. Returns title, body as HTML and plain text, audience flag, and a paywall message if the post is subscriber-only and you do not have access.',
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

const WRITE_TOOLS = [
  {
    name: 'publish_post',
    description: 'Publish a new post to one of your Substack publications. Three-step internal flow (draft → prepublish → publish). Requires a connected account.',
    inputSchema: {
      type: 'object',
      required: ['publication', 'title', 'body_html'],
      properties: {
        publication: { type: 'string', description: 'Your publication (slug, custom domain, or full URL).' },
        title:       { type: 'string', description: 'Post title.' },
        subtitle:    { type: 'string', description: 'Optional subtitle/dek.' },
        body_html:   { type: 'string', description: 'Post body as HTML. Paragraphs as <p>...</p>, headings as <h2>...</h2>, etc.' },
        audience:    {
          type: 'string',
          enum: ['everyone', 'only_paid', 'only_free', 'founding'],
          description: 'Who can read this post. Default: everyone.',
        },
      },
    },
  },
  {
    name: 'post_note',
    description: 'Post a Substack Note (short post, similar to a tweet). Requires a connected account.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Note body (plain text; Substack handles linkification).' },
      },
    },
  },
  {
    name: 'comment_on_post',
    description: 'Post a comment on any Substack post you can access. Requires a connected account.',
    inputSchema: {
      type: 'object',
      required: ['url', 'text'],
      properties: {
        url:  { type: 'string', description: 'Post URL.' },
        text: { type: 'string', description: 'Comment body.' },
      },
    },
  },
  {
    name: 'restack_post',
    description: 'Restack a post to your followers (Substack equivalent of a retweet/quote). Requires a connected account.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url:     { type: 'string', description: 'Post URL.' },
        comment: { type: 'string', description: 'Optional comment to attach.' },
      },
    },
  },
];

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

// ─── MCP wiring ────────────────────────────────────────────────────────────

const HANDLERS = {
  read_publication_archive: readArchive,
  read_post:                readPost,
  get_author:               getAuthor,
  list_recent_notes:        listRecentNotes,
  list_comments:            listComments,
  publish_post:             publishPost,
  post_note:                postNote,
  comment_on_post:          commentOnPost,
  restack_post:             restackPost,
};

const server = new Server(
  { name: 'substack', version: '1.0.0' },
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
process.stderr.write(`[substack-mcp] ready (${HAS_AUTH ? 'connected account' : 'read-only'})\n`);
