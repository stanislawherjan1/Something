/**
 * X (Twitter) read-only MCP — backed by twitterapi.io
 *
 * Auth: simple `X-API-Key` header. The user gets a key from twitterapi.io
 * (after sign-up + $0.10 free credit) and pastes it into the integration
 * form. We never touch the user's actual X account credentials — every
 * request reads public X data via twitterapi.io's scraper proxy.
 *
 * Cost (paid by the user to twitterapi.io, not us):
 *   $0.15 / 1k tweets  ·  $0.18 / 1k user profiles  ·  $0.15 / 1k followers
 *
 * Env vars:
 *   X_API_KEY — twitterapi.io key, mandatory
 *
 * ─────────────────────────────────────────────
 * Tools (all read-only, no write capability by design):
 *   search_tweets       — advanced query ("from:elonmusk AI", "lang:pl ...")
 *   get_user            — profile by @username
 *   user_last_tweets    — recent tweets from one user
 *   user_followers      — who follows @username (paginated)
 *   user_following      — who @username follows (paginated)
 *   user_mentions       — tweets mentioning @username
 *   tweet_replies       — replies under a tweet id
 *   tweet_quotations    — quote-tweets of a tweet id
 *   tweets_by_ids       — batch lookup multiple tweet ids
 * ─────────────────────────────────────────────
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY  = process.env.X_API_KEY;
const BASE_URL = 'https://api.twitterapi.io';

if (!API_KEY) {
  process.stderr.write('[x-mcp] Missing X_API_KEY\n');
  process.exit(1);
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

async function api(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`twitterapi.io ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Shape helpers ─────────────────────────────────────────────────────────

// twitterapi.io is inconsistent about where a list lives in its envelope:
// sometimes the array is top-level (`data.tweets`), sometimes nested under a
// `data` object (`data.data.tweets`, as /user/last_tweets and /user/mentions
// return), and `data.data` itself is sometimes the array and sometimes an
// object like `{ tweets: [...] }`. Assuming one shape is what blew up with
// `(data.tweets || data.data || []).map is not a function` when the endpoint
// returned `{ data: { tweets: [...] } }`. Pick the first value that is actually
// an array from the likely paths, so a shape change degrades to [] not a throw.
function firstArray(...cands) {
  for (const c of cands) if (Array.isArray(c)) return c;
  return [];
}

// Trim a tweet down to the fields the bot actually uses. Full responses can
// be 3-4 KB each — multiplied by 20 tweets per page that fills a context
// window with noise. We expose link, author handle, counts, lang, snippet.
function compactTweet(t) {
  if (!t) return null;
  return {
    id:           t.id,
    url:          t.url || (t.author?.userName ? `https://x.com/${t.author.userName}/status/${t.id}` : null),
    text:         t.text,
    author:       t.author ? { username: t.author.userName, name: t.author.name, verified: !!t.author.isBlueVerified, followers: t.author.followers } : null,
    created_at:   t.createdAt,
    lang:         t.lang,
    is_reply:     t.isReply,
    counts: {
      reply:    t.replyCount,
      retweet:  t.retweetCount,
      like:     t.likeCount,
      quote:    t.quoteCount,
      bookmark: t.bookmarkCount,
      view:     t.viewCount,
    },
  };
}

function compactUser(u) {
  if (!u) return null;
  return {
    id:        u.id,
    username:  u.userName,
    name:      u.name,
    bio:       u.description || u.bio,
    verified:  !!u.isBlueVerified,
    followers: u.followers ?? u.followersCount,
    following: u.following ?? u.followingCount,
    tweets:    u.statusesCount ?? u.tweetsCount,
    created_at: u.createdAt,
    location:  u.location,
    url:       u.url || (u.userName ? `https://x.com/${u.userName}` : null),
  };
}

function pageOf(items, raw) {
  return {
    items,
    // Same envelope inconsistency as firstArray: the pagination fields are
    // usually top-level but can ride inside `data` — accept either.
    has_next:  !!(raw.has_next_page ?? raw.data?.has_next_page),
    cursor:    raw.next_cursor || raw.data?.next_cursor || null,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_tweets',
    description:
      'Advanced X search. Query supports operators: from:user, to:user, ' +
      '@user, "exact phrase", -word, lang:pl, since:YYYY-MM-DD, until:YYYY-MM-DD, ' +
      'has:images, has:links, min_retweets:N, min_faves:N. Returns 20 tweets ' +
      'per page; pass the returned cursor to keep paging.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search query, e.g. `from:elonmusk AI` or `"open source" lang:en min_faves:50`.',
        },
        queryType: {
          type: 'string',
          enum: ['Latest', 'Top'],
          default: 'Latest',
          description: 'Latest = chronological. Top = engagement-ranked.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned from a previous call. Empty for first page.',
        },
      },
    },
  },
  {
    name: 'get_user',
    description: 'Look up a single X user by their @username (without the @). Returns profile, follower/following counts, bio.',
    inputSchema: {
      type: 'object',
      required: ['username'],
      properties: {
        username: { type: 'string', description: 'Handle without @, e.g. "elonmusk".' },
      },
    },
  },
  {
    name: 'user_last_tweets',
    description: 'Recent tweets from one user, newest first. 20 per page; cursor for older.',
    inputSchema: {
      type: 'object',
      required: ['username'],
      properties: {
        username: { type: 'string' },
        cursor:   { type: 'string' },
      },
    },
  },
  {
    name: 'user_followers',
    description: 'Followers of @username, reverse chronological (newest follower first). 20/page.',
    inputSchema: {
      type: 'object',
      required: ['username'],
      properties: {
        username: { type: 'string' },
        cursor:   { type: 'string' },
      },
    },
  },
  {
    name: 'user_following',
    description: 'Accounts that @username follows, sorted by follow date. 20/page.',
    inputSchema: {
      type: 'object',
      required: ['username'],
      properties: {
        username: { type: 'string' },
        cursor:   { type: 'string' },
      },
    },
  },
  {
    name: 'user_mentions',
    description: 'Tweets that mention @username. 20/page.',
    inputSchema: {
      type: 'object',
      required: ['username'],
      properties: {
        username: { type: 'string' },
        cursor:   { type: 'string' },
      },
    },
  },
  {
    name: 'tweet_replies',
    description: 'Replies under a tweet, by tweet id. 20/page.',
    inputSchema: {
      type: 'object',
      required: ['tweet_id'],
      properties: {
        tweet_id: { type: 'string', description: 'Numeric tweet id (last segment of the tweet URL).' },
        cursor:   { type: 'string' },
      },
    },
  },
  {
    name: 'tweet_quotations',
    description: 'Quote-tweets of a tweet, by tweet id. 20/page.',
    inputSchema: {
      type: 'object',
      required: ['tweet_id'],
      properties: {
        tweet_id: { type: 'string' },
        cursor:   { type: 'string' },
      },
    },
  },
  {
    name: 'tweets_by_ids',
    description: 'Batch-fetch full data for up to ~100 tweets at once by their ids. Cheaper than calling get-by-id 100 times.',
    inputSchema: {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tweet ids.',
        },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleSearchTweets({ query, queryType = 'Latest', cursor }) {
  const data = await api('/twitter/tweet/advanced_search', { query, queryType, cursor });
  const items = firstArray(data.tweets, data.data?.tweets, data.data).map(compactTweet).filter(Boolean);
  return pageOf(items, data);
}

async function handleGetUser({ username }) {
  const data = await api('/twitter/user/info', { userName: username });
  return compactUser(data?.data || data?.user || data);
}

async function handleUserLastTweets({ username, cursor }) {
  const data = await api('/twitter/user/last_tweets', { userName: username, cursor });
  const items = firstArray(data.tweets, data.data?.tweets, data.data).map(compactTweet).filter(Boolean);
  return pageOf(items, data);
}

async function handleUserFollowers({ username, cursor }) {
  const data = await api('/twitter/user/followers', { userName: username, cursor });
  const items = firstArray(data.followers, data.users, data.data?.followers, data.data?.users, data.data).map(compactUser).filter(Boolean);
  return pageOf(items, data);
}

async function handleUserFollowing({ username, cursor }) {
  const data = await api('/twitter/user/followings', { userName: username, cursor });
  const items = firstArray(data.followings, data.users, data.data?.followings, data.data?.users, data.data).map(compactUser).filter(Boolean);
  return pageOf(items, data);
}

async function handleUserMentions({ username, cursor }) {
  const data = await api('/twitter/user/mentions', { userName: username, cursor });
  const items = firstArray(data.tweets, data.data?.tweets, data.data).map(compactTweet).filter(Boolean);
  return pageOf(items, data);
}

async function handleTweetReplies({ tweet_id, cursor }) {
  const data = await api('/twitter/tweet/replies', { tweetId: tweet_id, cursor });
  const items = firstArray(data.tweets, data.replies, data.data?.tweets, data.data?.replies, data.data).map(compactTweet).filter(Boolean);
  return pageOf(items, data);
}

async function handleTweetQuotations({ tweet_id, cursor }) {
  const data = await api('/twitter/tweet/quotations', { tweetId: tweet_id, cursor });
  const items = firstArray(data.tweets, data.quotations, data.data?.tweets, data.data?.quotations, data.data).map(compactTweet).filter(Boolean);
  return pageOf(items, data);
}

async function handleTweetsByIds({ ids }) {
  const data = await api('/twitter/tweets', { tweetIds: ids.join(',') });
  return firstArray(data.tweets, data.data?.tweets, data.data).map(compactTweet).filter(Boolean);
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'x-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'search_tweets':     result = await handleSearchTweets(args || {});     break;
      case 'get_user':          result = await handleGetUser(args);                 break;
      case 'user_last_tweets':  result = await handleUserLastTweets(args);          break;
      case 'user_followers':    result = await handleUserFollowers(args);           break;
      case 'user_following':    result = await handleUserFollowing(args);           break;
      case 'user_mentions':     result = await handleUserMentions(args);            break;
      case 'tweet_replies':     result = await handleTweetReplies(args);            break;
      case 'tweet_quotations':  result = await handleTweetQuotations(args);         break;
      case 'tweets_by_ids':     result = await handleTweetsByIds(args);             break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[x-mcp] Ready\n');
