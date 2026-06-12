---
name: google-ads-copy
description: Use this when the user wants to WRITE or IMPROVE Google Ads copy — generating RSA headlines and descriptions, checking character limits, rewriting existing ads, or creating ad variations for testing.
allowed-tools: mcp__google-ads__search, mcp__google-ads__list_accounts, mcp__google-ads__create_responsive_search_ad, mcp__google-ads__update_ad
requires: google-ads
---

# Google Ads Copy Protocol

## 1. Gather context before writing

Before generating any copy, collect:

- **Product / service** — what is being sold? Key differentiators?
- **Target keywords** — what queries should the ad match? (at least 2–3 seed keywords)
- **Landing page URL** — extract product name, key benefits, price/offer, CTA language (see `references/copy-recipes.md` → landing-page extraction).
- **Tone** — luxury, friendly, urgent, professional?
- **Constraints** — anything to avoid? Brand guidelines?
- **Existing ads** — check what's running:

```
SELECT ad_group_ad.ad.responsive_search_ad.headlines,
       ad_group_ad.ad.responsive_search_ad.descriptions
FROM ad_group_ad
WHERE ad_group_ad.status = 'ENABLED'
```

## 2. RSA character limits — enforce strictly

| Asset | Limit | Rule |
|---|---|---|
| Headline | 30 characters max | Include primary keyword in at least 1; include price/offer in at least 1 |
| Description | 90 characters max | At least 1 must have a clear CTA |
| path1 / path2 | 15 characters each | Short, readable slugs |

**Count characters before proposing.** If a headline is 31+ chars, shorten first. Never submit text that exceeds limits.

## 3. Write 15 headlines + 4 descriptions

Full recipe (headline-type spread, description archetypes, pinning rules, rewriting flow) → `references/copy-recipes.md`.

## 4. Present for review before creating

Show the full proposed ad copy clearly:

```
HEADLINES (15):
1. [30 chars] From €850 — Allura Corset      ← pin 1
2. [28 chars] Handmade French Silk Corsets
3. [25 chars] Made to Your Measurements
...

DESCRIPTIONS (4):
1. Handcrafted corsets in 100% French silk. Free sizing exchange. Ships in 4 weeks. Order now.
2. ...

PATH: allura.com / corsets / silk

Does this look right? Any headlines to change before I create the ad?
```

**Never create the ad without explicit approval.**

## 5. After creating — report

> "RSA created in ad group [name]. Ad ID: 12345.
> 15 headlines, 4 descriptions. Headline 1 pinned: 'From €850 — Allura Corset'.
> Google will test combinations and optimise over time — check ad strength in 1–2 weeks."

If ad strength is visible in the account, note it.
