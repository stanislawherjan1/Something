# Extensions (assets) + audience targeting

## Extensions

Extensions show extra info below the ad and improve CTR.

| Tool | What it adds | Key params |
|---|---|---|
| `create_sitelink_assets` | Extra links with own URLs | `sitelinks: [{ text, url, desc1?, desc2? }]` |
| `create_callout_assets` | Short phrases (max 25 chars) | `callouts: ["Handmade to Order", ...]` |
| `create_structured_snippet` | Header + value list | `header: "Types"`, `values: ["Corsets", ...]` |
| `create_call_asset` | Phone number / call button | `phone_number`, `country_code` |

**See what's on a campaign:** `list_campaign_assets`

**Remove an extension:** `remove_campaign_asset` — needs `asset_id` (from `list_campaign_assets`) + `field_type`

## Audience targeting

Add audiences in **observation mode** by default — does not restrict reach, only allows bid adjustment and performance tracking per segment.

```
1. search_audiences — find IDs by name (e.g. "luxury", "fashion")
2. add_audience_target — pass audience_type ("user_interest" or "user_list") + audience_id
```

## Removing a targeting criterion (geo / language / audience)

1. Find criterion ID with the campaign-criteria GAQL query in `gaql-queries.md`.
2. Call `remove_campaign_criterion` with that `criterion_id`.

## Negative-keyword defaults

When adding negatives, default to `EXACT` match unless the user specifies otherwise. BROAD negatives can accidentally block relevant searches.

Good defaults for any new campaign:
- `"free"` [EXACT]
- `"cheap"` [EXACT]
- Any terms clearly outside the business category

For negatives identified from the search-terms report, use the **same match type** as how they appeared.

## RSA guidelines

- Headlines: 3–15, max 30 characters each. Include the main keyword in at least one.
- Descriptions: 2–4, max 90 characters each. At least one should include a clear CTA.
- `path1` / `path2`: short display path slugs — keep readable (e.g. `shoes`, `sale`).
- **Never truncate** — if a headline exceeds 30 chars, shorten it before calling the tool.
