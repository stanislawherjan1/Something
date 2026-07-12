/**
 * Substack MCP — read + write.
 *
 * READS work with NO credentials (public content): list a publication's
 * archive, read a post, look up an author, follow Notes, list comments.
 *
 * WRITES need one credential — the `substack.sid` session cookie (paste it
 * once in the integration settings). With it the bot can draft, upload
 * images, publish, schedule, and post Notes on the *owner's own* account.
 * The account's user id and writable publication are auto-detected from the
 * cookie (`/api/v1/user/profile/self`), so nothing else has to be entered.
 *
 * SAFETY
 *   - Reads never require the cookie (backward-compatible, zero-risk).
 *   - The cookie is `substack.sid` — it is equivalent to a password: anyone
 *     holding it has full account access. It is stored encrypted via the
 *     workspace secret store (broker), never in plaintext env or git.
 *   - Publishing to the world is GATED. `publish_draft`, `schedule_draft`,
 *     `unschedule_draft` and `publish_note` refuse unless the workspace owner
 *     turned on "Allow publishing" (SUBSTACK_ALLOW_PUBLISH=yes). Draft tools
 *     are always allowed because a draft goes nowhere public. `publish_draft`
 *     also defaults to send_email=false so a mistake never blasts subscribers.
 *
 * Substack has no official write API. We hit the same unauthenticated /
 * cookie-authenticated `/api/v1/*` endpoints the website itself uses. This
 * brushes Substack ToS (Acceptable Use § scraping/automation); enforcement
 * risk is low for reads, but real for automated publishing at scale.
 *
 * Endpoint reference (verified via python-substack + live curl):
 *   READ
 *     GET    {pub}.substack.com/api/v1/archive?sort=new&limit=&offset=
 *     GET    {pub}.substack.com/api/v1/posts/{slug}
 *     GET    {pub}.substack.com/api/v1/post/{id}/comments
 *     GET    substack.com/api/v1/user/{handle}/public_profile
 *     GET    substack.com/api/v1/reader/feed/profile/{user_id}      (Notes feed)
 *   WRITE (cookie required)
 *     GET    substack.com/api/v1/user/profile/self                  (whoami)
 *     GET    {pub}/api/v1/drafts?filter=&offset=&limit=
 *     POST   {pub}/api/v1/drafts
 *     GET    {pub}/api/v1/drafts/{id}
 *     PUT    {pub}/api/v1/drafts/{id}
 *     DELETE {pub}/api/v1/drafts/{id}
 *     GET    {pub}/api/v1/drafts/{id}/prepublish
 *     POST   {pub}/api/v1/drafts/{id}/publish                       {send, share_automatically}
 *     POST   {pub}/api/v1/drafts/{id}/schedule                      {post_date}
 *     POST   {pub}/api/v1/image                                     {image}
 *     POST   substack.com/api/v1/comment/feed                       (Note; best-effort)
 *
 * Egress: the host allow-list must cover `substack.com` AND `*.substack.com`.
 * Custom-domain publications can't be statically allow-listed and won't be
 * reachable through the proxy.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch encrypted credentials over UDS at startup when
// launched via mcp-runner. No-op when run standalone (local dev), so the
// process.env reads below keep working. SUBSTACK_SID lands in process.env.
await loadCredentials();

const UA  = 'substack-mcp/3.0 (+https://github.com/anthropics/claude-code)';
const SID = (process.env.SUBSTACK_SID || '').trim();
const ALLOW_PUBLISH = (process.env.SUBSTACK_ALLOW_PUBLISH || 'no').trim().toLowerCase() === 'yes';
const PUBLICATION_OVERRIDE = (process.env.SUBSTACK_PUBLICATION_URL || '').trim();

// ─── HTTP helpers ──────────────────────────────────────────────────────────

const BASE_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };

function authHeaders(extra = {}) {
  const h = { ...BASE_HEADERS, ...extra };
  // Attach the session cookie whenever we have one. Harmless for public
  // reads; required for writes and for reading the owner's own paid content.
  if (SID) h['Cookie'] = `substack.sid=${SID}`;
  return h;
}

function requireAuth() {
  if (!SID) {
    throw new Error('This action needs sign-in. Paste your Substack session cookie (substack.sid) in the integration settings, then retry. Reading public content works without it.');
  }
}

function requirePublish() {
  if (!ALLOW_PUBLISH) {
    throw new Error('Publishing is turned OFF for this workspace. The bot can create and edit drafts, but publishing/scheduling/Notes are disabled until the owner enables "Allow publishing" in the Substack integration settings. This is a safety gate so nothing goes public by accident.');
  }
}

async function raiseForStatus(resp, url) {
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(SID
      ? 'Substack rejected the session cookie (expired or wrong account). Re-paste a fresh substack.sid in the integration settings.'
      : 'This Substack resource is not public (subscriber-only). This action needs a signed-in session cookie.');
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 400); } catch {}
    throw new Error(`Substack ${resp.status} ${resp.statusText} for ${url}: ${detail}`);
  }
}

async function httpGet(url) {
  let resp = await fetch(url, { headers: authHeaders() });

  // Custom-domain Substacks often canonicalise on `www.` and 404 on the
  // bare host (noahpinion.blog → www.noahpinion.blog). Retry once with www.
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
    } catch { /* malformed URL, fall through */ }
  }

  await raiseForStatus(resp, url);
  return resp.json();
}

async function httpSend(method, url, body) {
  requireAuth();
  const resp = await fetch(url, {
    method,
    headers: authHeaders(body != null ? { 'Content-Type': 'application/json' } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  await raiseForStatus(resp, url);
  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// ─── URL / handle normalisers ──────────────────────────────────────────────

function publicationOrigin(input) {
  if (!input || typeof input !== 'string') throw new Error('`publication` is required.');
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  }
  if (s.includes('.')) return `https://${s.replace(/\/+$/, '')}`;   // custom domain
  return `https://${s}.substack.com`;                              // bare slug
}

function parsePostUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('`url` is required.');
  const u = new URL(input.trim());
  const origin = `${u.protocol}//${u.host}`;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) return { origin, slug: parts[1] };
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

// Substack post/note bodies are ProseMirror docs. Turn plain text (blank-line
// separated paragraphs) into the minimal valid doc. Advanced callers can pass
// a ready ProseMirror doc via `body_prosemirror` to bypass this.
function textToDoc(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const content = blocks
    .map(b => b.trim())
    .filter(Boolean)
    .map(b => ({ type: 'paragraph', content: [{ type: 'text', text: b }] }));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ─── Identity / publication resolution (cached) ─────────────────────────────

let _self = null;
async function getSelf() {
  if (_self) return _self;
  _self = await httpGet('https://substack.com/api/v1/user/profile/self');
  return _self;
}

let _ownOrigin = null;
async function ownPublicationOrigin() {
  if (_ownOrigin) return _ownOrigin;
  if (PUBLICATION_OVERRIDE) { _ownOrigin = publicationOrigin(PUBLICATION_OVERRIDE); return _ownOrigin; }
  const self = await getSelf();
  const pubs = self.publicationUsers || self.publications || [];
  const owned = pubs.find(p => ['admin', 'owner', 'editor'].includes(p.role)) || pubs[0];
  const pub = owned?.publication || owned;
  if (pub?.subdomain)      _ownOrigin = `https://${pub.subdomain}.substack.com`;
  else if (pub?.custom_domain) _ownOrigin = `https://${pub.custom_domain}`;
  else throw new Error('No writable publication found on this account. Set SUBSTACK_PUBLICATION_URL in the integration settings to point at your publication.');
  return _ownOrigin;
}

// ─── Read tools (no credentials required) ───────────────────────────────────

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
      ? 'This is a paid/subscriber-only post; only public content is available unless you are signed in with a subscribing account.'
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
      name: p.publication?.name || p.name,
      url:  p.publication?.subdomain
        ? `https://${p.publication.subdomain}.substack.com`
        : (p.publication?.custom_domain ? `https://${p.publication.custom_domain}` : null),
      role: p.role,
    })),
    links: (data.userLinks || []).map(l => ({ type: l.type, url: l.url, label: l.label || null })),
  };
}

async function listRecentNotes({ handle, limit }) {
  const h = handle.replace(/^@/, '').trim();
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

// ─── Write tools (cookie required; publishing additionally gated) ───────────

async function whoami() {
  const self = await getSelf();
  const pubs = (self.publicationUsers || self.publications || []).map(p => ({
    name: p.publication?.name || p.name,
    url:  p.publication?.subdomain
      ? `https://${p.publication.subdomain}.substack.com`
      : (p.publication?.custom_domain ? `https://${p.publication.custom_domain}` : null),
    role: p.role,
  }));
  let writable = null;
  try { writable = await ownPublicationOrigin(); } catch { /* none */ }
  return {
    signed_in_as:      self.name,
    handle:            self.handle,
    user_id:           self.id,
    publications:      pubs,
    writable_publication: writable,
    publishing_enabled: ALLOW_PUBLISH,
  };
}

function draftFields({ title, subtitle, body, body_prosemirror, audience, cover_image }, self) {
  const doc = body_prosemirror || (body != null ? textToDoc(body) : undefined);
  const out = {};
  if (title != null)     out.draft_title = title;
  if (subtitle != null)  out.draft_subtitle = subtitle;
  if (doc != null)       out.draft_body = JSON.stringify(doc);
  if (audience)          out.audience = audience;         // 'everyone' | 'only_paid' | 'founding'
  if (cover_image)       out.cover_image = cover_image;
  if (self)              out.draft_bylines = [{ id: self.id, is_guest: false }];
  return out;
}

async function createDraft(args) {
  const origin = await ownPublicationOrigin();
  const self = await getSelf();
  const payload = {
    type: 'newsletter',
    audience: 'everyone',
    ...draftFields(args, self),
  };
  const d = await httpSend('POST', `${origin}/api/v1/drafts`, payload);
  return {
    id: d.id,
    title: d.draft_title,
    editor_url: `${origin}/publish/post/${d.id}`,
    note: 'Draft created. It is NOT public. Review it in the editor, then call publish_draft (if publishing is enabled) or publish from the Substack UI.',
  };
}

async function updateDraft(args) {
  if (!args.draft_id) throw new Error('`draft_id` is required.');
  const origin = await ownPublicationOrigin();
  const self = await getSelf();
  const payload = draftFields(args, args.body_prosemirror || args.body != null ? self : null);
  const d = await httpSend('PUT', `${origin}/api/v1/drafts/${args.draft_id}`, payload);
  return { id: d.id ?? args.draft_id, title: d.draft_title, editor_url: `${origin}/publish/post/${args.draft_id}`, updated: true };
}

async function listDrafts({ limit, offset }) {
  const origin = await ownPublicationOrigin();
  const url = new URL(`${origin}/api/v1/drafts`);
  url.searchParams.set('limit', String(Math.min(Math.max(limit || 20, 1), 50)));
  if (offset) url.searchParams.set('offset', String(offset));
  const data = await httpGet(url.toString());
  const items = Array.isArray(data) ? data : (data.drafts || data.posts || []);
  return items.map(d => ({
    id: d.id,
    title: d.draft_title || d.title,
    is_published: d.is_published ?? false,
    scheduled_for: d.post_date && !d.is_published ? d.post_date : null,
    updated: d.updated_at || d.draft_updated_at || null,
  }));
}

async function getDraft({ draft_id }) {
  if (!draft_id) throw new Error('`draft_id` is required.');
  const origin = await ownPublicationOrigin();
  const d = await httpGet(`${origin}/api/v1/drafts/${draft_id}`);
  let body_text = null;
  try { body_text = d.draft_body ? stripHtml(String(d.draft_body)) : null; } catch {}
  return {
    id: d.id,
    title: d.draft_title,
    subtitle: d.draft_subtitle,
    audience: d.audience,
    is_published: d.is_published ?? false,
    scheduled_for: d.post_date && !d.is_published ? d.post_date : null,
    body_prosemirror: d.draft_body ?? null,
    body_preview: body_text,
  };
}

async function deleteDraft({ draft_id }) {
  if (!draft_id) throw new Error('`draft_id` is required.');
  const origin = await ownPublicationOrigin();
  await httpSend('DELETE', `${origin}/api/v1/drafts/${draft_id}`);
  return { deleted: true, draft_id };
}

async function uploadImage({ image }) {
  if (!image) throw new Error('`image` is required (a public https URL or a data: URI / base64 string).');
  const origin = await ownPublicationOrigin();
  const d = await httpSend('POST', `${origin}/api/v1/image`, { image });
  return { url: d.url || d.image_url || null, raw: d.url ? undefined : d };
}

async function publishDraft({ draft_id, send_email, share_to_notes }) {
  requirePublish();
  if (!draft_id) throw new Error('`draft_id` is required.');
  const origin = await ownPublicationOrigin();
  // Validate first — surfaces "missing title/section" etc. before going live.
  try { await httpSend('GET', `${origin}/api/v1/drafts/${draft_id}/prepublish`); } catch (e) {
    throw new Error(`Draft is not publishable yet: ${e.message}`);
  }
  const r = await httpSend('POST', `${origin}/api/v1/drafts/${draft_id}/publish`, {
    send: send_email === true,            // default OFF — never email subscribers unless asked
    share_automatically: share_to_notes === true,
  });
  return {
    published: true,
    emailed_subscribers: send_email === true,
    url: r?.canonical_url || r?.url || null,
  };
}

async function scheduleDraft({ draft_id, post_date }) {
  requirePublish();
  if (!draft_id) throw new Error('`draft_id` is required.');
  if (!post_date) throw new Error('`post_date` (ISO 8601, e.g. 2026-08-01T14:00:00Z) is required.');
  const origin = await ownPublicationOrigin();
  await httpSend('POST', `${origin}/api/v1/drafts/${draft_id}/schedule`, { post_date });
  return { scheduled: true, draft_id, post_date };
}

async function unscheduleDraft({ draft_id }) {
  requirePublish();
  if (!draft_id) throw new Error('`draft_id` is required.');
  const origin = await ownPublicationOrigin();
  await httpSend('POST', `${origin}/api/v1/drafts/${draft_id}/schedule`, { post_date: null });
  return { unscheduled: true, draft_id };
}

async function publishNote({ body, body_prosemirror }) {
  requirePublish();
  if (!body && !body_prosemirror) throw new Error('`body` (text) or `body_prosemirror` is required.');
  const doc = body_prosemirror || textToDoc(body);
  const bodyJson = { type: 'doc', attrs: { schemaVersion: 'v1' }, content: doc.content };
  const r = await httpSend('POST', 'https://substack.com/api/v1/comment/feed', {
    bodyJson,
    tabId: 'for-you',
    surface: 'feed',
    replyMinimumRole: 'everyone',
  });
  return { posted: true, id: r?.id ?? null, url: r?.url ?? null };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const READ_TOOLS = [
  {
    name: 'read_publication_archive',
    description: 'List recent posts from a Substack publication. Works without authentication for any public publication. Use this to monitor an author or pull a recent-posts list for a research synthesis.',
    inputSchema: {
      type: 'object',
      required: ['publication'],
      properties: {
        publication: { type: 'string', description: 'Bare slug ("noahpinion"), custom domain ("noahpinion.blog"), or full URL.' },
        limit:  { type: 'integer', minimum: 1, maximum: 50, description: 'Posts to return (default 20, max 50).' },
        offset: { type: 'integer', minimum: 0, description: 'Pagination offset.' },
        type:   { type: 'string', enum: ['newsletter', 'podcast', 'thread'], description: 'Filter by post type.' },
      },
    },
  },
  {
    name: 'read_post',
    description: 'Read the full content of a single public Substack post by URL. Returns title, body as HTML and plain text, audience flag, and a note if it is subscriber-only.',
    inputSchema: {
      type: 'object', required: ['url'],
      properties: { url: { type: 'string', description: 'Full post URL (e.g. https://example.substack.com/p/some-slug).' } },
    },
  },
  {
    name: 'get_author',
    description: 'Look up a Substack author by handle. Returns bio, photo, the publications they write for, and external links.',
    inputSchema: {
      type: 'object', required: ['handle'],
      properties: { handle: { type: 'string', description: 'Author handle (e.g. "noahpinion" or "@noahpinion").' } },
    },
  },
  {
    name: 'list_recent_notes',
    description: "List recent Substack Notes (short posts) from an author's feed. Resolves handle to user id under the hood.",
    inputSchema: {
      type: 'object', required: ['handle'],
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
      type: 'object', required: ['url'],
      properties: {
        url:   { type: 'string', description: 'Post URL.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max comments (default 30).' },
      },
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'whoami',
    description: 'Check which Substack account the session cookie belongs to and which publication the bot can write to. Also reports whether publishing is enabled. Use this first to confirm sign-in before drafting.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_draft',
    description: 'Create a NEW draft post on the owner\'s publication. The draft is private — it does NOT go public and does NOT email anyone. This is the safe default for "write a post". Returns the draft id and editor URL.',
    inputSchema: {
      type: 'object', required: ['title'],
      properties: {
        title:    { type: 'string', description: 'Post title.' },
        subtitle: { type: 'string', description: 'Optional subtitle/deck.' },
        body:     { type: 'string', description: 'Post body as plain text / light markdown. Blank lines separate paragraphs.' },
        body_prosemirror: { type: 'object', description: 'Advanced: a ready ProseMirror doc ({type:"doc",content:[...]}). Overrides `body`.' },
        audience: { type: 'string', enum: ['everyone', 'only_paid', 'founding'], description: 'Who can read it once published (default everyone).' },
        cover_image: { type: 'string', description: 'Cover image URL (use upload_image first to get one).' },
      },
    },
  },
  {
    name: 'update_draft',
    description: 'Edit an existing draft (title, subtitle, body, cover). Only the fields you pass are changed. Does not publish.',
    inputSchema: {
      type: 'object', required: ['draft_id'],
      properties: {
        draft_id: { type: 'string', description: 'Draft id from create_draft / list_drafts.' },
        title:    { type: 'string' },
        subtitle: { type: 'string' },
        body:     { type: 'string', description: 'Replacement body (plain text / light markdown).' },
        body_prosemirror: { type: 'object' },
        audience: { type: 'string', enum: ['everyone', 'only_paid', 'founding'] },
        cover_image: { type: 'string' },
      },
    },
  },
  {
    name: 'list_drafts',
    description: 'List the owner\'s drafts and scheduled/unpublished posts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
  {
    name: 'get_draft',
    description: 'Fetch one draft by id, including a plain-text preview of its body.',
    inputSchema: {
      type: 'object', required: ['draft_id'],
      properties: { draft_id: { type: 'string' } },
    },
  },
  {
    name: 'delete_draft',
    description: 'Delete a draft by id. Only deletes drafts; published posts are unaffected.',
    inputSchema: {
      type: 'object', required: ['draft_id'],
      properties: { draft_id: { type: 'string' } },
    },
  },
  {
    name: 'upload_image',
    description: 'Upload an image to Substack\'s CDN and get back a hosted URL you can use as a cover_image or inside a body. Accepts a public https URL or a data: URI / base64 string.',
    inputSchema: {
      type: 'object', required: ['image'],
      properties: { image: { type: 'string', description: 'Public https image URL, or a data: URI / base64-encoded image.' } },
    },
  },
  {
    name: 'publish_draft',
    description: 'PUBLISH a draft — this makes the post PUBLIC on the web immediately and is NOT reversible from here. By default it does NOT email subscribers (set send_email=true to blast the list). Requires the owner to have enabled "Allow publishing"; otherwise it is refused. Prefer create_draft and let a human hit publish unless explicitly told to publish.',
    inputSchema: {
      type: 'object', required: ['draft_id'],
      properties: {
        draft_id:      { type: 'string', description: 'Draft id to publish.' },
        send_email:    { type: 'boolean', description: 'Email the post to all subscribers. Default false (web-only). Only set true when explicitly asked.' },
        share_to_notes:{ type: 'boolean', description: 'Auto-share to Notes after publishing. Default false.' },
      },
    },
  },
  {
    name: 'schedule_draft',
    description: 'Schedule a draft to publish at a future time (ISO 8601). Goes public automatically at that time. Requires "Allow publishing".',
    inputSchema: {
      type: 'object', required: ['draft_id', 'post_date'],
      properties: {
        draft_id:  { type: 'string' },
        post_date: { type: 'string', description: 'ISO 8601 timestamp, e.g. 2026-08-01T14:00:00Z.' },
      },
    },
  },
  {
    name: 'unschedule_draft',
    description: 'Cancel a scheduled publish, returning the post to an ordinary draft. Requires "Allow publishing".',
    inputSchema: {
      type: 'object', required: ['draft_id'],
      properties: { draft_id: { type: 'string' } },
    },
  },
  {
    name: 'publish_note',
    description: 'Post a Substack Note (a short public post, like a tweet) from the owner\'s account. This is PUBLIC immediately. Requires "Allow publishing".',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Note text (plain text; blank lines separate paragraphs).' },
        body_prosemirror: { type: 'object', description: 'Advanced: ready ProseMirror doc.' },
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
  whoami:                   whoami,
  create_draft:             createDraft,
  update_draft:             updateDraft,
  list_drafts:              listDrafts,
  get_draft:                getDraft,
  delete_draft:             deleteDraft,
  upload_image:             uploadImage,
  publish_draft:            publishDraft,
  schedule_draft:           scheduleDraft,
  unschedule_draft:         unscheduleDraft,
  publish_note:             publishNote,
};

// Read tools are always listed. Write tools only appear when a session cookie
// is configured — no point advertising sign-in-only tools to a read-only setup.
const TOOLS = SID ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;

const server = new Server(
  { name: 'substack', version: '3.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const fn = HANDLERS[name];
  if (!fn) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    const result = await fn(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `substack error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[substack-mcp] ready (${SID ? 'read+write' : 'read-only'}${SID && ALLOW_PUBLISH ? ', publishing ON' : SID ? ', publishing OFF' : ''})\n`);