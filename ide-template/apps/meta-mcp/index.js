/**
 * Meta Marketing API — MCP Server
 *
 * Auth: System User Token (non-expiring) from Meta Business Manager.
 * API version: v22.0
 *
 * Env vars:
 *   META_ACCESS_TOKEN          — system user token (required)
 *   META_AD_ACCOUNT_ID         — e.g. act_123456789 (required)
 *   META_PAGE_ID               — Facebook Page ID (optional, enables creative tools)
 *   META_INSTAGRAM_ACCOUNT_ID  — IG Business Account ID (optional, enables IG tools)
 *   META_BUSINESS_ID           — Business Manager ID (optional, enables portfolio tools)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOOL INDEX
 *
 * ── Campaigns & Performance ──────────────────────────────────────────────────
 *   get_campaigns              list campaigns with status and budgets
 *   get_campaign_performance   insights for a campaign (spend, ROAS, CTR…)
 *   get_ad_account_insights    account-level metrics with optional breakdown
 *   get_ad_sets                list ad sets within a campaign
 *   get_ads                    list ads within a campaign or ad set
 *   get_ad_insights            creative-level performance metrics
 *   create_campaign            create new campaign (starts PAUSED)
 *   update_campaign_budget     change daily or lifetime budget
 *   pause_campaign             pause an active campaign
 *   resume_campaign            resume a paused campaign
 *
 * ── Ad Sets & Audiences ──────────────────────────────────────────────────────
 *   create_ad_set              create ad set with targeting (geo, age, interests, custom audiences)
 *   update_ad_set              change ad set status, budget, or end date
 *   search_interests           search interest IDs for targeting (use in create_ad_set)
 *   get_audiences              list custom and lookalike audiences in the ad account
 *   create_custom_audience     create audience from customer email list or pixel events
 *   create_lookalike_audience  create lookalike from a source audience
 *
 * ── Creatives & Media ────────────────────────────────────────────────────────
 *   upload_image               upload image from URL or local path → returns hash
 *   upload_video               upload video from URL → returns video_id
 *   create_ad_creative         create image ad creative (link_data)
 *   create_video_creative      create video ad creative (video_data, for Reels/Stories/Feed)
 *   create_carousel_creative   create carousel ad creative (child_attachments, 2–10 cards)
 *   list_media_library         list uploaded images and videos in the ad account
 *   create_ad                  create ad combining ad set + creative
 *   update_ad                  change ad status (pause, enable, archive)
 *
 * ── Instagram & Pages ────────────────────────────────────────────────────────
 *   get_instagram_insights     IG account metrics (reach, profile views, followers)
 *   get_instagram_media        recent IG posts with engagement stats
 *   get_page_insights          Facebook page metrics
 *
 * ── Business Portfolio (requires META_BUSINESS_ID) ───────────────────────────
 *   get_business_overview      business info + all owned assets summary
 *   list_business_users        all users in Business Manager with roles
 *   list_agencies              partner agencies with shared asset access
 *   update_user_access         add or remove a user's access to an ad account
 *   list_pixels                owned pixels (Datasets) in the business
 *   create_pixel               create a new Meta Pixel / Dataset
 *   assign_pixel_to_account    share a pixel with an ad account
 *   list_custom_conversions    list custom conversion events on the ad account
 *   create_custom_conversion   create a new custom conversion event
 *   list_catalogs              list product catalogs owned by the business
 *   create_catalog             create a new product catalog
 *   list_product_feeds         list product feeds in a catalog
 *   create_product_feed        add a feed URL to a catalog (with schedule)
 *   batch_upload_products      create/update/delete products in a catalog via batch API
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const TOKEN       = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT  = process.env.META_AD_ACCOUNT_ID;
const PAGE_ID     = process.env.META_PAGE_ID ?? null;
const IG_ID       = process.env.META_INSTAGRAM_ACCOUNT_ID ?? null;
const BUSINESS_ID = process.env.META_BUSINESS_ID ?? null;
const API_VERSION = 'v22.0';
const BASE        = `https://graph.facebook.com/${API_VERSION}`;

if (!TOKEN || !AD_ACCOUNT) {
  console.error('[meta-mcp] Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID');
  process.exit(1);
}

// Normalise ad account ID — accept with or without "act_" prefix
const AD_ACCOUNT_ID = AD_ACCOUNT.startsWith('act_') ? AD_ACCOUNT : `act_${AD_ACCOUNT}`;

// ─── Graph API helpers ─────────────────────────────────────────────────────

async function graph(path, params = {}, method = 'GET') {
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  url.searchParams.set('access_token', TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { method });
  const json = await res.json();
  if (json.error) throw new Error(`Meta API error ${json.error.code}: ${json.error.message}`);
  return json;
}

// POST with query-string params — for simple status/budget changes
async function graphPost(path, params = {}) {
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  url.searchParams.set('access_token', TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { method: 'POST' });
  const json = await res.json();
  if (json.error) throw new Error(`Meta API error ${json.error.code}: ${json.error.message}`);
  return json;
}

// POST with form-encoded body — for create operations with complex fields
// (objects/arrays are JSON-stringified automatically)
async function graphCreate(path, params = {}) {
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  url.searchParams.set('access_token', TOKEN);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Meta API error ${json.error.code}: ${json.error.message}`);
  return json;
}

// ─── Utility helpers ───────────────────────────────────────────────────────

function dateParams(date_preset, since, until) {
  if (since && until) return { since, until };
  return { date_preset: date_preset ?? 'last_7d' };
}

function budgetDisplay(cents) {
  if (!cents) return null;
  return (parseInt(cents, 10) / 100).toFixed(2);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str.trim().toLowerCase()).digest('hex');
}

function requireBusiness() {
  if (!BUSINESS_ID) {
    throw new Error(
      'META_BUSINESS_ID is not configured. Add it to .env to use Business Portfolio tools.'
    );
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGNS & PERFORMANCE
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'get_campaigns',
    description: 'List campaigns for the ad account with status, objective, and budget.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ALL'],
          description: 'Filter by campaign status (default: ALL)',
        },
        limit: { type: 'number', description: 'Number of campaigns to return (default: 30, max: 100)' },
      },
    },
  },

  {
    name: 'get_campaign_performance',
    description: 'Get performance insights for a campaign: spend, impressions, reach, clicks, CTR, CPC, ROAS, purchases, leads.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month'],
          description: 'Date range preset (default: last_7d)',
        },
        since: { type: 'string', description: 'Start date YYYY-MM-DD (overrides date_preset)' },
        until: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: ['campaign_id'],
    },
  },

  {
    name: 'get_ad_account_insights',
    description: 'Get account-level ad performance metrics. Optionally break down by age, gender, placement, or device.',
    inputSchema: {
      type: 'object',
      properties: {
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month'],
          description: 'Date range preset (default: last_7d)',
        },
        since:     { type: 'string', description: 'Start date YYYY-MM-DD' },
        until:     { type: 'string', description: 'End date YYYY-MM-DD' },
        breakdown: {
          type: 'string',
          enum: ['age', 'gender', 'age,gender', 'device_platform', 'publisher_platform', 'impression_device'],
          description: 'Optional breakdown dimension',
        },
      },
    },
  },

  {
    name: 'get_ad_sets',
    description: 'List ad sets within a campaign with targeting summary, status, and budget.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        limit: { type: 'number', description: 'Number of ad sets to return (default: 20)' },
      },
      required: ['campaign_id'],
    },
  },

  {
    name: 'get_ads',
    description: 'List individual ads within a campaign or ad set with creative details and status.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID (list all ads in campaign)' },
        ad_set_id:   { type: 'string', description: 'Ad set ID (list ads in a specific ad set)' },
        limit: { type: 'number', description: 'Number of ads to return (default: 20)' },
      },
    },
  },

  {
    name: 'get_ad_insights',
    description: 'Get per-ad (creative-level) performance: spend, impressions, clicks, CTR, CPC, purchases, ROAS. Use to identify best-performing creatives.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'All ads in this campaign' },
        ad_set_id:   { type: 'string', description: 'All ads in this ad set' },
        ad_id:       { type: 'string', description: 'Single specific ad' },
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month'],
          description: 'Date range preset (default: last_7d)',
        },
        since: { type: 'string', description: 'Start date YYYY-MM-DD' },
        until: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
    },
  },

  {
    name: 'create_campaign',
    description: 'Create a new Meta Ads campaign. Starts PAUSED: activate with resume_campaign when ready.',
    inputSchema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Campaign name.' },
        objective: {
          type: 'string',
          enum: ['OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_LEADS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_APP_PROMOTION'],
          description: 'Campaign objective (default: OUTCOME_SALES).',
        },
        daily_budget:    { type: 'number', description: 'Daily budget in account currency (e.g. 50.00).' },
        lifetime_budget: { type: 'number', description: 'Lifetime budget in account currency.' },
        special_ad_categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pass [] for standard ads. Use ["CREDIT"], ["EMPLOYMENT"], or ["HOUSING"] for regulated categories.',
        },
      },
      required: ['name'],
    },
  },

  {
    name: 'update_campaign_budget',
    description: 'Update the daily or lifetime budget of a campaign. Amount in account currency (e.g. 50.00).',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id:     { type: 'string', description: 'Campaign ID' },
        daily_budget:    { type: 'number', description: 'New daily budget' },
        lifetime_budget: { type: 'number', description: 'New lifetime budget' },
      },
      required: ['campaign_id'],
    },
  },

  {
    name: 'pause_campaign',
    description: 'Pause an active campaign immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID to pause' },
      },
      required: ['campaign_id'],
    },
  },

  {
    name: 'resume_campaign',
    description: 'Resume (activate) a paused campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID to resume' },
      },
      required: ['campaign_id'],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AD SETS & AUDIENCES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'create_ad_set',
    description: 'Create an ad set inside a campaign. Defines audience targeting (geo, age, gender, interests, custom audiences), budget, schedule, and optimization goal.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id:       { type: 'string', description: 'Campaign ID.' },
        name:              { type: 'string', description: 'Ad set name.' },
        daily_budget:      { type: 'number', description: 'Daily budget in account currency. Either daily or lifetime required.' },
        lifetime_budget:   { type: 'number', description: 'Lifetime budget in account currency.' },
        optimization_goal: {
          type: 'string',
          enum: ['OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS', 'LANDING_PAGE_VIEWS', 'LEAD_GENERATION', 'VALUE'],
          description: 'What to optimize for (default: OFFSITE_CONVERSIONS for OUTCOME_SALES).',
        },
        billing_event: {
          type: 'string',
          enum: ['IMPRESSIONS', 'LINK_CLICKS'],
          description: 'When you get charged (default: IMPRESSIONS).',
        },
        bid_strategy: {
          type: 'string',
          enum: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
          description: 'Bidding strategy (default: LOWEST_COST_WITHOUT_CAP).',
        },
        countries:   { type: 'array', items: { type: 'string' }, description: 'Target countries as ISO codes, e.g. ["PL", "DE"].' },
        age_min:     { type: 'number', description: 'Minimum age (default: 18).' },
        age_max:     { type: 'number', description: 'Maximum age (default: 65).' },
        genders:     { type: 'string', enum: ['all', 'male', 'female'], description: 'Target gender (default: all).' },
        placements:  { type: 'string', enum: ['all', 'facebook', 'instagram'], description: 'Platforms (default: all).' },
        interests: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id'] },
          description: 'Interest IDs from search_interests, e.g. [{"id": "6003139266461", "name": "Fashion"}]. Combined with OR logic.',
        },
        behaviors: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id'] },
          description: 'Behavior IDs for targeting (e.g. online shoppers). Combined with OR logic alongside interests.',
        },
        custom_audience_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom or lookalike audience IDs from get_audiences to include in targeting.',
        },
        excluded_audience_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom audience IDs to exclude from targeting.',
        },
        start_time:  { type: 'string', description: 'Start date YYYY-MM-DD (default: today).' },
        end_time:    { type: 'string', description: 'End date YYYY-MM-DD (optional).' },
      },
      required: ['campaign_id', 'name'],
    },
  },

  {
    name: 'update_ad_set',
    description: 'Update an ad set: change status, daily budget, or end date.',
    inputSchema: {
      type: 'object',
      properties: {
        ad_set_id:      { type: 'string', description: 'Ad set ID.' },
        status:         { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'], description: 'New status.' },
        daily_budget:   { type: 'number', description: 'New daily budget in account currency.' },
        end_time:       { type: 'string', description: 'New end date YYYY-MM-DD.' },
      },
      required: ['ad_set_id'],
    },
  },

  {
    name: 'search_interests',
    description: 'Search Meta interest and behavior categories by keyword. Returns IDs and audience sizes to use in create_ad_set.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Search term, e.g. "fashion", "wedding", "luxury".' },
        locale: { type: 'string', description: 'Locale for result names (default: en_US).' },
        limit:  { type: 'number', description: 'Number of results (default: 10, max: 30).' },
      },
      required: ['query'],
    },
  },

  {
    name: 'get_audiences',
    description: 'List custom audiences and lookalike audiences in the ad account. Returns IDs to use in create_ad_set.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of audiences to return (default: 30).' },
      },
    },
  },

  {
    name: 'create_custom_audience',
    description: 'Create a custom audience from a customer email list (hashed automatically) or from pixel events (website visitors, purchasers, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Audience name.' },
        description: { type: 'string', description: 'Optional description.' },
        type: {
          type: 'string',
          enum: ['customer_list', 'website'],
          description: '"customer_list": upload email addresses (hashed with SHA-256 before sending). "website": pixel-based audience from site events.',
        },
        emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'For type "customer_list": plaintext email addresses. They are SHA-256 hashed before upload, so do NOT pre-hash.',
        },
        pixel_id: {
          type: 'string',
          description: 'For type "website": the Pixel/Dataset ID to base the audience on.',
        },
        event: {
          type: 'string',
          description: 'For type "website": pixel event to match, e.g. "PageView", "Purchase", "AddToCart", "InitiateCheckout".',
        },
        retention_days: {
          type: 'number',
          description: 'For type "website": how many days back to include (default: 30, max: 180).',
        },
      },
      required: ['name', 'type'],
    },
  },

  {
    name: 'create_lookalike_audience',
    description: 'Create a lookalike audience from an existing custom audience. Meta finds users who resemble your source audience.',
    inputSchema: {
      type: 'object',
      properties: {
        name:               { type: 'string', description: 'Audience name.' },
        source_audience_id: { type: 'string', description: 'Source custom audience ID (min 100 members from a single country).' },
        country:            { type: 'string', description: 'Target country ISO code, e.g. "PL", "DE", "US".' },
        ratio: {
          type: 'number',
          description: 'Top X% of the country population (0.01 = 1%, 0.10 = 10%). Default: 0.02. Higher = broader, less similar.',
        },
      },
      required: ['name', 'source_audience_id', 'country'],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATIVES & MEDIA
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'upload_image',
    description: 'Upload an image to the Meta ad account library. Returns an image hash needed for create_ad_creative or create_carousel_creative. Accepts a public HTTPS URL or a local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Public HTTPS URL or local file path (e.g. /home/coder/project/generated/img.jpeg).' },
        name:  { type: 'string', description: 'Name for the image in the library (optional).' },
      },
      required: ['image'],
    },
  },

  {
    name: 'upload_video',
    description: 'Upload a video to the Meta ad account library from a public URL. Returns a video_id needed for create_video_creative. Meta fetches the video asynchronously, so status will show "processing" initially.',
    inputSchema: {
      type: 'object',
      properties: {
        file_url: { type: 'string', description: 'Public HTTPS URL of the video file (MP4 or MOV, H.264). Must be publicly accessible.' },
        title:    { type: 'string', description: 'Title for the video in the library (optional).' },
      },
      required: ['file_url'],
    },
  },

  {
    name: 'create_ad_creative',
    description: 'Create an image ad creative: combines an image with copy (text, headline, CTA) and a destination URL. Returns a creative_id for create_ad. Requires META_PAGE_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string', description: 'Creative name (internal label).' },
        image_hash:   { type: 'string', description: 'Image hash from upload_image.' },
        message:      { type: 'string', description: 'Main post text / caption shown above the image.' },
        headline:     { type: 'string', description: 'Bold headline below the image (max 40 chars recommended).' },
        description:  { type: 'string', description: 'Small description below the headline (optional).' },
        link:         { type: 'string', description: 'Destination URL when user clicks the ad.' },
        call_to_action: {
          type: 'string',
          enum: ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US', 'DOWNLOAD', 'GET_OFFER', 'SUBSCRIBE', 'WATCH_MORE'],
          description: 'CTA button label (default: SHOP_NOW).',
        },
        instagram_user_id: {
          type: 'string',
          description: 'Instagram Business Account ID to show the ad from Instagram. Uses META_INSTAGRAM_ACCOUNT_ID if not provided.',
        },
      },
      required: ['name', 'image_hash', 'message', 'link'],
    },
  },

  {
    name: 'create_video_creative',
    description: 'Create a video ad creative for Reels, Stories, or Feed. Uses video_data format. Requires META_PAGE_ID. Call upload_video first to get a video_id.',
    inputSchema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Creative name (internal label).' },
        video_id:  { type: 'string', description: 'Video ID from upload_video.' },
        message:   { type: 'string', description: 'Main post caption / body text.' },
        title:     { type: 'string', description: 'Headline / title text (optional).' },
        link:      { type: 'string', description: 'Destination URL when user clicks the ad.' },
        call_to_action: {
          type: 'string',
          enum: ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US', 'DOWNLOAD', 'GET_OFFER', 'SUBSCRIBE', 'WATCH_MORE'],
          description: 'CTA button label (default: SHOP_NOW).',
        },
        image_url: {
          type: 'string',
          description: 'Custom thumbnail URL. If omitted, Meta selects a frame automatically.',
        },
        instagram_user_id: {
          type: 'string',
          description: 'Instagram Business Account ID to run the ad from Instagram. Uses META_INSTAGRAM_ACCOUNT_ID if not provided.',
        },
      },
      required: ['name', 'video_id', 'message', 'link'],
    },
  },

  {
    name: 'create_carousel_creative',
    description: 'Create a carousel ad creative with 2–10 cards. Each card has its own image, headline, and destination URL. Requires META_PAGE_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Creative name (internal label).' },
        message: { type: 'string', description: 'Main post caption shown above the carousel.' },
        cards: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          description: 'Array of 2–10 cards. Each card needs link + image_hash or image_url.',
          items: {
            type: 'object',
            properties: {
              link:        { type: 'string', description: 'Destination URL for this card.' },
              image_hash:  { type: 'string', description: 'Image hash from upload_image (preferred).' },
              image_url:   { type: 'string', description: 'Public image URL (alternative to image_hash).' },
              video_id:    { type: 'string', description: 'Video ID for video card (instead of image).' },
              name:        { type: 'string', description: 'Card title / headline.' },
              description: { type: 'string', description: 'Card description (Facebook only).' },
              call_to_action: {
                type: 'string',
                enum: ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US', 'GET_OFFER'],
                description: 'CTA button for this card (default: SHOP_NOW).',
              },
            },
            required: ['link'],
          },
        },
        default_link: { type: 'string', description: 'Fallback link for the carousel (used when no card link applies).' },
        multi_share_optimized: {
          type: 'boolean',
          description: 'Let Meta automatically reorder cards to maximize performance (default: true).',
        },
        instagram_user_id: {
          type: 'string',
          description: 'Instagram Business Account ID. Uses META_INSTAGRAM_ACCOUNT_ID if not provided.',
        },
      },
      required: ['name', 'message', 'cards'],
    },
  },

  {
    name: 'list_media_library',
    description: 'List uploaded images and videos in the ad account library. Useful to find existing asset hashes/IDs before creating new creatives.',
    inputSchema: {
      type: 'object',
      properties: {
        type:  { type: 'string', enum: ['images', 'videos', 'all'], description: 'What to list (default: all).' },
        limit: { type: 'number', description: 'Number of items to return per type (default: 20).' },
      },
    },
  },

  {
    name: 'create_ad',
    description: 'Create an ad by combining an ad set and a creative. This is the final step: the ad is what users see.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Ad name.' },
        ad_set_id:   { type: 'string', description: 'Ad set ID.' },
        creative_id: { type: 'string', description: 'Creative ID from create_ad_creative / create_video_creative / create_carousel_creative.' },
        status:      { type: 'string', enum: ['ACTIVE', 'PAUSED'], description: 'Initial status (default: PAUSED).' },
      },
      required: ['name', 'ad_set_id', 'creative_id'],
    },
  },

  {
    name: 'update_ad',
    description: 'Change the status of an existing ad (pause, enable, or archive).',
    inputSchema: {
      type: 'object',
      properties: {
        ad_id:  { type: 'string', description: 'Ad ID.' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'], description: 'New status.' },
      },
      required: ['ad_id', 'status'],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INSTAGRAM & PAGES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'get_instagram_insights',
    description: 'Get Instagram Business account metrics: reach, profile views, follower count. Requires META_INSTAGRAM_ACCOUNT_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start date YYYY-MM-DD' },
        until: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
      },
    },
  },

  {
    name: 'get_instagram_media',
    description: 'List recent Instagram posts with like count, comments, and per-post insights (reach, views, saves). Requires META_INSTAGRAM_ACCOUNT_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of posts to return (default: 12)' },
      },
    },
  },

  {
    name: 'get_page_insights',
    description: 'Get Facebook Page metrics: impressions, reach, page views, new fans, post engagements. Requires META_PAGE_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['day', 'week', 'days_28'],
          description: 'Aggregation period (default: day)',
        },
        since: { type: 'string', description: 'Start date YYYY-MM-DD' },
        until: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BUSINESS PORTFOLIO  (requires META_BUSINESS_ID)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'get_business_overview',
    description: 'Get Business Manager info and a summary of all owned assets: ad accounts, pages, pixels, catalogs, Instagram accounts. Requires META_BUSINESS_ID.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'list_business_users',
    description: 'List all users in the Business Manager with their roles and assigned assets. Requires META_BUSINESS_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of users to return (default: 50).' },
      },
    },
  },

  {
    name: 'list_agencies',
    description: 'List partner agencies that have access to this Business Manager. Requires META_BUSINESS_ID.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'update_user_access',
    description: 'Add or remove a user\'s access to an ad account. Tasks: MANAGE (admin), ADVERTISE (create/edit ads), ANALYZE (read-only insights). Requires META_BUSINESS_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: '"add" to grant access, "remove" to revoke.',
        },
        user_id:        { type: 'string', description: 'Facebook user ID to add or remove.' },
        ad_account_id:  { type: 'string', description: 'Ad account ID (with or without "act_" prefix).' },
        tasks: {
          type: 'array',
          items: { type: 'string', enum: ['MANAGE', 'ADVERTISE', 'ANALYZE'] },
          description: 'Access tasks to assign (required when action is "add"). MANAGE includes all tasks.',
        },
      },
      required: ['action', 'user_id', 'ad_account_id'],
    },
  },

  {
    name: 'list_pixels',
    description: 'List all Meta Pixels (Datasets) owned by the Business Manager. Requires META_BUSINESS_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of pixels to return (default: 20).' },
      },
    },
  },

  {
    name: 'create_pixel',
    description: 'Create a new Meta Pixel / Dataset in the Business Manager. Returns the pixel ID. Requires META_BUSINESS_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pixel name, e.g. "Store Pixel".' },
      },
      required: ['name'],
    },
  },

  {
    name: 'assign_pixel_to_account',
    description: 'Share a pixel with an ad account so campaigns can use it for conversion tracking and custom audiences.',
    inputSchema: {
      type: 'object',
      properties: {
        pixel_id:      { type: 'string', description: 'Pixel ID to share.' },
        ad_account_id: { type: 'string', description: 'Ad account ID (with or without "act_" prefix).' },
      },
      required: ['pixel_id', 'ad_account_id'],
    },
  },

  {
    name: 'list_custom_conversions',
    description: 'List custom conversion events on the ad account.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of conversions to return (default: 30).' },
      },
    },
  },

  {
    name: 'create_custom_conversion',
    description: 'Create a custom conversion event on the ad account. Tracks specific actions (purchases above a value, specific page visits, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Conversion name, e.g. "High-Value Purchase".' },
        description: { type: 'string', description: 'Optional description.' },
        pixel_id:    { type: 'string', description: 'Pixel ID to track conversions on.' },
        event_type: {
          type: 'string',
          enum: ['PURCHASE', 'LEAD', 'COMPLETE_REGISTRATION', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'VIEW_CONTENT', 'SEARCH', 'SUBSCRIBE', 'START_TRIAL', 'OTHER'],
          description: 'Standard event type to base the conversion on.',
        },
        url_contains: {
          type: 'string',
          description: 'Optional URL substring to filter: only count events from URLs containing this string.',
        },
        min_value: {
          type: 'number',
          description: 'Optional minimum event value: only count purchases above this amount.',
        },
      },
      required: ['name', 'pixel_id', 'event_type'],
    },
  },

  {
    name: 'list_catalogs',
    description: 'List product catalogs owned by the Business Manager. Requires META_BUSINESS_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of catalogs to return (default: 20).' },
      },
    },
  },

  {
    name: 'create_catalog',
    description: 'Create a new product catalog in the Business Manager. Requires META_BUSINESS_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Catalog name, e.g. "Spring 2025 Collection".' },
      },
      required: ['name'],
    },
  },

  {
    name: 'list_product_feeds',
    description: 'List product feeds (upload URLs and schedules) in a catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        catalog_id: { type: 'string', description: 'Product catalog ID.' },
      },
      required: ['catalog_id'],
    },
  },

  {
    name: 'create_product_feed',
    description: 'Add a product feed URL to a catalog. Meta will fetch the feed on the given schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        catalog_id: { type: 'string', description: 'Product catalog ID.' },
        name:       { type: 'string', description: 'Feed name.' },
        url:        { type: 'string', description: 'Public URL of the feed file (CSV, TSV, XML, or Google Sheets link).' },
        interval: {
          type: 'string',
          enum: ['HOURLY', 'DAILY', 'WEEKLY'],
          description: 'Fetch interval (default: DAILY).',
        },
        hour: {
          type: 'number',
          description: 'Hour of day (0–23) to fetch the feed when interval is DAILY (default: 6).',
        },
      },
      required: ['catalog_id', 'name', 'url'],
    },
  },

  {
    name: 'batch_upload_products',
    description: 'Create, update, or delete products in a catalog via batch API. Price format: "10.00 USD". Max 50 items per call.',
    inputSchema: {
      type: 'object',
      properties: {
        catalog_id: { type: 'string', description: 'Product catalog ID.' },
        requests: {
          type: 'array',
          maxItems: 50,
          description: 'Array of product operations.',
          items: {
            type: 'object',
            properties: {
              method: {
                type: 'string',
                enum: ['CREATE', 'UPDATE', 'DELETE'],
                description: 'Operation type.',
              },
              retailer_id: { type: 'string', description: 'Your internal product SKU/ID (used as stable identifier).' },
              data: {
                type: 'object',
                description: 'Product fields. Required for CREATE: availability, condition, description, image_url, link, title, price (e.g. "10.00 USD").',
                properties: {
                  availability:   { type: 'string', enum: ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'AVAILABLE_FOR_ORDER'] },
                  condition:      { type: 'string', enum: ['NEW', 'REFURBISHED', 'USED'] },
                  description:    { type: 'string' },
                  image_url:      { type: 'string' },
                  link:           { type: 'string', description: 'Product page URL.' },
                  title:          { type: 'string' },
                  price:          { type: 'string', description: 'Price with currency, e.g. "89.00 EUR".' },
                  brand:          { type: 'string' },
                  sale_price:     { type: 'string', description: 'Sale price if discounted, e.g. "59.00 EUR".' },
                  additional_image_urls: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            required: ['method', 'retailer_id'],
          },
        },
      },
      required: ['catalog_id', 'requests'],
    },
  },

];

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name, args) {

  // ── get_campaigns ──────────────────────────────────────────────────────
  if (name === 'get_campaigns') {
    const fields = 'id,name,status,objective,daily_budget,lifetime_budget,spend_cap,start_time,stop_time,updated_time';
    const params = { fields, limit: Math.min(args.limit ?? 30, 100) };
    if (args.status && args.status !== 'ALL') {
      params.effective_status = JSON.stringify([args.status]);
    }
    const data = await graph(`${AD_ACCOUNT_ID}/campaigns`, params);
    const campaigns = (data.data ?? []).map(c => ({
      id:              c.id,
      name:            c.name,
      status:          c.status,
      objective:       c.objective,
      daily_budget:    budgetDisplay(c.daily_budget),
      lifetime_budget: budgetDisplay(c.lifetime_budget),
      spend_cap:       budgetDisplay(c.spend_cap),
      start_time:      c.start_time,
      stop_time:       c.stop_time,
      updated_time:    c.updated_time,
    }));
    return `Found ${campaigns.length} campaigns:\n\n${JSON.stringify(campaigns, null, 2)}`;
  }

  // ── get_campaign_performance ───────────────────────────────────────────
  if (name === 'get_campaign_performance') {
    const { campaign_id, date_preset, since, until } = args;
    const fields = [
      'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
      'clicks', 'ctr', 'cpc', 'cpp',
      'actions', 'action_values', 'purchase_roas', 'cost_per_action_type',
    ].join(',');
    const params = { fields, level: 'campaign', ...dateParams(date_preset, since, until) };
    const data = await graph(`${campaign_id}/insights`, params);
    const rows = data.data ?? [];
    if (rows.length === 0) return `No data for campaign ${campaign_id} in the selected date range.`;
    const r = rows[0];
    const purchases    = (r.actions ?? []).find(a => a.action_type === 'purchase');
    const leads        = (r.actions ?? []).find(a => a.action_type === 'lead');
    const purchaseVal  = (r.action_values ?? []).find(a => a.action_type === 'purchase');
    return JSON.stringify({
      campaign:       r.campaign_name,
      date_range:     { since: r.date_start, until: r.date_stop },
      spend:          r.spend,
      impressions:    r.impressions,
      reach:          r.reach,
      frequency:      r.frequency,
      clicks:         r.clicks,
      ctr:            r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : null,
      cpc:            r.cpc,
      cpp:            r.cpp,
      purchases:      purchases?.value ?? 0,
      purchase_value: purchaseVal?.value ?? 0,
      roas:           r.purchase_roas?.[0]?.value ?? null,
      leads:          leads?.value ?? 0,
    }, null, 2);
  }

  // ── get_ad_account_insights ────────────────────────────────────────────
  if (name === 'get_ad_account_insights') {
    const { date_preset, since, until, breakdown } = args;
    const fields = [
      'spend', 'impressions', 'reach', 'frequency',
      'clicks', 'ctr', 'cpc', 'cpp',
      'actions', 'action_values', 'purchase_roas',
    ].join(',');
    const params = { fields, level: 'account', ...dateParams(date_preset, since, until) };
    if (breakdown) params.breakdowns = breakdown;
    const data = await graph(`${AD_ACCOUNT_ID}/insights`, params);
    const rows = data.data ?? [];
    if (rows.length === 0) return 'No data for the selected date range.';
    const result = rows.map(r => {
      const purchases    = (r.actions ?? []).find(a => a.action_type === 'purchase');
      const purchaseVal  = (r.action_values ?? []).find(a => a.action_type === 'purchase');
      const leads        = (r.actions ?? []).find(a => a.action_type === 'lead');
      return {
        ...(r.age             ? { age: r.age }              : {}),
        ...(r.gender          ? { gender: r.gender }        : {}),
        ...(r.device_platform ? { device: r.device_platform } : {}),
        ...(r.publisher_platform ? { placement: r.publisher_platform } : {}),
        date_range:     { since: r.date_start, until: r.date_stop },
        spend:          r.spend,
        impressions:    r.impressions,
        reach:          r.reach,
        clicks:         r.clicks,
        ctr:            r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : null,
        cpc:            r.cpc,
        purchases:      purchases?.value ?? 0,
        purchase_value: purchaseVal?.value ?? 0,
        roas:           r.purchase_roas?.[0]?.value ?? null,
        leads:          leads?.value ?? 0,
      };
    });
    return JSON.stringify(result, null, 2);
  }

  // ── get_ad_sets ────────────────────────────────────────────────────────
  if (name === 'get_ad_sets') {
    const fields = 'id,name,status,daily_budget,lifetime_budget,start_time,end_time,targeting,optimization_goal,billing_event';
    const data = await graph(`${args.campaign_id}/adsets`, { fields, limit: args.limit ?? 20 });
    const adsets = (data.data ?? []).map(s => ({
      id:               s.id,
      name:             s.name,
      status:           s.status,
      daily_budget:     budgetDisplay(s.daily_budget),
      lifetime_budget:  budgetDisplay(s.lifetime_budget),
      optimization_goal: s.optimization_goal,
      billing_event:    s.billing_event,
      start_time:       s.start_time,
      end_time:         s.end_time,
      targeting: {
        age_min:       s.targeting?.age_min,
        age_max:       s.targeting?.age_max,
        genders:       s.targeting?.genders,
        countries:     s.targeting?.geo_locations?.countries,
        placements:    s.targeting?.publisher_platforms,
        custom_audiences: s.targeting?.custom_audiences?.map(a => a.id),
      },
    }));
    return `Found ${adsets.length} ad sets:\n\n${JSON.stringify(adsets, null, 2)}`;
  }

  // ── get_ads ────────────────────────────────────────────────────────────
  if (name === 'get_ads') {
    const { campaign_id, ad_set_id, limit } = args;
    const fields = 'id,name,status,adset_id,campaign_id,creative{id,name,title,body,image_url},updated_time';
    let path;
    if (ad_set_id)       path = `${ad_set_id}/ads`;
    else if (campaign_id) path = `${campaign_id}/ads`;
    else                  path = `${AD_ACCOUNT_ID}/ads`;
    const data = await graph(path, { fields, limit: limit ?? 20 });
    return `Found ${data.data?.length ?? 0} ads:\n\n${JSON.stringify(data.data ?? [], null, 2)}`;
  }

  // ── get_ad_insights ────────────────────────────────────────────────────
  if (name === 'get_ad_insights') {
    const { campaign_id, ad_set_id, ad_id, date_preset, since, until } = args;
    const fields = [
      'ad_name', 'adset_name', 'campaign_name',
      'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpp',
      'actions', 'action_values', 'purchase_roas',
    ].join(',');
    let path;
    if (ad_id)        path = `${ad_id}/insights`;
    else if (ad_set_id)   path = `${ad_set_id}/insights`;
    else if (campaign_id) path = `${campaign_id}/insights`;
    else              path = `${AD_ACCOUNT_ID}/insights`;
    const params = { fields, level: 'ad', ...dateParams(date_preset, since, until) };
    const data = await graph(path, params);
    const rows = data.data ?? [];
    if (rows.length === 0) return 'No ad data for the selected date range.';
    const result = rows.map(r => {
      const purchases    = (r.actions ?? []).find(a => a.action_type === 'purchase');
      const purchaseVal  = (r.action_values ?? []).find(a => a.action_type === 'purchase');
      return {
        ad:             r.ad_name,
        ad_set:         r.adset_name,
        campaign:       r.campaign_name,
        date_range:     { since: r.date_start, until: r.date_stop },
        spend:          r.spend,
        impressions:    r.impressions,
        reach:          r.reach,
        clicks:         r.clicks,
        ctr:            r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : null,
        cpc:            r.cpc,
        purchases:      purchases?.value ?? 0,
        purchase_value: purchaseVal?.value ?? 0,
        roas:           r.purchase_roas?.[0]?.value ?? null,
      };
    }).sort((a, b) => parseFloat(b.spend || 0) - parseFloat(a.spend || 0));
    return JSON.stringify(result, null, 2);
  }

  // ── create_campaign ────────────────────────────────────────────────────
  if (name === 'create_campaign') {
    const { name: cName, objective = 'OUTCOME_SALES', daily_budget, lifetime_budget, special_ad_categories = [] } = args;
    if (!daily_budget && !lifetime_budget) throw new Error('Provide daily_budget or lifetime_budget.');
    const params = {
      name:                  cName,
      objective,
      status:                'PAUSED',
      special_ad_categories,
    };
    if (daily_budget)    params.daily_budget    = Math.round(daily_budget * 100);
    if (lifetime_budget) params.lifetime_budget = Math.round(lifetime_budget * 100);
    const result = await graphCreate(`${AD_ACCOUNT_ID}/campaigns`, params);
    return `Campaign created (PAUSED).\nID: ${result.id}\n\nActivate with resume_campaign when ready.`;
  }

  // ── update_campaign_budget ─────────────────────────────────────────────
  if (name === 'update_campaign_budget') {
    const { campaign_id, daily_budget, lifetime_budget } = args;
    if (!daily_budget && !lifetime_budget) return 'Provide daily_budget or lifetime_budget.';
    const params = {};
    if (daily_budget)    params.daily_budget    = Math.round(daily_budget * 100);
    if (lifetime_budget) params.lifetime_budget = Math.round(lifetime_budget * 100);
    const result = await graphPost(campaign_id, params);
    if (result.success) {
      const lines = [];
      if (daily_budget)    lines.push(`daily budget → ${daily_budget}`);
      if (lifetime_budget) lines.push(`lifetime budget → ${lifetime_budget}`);
      return `Campaign ${campaign_id} updated: ${lines.join(', ')}.`;
    }
    return `Unexpected response: ${JSON.stringify(result)}`;
  }

  // ── pause_campaign ─────────────────────────────────────────────────────
  if (name === 'pause_campaign') {
    const result = await graphPost(args.campaign_id, { status: 'PAUSED' });
    return result.success ? `Campaign ${args.campaign_id} paused.` : `Unexpected: ${JSON.stringify(result)}`;
  }

  // ── resume_campaign ────────────────────────────────────────────────────
  if (name === 'resume_campaign') {
    const result = await graphPost(args.campaign_id, { status: 'ACTIVE' });
    return result.success ? `Campaign ${args.campaign_id} resumed.` : `Unexpected: ${JSON.stringify(result)}`;
  }

  // ── create_ad_set ──────────────────────────────────────────────────────
  if (name === 'create_ad_set') {
    const {
      campaign_id, name: sName,
      daily_budget, lifetime_budget,
      optimization_goal = 'OFFSITE_CONVERSIONS',
      billing_event = 'IMPRESSIONS',
      bid_strategy = 'LOWEST_COST_WITHOUT_CAP',
      countries = ['US'],
      age_min = 18, age_max = 65,
      genders = 'all',
      placements = 'all',
      interests,
      behaviors,
      custom_audience_ids,
      excluded_audience_ids,
      start_time, end_time,
    } = args;

    if (!daily_budget && !lifetime_budget) throw new Error('Provide daily_budget or lifetime_budget.');

    const targeting = {
      age_min,
      age_max,
      geo_locations: { countries },
    };

    // Gender
    if (genders === 'male')   targeting.genders = [1];
    if (genders === 'female') targeting.genders = [2];

    // Placement targeting
    if (placements === 'facebook') {
      targeting.publisher_platforms = ['facebook'];
      targeting.facebook_positions  = ['feed', 'story', 'reels'];
    } else if (placements === 'instagram') {
      targeting.publisher_platforms = ['instagram'];
      targeting.instagram_positions = ['stream', 'story', 'reels'];
    }
    // 'all' → omit publisher_platforms, Meta uses all

    // Interest + behavior targeting via flexible_spec
    // flexible_spec: each object in the array is AND-joined; items within an object are OR-joined
    const flexSpec = {};
    if (interests && interests.length > 0) {
      flexSpec.interests = interests.map(i => ({ id: i.id, name: i.name ?? i.id }));
    }
    if (behaviors && behaviors.length > 0) {
      flexSpec.behaviors = behaviors.map(b => ({ id: b.id, name: b.name ?? b.id }));
    }
    if (Object.keys(flexSpec).length > 0) {
      targeting.flexible_spec = [flexSpec];
    }

    // Custom / lookalike audience inclusion
    if (custom_audience_ids && custom_audience_ids.length > 0) {
      targeting.custom_audiences = custom_audience_ids.map(id => ({ id }));
    }

    // Excluded audiences
    if (excluded_audience_ids && excluded_audience_ids.length > 0) {
      targeting.excluded_custom_audiences = excluded_audience_ids.map(id => ({ id }));
    }

    const params = {
      name:              sName,
      campaign_id,
      optimization_goal,
      billing_event,
      bid_strategy,
      targeting,
      status:            'PAUSED',
    };
    if (daily_budget)    params.daily_budget    = Math.round(daily_budget * 100);
    if (lifetime_budget) params.lifetime_budget = Math.round(lifetime_budget * 100);
    if (start_time) params.start_time = start_time;
    if (end_time)   params.end_time   = end_time;

    const result = await graphCreate(`${AD_ACCOUNT_ID}/adsets`, params);
    return `Ad set created (PAUSED).\nID: ${result.id}\n\nTargeting: ${JSON.stringify({ countries, age_min, age_max, genders, placements, interests: interests?.length ?? 0, custom_audiences: custom_audience_ids?.length ?? 0 }, null, 2)}`;
  }

  // ── update_ad_set ──────────────────────────────────────────────────────
  if (name === 'update_ad_set') {
    const { ad_set_id, status, daily_budget, end_time } = args;
    const params = {};
    if (status)       params.status       = status;
    if (daily_budget) params.daily_budget = Math.round(daily_budget * 100);
    if (end_time)     params.end_time     = end_time;
    if (Object.keys(params).length === 0) return 'No updates provided.';
    const result = await graphPost(ad_set_id, params);
    return result.success ? `Ad set ${ad_set_id} updated.` : `Unexpected: ${JSON.stringify(result)}`;
  }

  // ── search_interests ───────────────────────────────────────────────────
  if (name === 'search_interests') {
    const { query, locale = 'en_US', limit = 10 } = args;
    const data = await graph('search', {
      type:   'adinterest',
      q:      query,
      locale,
      limit:  Math.min(limit, 30),
    });
    const results = (data.data ?? []).map(i => ({
      id:           i.id,
      name:         i.name,
      audience_size_lower: i.audience_size_lower_bound,
      audience_size_upper: i.audience_size_upper_bound,
      path:         i.path?.join(' > '),
      topic:        i.topic,
    }));
    return `Found ${results.length} interests for "${query}":\n\n${JSON.stringify(results, null, 2)}\n\nUse id + name in create_ad_set interests field.`;
  }

  // ── get_audiences ──────────────────────────────────────────────────────
  if (name === 'get_audiences') {
    const fields = 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,description,operation_status,data_source,time_updated';
    const data = await graph(`${AD_ACCOUNT_ID}/customaudiences`, {
      fields,
      limit: args.limit ?? 30,
    });
    const audiences = (data.data ?? []).map(a => ({
      id:          a.id,
      name:        a.name,
      type:        a.subtype,
      size_approx: a.approximate_count_lower_bound != null
        ? `${a.approximate_count_lower_bound.toLocaleString()}–${a.approximate_count_upper_bound?.toLocaleString()}`
        : 'unknown',
      status:      a.operation_status?.code === 200 ? 'ready' : a.operation_status?.description,
      description: a.description,
      updated:     a.time_updated,
    }));
    return `Found ${audiences.length} audiences:\n\n${JSON.stringify(audiences, null, 2)}`;
  }

  // ── create_custom_audience ─────────────────────────────────────────────
  if (name === 'create_custom_audience') {
    const { name: aName, description, type, emails, pixel_id, event, retention_days = 30 } = args;

    if (type === 'customer_list') {
      // Create the audience shell
      const audience = await graphCreate(`${AD_ACCOUNT_ID}/customaudiences`, {
        name:                 aName,
        subtype:              'CUSTOM',
        description:          description ?? '',
        customer_file_source: 'USER_PROVIDED_ONLY',
      });

      // Upload hashed emails if provided
      if (emails && emails.length > 0) {
        const hashed = emails.map(e => [sha256(e)]);
        await graphCreate(`${audience.id}/users`, {
          payload: { schema: ['EMAIL'], data: hashed },
        });
        return `Custom audience created.\nID: ${audience.id}\nName: ${aName}\nEmails uploaded: ${emails.length} (SHA-256 hashed before sending).`;
      }
      return `Custom audience created (empty).\nID: ${audience.id}\nName: ${aName}\nAdd users via the Meta UI or call this tool again with emails.`;
    }

    if (type === 'website') {
      if (!pixel_id) throw new Error('pixel_id is required for website audience type.');
      if (!event)    throw new Error('event is required for website audience type (e.g. "PageView", "Purchase").');

      const retentionSeconds = retention_days * 86400;
      const rule = {
        inclusions: {
          operator: 'or',
          rules: [{
            event_sources: [{ id: pixel_id, type: 'pixel' }],
            retention_seconds: retentionSeconds,
            filter: {
              operator: 'and',
              filters: [{ field: 'event', operator: '=', value: event }],
            },
          }],
        },
      };

      const audience = await graphCreate(`${AD_ACCOUNT_ID}/customaudiences`, {
        name:           aName,
        subtype:        'WEBSITE',
        retention_days,
        pixel_id,
        rule:           JSON.stringify(rule),
        description:    description ?? `${event} last ${retention_days} days`,
      });
      return `Website audience created.\nID: ${audience.id}\nName: ${aName}\nPixel: ${pixel_id} | Event: ${event} | Retention: ${retention_days} days\n\nNote: audience will start populating as pixel events arrive. Check size in get_audiences.`;
    }

    throw new Error(`Unknown audience type: ${type}. Use "customer_list" or "website".`);
  }

  // ── create_lookalike_audience ──────────────────────────────────────────
  if (name === 'create_lookalike_audience') {
    const { name: aName, source_audience_id, country, ratio = 0.02 } = args;

    if (ratio < 0.01 || ratio > 0.20) throw new Error('ratio must be between 0.01 (1%) and 0.20 (20%).');

    const lookalike_spec = {
      origin:  [{ id: source_audience_id, type: 'custom_audience' }],
      ratio,
      country,
    };

    const result = await graphCreate(`${AD_ACCOUNT_ID}/customaudiences`, {
      name:            aName,
      subtype:         'LOOKALIKE',
      lookalike_spec,
    });
    return `Lookalike audience created.\nID: ${result.id}\nName: ${aName}\nSource: ${source_audience_id} | Country: ${country} | Ratio: ${(ratio * 100).toFixed(0)}% of population\n\nNote: takes 1–6 hours to populate. Requires source audience to have ≥100 members from ${country}.`;
  }

  // ── upload_image ───────────────────────────────────────────────────────
  if (name === 'upload_image') {
    const { image, name: imgName } = args;
    const { readFileSync } = await import('fs');
    const { resolve, basename } = await import('path');
    let params;
    if (image.startsWith('http://') || image.startsWith('https://')) {
      const res = await fetch(image);
      if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = imgName ?? basename(new URL(image).pathname) ?? 'image.jpg';
      params = { filename, bytes: buf.toString('base64') };
    } else {
      const buf = readFileSync(resolve(image));
      const filename = imgName ?? basename(image);
      params = { filename, bytes: buf.toString('base64') };
    }
    const result = await graphCreate(`${AD_ACCOUNT_ID}/adimages`, params);
    const hash = Object.values(result.images ?? {})?.[0]?.hash;
    if (!hash) throw new Error(`Upload succeeded but no hash returned: ${JSON.stringify(result)}`);
    return `Image uploaded.\nHash: ${hash}\n\nUse this hash in create_ad_creative or create_carousel_creative.`;
  }

  // ── upload_video ───────────────────────────────────────────────────────
  if (name === 'upload_video') {
    const { file_url, title } = args;
    const params = { file_url };
    if (title) params.title = title;
    // Meta fetches the video asynchronously from the URL
    const result = await graphCreate(`${AD_ACCOUNT_ID}/advideos`, params);
    const videoId = result.id;
    if (!videoId) throw new Error(`Upload initiated but no video_id returned: ${JSON.stringify(result)}`);
    return `Video upload initiated.\nVideo ID: ${videoId}\n\nMeta is fetching and processing the video asynchronously. Status will show "processing" initially.\nUse this video_id in create_video_creative once processing completes.`;
  }

  // ── create_ad_creative ─────────────────────────────────────────────────
  if (name === 'create_ad_creative') {
    if (!PAGE_ID) throw new Error('META_PAGE_ID is not configured. Add it to .env to create ad creatives.');
    const {
      name: cName, image_hash, message, headline, description,
      link, call_to_action = 'SHOP_NOW', instagram_user_id,
    } = args;

    const link_data = {
      image_hash,
      link,
      message,
      call_to_action: { type: call_to_action, value: { link } },
    };
    if (headline)    link_data.name        = headline;
    if (description) link_data.description = description;

    const story_spec = { page_id: PAGE_ID, link_data };
    const igId = instagram_user_id ?? IG_ID;
    if (igId) story_spec.instagram_user_id = igId;

    const params = { name: cName, object_story_spec: story_spec };
    const result = await graphCreate(`${AD_ACCOUNT_ID}/adcreatives`, params);
    return `Image creative created.\nID: ${result.id}\n\nUse this creative_id in create_ad.`;
  }

  // ── create_video_creative ──────────────────────────────────────────────
  if (name === 'create_video_creative') {
    if (!PAGE_ID) throw new Error('META_PAGE_ID is not configured. Add it to .env to create video creatives.');
    const {
      name: cName, video_id, message, title,
      link, call_to_action = 'SHOP_NOW',
      image_url, instagram_user_id,
    } = args;

    const video_data = {
      video_id,
      message,
      call_to_action: { type: call_to_action, value: { link } },
    };
    if (title)     video_data.title     = title;
    if (image_url) video_data.image_url = image_url; // custom thumbnail

    const story_spec = { page_id: PAGE_ID, video_data };
    const igId = instagram_user_id ?? IG_ID;
    if (igId) story_spec.instagram_user_id = igId;

    const params = { name: cName, object_story_spec: story_spec };
    const result = await graphCreate(`${AD_ACCOUNT_ID}/adcreatives`, params);
    return `Video creative created.\nID: ${result.id}\n\nUse this creative_id in create_ad.`;
  }

  // ── create_carousel_creative ───────────────────────────────────────────
  if (name === 'create_carousel_creative') {
    if (!PAGE_ID) throw new Error('META_PAGE_ID is not configured. Add it to .env to create carousel creatives.');
    const {
      name: cName, message, cards,
      default_link,
      multi_share_optimized = true,
      instagram_user_id,
    } = args;

    if (!cards || cards.length < 2) throw new Error('Carousel requires at least 2 cards.');
    if (cards.length > 10)          throw new Error('Carousel supports a maximum of 10 cards.');

    const child_attachments = cards.map(card => {
      const attachment = {
        link: card.link,
        call_to_action: {
          type:  card.call_to_action ?? 'SHOP_NOW',
          value: { link: card.link },
        },
      };
      // Media: image hash preferred, then image URL, then video
      if (card.image_hash)  attachment.image_hash = card.image_hash;
      else if (card.image_url) attachment.picture = card.image_url;
      else if (card.video_id)  attachment.video_id = card.video_id;
      if (card.name)        attachment.name        = card.name;
      if (card.description) attachment.description = card.description;
      return attachment;
    });

    const link_data = {
      message,
      link:                   default_link ?? cards[0].link,
      child_attachments,
      multi_share_optimized,
      multi_share_end_card:   false, // remove "See more" card
    };

    const story_spec = { page_id: PAGE_ID, link_data };
    const igId = instagram_user_id ?? IG_ID;
    if (igId) story_spec.instagram_user_id = igId;

    const params = { name: cName, object_story_spec: story_spec };
    const result = await graphCreate(`${AD_ACCOUNT_ID}/adcreatives`, params);
    return `Carousel creative created.\nID: ${result.id}\nCards: ${cards.length}\n\nUse this creative_id in create_ad.`;
  }

  // ── list_media_library ─────────────────────────────────────────────────
  if (name === 'list_media_library') {
    const { type = 'all', limit = 20 } = args;
    const results = {};

    if (type === 'images' || type === 'all') {
      const imgData = await graph(`${AD_ACCOUNT_ID}/adimages`, {
        fields: 'hash,name,url,url_128,width,height,created_time',
        limit,
      });
      results.images = (imgData.data ?? []).map(i => ({
        hash:         i.hash,
        name:         i.name,
        dimensions:   `${i.width}x${i.height}`,
        url:          i.url_128 ?? i.url,
        created:      i.created_time,
      }));
    }

    if (type === 'videos' || type === 'all') {
      const vidData = await graph(`${AD_ACCOUNT_ID}/advideos`, {
        fields: 'id,title,picture,length,status,created_time',
        limit,
      });
      results.videos = (vidData.data ?? []).map(v => ({
        id:         v.id,
        title:      v.title,
        length_sec: v.length,
        status:     v.status,
        thumbnail:  v.picture,
        created:    v.created_time,
      }));
    }

    const summary = [];
    if (results.images) summary.push(`Images: ${results.images.length}`);
    if (results.videos) summary.push(`Videos: ${results.videos.length}`);
    return `Media library (${summary.join(', ')}):\n\n${JSON.stringify(results, null, 2)}`;
  }

  // ── create_ad ──────────────────────────────────────────────────────────
  if (name === 'create_ad') {
    const { name: adName, ad_set_id, creative_id, status = 'PAUSED' } = args;
    const result = await graphCreate(`${AD_ACCOUNT_ID}/ads`, {
      name:     adName,
      adset_id: ad_set_id,
      creative: { creative_id },
      status,
    });
    return `Ad created (${status}).\nID: ${result.id}`;
  }

  // ── update_ad ──────────────────────────────────────────────────────────
  if (name === 'update_ad') {
    const result = await graphPost(args.ad_id, { status: args.status });
    return result.success
      ? `Ad ${args.ad_id} status set to ${args.status}.`
      : `Unexpected: ${JSON.stringify(result)}`;
  }

  // ── get_instagram_insights ─────────────────────────────────────────────
  if (name === 'get_instagram_insights') {
    if (!IG_ID) return 'META_INSTAGRAM_ACCOUNT_ID is not configured.';
    const { since, until } = args;
    const reachParams = {
      metric: 'reach,profile_views',
      period: 'day',
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    };
    const reachData = await graph(`${IG_ID}/insights`, reachParams);
    let followerCount = null;
    try {
      const followerData = await graph(IG_ID, { fields: 'followers_count' });
      followerCount = followerData.followers_count;
    } catch (_) { /* optional */ }
    const metrics = {};
    for (const m of reachData.data ?? []) {
      metrics[m.name] = m.values?.slice(-7) ?? m.values;
    }
    return JSON.stringify({ follower_count: followerCount, metrics }, null, 2);
  }

  // ── get_instagram_media ────────────────────────────────────────────────
  if (name === 'get_instagram_media') {
    if (!IG_ID) return 'META_INSTAGRAM_ACCOUNT_ID is not configured.';
    const limit = Math.min(args.limit ?? 12, 50);
    const fields = 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink';
    const data = await graph(`${IG_ID}/media`, { fields, limit });
    const enriched = await Promise.all((data.data ?? []).map(async post => {
      try {
        const insightFields = post.media_type === 'VIDEO'
          ? 'reach,views,saved'
          : 'reach,views,saved,total_interactions';
        const ins = await graph(`${post.id}/insights`, { metric: insightFields });
        const insightMap = {};
        for (const i of ins.data ?? []) insightMap[i.name] = i.values?.[0]?.value ?? i.value;
        return { ...post, insights: insightMap };
      } catch (_) { return post; }
    }));
    return `Found ${enriched.length} posts:\n\n${JSON.stringify(enriched, null, 2)}`;
  }

  // ── get_page_insights ──────────────────────────────────────────────────
  if (name === 'get_page_insights') {
    if (!PAGE_ID) return 'META_PAGE_ID is not configured.';
    const { period = 'day', since, until } = args;
    const metric = [
      'page_impressions',
      'page_impressions_unique',
      'page_views_total',
      'page_fan_adds',
      'page_post_engagements',
    ].join(',');
    const params = { metric, period, ...(since ? { since } : {}), ...(until ? { until } : {}) };
    const data = await graph(`${PAGE_ID}/insights`, params);
    const result = {};
    for (const m of data.data ?? []) {
      result[m.name] = { title: m.title, values: m.values?.slice(-14) };
    }
    try {
      const page = await graph(PAGE_ID, { fields: 'fan_count,name' });
      result._page = { name: page.name, total_fans: page.fan_count };
    } catch (_) { /* optional */ }
    return JSON.stringify(result, null, 2);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUSINESS PORTFOLIO TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── get_business_overview ──────────────────────────────────────────────
  if (name === 'get_business_overview') {
    requireBusiness();
    const [biz, adAccounts, pages, pixels, catalogs] = await Promise.all([
      graph(BUSINESS_ID, { fields: 'id,name,link,verification_status,created_time,timezone_id' }),
      graph(`${BUSINESS_ID}/owned_ad_accounts`, { fields: 'id,name,account_status,currency,timezone_name', limit: 20 }),
      graph(`${BUSINESS_ID}/owned_pages`, { fields: 'id,name,category,fan_count,link', limit: 20 }),
      graph(`${BUSINESS_ID}/owned_pixels`, { fields: 'id,name,last_fired_time', limit: 20 }),
      graph(`${BUSINESS_ID}/owned_product_catalogs`, { fields: 'id,name,product_count', limit: 20 }),
    ]);

    return JSON.stringify({
      business: {
        id:                  biz.id,
        name:                biz.name,
        link:                biz.link,
        verification_status: biz.verification_status,
        created:             biz.created_time,
        timezone:            biz.timezone_id,
      },
      ad_accounts: (adAccounts.data ?? []).map(a => ({
        id: a.id, name: a.name, status: a.account_status, currency: a.currency, timezone: a.timezone_name,
      })),
      pages: (pages.data ?? []).map(p => ({
        id: p.id, name: p.name, category: p.category, fans: p.fan_count, link: p.link,
      })),
      pixels: (pixels.data ?? []).map(p => ({
        id: p.id, name: p.name, last_fired: p.last_fired_time,
      })),
      catalogs: (catalogs.data ?? []).map(c => ({
        id: c.id, name: c.name, products: c.product_count,
      })),
    }, null, 2);
  }

  // ── list_business_users ────────────────────────────────────────────────
  if (name === 'list_business_users') {
    requireBusiness();
    const fields = 'id,name,email,role,created_time';
    const data = await graph(`${BUSINESS_ID}/business_users`, { fields, limit: args.limit ?? 50 });
    const users = (data.data ?? []).map(u => ({
      id:      u.id,
      name:    u.name,
      email:   u.email,
      role:    u.role,
      created: u.created_time,
    }));
    return `${users.length} users in Business Manager:\n\n${JSON.stringify(users, null, 2)}`;
  }

  // ── list_agencies ──────────────────────────────────────────────────────
  if (name === 'list_agencies') {
    requireBusiness();
    const data = await graph(`${BUSINESS_ID}/agencies`, { fields: 'id,name,link', limit: 50 });
    const agencies = data.data ?? [];
    if (agencies.length === 0) return 'No partner agencies found.';
    return `${agencies.length} partner agencies:\n\n${JSON.stringify(agencies, null, 2)}`;
  }

  // ── update_user_access ─────────────────────────────────────────────────
  if (name === 'update_user_access') {
    const { action, user_id, ad_account_id, tasks = [] } = args;
    const accountId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;

    if (action === 'add') {
      if (tasks.length === 0) throw new Error('Provide tasks for action "add": ["MANAGE"], ["ADVERTISE","ANALYZE"], etc.');
      const result = await graphCreate(`${accountId}/assigned_users`, { user: user_id, tasks });
      return result.success
        ? `User ${user_id} added to ${accountId} with tasks: ${tasks.join(', ')}.`
        : `Unexpected: ${JSON.stringify(result)}`;
    }

    if (action === 'remove') {
      const url = new URL(`${BASE}/${accountId}/assigned_users`);
      url.searchParams.set('access_token', TOKEN);
      url.searchParams.set('user', user_id);
      const res = await fetch(url.toString(), { method: 'DELETE' });
      const json = await res.json();
      if (json.error) throw new Error(`Meta API error ${json.error.code}: ${json.error.message}`);
      return json.success ? `User ${user_id} removed from ${accountId}.` : `Unexpected: ${JSON.stringify(json)}`;
    }

    throw new Error('action must be "add" or "remove".');
  }

  // ── list_pixels ────────────────────────────────────────────────────────
  if (name === 'list_pixels') {
    requireBusiness();
    const fields = 'id,name,last_fired_time,creation_time,is_unavailable';
    const data = await graph(`${BUSINESS_ID}/owned_pixels`, { fields, limit: args.limit ?? 20 });
    const pixels = (data.data ?? []).map(p => ({
      id:           p.id,
      name:         p.name,
      last_fired:   p.last_fired_time,
      created:      p.creation_time,
      unavailable:  p.is_unavailable,
    }));
    return `Found ${pixels.length} pixels:\n\n${JSON.stringify(pixels, null, 2)}`;
  }

  // ── create_pixel ───────────────────────────────────────────────────────
  if (name === 'create_pixel') {
    requireBusiness();
    const result = await graphCreate(`${BUSINESS_ID}/adspixels`, { name: args.name });
    return `Pixel created.\nID: ${result.id}\nName: ${args.name}\n\nNext: use assign_pixel_to_account to share it with an ad account.`;
  }

  // ── assign_pixel_to_account ────────────────────────────────────────────
  if (name === 'assign_pixel_to_account') {
    const { pixel_id, ad_account_id } = args;
    const accountId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;
    const result = await graphCreate(`${accountId}/adspixels`, { pixel_id });
    return result.success
      ? `Pixel ${pixel_id} assigned to ad account ${accountId}.`
      : `Unexpected: ${JSON.stringify(result)}`;
  }

  // ── list_custom_conversions ────────────────────────────────────────────
  if (name === 'list_custom_conversions') {
    const fields = 'id,name,description,creation_time,last_fired_time,is_archived,pixel_id,custom_event_type';
    const data = await graph(`${AD_ACCOUNT_ID}/customconversions`, { fields, limit: args.limit ?? 30 });
    const conversions = (data.data ?? []).map(c => ({
      id:           c.id,
      name:         c.name,
      event_type:   c.custom_event_type,
      pixel_id:     c.pixel_id,
      last_fired:   c.last_fired_time,
      is_archived:  c.is_archived,
      created:      c.creation_time,
    }));
    return `Found ${conversions.length} custom conversions:\n\n${JSON.stringify(conversions, null, 2)}`;
  }

  // ── create_custom_conversion ───────────────────────────────────────────
  if (name === 'create_custom_conversion') {
    const { name: cName, description, pixel_id, event_type, url_contains, min_value } = args;

    // Build filter rules
    const filters = [];
    if (url_contains) {
      filters.push({
        field:    'url',
        operator: 'CONTAIN',
        value:    url_contains,
      });
    }
    if (min_value != null) {
      filters.push({
        field:    'value',
        operator: 'GREATER_THAN',
        value:    String(min_value),
      });
    }

    const params = {
      name:               cName,
      pixel_id,
      custom_event_type:  event_type,
    };
    if (description) params.description = description;
    if (filters.length > 0) {
      params.rule = JSON.stringify({ and: filters });
    }

    const result = await graphCreate(`${AD_ACCOUNT_ID}/customconversions`, params);
    return `Custom conversion created.\nID: ${result.id}\nName: ${cName}\nEvent: ${event_type}${url_contains ? ` | URL contains: "${url_contains}"` : ''}${min_value != null ? ` | Min value: ${min_value}` : ''}`;
  }

  // ── list_catalogs ──────────────────────────────────────────────────────
  if (name === 'list_catalogs') {
    requireBusiness();
    const data = await graph(`${BUSINESS_ID}/owned_product_catalogs`, {
      fields: 'id,name,product_count,vertical,created_time',
      limit:  args.limit ?? 20,
    });
    const catalogs = (data.data ?? []).map(c => ({
      id:        c.id,
      name:      c.name,
      products:  c.product_count,
      vertical:  c.vertical,
      created:   c.created_time,
    }));
    return `Found ${catalogs.length} catalogs:\n\n${JSON.stringify(catalogs, null, 2)}`;
  }

  // ── create_catalog ─────────────────────────────────────────────────────
  if (name === 'create_catalog') {
    requireBusiness();
    const result = await graphCreate(`${BUSINESS_ID}/owned_product_catalogs`, { name: args.name });
    return `Catalog created.\nID: ${result.id}\nName: ${args.name}\n\nNext: use create_product_feed to add a product feed URL.`;
  }

  // ── list_product_feeds ─────────────────────────────────────────────────
  if (name === 'list_product_feeds') {
    const { catalog_id } = args;
    const data = await graph(`${catalog_id}/product_feeds`, {
      fields: 'id,name,schedule,latest_upload,product_count',
      limit:  20,
    });
    const feeds = (data.data ?? []).map(f => ({
      id:            f.id,
      name:          f.name,
      products:      f.product_count,
      schedule:      f.schedule,
      latest_upload: f.latest_upload,
    }));
    return `Found ${feeds.length} product feeds:\n\n${JSON.stringify(feeds, null, 2)}`;
  }

  // ── create_product_feed ────────────────────────────────────────────────
  if (name === 'create_product_feed') {
    const { catalog_id, name: fName, url, interval = 'DAILY', hour = 6 } = args;
    const schedule = { interval, url, hour: String(hour) };
    const result = await graphCreate(`${catalog_id}/product_feeds`, { name: fName, schedule });
    return `Product feed created.\nID: ${result.id}\nName: ${fName}\nURL: ${url}\nSchedule: ${interval} at ${hour}:00`;
  }

  // ── batch_upload_products ──────────────────────────────────────────────
  if (name === 'batch_upload_products') {
    const { catalog_id, requests } = args;
    if (!requests || requests.length === 0) throw new Error('Provide at least one product request.');
    if (requests.length > 50) throw new Error('Maximum 50 products per batch call.');

    const result = await graphCreate(`${catalog_id}/items_batch`, {
      requests,
      item_type: 'PRODUCT_ITEM',
    });

    const handles     = result.handles ?? [];
    const invalid     = result.invalid_request_count ?? 0;
    return `Batch submitted.\nRequests: ${requests.length} | Invalid: ${invalid}\nHandles: ${handles.length}\n\nCheck catalog in Meta Commerce Manager to verify products.`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'meta-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await handleTool(name, args ?? {});
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[meta-mcp] Server started (v2.0.0, API v22.0)');
