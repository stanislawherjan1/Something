# Negatives — triage reference

## Search-terms GAQL query

```
SELECT search_term_view.search_term, search_term_view.status,
       campaign.id, campaign.name, ad_group.id, ad_group.name,
       metrics.clicks, metrics.impressions, metrics.cost_micros,
       metrics.conversions, metrics.ctr
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS
ORDER BY metrics.clicks DESC
LIMIT 100
```

Swap `LAST_30_DAYS` for `LAST_7_DAYS` / `LAST_14_DAYS` if the user specifies a tighter window.

## Categorisation table

Group search terms into these categories and present as a table per category:

| Category | Examples | Default action |
|---|---|---|
| **Competitor brands** | "rival brand corset", "competitor name" | Propose negative (unless brand bidding is intentional — ask) |
| **Irrelevant intent** | "free", "DIY", "how to make" | Negative |
| **Wrong product** | "waist trainer", "shapewear" (if selling only corsets) | Negative if out of scope |
| **Informational** | "what is a corset", "corset history" | Negative unless brand building |
| **Low quality** | >20 clicks, 0 conversions, not a new term | Flag for review |
| **Converting well** | High CTR + conversions, not yet as keyword | Suggest adding as exact match keyword |

## Negative level

- **Campaign-level negative**: blocks the term across all ad groups in the campaign.
- **Ad group-level negative**: blocks it only in one ad group (use when the term is relevant elsewhere).

**Default to campaign-level** unless the user specifies otherwise or the term is only irrelevant for one ad group.

## Match type

Use `EXACT` match for negatives by default. Only use `PHRASE` or `BROAD` if the user explicitly asks. BROAD negatives can accidentally block relevant searches.
