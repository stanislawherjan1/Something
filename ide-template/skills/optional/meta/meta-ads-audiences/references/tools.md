# Meta Ads audiences — tool reference

## `get_audiences`

Returns all custom + lookalike audiences in the ad account.

Key fields: `id`, `name`, `subtype` (CUSTOM / WEBSITE / LOOKALIKE), `size_approx`, `status` (ready / processing), `updated`.

Use the `id` values in `create_ad_set` as `custom_audience_ids` or `excluded_audience_ids`.

## `create_custom_audience` — type: `customer_list`

Uploads a list of email addresses. Emails are hashed with SHA-256 automatically before being sent to Meta.

Required: `name`, `type: "customer_list"`, `emails: [...]`

```json
{
  "name": "Purchasers Q1 2025",
  "type": "customer_list",
  "emails": ["user@example.com", "other@example.com"]
}
```

- Minimum 100 emails; Meta recommends 1,000–5,000 for use as a lookalike source
- Match rate is typically 50–70% (Meta matches to Facebook accounts)
- After upload, audience populates within minutes

## `create_custom_audience` — type: `website`

Builds an audience from pixel events. Requires `pixel_id` to be configured on the account.

Required: `name`, `type: "website"`, `pixel_id`, `event`, `retention_days`

```json
{
  "name": "AddToCart 14d",
  "type": "website",
  "pixel_id": "123456789",
  "event": "AddToCart",
  "retention_days": 14
}
```

Available events: `PageView`, `ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase` (and any custom events fired by the pixel).

`retention_days`: 1–180. The audience includes users who fired the event within this window.

Audience starts empty and populates as new pixel events arrive.

## `create_lookalike_audience`

Creates a lookalike from an existing custom audience.

Required: `name`, `source_audience_id`, `country`, `ratio`

```json
{
  "name": "LLA 1% PL — Top Customers",
  "source_audience_id": "987654321",
  "country": "PL",
  "ratio": 0.01
}
```

`ratio`: 0.01–0.20 (1%–20% of the country population). Start at 0.01 for highest similarity.

Source audience requirements:

- Minimum 100 people
- Must include people from the target `country`
- Meta recommends 1,000–5,000 high-quality members for best results

Population time: 1–6 hours. The audience will show `status: processing` in `get_audiences` until ready.

## `search_interests`

Finds interest and behavior IDs to use in `create_ad_set`.

Required: `query` (keyword string)

```json
{
  "query": "luxury fashion",
  "locale": "en_US",
  "limit": 10
}
```

Returns: `id`, `name`, `audience_size_lower`, `audience_size_upper`, `path` (category path).

Pass results directly to `create_ad_set`:

```json
"interests": [
  {"id": "6003139266461", "name": "Luxury goods"}
]
```

Interests within one `flexible_spec` object are OR-joined. To AND two groups, pass two objects in the array:

```json
"flexible_spec": [
  {"interests": [{"id": "X"}]},
  {"behaviors": [{"id": "Y"}]}
]
```

→ targets users matching interest X AND behavior Y.
