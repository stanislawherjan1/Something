/**
 * Google Ads MCP Server
 *
 * Custom Node.js MCP server supporting read, keyword planning, and full
 * campaign management (create + update + negative keywords).
 *
 * Env vars (all require OAuth — google-ads-api npm always needs it):
 *   GOOGLE_CLIENT_ID              — OAuth client ID (same as Google Drive)
 *   GOOGLE_CLIENT_SECRET          — OAuth client secret (same as Google Drive)
 *   GOOGLE_ADS_DEVELOPER_TOKEN    — required. From Google Ads → Tools → API Center
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID  — required. Manager account ID (no dashes)
 *   GOOGLE_ADS_REFRESH_TOKEN      — required. Generate via OAuth consent once.
 *
 * Tools:
 *   search                    — GAQL query (reports, campaigns, metrics, search terms)
 *   list_accounts             — list accessible customer accounts
 *   keyword_ideas             — generate keyword ideas from seed words (Keyword Planner)
 *   historical_metrics        — search volumes for specific keywords
 *   create_campaign           — create a new Search/Display/Shopping/PMax campaign
 *   update_campaign           — status, name, budget, bidding strategy, conversion goal, AI Max, URL expansion
 *   create_ad_group           — create ad group inside a campaign
 *   update_ad_group           — pause, enable, rename, change default bid
 *   create_keyword            — add keyword to ad group
 *   update_keyword            — change keyword status or bid
 *   create_negative_keyword   — add negative keyword at ad group or campaign level
 *   create_responsive_search_ad — create RSA with headlines (supports pinning) + descriptions
 *   update_ad                 — change status of an existing ad (pause/enable)
 *   update_budget             — change daily budget for a campaign budget resource
 *   create_callout_assets     — add callout extensions to a campaign
 *   create_structured_snippet — add structured snippet extension
 *   create_sitelink_assets    — add sitelink extensions (text + URL + optional descriptions)
 *   create_call_asset         — add phone number extension
 *   add_audience_target       — add audience in observation mode (user_interest or user_list)
 *   search_audiences          — search for audience segment IDs by name
 *   list_campaign_assets      — list all extensions on a campaign
 *   remove_campaign_asset     — remove an extension from a campaign
 *   remove_campaign_criterion — remove a targeting criterion (geo/language/audience)
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GoogleAdsApi, enums, errors } from 'google-ads-api';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DEV_TOKEN     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const MANAGER_ID    = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, '');
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;

if (!DEV_TOKEN || !MANAGER_ID) {
  console.error('[google-ads-mcp] Missing GOOGLE_ADS_DEVELOPER_TOKEN or GOOGLE_ADS_LOGIN_CUSTOMER_ID');
  process.exit(1);
}

// google-ads-api npm always requires OAuth for every operation (including reads).
const hasOAuth = !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

let api, defaultCustomer;

if (hasOAuth) {
  api = new GoogleAdsApi({
    client_id:       CLIENT_ID,
    client_secret:   CLIENT_SECRET,
    developer_token: DEV_TOKEN,
  });
  defaultCustomer = api.Customer({
    customer_id:       MANAGER_ID,
    refresh_token:     REFRESH_TOKEN,
    login_customer_id: MANAGER_ID,
  });
}

function requireOAuth() {
  if (!hasOAuth) {
    throw new Error(
      'All Google Ads tools require OAuth credentials. ' +
      'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_ADS_REFRESH_TOKEN to .env. ' +
      'See docs/INTEGRATIONS.md → Google Ads for how to generate a refresh token.'
    );
  }
}

function getCustomer(customerId) {
  requireOAuth();
  if (!customerId || customerId.replace(/-/g, '') === MANAGER_ID) return defaultCustomer;
  return api.Customer({
    customer_id:       customerId.replace(/-/g, ''),
    refresh_token:     REFRESH_TOKEN,
    login_customer_id: MANAGER_ID,
  });
}

// google-ads-api v23 exposes keyword planner as keywordPlanIdeaService (singular)
// with a .generate() method that wraps generateKeywordIdeas/generateHistoricalMetrics.
// Access pattern: customer.keywordPlanIdeaService — fall back to keywordPlanIdeas if needed.
function getKeywordPlanService(cust) {
  return cust.keywordPlanIdeaService ?? cust.keywordPlanIdeas;
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [

  {
    name: 'search',
    description: 'Execute a GAQL (Google Ads Query Language) query. Use for all reporting: campaign metrics, ad performance, keyword stats, search terms, quality scores, budgets, audiences, conversions. Returns rows as JSON. Example queries: "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS", "SELECT search_term_view.search_term, metrics.clicks FROM search_term_view ORDER BY metrics.clicks DESC LIMIT 50"',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'GAQL query string.',
        },
        customer_id: {
          type: 'string',
          description: 'Customer account ID to query (optional, defaults to manager account).',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'list_accounts',
    description: 'List all Google Ads accounts accessible via the manager account.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'keyword_ideas',
    description: 'Generate keyword ideas from seed keywords using Google Keyword Planner. Returns suggestions with average monthly searches, competition level, and CPC bid estimates. Sort by volume to find high-traffic opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Seed keywords. E.g. ["running shoes", "trail running"]',
        },
        customer_id: {
          type: 'string',
          description: 'Customer account ID (optional, defaults to manager account).',
        },
        location_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Geo target location IDs. Common: "2840" (USA), "2826" (UK), "2276" (Germany), "2616" (Poland). Default: ["2840"] (USA).',
        },
        language_id: {
          type: 'string',
          description: 'Language constant ID. Common: "1000" (English), "1030" (Polish), "1001" (French). Default: "1000".',
        },
        page_size: {
          type: 'number',
          description: 'Max results to return (default: 50, max: 1000).',
        },
      },
      required: ['keywords'],
    },
  },

  {
    name: 'historical_metrics',
    description: 'Get historical search volume and competition data for specific keywords. Returns avg monthly searches, competition level, and bid ranges. Useful for validating keyword choices before adding them to campaigns.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to get metrics for.',
        },
        customer_id: {
          type: 'string',
          description: 'Customer account ID (optional).',
        },
        location_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Geo target location IDs (default: ["2840"] USA).',
        },
        language_id: {
          type: 'string',
          description: 'Language constant ID (default: "1000" English).',
        },
      },
      required: ['keywords'],
    },
  },

  {
    name: 'create_campaign',
    description: 'Create a new Google Ads campaign. Budget is created automatically. Campaign starts PAUSED: use update_campaign to enable when ready.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        name: {
          type: 'string',
          description: 'Campaign name.',
        },
        daily_budget_micros: {
          type: 'number',
          description: 'Daily budget in micros (1,000,000 micros = 1 unit of account currency). E.g. 50000000 = 50/day.',
        },
        campaign_type: {
          type: 'string',
          enum: ['SEARCH', 'DISPLAY', 'SHOPPING', 'VIDEO', 'PERFORMANCE_MAX'],
          description: 'Campaign type (default: SEARCH).',
        },
        bidding_strategy: {
          type: 'string',
          enum: ['MANUAL_CPC', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS'],
          description: 'Bidding strategy (default: MAXIMIZE_CLICKS). TARGET_CPA requires target_cpa_micros. TARGET_ROAS requires target_roas.',
        },
        target_cpa_micros: {
          type: 'number',
          description: 'Target CPA in micros (required when bidding_strategy=TARGET_CPA). E.g. 5000000 = 5.00 in account currency per conversion.',
        },
        target_roas: {
          type: 'number',
          description: 'Target ROAS as a ratio (required when bidding_strategy=TARGET_ROAS). E.g. 3.5 = 350% ROAS.',
        },
        start_date: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (default: today).',
        },
        end_date: {
          type: 'string',
          description: 'End date YYYY-MM-DD (optional).',
        },
        network_search: {
          type: 'boolean',
          description: 'Target Google Search (default: true).',
        },
        network_search_partners: {
          type: 'boolean',
          description: 'Target Search Partners (default: false).',
        },
        geo_target_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Location criterion IDs to target. Common: "2840" (USA), "1014044" (Los Angeles), "2826" (UK), "2276" (Germany), "2616" (Poland), "2250" (France). Leave empty to target all locations.',
        },
        language_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Language criterion IDs. Common: "1000" (English), "1030" (Polish), "1001" (French), "1009" (German). Leave empty to target all languages.',
        },
        conversion_goal: {
          type: 'string',
          enum: ['PURCHASE', 'LEAD', 'SIGNUP', 'PAGE_VIEW', 'CONTACT', 'DOWNLOAD', 'DEFAULT'],
          description: 'Conversion goal category the campaign should optimise for. Sets the matching CampaignConversionGoal as biddable. Common: PURCHASE (e-commerce), LEAD (lead gen), SIGNUP, PAGE_VIEW (traffic).',
        },
        url_expansion_opt_out: {
          type: 'boolean',
          description: 'Set true to disable Final URL Expansion (AI Max). Prevents Google from directing traffic to other landing pages.',
        },
        ai_max_enabled: {
          type: 'boolean',
          description: 'Set true to enable AI Max (automatically created assets). Allows Google to generate additional assets.',
        },
      },
      required: ['customer_id', 'name', 'daily_budget_micros'],
    },
  },

  {
    name: 'update_campaign',
    description: 'Update a campaign: change status, name, budget, bidding strategy, conversion goal, end date, AI Max, or URL expansion.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        campaign_id: {
          type: 'string',
          description: 'Campaign ID to update.',
        },
        status: {
          type: 'string',
          enum: ['ENABLED', 'PAUSED'],
          description: 'New status. Note: campaigns cannot be deleted via API; REMOVED is a read-only value. To delete, pause it and remove manually in the UI.',
        },
        name: {
          type: 'string',
          description: 'New campaign name.',
        },
        end_date: {
          type: 'string',
          description: 'New end date YYYY-MM-DD.',
        },
        daily_budget_micros: {
          type: 'number',
          description: 'New daily budget in micros.',
        },
        bidding_strategy: {
          type: 'string',
          enum: ['MANUAL_CPC', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS'],
          description: 'Change the bidding strategy.',
        },
        target_cpa_micros: {
          type: 'number',
          description: 'Required when changing bidding_strategy to TARGET_CPA.',
        },
        target_roas: {
          type: 'number',
          description: 'Required when changing bidding_strategy to TARGET_ROAS. E.g. 3.5 = 350%.',
        },
        conversion_goal: {
          type: 'string',
          enum: ['PURCHASE', 'LEAD', 'SIGNUP', 'PAGE_VIEW', 'CONTACT', 'DOWNLOAD', 'DEFAULT'],
          description: 'Change which conversion category the campaign optimises for.',
        },
        url_expansion_opt_out: {
          type: 'boolean',
          description: 'Set true to disable Final URL Expansion. Set false to re-enable.',
        },
        ai_max_enabled: {
          type: 'boolean',
          description: 'Set true to enable AI Max (automatically created assets). Set false to disable.',
        },
      },
      required: ['customer_id', 'campaign_id'],
    },
  },

  {
    name: 'create_ad_group',
    description: 'Create an ad group inside a campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        campaign_id: {
          type: 'string',
          description: 'Campaign ID.',
        },
        name: {
          type: 'string',
          description: 'Ad group name.',
        },
        cpc_bid_micros: {
          type: 'number',
          description: 'Default max CPC bid in micros (e.g. 1000000 = 1.00 in account currency).',
        },
        status: {
          type: 'string',
          enum: ['ENABLED', 'PAUSED'],
          description: 'Initial status (default: ENABLED).',
        },
      },
      required: ['customer_id', 'campaign_id', 'name'],
    },
  },

  {
    name: 'update_ad_group',
    description: 'Update an ad group: change status, name, or default CPC bid.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        ad_group_id: {
          type: 'string',
          description: 'Ad group ID to update.',
        },
        status: {
          type: 'string',
          enum: ['ENABLED', 'PAUSED', 'REMOVED'],
          description: 'New status.',
        },
        name: {
          type: 'string',
          description: 'New name.',
        },
        cpc_bid_micros: {
          type: 'number',
          description: 'New default CPC bid in micros.',
        },
      },
      required: ['customer_id', 'ad_group_id'],
    },
  },

  {
    name: 'create_keyword',
    description: 'Add a keyword to an ad group.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        ad_group_id: {
          type: 'string',
          description: 'Ad group ID.',
        },
        keyword_text: {
          type: 'string',
          description: 'Keyword text, e.g. "running shoes".',
        },
        match_type: {
          type: 'string',
          enum: ['BROAD', 'PHRASE', 'EXACT'],
          description: 'Keyword match type (default: PHRASE).',
        },
        cpc_bid_micros: {
          type: 'number',
          description: 'Max CPC bid override in micros (optional, inherits from ad group).',
        },
        status: {
          type: 'string',
          enum: ['ENABLED', 'PAUSED'],
          description: 'Initial status (default: ENABLED).',
        },
      },
      required: ['customer_id', 'ad_group_id', 'keyword_text'],
    },
  },

  {
    name: 'update_keyword',
    description: 'Update a keyword: change status (pause/enable) or CPC bid. Use the criterion ID returned by create_keyword or found via search.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        ad_group_id: {
          type: 'string',
          description: 'Ad group ID the keyword belongs to.',
        },
        criterion_id: {
          type: 'string',
          description: 'Keyword criterion ID (from create_keyword or search: SELECT ad_group_criterion.criterion_id FROM ad_group_criterion).',
        },
        status: {
          type: 'string',
          enum: ['ENABLED', 'PAUSED', 'REMOVED'],
          description: 'New status.',
        },
        cpc_bid_micros: {
          type: 'number',
          description: 'New max CPC bid in micros.',
        },
      },
      required: ['customer_id', 'ad_group_id', 'criterion_id'],
    },
  },

  {
    name: 'create_negative_keyword',
    description: 'Add a negative keyword to block irrelevant searches. Can be added at campaign level (blocks for all ad groups) or ad group level (blocks for one ad group). Critical for reducing wasted spend.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        keyword_text: {
          type: 'string',
          description: 'Negative keyword text, e.g. "free", "cheap", "tutorial".',
        },
        match_type: {
          type: 'string',
          enum: ['BROAD', 'PHRASE', 'EXACT'],
          description: 'Match type (default: EXACT, the safest; only blocks that exact phrase).',
        },
        campaign_id: {
          type: 'string',
          description: 'Campaign ID for campaign-level negative. Either campaign_id or ad_group_id required.',
        },
        ad_group_id: {
          type: 'string',
          description: 'Ad group ID for ad group-level negative. Either campaign_id or ad_group_id required.',
        },
      },
      required: ['customer_id', 'keyword_text'],
    },
  },

  {
    name: 'create_responsive_search_ad',
    description: 'Create a Responsive Search Ad (RSA). Google automatically tests headline/description combinations and shows the best performers. Provide 3–15 headlines (max 30 chars each) and 2–4 descriptions (max 90 chars each).',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        ad_group_id: {
          type: 'string',
          description: 'Ad group ID.',
        },
        headlines: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  pin: { type: 'number', enum: [1, 2, 3], description: 'Pin to position 1, 2, or 3.' },
                },
                required: ['text'],
              },
            ],
          },
          description: 'Headlines (3–15, max 30 chars each). Pass a plain string, or an object { text, pin } to pin to a position. E.g. [{ "text": "From €850, Allura Corset", "pin": 1 }, "Handmade French Silk"]',
        },
        descriptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Descriptions (2–4, max 90 chars each).',
        },
        final_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Landing page URLs. E.g. ["https://example.com/shoes"]',
        },
        path1: {
          type: 'string',
          description: 'Display URL path 1 (optional, max 15 chars). E.g. "shoes"',
        },
        path2: {
          type: 'string',
          description: 'Display URL path 2 (optional, max 15 chars). E.g. "sale"',
        },
      },
      required: ['customer_id', 'ad_group_id', 'headlines', 'descriptions', 'final_urls'],
    },
  },

  {
    name: 'update_ad',
    description: 'Change the status of an existing ad (ENABLED, PAUSED, or REMOVED). Use the ad ID from create_responsive_search_ad or search: SELECT ad_group_ad.ad.id FROM ad_group_ad.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        ad_group_id: {
          type: 'string',
          description: 'Ad group ID the ad belongs to.',
        },
        ad_id: {
          type: 'string',
          description: 'Ad ID.',
        },
        status: {
          type: 'string',
          enum: ['ENABLED', 'PAUSED', 'REMOVED'],
          description: 'New ad status.',
        },
      },
      required: ['customer_id', 'ad_group_id', 'ad_id', 'status'],
    },
  },

  {
    name: 'create_callout_assets',
    description: 'Add callout extensions to a campaign. Each callout is a short phrase shown below the ad (e.g. "Free Shipping", "24/7 Support"). Pass up to 20 callout texts.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        campaign_id: { type: 'string', description: 'Campaign ID to attach callouts to.' },
        callouts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Callout texts (max 25 chars each). E.g. ["Handmade to Order", "100% French Silk", "Free Sizing Exchange"]',
        },
      },
      required: ['customer_id', 'campaign_id', 'callouts'],
    },
  },

  {
    name: 'create_structured_snippet',
    description: 'Add a structured snippet extension to a campaign. Shows a header + list of values (e.g. Types: Corsets, Lingerie, Silk).',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        campaign_id: { type: 'string', description: 'Campaign ID.' },
        header: {
          type: 'string',
          enum: ['Amenities', 'Brands', 'Courses', 'Degree programs', 'Destinations', 'Featured hotels', 'Insurance coverage', 'Models', 'Neighborhoods', 'Service catalog', 'Shows', 'Styles', 'Types'],
          description: 'Snippet header (must be one of Google\'s predefined values).',
        },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Snippet values (3–10 items, max 25 chars each). E.g. ["Corsets", "Lingerie", "Silk"]',
        },
      },
      required: ['customer_id', 'campaign_id', 'header', 'values'],
    },
  },

  {
    name: 'add_audience_target',
    description: 'Add an audience to a campaign in observation mode (does not restrict reach, only lets you see and bid-adjust per audience). Use search tool to find audience IDs first.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        campaign_id: { type: 'string', description: 'Campaign ID.' },
        audience_type: {
          type: 'string',
          enum: ['user_interest', 'user_list'],
          description: 'Type of audience: user_interest (in-market / affinity segments from Google) or user_list (remarketing / custom lists).',
        },
        audience_id: {
          type: 'string',
          description: 'Audience ID. Find user_interest IDs via: SELECT user_interest.user_interest_id, user_interest.name FROM user_interest WHERE user_interest.name LIKE \'%luxury%\'. Find user_list IDs via: SELECT user_list.id, user_list.name FROM user_list.',
        },
        bid_modifier: {
          type: 'number',
          description: 'Bid modifier (optional). 1.0 = no change, 1.2 = +20%, 0.8 = -20%. Range: 0.1–10.0.',
        },
      },
      required: ['customer_id', 'campaign_id', 'audience_type', 'audience_id'],
    },
  },

  {
    name: 'create_sitelink_assets',
    description: 'Add sitelink extensions to a campaign. Each sitelink is a clickable link with its own URL shown below the main ad. High impact on CTR.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        campaign_id: { type: 'string', description: 'Campaign ID.' },
        sitelinks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text:   { type: 'string', description: 'Link text (max 25 chars). E.g. "Shop Corsets"' },
              url:    { type: 'string', description: 'Landing page URL.' },
              desc1:  { type: 'string', description: 'Description line 1 (optional, max 35 chars).' },
              desc2:  { type: 'string', description: 'Description line 2 (optional, max 35 chars).' },
            },
            required: ['text', 'url'],
          },
          description: 'List of sitelinks to add.',
        },
      },
      required: ['customer_id', 'campaign_id', 'sitelinks'],
    },
  },

  {
    name: 'create_call_asset',
    description: 'Add a phone number extension to a campaign. Shows a call button next to the ad on mobile.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id:  { type: 'string', description: 'Customer account ID.' },
        campaign_id:  { type: 'string', description: 'Campaign ID.' },
        phone_number: { type: 'string', description: 'Phone number. E.g. "+1 800 555 1234"' },
        country_code: { type: 'string', description: 'Two-letter country code. E.g. "US", "GB", "PL"' },
      },
      required: ['customer_id', 'campaign_id', 'phone_number', 'country_code'],
    },
  },

  {
    name: 'search_audiences',
    description: 'Search for audience segment IDs to use with add_audience_target. Returns user_interest (in-market / affinity) segments matching the query.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        query: { type: 'string', description: 'Search term. E.g. "luxury", "fashion", "competitor name".' },
        type: {
          type: 'string',
          enum: ['user_interest', 'user_list', 'both'],
          description: 'Which audience type to search. user_interest = Google in-market/affinity segments. user_list = remarketing/custom lists in this account. Default: both.',
        },
      },
      required: ['customer_id', 'query'],
    },
  },

  {
    name: 'list_campaign_assets',
    description: 'List all asset extensions currently linked to a campaign (sitelinks, callouts, snippets, call assets, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        campaign_id: { type: 'string', description: 'Campaign ID.' },
      },
      required: ['customer_id', 'campaign_id'],
    },
  },

  {
    name: 'remove_campaign_asset',
    description: 'Remove an asset extension from a campaign (e.g. a sitelink or callout). Find asset IDs via list_campaign_assets.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer account ID.' },
        campaign_id: { type: 'string', description: 'Campaign ID.' },
        asset_id:    { type: 'string', description: 'Asset ID to remove. Find via list_campaign_assets.' },
        field_type:  { type: 'string', description: 'Asset field type. E.g. "SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL".' },
      },
      required: ['customer_id', 'campaign_id', 'asset_id', 'field_type'],
    },
  },

  {
    name: 'remove_campaign_criterion',
    description: 'Remove a targeting criterion from a campaign (geo location, language, or audience). Find criterion IDs via search.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id:  { type: 'string', description: 'Customer account ID.' },
        campaign_id:  { type: 'string', description: 'Campaign ID.' },
        criterion_id: { type: 'string', description: 'Criterion ID. Find via: SELECT campaign_criterion.criterion_id, campaign_criterion.type FROM campaign_criterion WHERE campaign_criterion.campaign = \'customers/X/campaigns/Y\'.' },
      },
      required: ['customer_id', 'campaign_id', 'criterion_id'],
    },
  },

  {
    name: 'update_budget',
    description: 'Change the daily budget for a campaign budget resource.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Customer account ID.',
        },
        campaign_budget_id: {
          type: 'string',
          description: 'Campaign budget ID. Find via: SELECT campaign_budget.id FROM campaign_budget.',
        },
        daily_amount_micros: {
          type: 'number',
          description: 'New daily budget in micros (1,000,000 = 1 unit of account currency).',
        },
      },
      required: ['customer_id', 'campaign_budget_id', 'daily_amount_micros'],
    },
  },

];

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name, args) {

  // ── search ───────────────────────────────────────────────────────────────
  if (name === 'search') {
    const cust = getCustomer(args.customer_id);
    const rows = await cust.query(args.query);
    if (rows.length === 0) return 'No results.';
    return JSON.stringify(rows, null, 2);
  }

  // ── list_accounts ────────────────────────────────────────────────────────
  if (name === 'list_accounts') {
    const rows = await defaultCustomer.query(
      'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone FROM customer_client WHERE customer_client.level <= 1'
    );
    return JSON.stringify(rows.map(r => r.customer_client), null, 2);
  }

  // ── keyword_ideas ────────────────────────────────────────────────────────
  if (name === 'keyword_ideas') {
    const cust        = getCustomer(args.customer_id);
    const locationIds = (args.location_ids ?? ['2840']).map(id => `geoTargetConstants/${id}`);
    const language    = `languageConstants/${args.language_id ?? '1000'}`;
    const pageSize    = Math.min(args.page_size ?? 50, 1000);
    const svc         = getKeywordPlanService(cust);

    const results = await svc.generateKeywordIdeas({
      customer_id:          cust.credentials.customer_id,
      language,
      geo_target_constants: locationIds,
      keyword_seed:         { keywords: args.keywords },
      keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
      page_size:            pageSize,
    });

    const ideas = (results ?? []).slice(0, pageSize).map(r => ({
      keyword:              r.text,
      avg_monthly_searches: r.keyword_idea_metrics?.avg_monthly_searches ?? 0,
      competition:          r.keyword_idea_metrics?.competition ?? 'UNKNOWN',
      competition_index:    r.keyword_idea_metrics?.competition_index ?? 0,
      low_bid_micros:       r.keyword_idea_metrics?.low_top_of_page_bid_micros ?? 0,
      high_bid_micros:      r.keyword_idea_metrics?.high_top_of_page_bid_micros ?? 0,
    }));

    ideas.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);
    return JSON.stringify(ideas, null, 2);
  }

  // ── historical_metrics ───────────────────────────────────────────────────
  if (name === 'historical_metrics') {
    const cust        = getCustomer(args.customer_id);
    const locationIds = (args.location_ids ?? ['2840']).map(id => `geoTargetConstants/${id}`);
    const language    = `languageConstants/${args.language_id ?? '1000'}`;
    const svc         = getKeywordPlanService(cust);

    const results = await svc.generateHistoricalMetrics({
      customer_id:          cust.credentials.customer_id,
      keywords:             args.keywords,
      language,
      geo_target_constants: locationIds,
      keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
    });

    const metrics = (results?.metrics ?? []).map((m, i) => ({
      keyword:              args.keywords[i] ?? `keyword_${i}`,
      avg_monthly_searches: m.keyword_metrics?.avg_monthly_searches ?? 0,
      competition:          m.keyword_metrics?.competition ?? 'UNKNOWN',
      competition_index:    m.keyword_metrics?.competition_index ?? 0,
      low_bid_micros:       m.keyword_metrics?.low_top_of_page_bid_micros ?? 0,
      high_bid_micros:      m.keyword_metrics?.high_top_of_page_bid_micros ?? 0,
    }));

    return JSON.stringify(metrics, null, 2);
  }

  // ── create_campaign ──────────────────────────────────────────────────────
  if (name === 'create_campaign') {
    const cust  = getCustomer(args.customer_id);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (Google Ads API format)

    // 1. Create budget
    const { results: budgetResults } = await cust.campaignBudgets.create([{
      name:              `Budget for ${args.name}`,
      amount_micros:     args.daily_budget_micros,
      delivery_method:   enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    }]);
    const budgetResourceName = budgetResults[0].resource_name;

    // 2. Build campaign
    const biddingStrategy = args.bidding_strategy ?? 'MAXIMIZE_CLICKS';
    const campaign = {
      name:                              args.name,
      advertising_channel_type:         enums.AdvertisingChannelType[args.campaign_type ?? 'SEARCH'],
      status:                           enums.CampaignStatus.PAUSED,
      campaign_budget:                  budgetResourceName,
      start_date:                       args.start_date ?? today,
      // Required for EU accounts (Google Ads EU political advertising transparency rules)
      // EuPoliticalAdvertisingStatus enum: 3 = DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
      network_settings: {
        target_google_search:   args.network_search ?? true,
        target_search_network:  args.network_search_partners ?? false,
        target_content_network: false,
      },
    };

    if (args.end_date) campaign.end_date = args.end_date;
    if (args.url_expansion_opt_out !== undefined) campaign.url_expansion_opt_out = args.url_expansion_opt_out;
    if (args.ai_max_enabled !== undefined) campaign.automatically_created_assets_enabled = args.ai_max_enabled;

    switch (biddingStrategy) {
      case 'MANUAL_CPC':
        campaign.manual_cpc = { enhanced_cpc_enabled: false };
        break;
      case 'TARGET_CPA':
        campaign.target_cpa = args.target_cpa_micros
          ? { target_cpa_micros: args.target_cpa_micros }
          : {};
        break;
      case 'TARGET_ROAS':
        campaign.maximize_conversion_value = args.target_roas
          ? { target_roas: args.target_roas }
          : {};
        break;
      case 'MAXIMIZE_CONVERSIONS':
        campaign.maximize_conversions = {};
        break;
      default:
        // MAXIMIZE_CLICKS in Google Ads API = target_spend (no maximize_clicks field exists)
        campaign.target_spend = {};
    }

    const { results } = await cust.campaigns.create([campaign]);
    const campaignId       = results[0].resource_name.split('/').pop();
    const campaignResource = results[0].resource_name;
    const customerId       = args.customer_id.replace(/-/g, '');
    const targetingLines   = [];

    // Geo targeting — campaign-level CampaignCriteria
    if (args.geo_target_ids?.length) {
      const geoCriteria = args.geo_target_ids.map(id => ({
        campaign: campaignResource,
        location: { geo_target_constant: `geoTargetConstants/${id}` },
      }));
      await cust.campaignCriteria.create(geoCriteria);
      targetingLines.push(`Geo targets: ${args.geo_target_ids.join(', ')}`);
    }

    // Language targeting — campaign-level CampaignCriteria
    if (args.language_ids?.length) {
      const langCriteria = args.language_ids.map(id => ({
        campaign: campaignResource,
        language: { language_constant: `languageConstants/${id}` },
      }));
      await cust.campaignCriteria.create(langCriteria);
      targetingLines.push(`Languages: ${args.language_ids.join(', ')}`);
    }

    const targetingSummary = targetingLines.length
      ? `\n${targetingLines.join('\n')}`
      : '\nTargeting: all locations, all languages (no restrictions set)';

    // Conversion goal — query auto-created CampaignConversionGoals and set biddable
    let conversionGoalSummary = '';
    if (args.conversion_goal) {
      try {
        const goalRows = await cust.query(
          `SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.category, campaign_conversion_goal.biddable
           FROM campaign_conversion_goal
           WHERE campaign_conversion_goal.campaign = '${campaignResource}'`
        );
        const targetCategory = enums.ConversionActionCategory[args.conversion_goal];
        const match = goalRows.find(r => r.campaign_conversion_goal.category === targetCategory);
        if (match) {
          await cust.campaignConversionGoals.update([{
            resource_name: match.campaign_conversion_goal.resource_name,
            biddable: true,
          }]);
          conversionGoalSummary = `\nConversion goal: ${args.conversion_goal} (biddable)`;
        } else {
          conversionGoalSummary = `\nConversion goal: ${args.conversion_goal} requested but no matching goal found in account, set manually in UI`;
        }
      } catch (goalErr) {
        const msg = goalErr?.errors?.length
          ? goalErr.errors.map(e => e.message).join('; ')
          : (goalErr?.message ?? String(goalErr));
        conversionGoalSummary = `\nConversion goal: failed to set (${msg}), set manually in UI`;
      }
    }

    return `Campaign created (PAUSED).\nID: ${campaignId}\nResource: ${campaignResource}\nBudget: ${budgetResourceName}${targetingSummary}${conversionGoalSummary}\n\nActivate with update_campaign when ready.`;
  }

  // ── update_campaign ──────────────────────────────────────────────────────
  if (name === 'update_campaign') {
    const cust         = getCustomer(args.customer_id);
    const customerId   = args.customer_id.replace(/-/g, '');
    const resourceName = `customers/${customerId}/campaigns/${args.campaign_id}`;
    const updates      = { resource_name: resourceName };
    const updateMask   = [];

    if (args.status)    { updates.status    = enums.CampaignStatus[args.status]; updateMask.push('status'); }
    if (args.name)      { updates.name      = args.name;                          updateMask.push('name'); }
    if (args.end_date)  { updates.end_date  = args.end_date;                      updateMask.push('end_date'); }
    if (args.url_expansion_opt_out !== undefined) { updates.url_expansion_opt_out = args.url_expansion_opt_out; updateMask.push('url_expansion_opt_out'); }
    if (args.ai_max_enabled !== undefined)        { updates.automatically_created_assets_enabled = args.ai_max_enabled; updateMask.push('automatically_created_assets_enabled'); }

    // Bidding strategy change
    if (args.bidding_strategy) {
      switch (args.bidding_strategy) {
        case 'MANUAL_CPC':
          updates.manual_cpc = { enhanced_cpc_enabled: false };
          updateMask.push('manual_cpc');
          break;
        case 'TARGET_CPA':
          updates.target_cpa = args.target_cpa_micros ? { target_cpa_micros: args.target_cpa_micros } : {};
          updateMask.push('target_cpa');
          break;
        case 'TARGET_ROAS':
          updates.maximize_conversion_value = args.target_roas ? { target_roas: args.target_roas } : {};
          updateMask.push('maximize_conversion_value');
          break;
        case 'MAXIMIZE_CONVERSIONS':
          updates.maximize_conversions = {};
          updateMask.push('maximize_conversions');
          break;
        default: // MAXIMIZE_CLICKS
          updates.target_spend = {};
          updateMask.push('target_spend');
      }
    }

    if (args.daily_budget_micros) {
      const [budgetRow] = await cust.query(
        `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${args.campaign_id}`
      );
      if (budgetRow) {
        await cust.campaignBudgets.update([{
          resource_name: budgetRow.campaign.campaign_budget,
          amount_micros: args.daily_budget_micros,
        }]);
      }
    }

    if (updateMask.length > 0) await cust.campaigns.update([updates]);

    // Conversion goal change
    let goalNote = '';
    if (args.conversion_goal) {
      const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;
      try {
        const goalRows = await cust.query(
          `SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.category, campaign_conversion_goal.biddable
           FROM campaign_conversion_goal
           WHERE campaign_conversion_goal.campaign = '${campaignResource}'`
        );
        const targetCategory = enums.ConversionActionCategory[args.conversion_goal];
        const match = goalRows.find(r => r.campaign_conversion_goal.category === targetCategory);
        if (match) {
          await cust.campaignConversionGoals.update([{
            resource_name: match.campaign_conversion_goal.resource_name,
            biddable: true,
          }]);
          goalNote = ` | Conversion goal: ${args.conversion_goal} (biddable)`;
        } else {
          goalNote = ` | Conversion goal: ${args.conversion_goal} not found in account, set manually in UI`;
        }
      } catch (goalErr) {
        const msg = goalErr?.errors?.length ? goalErr.errors.map(e => e.message).join('; ') : (goalErr?.message ?? String(goalErr));
        goalNote = ` | Conversion goal failed: ${msg}`;
      }
    }

    return `Campaign ${args.campaign_id} updated.${goalNote}`;
  }

  // ── create_ad_group ──────────────────────────────────────────────────────
  if (name === 'create_ad_group') {
    const cust             = getCustomer(args.customer_id);
    const customerId       = args.customer_id.replace(/-/g, '');
    const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;

    const adGroup = {
      name:     args.name,
      campaign: campaignResource,
      status:   enums.AdGroupStatus[args.status ?? 'ENABLED'],
      type:     enums.AdGroupType.SEARCH_STANDARD,
    };
    if (args.cpc_bid_micros) adGroup.cpc_bid_micros = args.cpc_bid_micros;

    const { results } = await cust.adGroups.create([adGroup]);
    const adGroupId   = results[0].resource_name.split('/').pop();

    return `Ad group created.\nID: ${adGroupId}\nResource: ${results[0].resource_name}`;
  }

  // ── update_ad_group ──────────────────────────────────────────────────────
  if (name === 'update_ad_group') {
    const cust         = getCustomer(args.customer_id);
    const customerId   = args.customer_id.replace(/-/g, '');
    const resourceName = `customers/${customerId}/adGroups/${args.ad_group_id}`;
    const updates      = { resource_name: resourceName };
    const updateMask   = [];

    if (args.status)         { updates.status         = enums.AdGroupStatus[args.status]; updateMask.push('status'); }
    if (args.name)           { updates.name           = args.name;                         updateMask.push('name'); }
    if (args.cpc_bid_micros) { updates.cpc_bid_micros = args.cpc_bid_micros;               updateMask.push('cpc_bid_micros'); }

    if (updateMask.length === 0) return 'No updates provided.';

    await cust.adGroups.update([updates]);
    return `Ad group ${args.ad_group_id} updated: ${JSON.stringify({ status: args.status, name: args.name, cpc_bid_micros: args.cpc_bid_micros })}`;
  }

  // ── create_keyword ───────────────────────────────────────────────────────
  if (name === 'create_keyword') {
    const cust            = getCustomer(args.customer_id);
    const customerId      = args.customer_id.replace(/-/g, '');
    const adGroupResource = `customers/${customerId}/adGroups/${args.ad_group_id}`;

    const criterion = {
      ad_group: adGroupResource,
      status:   enums.AdGroupCriterionStatus[args.status ?? 'ENABLED'],
      keyword: {
        text:       args.keyword_text,
        match_type: enums.KeywordMatchType[args.match_type ?? 'PHRASE'],
      },
    };
    if (args.cpc_bid_micros) criterion.cpc_bid_micros = args.cpc_bid_micros;

    const { results } = await cust.adGroupCriteria.create([criterion]);
    const criterionId  = results[0].resource_name.split('/').pop();

    return `Keyword added.\nText: "${args.keyword_text}" [${args.match_type ?? 'PHRASE'}]\nCriterion ID: ${criterionId}\nResource: ${results[0].resource_name}`;
  }

  // ── update_keyword ───────────────────────────────────────────────────────
  if (name === 'update_keyword') {
    const cust         = getCustomer(args.customer_id);
    const customerId   = args.customer_id.replace(/-/g, '');
    const resourceName = `customers/${customerId}/adGroups/${args.ad_group_id}/adGroupCriteria/${args.criterion_id}`;
    const updates      = { resource_name: resourceName };
    const updateMask   = [];

    if (args.status)         { updates.status         = enums.AdGroupCriterionStatus[args.status]; updateMask.push('status'); }
    if (args.cpc_bid_micros) { updates.cpc_bid_micros = args.cpc_bid_micros;                        updateMask.push('cpc_bid_micros'); }

    if (updateMask.length === 0) return 'No updates provided.';

    await cust.adGroupCriteria.update([updates]);
    return `Keyword ${args.criterion_id} updated: ${JSON.stringify({ status: args.status, cpc_bid_micros: args.cpc_bid_micros })}`;
  }

  // ── create_negative_keyword ──────────────────────────────────────────────
  if (name === 'create_negative_keyword') {
    const cust       = getCustomer(args.customer_id);
    const customerId = args.customer_id.replace(/-/g, '');
    const matchType  = enums.KeywordMatchType[args.match_type ?? 'EXACT'];
    const keyword    = { text: args.keyword_text, match_type: matchType };

    if (args.ad_group_id) {
      // Ad group-level negative
      const { results } = await cust.adGroupCriteria.create([{
        ad_group: `customers/${customerId}/adGroups/${args.ad_group_id}`,
        status:   enums.AdGroupCriterionStatus.ENABLED,
        negative: true,
        keyword,
      }]);
      const criterionId = results[0].resource_name.split('/').pop();
      return `Negative keyword added at ad group level.\nText: "${args.keyword_text}" [${args.match_type ?? 'EXACT'}]\nCriterion ID: ${criterionId}`;

    } else if (args.campaign_id) {
      // Campaign-level negative
      const { results } = await cust.campaignCriteria.create([{
        campaign: `customers/${customerId}/campaigns/${args.campaign_id}`,
        negative: true,
        keyword,
      }]);
      const criterionId = results[0].resource_name.split('/').pop();
      return `Negative keyword added at campaign level.\nText: "${args.keyword_text}" [${args.match_type ?? 'EXACT'}]\nCriterion ID: ${criterionId}`;

    } else {
      throw new Error('Either campaign_id or ad_group_id is required for create_negative_keyword.');
    }
  }

  // ── create_responsive_search_ad ──────────────────────────────────────────
  if (name === 'create_responsive_search_ad') {
    const cust            = getCustomer(args.customer_id);
    const customerId      = args.customer_id.replace(/-/g, '');
    const adGroupResource = `customers/${customerId}/adGroups/${args.ad_group_id}`;

    const PIN_FIELD = {
      1: enums.ServedAssetFieldType.HEADLINE_1,
      2: enums.ServedAssetFieldType.HEADLINE_2,
      3: enums.ServedAssetFieldType.HEADLINE_3,
    };
    const headlines = args.headlines.slice(0, 15).map(h => {
      if (typeof h === 'string') return { text: h };
      const asset = { text: h.text };
      if (h.pin && PIN_FIELD[h.pin]) asset.pinned_field = PIN_FIELD[h.pin];
      return asset;
    });

    const adGroupAd = {
      ad_group: adGroupResource,
      status:   enums.AdGroupAdStatus.ENABLED,
      ad: {
        final_urls: args.final_urls,
        responsive_search_ad: {
          headlines,
          descriptions: args.descriptions.slice(0, 4).map(text => ({ text })),
        },
      },
    };

    if (args.path1) adGroupAd.ad.responsive_search_ad.path1 = args.path1;
    if (args.path2) adGroupAd.ad.responsive_search_ad.path2 = args.path2;

    const { results } = await cust.adGroupAds.create([adGroupAd]);
    const adId = results[0].resource_name.split('/').pop();

    return `Responsive Search Ad created.\nAd ID: ${adId}\nHeadlines: ${args.headlines.length}\nDescriptions: ${args.descriptions.length}\nResource: ${results[0].resource_name}`;
  }

  // ── update_ad ────────────────────────────────────────────────────────────
  if (name === 'update_ad') {
    const cust         = getCustomer(args.customer_id);
    const customerId   = args.customer_id.replace(/-/g, '');
    const resourceName = `customers/${customerId}/adGroupAds/${args.ad_group_id}~${args.ad_id}`;

    await cust.adGroupAds.update([{
      resource_name: resourceName,
      status:        enums.AdGroupAdStatus[args.status],
    }]);

    return `Ad ${args.ad_id} status set to ${args.status}.`;
  }

  // ── create_callout_assets ────────────────────────────────────────────────
  if (name === 'create_callout_assets') {
    const cust             = getCustomer(args.customer_id);
    const customerId       = args.customer_id.replace(/-/g, '');
    const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;
    const created          = [];

    for (const calloutText of args.callouts) {
      const { results: assetResults } = await cust.assets.create([{
        name:           `Callout: ${calloutText}`,
        callout_asset:  { callout_text: calloutText },
      }]);
      const assetResource = assetResults[0].resource_name;
      await cust.campaignAssets.create([{
        campaign:   campaignResource,
        asset:      assetResource,
        field_type: enums.AssetFieldType.CALLOUT,
      }]);
      created.push(calloutText);
    }

    return `Callout assets added to campaign ${args.campaign_id}:\n${created.map(c => `  • ${c}`).join('\n')}`;
  }

  // ── create_structured_snippet ────────────────────────────────────────────
  if (name === 'create_structured_snippet') {
    const cust             = getCustomer(args.customer_id);
    const customerId       = args.customer_id.replace(/-/g, '');
    const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;

    const { results: assetResults } = await cust.assets.create([{
      name: `Snippet: ${args.header}`,
      structured_snippet_asset: {
        header: args.header,
        values: args.values,
      },
    }]);
    const assetResource = assetResults[0].resource_name;
    await cust.campaignAssets.create([{
      campaign:   campaignResource,
      asset:      assetResource,
      field_type: enums.AssetFieldType.STRUCTURED_SNIPPET,
    }]);

    return `Structured snippet added to campaign ${args.campaign_id}:\n  ${args.header}: ${args.values.join(', ')}`;
  }

  // ── add_audience_target ──────────────────────────────────────────────────
  if (name === 'add_audience_target') {
    const cust             = getCustomer(args.customer_id);
    const customerId       = args.customer_id.replace(/-/g, '');
    const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;

    const criterion = {
      campaign:      campaignResource,
      criterion_use: enums.CriterionUse.OBSERVATION,
    };

    if (args.audience_type === 'user_interest') {
      criterion.user_interest = { user_interest_category: `userInterests/${args.audience_id}` };
    } else if (args.audience_type === 'user_list') {
      criterion.user_list = { user_list: `customers/${customerId}/userLists/${args.audience_id}` };
    }

    const { results } = await cust.campaignCriteria.create([criterion]);
    const criterionId = results[0].resource_name.split('/').pop();

    let summary = `Audience added (observation mode).\nType: ${args.audience_type}\nAudience ID: ${args.audience_id}\nCriterion ID: ${criterionId}`;
    if (args.bid_modifier !== undefined) {
      await cust.campaignCriteria.update([{
        resource_name:  results[0].resource_name,
        bid_modifier:   args.bid_modifier,
      }]);
      summary += `\nBid modifier: ${args.bid_modifier}`;
    }
    return summary;
  }

  // ── create_sitelink_assets ───────────────────────────────────────────────
  if (name === 'create_sitelink_assets') {
    const cust             = getCustomer(args.customer_id);
    const customerId       = args.customer_id.replace(/-/g, '');
    const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;
    const created          = [];

    for (const sl of args.sitelinks) {
      const sitelinkAsset = { link_text: sl.text, final_urls: [sl.url] };
      if (sl.desc1) sitelinkAsset.description1 = sl.desc1;
      if (sl.desc2) sitelinkAsset.description2 = sl.desc2;

      const { results: assetResults } = await cust.assets.create([{
        name:           `Sitelink: ${sl.text}`,
        sitelink_asset: sitelinkAsset,
      }]);
      await cust.campaignAssets.create([{
        campaign:   campaignResource,
        asset:      assetResults[0].resource_name,
        field_type: enums.AssetFieldType.SITELINK,
      }]);
      created.push(`${sl.text} → ${sl.url}`);
    }

    return `Sitelinks added to campaign ${args.campaign_id}:\n${created.map(s => `  • ${s}`).join('\n')}`;
  }

  // ── create_call_asset ────────────────────────────────────────────────────
  if (name === 'create_call_asset') {
    const cust             = getCustomer(args.customer_id);
    const customerId       = args.customer_id.replace(/-/g, '');
    const campaignResource = `customers/${customerId}/campaigns/${args.campaign_id}`;

    const { results: assetResults } = await cust.assets.create([{
      name:       `Call: ${args.phone_number}`,
      call_asset: { country_code: args.country_code, phone_number: args.phone_number },
    }]);
    await cust.campaignAssets.create([{
      campaign:   campaignResource,
      asset:      assetResults[0].resource_name,
      field_type: enums.AssetFieldType.CALL,
    }]);

    return `Call asset added to campaign ${args.campaign_id}: ${args.phone_number} (${args.country_code})`;
  }

  // ── search_audiences ─────────────────────────────────────────────────────
  if (name === 'search_audiences') {
    const cust   = getCustomer(args.customer_id);
    const type   = args.type ?? 'both';
    const q      = args.query.replace(/'/g, "\\'");
    const results = [];

    if (type === 'user_interest' || type === 'both') {
      const rows = await cust.query(
        `SELECT user_interest.user_interest_id, user_interest.name
         FROM user_interest
         WHERE user_interest.name LIKE '%${q}%'
         LIMIT 20`
      );
      rows.forEach(r => results.push({ type: 'user_interest', id: r.user_interest.user_interest_id, name: r.user_interest.name }));
    }

    if (type === 'user_list' || type === 'both') {
      const rows = await cust.query(
        `SELECT user_list.id, user_list.name, user_list.membership_status
         FROM user_list
         WHERE user_list.name LIKE '%${q}%'
         LIMIT 20`
      );
      rows.forEach(r => results.push({ type: 'user_list', id: r.user_list.id, name: r.user_list.name, status: r.user_list.membership_status }));
    }

    if (results.length === 0) return `No audiences found matching "${args.query}".`;
    return JSON.stringify(results, null, 2);
  }

  // ── list_campaign_assets ─────────────────────────────────────────────────
  if (name === 'list_campaign_assets') {
    const cust         = getCustomer(args.customer_id);
    const customerId   = args.customer_id.replace(/-/g, '');
    const campaignRes  = `customers/${customerId}/campaigns/${args.campaign_id}`;

    const rows = await cust.query(
      `SELECT campaign_asset.asset, campaign_asset.field_type, campaign_asset.status,
              asset.id, asset.name, asset.type,
              asset.callout_asset.callout_text,
              asset.sitelink_asset.link_text, asset.sitelink_asset.final_urls,
              asset.structured_snippet_asset.header, asset.structured_snippet_asset.values,
              asset.call_asset.phone_number, asset.call_asset.country_code
       FROM campaign_asset
       WHERE campaign_asset.campaign = '${campaignRes}'`
    );

    if (rows.length === 0) return 'No assets linked to this campaign.';
    return JSON.stringify(rows.map(r => ({
      asset_id:   r.asset.id,
      field_type: r.campaign_asset.field_type,
      status:     r.campaign_asset.status,
      name:       r.asset.name,
      type:       r.asset.type,
      callout:    r.asset.callout_asset?.callout_text,
      sitelink:   r.asset.sitelink_asset?.link_text,
      urls:       r.asset.sitelink_asset?.final_urls,
      snippet:    r.asset.structured_snippet_asset ? `${r.asset.structured_snippet_asset.header}: ${r.asset.structured_snippet_asset.values?.join(', ')}` : undefined,
      call:       r.asset.call_asset ? `${r.asset.call_asset.phone_number} (${r.asset.call_asset.country_code})` : undefined,
    })), null, 2);
  }

  // ── remove_campaign_asset ────────────────────────────────────────────────
  if (name === 'remove_campaign_asset') {
    const cust       = getCustomer(args.customer_id);
    const customerId = args.customer_id.replace(/-/g, '');
    const fieldType  = args.field_type.toUpperCase();
    // resource_name format: customers/{cid}/campaignAssets/{campaign_id}~{asset_id}~{field_type_enum}
    // field_type_enum is the integer value — easier to remove by querying first
    const rows = await cust.query(
      `SELECT campaign_asset.resource_name, campaign_asset.field_type
       FROM campaign_asset
       WHERE campaign_asset.campaign = 'customers/${customerId}/campaigns/${args.campaign_id}'
         AND campaign_asset.asset = 'customers/${customerId}/assets/${args.asset_id}'`
    );
    if (rows.length === 0) throw new Error(`Asset ${args.asset_id} not found on campaign ${args.campaign_id}`);
    await cust.campaignAssets.remove([rows[0].campaign_asset.resource_name]);
    return `Asset ${args.asset_id} (${fieldType}) removed from campaign ${args.campaign_id}.`;
  }

  // ── remove_campaign_criterion ────────────────────────────────────────────
  if (name === 'remove_campaign_criterion') {
    const cust       = getCustomer(args.customer_id);
    const customerId = args.customer_id.replace(/-/g, '');
    const resourceName = `customers/${customerId}/campaignCriteria/${args.campaign_id}~${args.criterion_id}`;
    await cust.campaignCriteria.remove([resourceName]);
    return `Criterion ${args.criterion_id} removed from campaign ${args.campaign_id}.`;
  }

  // ── update_budget ────────────────────────────────────────────────────────
  if (name === 'update_budget') {
    const cust       = getCustomer(args.customer_id);
    const customerId = args.customer_id.replace(/-/g, '');

    await cust.campaignBudgets.update([{
      resource_name: `customers/${customerId}/campaignBudgets/${args.campaign_budget_id}`,
      amount_micros: args.daily_amount_micros,
    }]);

    const amount = (args.daily_amount_micros / 1_000_000).toFixed(2);
    return `Budget ${args.campaign_budget_id} updated to ${amount}/day (account currency).`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'google-ads-mcp', version: '1.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await handleTool(name, args ?? {});
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    // google-ads-api wraps Google Ads API failures as GoogleAdsFailure objects.
    // err.message is often undefined — actual details are in err.errors[].
    let message;
    if (err instanceof errors.GoogleAdsFailure && err.errors?.length > 0) {
      message = err.errors
        .map(e => `${e.message ?? ''}${e.error_code ? ` [${JSON.stringify(e.error_code)}]` : ''}`)
        .join('; ');
    } else {
      message = err?.message || JSON.stringify(err) || String(err);
    }
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[google-ads-mcp] Ready — customer: ${MANAGER_ID} | oauth: ${hasOAuth ? 'yes' : 'NO — all tools require OAuth credentials'}`);
