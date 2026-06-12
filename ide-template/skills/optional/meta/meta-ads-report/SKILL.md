---
name: meta-ads-report
description: Use this when the user asks about Meta Ads performance, results, spend, ROAS, or wants a report on campaigns, ad sets, or individual ads.
allowed-tools: Glob, Read, mcp__meta__get_campaigns, mcp__meta__get_campaign_performance, mcp__meta__get_ad_account_insights, mcp__meta__get_ad_sets, mcp__meta__get_ads, mcp__meta__get_ad_insights, mcp__meta__get_instagram_insights, mcp__meta__get_instagram_media, mcp__meta__get_page_insights
requires: meta
---

# Meta Ads Report Protocol

## Step 0 — Read project context first

Search for project-specific Meta files (ROAS targets, campaign structure, KPI benchmarks, account notes). Adjust the globs to your project's actual layout.

```
Glob: marketing/meta/**
Glob: marketing/meta-ads/**
Glob: docs/meta/**
```

Read any files found. They may define ROAS targets, CPA goals, or which campaigns to focus on. If not found, proceed — apply default thresholds from this skill.

---

## Default data pull

When asked for a report without a specific scope, run these in parallel:

1. `get_ad_account_insights` — `date_preset: "last_7d"` (or as requested)
2. `get_campaigns` — `status: "ALL"` to see what's active vs paused
3. `get_campaign_performance` — for each ACTIVE campaign
4. `get_ad_insights` — account-level, same date range as above

Adjust `date_preset` or use `since`/`until` if user specifies a period.

Available `date_preset` values: `today`, `yesterday`, `last_3d`, `last_7d`, `last_14d`, `last_28d`, `last_30d`, `last_90d`, `this_month`, `last_month`.

---

## Number formatting — always apply

| Field | Format |
|---|---|
| spend, cpc, cpp | Currency + 2 decimals: `€1,234.56` |
| ctr | Percentage: `2.34%` |
| purchase_roas | Ratio: `3.41×` |
| purchases, impressions, reach | Integer with thousands separator: `12,456` |
| frequency | 2 decimals: `2.34` |

Never output raw API values (e.g. `"spend": "4521.00"` → show as `€4,521.00`).

---

## Report structure

```
ACCOUNT — [date range]
Spend: €X | Purchases: X | Revenue: €X | ROAS: X.X× | CTR: X.X% | CPC: €X.XX

CAMPAIGNS
[table: name | spend | purchases | ROAS | CTR | status]

TOP ADS (by ROAS)
1. [ad name] — ROAS X.X× | Spend €X | CTR X.X%

BOTTOM ADS (high spend, low ROAS)
1. [ad name] — ROAS X.X× | Spend €X | CTR X.X%

ISSUES
[see anomaly list below]

NEXT STEPS
[see recommendations below — always as questions, never auto-executed]
```

---

## Anomaly detection — check every report

Run these checks on every report. Flag any that trigger:

| Check | Condition | Flag |
|---|---|---|
| Zero conversions | Spend > €50, purchases = 0 | "[Campaign X] spent €Y with 0 purchases" |
| Low CTR | CTR < 1.0% | "[Ad X] CTR X% — below 1% threshold" |
| Learning phase stalled | Ad set > 14 days, < 50 conversions | "[Ad set X] may be stuck in learning phase" |
| Budget cap hit | Daily spend ≥ 95% of budget | "[Campaign X] hitting daily budget cap" |
| No active creatives | Campaign active, all ads paused | "[Campaign X] has no active ads" |
| Single creative | Only 1 active ad per ad set | "[Ad set X] has only 1 active creative" |
| ROAS below threshold | ROAS < 2.0× (or project-defined target) | "[Campaign X] ROAS X.X× below target" |
| High frequency | Frequency > 3.0 | "[Ad set X] frequency X.X — audience may be saturating" |

---

## Recommendations

After flagging anomalies, list proposed actions as questions — never auto-execute:

```
NEXT STEPS
1. Pause [ad X] — €200 spent, 0 purchases. Pause it?
2. Increase budget on [campaign Y] — ROAS 4.2×, hitting daily cap. Increase to €X?
3. Add new creative to [ad set Z] — only 1 active ad. Upload one?
```

Wait for user confirmation before using any write tool.

---

## Breakdown reports

If user asks for breakdown by age / gender / device / placement:
- Use `get_ad_account_insights` with `breakdown` parameter
- Values: `"age"`, `"gender"`, `"age,gender"`, `"device_platform"`, `"publisher_platform"`, `"impression_device"`
- Present as sorted table, best-performing segment first

---

## Instagram / Page reports

`get_instagram_insights` — requires `META_INSTAGRAM_ACCOUNT_ID`. Returns reach, profile_views, followers_count.

`get_instagram_media` — per-post: like_count, comments_count, insights (reach, views, saved, total_interactions).

`get_page_insights` — requires `META_PAGE_ID`. Returns page_impressions, page_impressions_unique, page_views_total, page_fan_adds, page_post_engagements.

Period options for page insights: `"day"`, `"week"`, `"days_28"`.
