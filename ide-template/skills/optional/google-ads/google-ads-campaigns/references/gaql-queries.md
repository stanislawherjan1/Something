# GAQL query templates

Use the `mcp__google-ads__search` tool with these queries. Convert `cost_micros` to currency when reporting: divide by 1,000,000.

## Campaign performance (last 30 days)

```
SELECT campaign.id, campaign.name, campaign.status,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, metrics.ctr, metrics.average_cpc
FROM campaign
WHERE segments.date DURING LAST_30_DAYS
ORDER BY metrics.cost_micros DESC
```

## Keyword performance

```
SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, ad_group_criterion.quality_info.quality_score
FROM ad_group_criterion
WHERE ad_group_criterion.type = KEYWORD
  AND segments.date DURING LAST_30_DAYS
ORDER BY metrics.clicks DESC
```

## Search terms (what people actually searched for)

```
SELECT search_term_view.search_term, metrics.clicks, metrics.impressions,
       metrics.cost_micros, metrics.conversions
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS
ORDER BY metrics.clicks DESC
LIMIT 50
```

## Ad performance

```
SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines,
       metrics.impressions, metrics.clicks, metrics.ctr,
       ad_group_ad.policy_summary.approval_status
FROM ad_group_ad
WHERE segments.date DURING LAST_30_DAYS
```

## Campaign criteria (for finding criterion_id when removing geo/language/audience)

```
SELECT campaign_criterion.criterion_id, campaign_criterion.type
FROM campaign_criterion
WHERE campaign_criterion.campaign = 'customers/X/campaigns/Y'
```

## Date-range tokens

`LAST_7_DAYS` · `LAST_14_DAYS` · `LAST_30_DAYS` · `THIS_MONTH` · `LAST_MONTH` · `YESTERDAY` · `TODAY`

For custom ranges: `BETWEEN '2026-04-01' AND '2026-04-30'`.
