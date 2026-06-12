---
name: google-ads-report
description: Use this when the user wants to ANALYSE Google Ads performance — weekly or monthly reports, spend overview, CTR analysis, keyword performance, search terms review, anomaly detection, quality score issues, or any "how are the ads doing?" question.
allowed-tools: mcp__google-ads__search, mcp__google-ads__list_accounts
requires: google-ads
---

# Google Ads Reporting Protocol

## 1. Clarify scope before running anything

Before pulling data, confirm:
- **Account** — if `list_accounts` returns more than one, ask which
- **Date range** — if not specified, default to last 30 days and say so
- **Scope** — all campaigns, or specific ones?

## 2. Standard report structure

For a general performance report, pull these in order and present as one summary:

### Campaign overview
```
SELECT campaign.id, campaign.name, campaign.status,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, metrics.ctr, metrics.average_cpc,
       metrics.cost_per_conversion
FROM campaign
WHERE segments.date DURING LAST_30_DAYS
  AND campaign.status != 'REMOVED'
ORDER BY metrics.cost_micros DESC
```

### Keyword performance (top 20 by spend)
```
SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
       campaign.name, ad_group.name,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, metrics.ctr, metrics.average_cpc,
       ad_group_criterion.quality_info.quality_score
FROM ad_group_criterion
WHERE ad_group_criterion.type = KEYWORD
  AND segments.date DURING LAST_30_DAYS
ORDER BY metrics.cost_micros DESC
LIMIT 20
```

### Search terms (top 30 by clicks)
```
SELECT search_term_view.search_term, campaign.name,
       metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS
ORDER BY metrics.clicks DESC
LIMIT 30
```

### Ad performance
```
SELECT ad_group_ad.ad.id, campaign.name, ad_group.name,
       ad_group_ad.ad.responsive_search_ad.headlines,
       metrics.impressions, metrics.clicks, metrics.ctr,
       ad_group_ad.policy_summary.approval_status
FROM ad_group_ad
WHERE segments.date DURING LAST_30_DAYS
  AND ad_group_ad.status = 'ENABLED'
```

## 3. Always flag anomalies

After pulling data, automatically check for and highlight:

| Anomaly | Threshold | Action |
|---|---|---|
| Zero-conversion keywords | >50 clicks, 0 conversions | Flag as potential waste |
| Low CTR keywords | CTR < 1% on Search | Flag — may hurt Quality Score |
| Low Quality Score | QS ≤ 4 | Flag — hurts CPC and ad rank |
| Budget exhaustion | Campaign spending >95% of daily budget | Mention — may be limiting impressions |
| Underperforming ads | 0 impressions in last 30 days (enabled ads) | Flag — may be disapproved |
| High CPC keywords | CPC > 3× account average | Flag for bid review |

Present anomalies as a dedicated "⚠️ Issues to address" section at the end of the report.

## 4. Number formatting

Always format output for humans — never return raw API values:

- **Cost**: divide `cost_micros` by 1,000,000, show as currency (e.g. `€32.50`)
- **CTR**: as percentage with 2 decimal places (e.g. `3.21%`)
- **CPC**: as currency (e.g. `€0.84`)
- **Conversions**: integer or 1 decimal (e.g. `14` or `14.5`)
- **Impressions / clicks**: integer with thousands separator (e.g. `12,450`)

## 5. Report layout

Present the report in this order:

1. **Summary** — total spend, clicks, impressions, CTR, conversions, CPA for the period
2. **By campaign** — table with key metrics per campaign
3. **Top keywords** — top 10 by spend with QS
4. **Search terms** — top 20 by clicks, note any that convert well but aren't added as keywords yet
5. **Ads** — approval status, flag any disapproved
6. **⚠️ Issues** — anomalies from section 3

## 6. Proactively suggest next steps

After the report, offer:
- "X keywords have >50 clicks and 0 conversions — want me to add them as negatives?"
- "Y ad has been disapproved — want me to check the policy reason?"
- "Campaign Z is hitting its daily budget — want to increase it?"

Do not act on these without confirmation.
