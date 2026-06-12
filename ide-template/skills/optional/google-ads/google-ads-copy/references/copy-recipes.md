# Google Ads copy — recipes

## RSA fill — 15 headlines + 4 descriptions

Generate a full set, not just the minimum. Spread headline types deliberately:

| Type | Count | Notes |
|---|---|---|
| Keyword-focused | 2–3 | Include the main search term |
| Price / offer | 1–2 | "From €850", "Free Sizing Exchange" |
| Benefit | 3–4 | What does the customer get? |
| USP / differentiator | 2–3 | What makes this unique? |
| CTA | 2 | "Order Now", "Shop the Collection" |
| Social proof | 1 | "Worn by 500+ Brides" (only if true) |
| Urgency | 1 | "Ships in 4 Weeks", "Limited Stock" |

**Description types (4):**

1. Primary benefit + CTA
2. Product detail + offer
3. Trust / social proof + CTA
4. Emotional / aspirational + CTA

## Pinning

If the user wants a specific headline pinned to position 1 (e.g. brand name or price), propose it with `pin: 1` in the `create_responsive_search_ad` call.

**Only pin when** the user explicitly asks, or there's a compliance/branding reason. Pinning limits Google's optimisation — overuse degrades performance.

## Rewriting existing ads

1. Fetch current headlines/descriptions via `search`.
2. Identify weaknesses: missing keyword, no price, no CTA, repetitive copy, over character limit.
3. Propose specific replacements with reasoning per item ("Headline 4 has no CTA, swap for 'Shop the Collection'").
4. Get confirmation.
5. **RSAs cannot be edited in place** — must create new + pause old (`update_ad` with `status: PAUSED`). Always tell the user this upfront.

## Landing-page extraction

If the user provides a URL, extract before generating copy:
- Product name (exact spelling)
- Key benefits (top 3)
- Price / offer (numeric value, currency)
- CTA language already used on the page

Re-using the landing page's own CTA verbiage in the ad lifts CTR and Quality Score (message-match).
