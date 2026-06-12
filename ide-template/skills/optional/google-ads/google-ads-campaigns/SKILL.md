---
name: google-ads-campaigns
description: Use this when the user wants to CREATE or MANAGE Google Ads campaigns — building new campaigns, adding keywords or ads, adjusting budgets, changing bidding strategy or targeting, adding extensions (sitelinks, callouts, snippets), or managing audiences.
allowed-tools: mcp__google-ads__search, mcp__google-ads__list_accounts, mcp__google-ads__keyword_ideas, mcp__google-ads__historical_metrics, mcp__google-ads__create_campaign, mcp__google-ads__update_campaign, mcp__google-ads__create_ad_group, mcp__google-ads__update_ad_group, mcp__google-ads__create_keyword, mcp__google-ads__update_keyword, mcp__google-ads__create_negative_keyword, mcp__google-ads__create_responsive_search_ad, mcp__google-ads__update_ad, mcp__google-ads__update_budget, mcp__google-ads__create_callout_assets, mcp__google-ads__create_structured_snippet, mcp__google-ads__create_sitelink_assets, mcp__google-ads__create_call_asset, mcp__google-ads__add_audience_target, mcp__google-ads__search_audiences, mcp__google-ads__list_campaign_assets, mcp__google-ads__remove_campaign_asset, mcp__google-ads__remove_campaign_criterion
requires: google-ads
---

# Google Ads Protocol

Follow these rules every time you work with Google Ads.

## What cannot be done via API — always remind the user

After every campaign creation or significant change, check this list and tell the user what still needs to be done manually in the UI:

| What | Why API can't do it | Where in UI |
|---|---|---|
| **Delete a campaign** | `REMOVED` status is read-only in API | Campaigns → 3-dot menu → Remove |
| **Set Marketing Objective** | UI-only label (Sales / Leads / Traffic), no API field | Campaign settings → Marketing Objective |
| **AI Max — enable toggle** | `automatically_created_assets_enabled` may not fully reflect the UI toggle in all account types | Campaign settings → Additional settings → Automatically created assets |

**Always end a setup session with:** "Here's what still needs to be done manually in the UI: [list only what applies]." Never claim a campaign is fully set up without mentioning pending manual steps.

## CRITICAL: When in doubt, ask — never guess

Google Ads mistakes cost real money and can be hard to undo. If you are not 100% certain, stop and ask:

- **Which campaign** — if user says "the campaign" but there are multiple, ask which
- **Which account** — if `list_accounts` returns more than one, ask which to use
- **Budget** — if user gives a number without context ("set budget to 100"), confirm: "100 per day or total? In what currency?"
- **Match type** — if not specified, state your assumption and confirm before adding keywords
- **Geo / language** — if user says "target Poland", confirm: country only, or also specific cities?
- **Bidding strategy** — if switching strategies, explain what will change and ask for confirmation
- **Conversion goal** — if not explicitly stated, ask what action should be optimised for
- **Activation** — never enable a paused campaign without explicit "yes, activate it"

Propose, explain, ask. Do not assume and proceed.

## 0. Find project context first

Before doing anything, search the project directory for existing Google Ads context:

```bash
find ~/project -type f \( -name "*.md" -o -name "*.txt" -o -name "*.json" \) \
  | xargs grep -l -i "google.ads\|campaign\|adwords\|keyword" 2>/dev/null | head -10
```

Look for `google-ads.md`, `campaigns.md`, `ads-strategy.md`, or notes in `project/` or `.claude/`. These may contain account IDs, existing structure, brand keywords, negatives, budget guidelines, previous notes. Only proceed once you know whether relevant context exists.

## 1. Always read before you write

Before creating or updating anything, call `search` to understand the current state:

- Creating an ad group? → get the campaign first to confirm it exists
- Adding keywords? → check what already exists in that ad group
- Changing a budget? → confirm the current budget first

Never invent IDs — always fetch them from `search`.

## 2. New campaigns always start PAUSED

`create_campaign` creates campaigns as PAUSED by default. **Do not enable a campaign unless the user explicitly says to activate it.** After building the full structure (campaign → ad groups → keywords → ads), summarise and ask:

> "Everything is set up and paused. Should I activate the campaign now?"

## 3. Changes that affect spend require explicit confirmation

Before any of these, state the change and wait for a yes:

- Increasing a budget
- Enabling a paused campaign
- Removing a negative keyword that was blocking spend

Example: *"This will increase the daily budget from $30 to $80. Confirm?"*

Decreasing a budget, pausing, or adding negatives does **not** need confirmation — those reduce spend.

## 4. Recommended campaign build order

1. `list_accounts` — get the `customer_id` (required for all write tools)
2. `keyword_ideas` — research seed keywords (if not already provided)
3. `create_campaign` — creates budget automatically, starts PAUSED. Always pass `conversion_goal` (see `references/campaign-params.md`)
4. `create_ad_group` — one or more ad groups
5. `create_keyword` — add keywords to each ad group
6. `create_negative_keyword` — obvious negatives (defaults in `references/extensions-and-audiences.md`)
7. `create_responsive_search_ad` — at least one RSA per ad group
8. `create_callout_assets` — short phrases below the ad
9. `create_sitelink_assets` — additional links with own URLs
10. `create_structured_snippet` — header + value list
11. `create_call_asset` — phone number extension
12. `add_audience_target` — audiences in observation mode (see references)
13. Confirm with user before enabling

**`customer_id` is required for all write tools.** Always pass it explicitly — do not rely on defaults.

## 5. Reporting

Use `search` for all performance data. GAQL templates (campaigns, keywords, search terms, ads, criteria) → `references/gaql-queries.md`.

## 6. Campaign parameters, geo IDs, languages, bidding strategies

Full `create_campaign` parameter reference, country/city/language IDs, conversion goal values, bidding strategy table, and known API limitations → `references/campaign-params.md`.

## 7. Extensions, audiences, negatives, RSAs

Extension tools, audience targeting flow, criterion removal, negative-keyword defaults, RSA guidelines → `references/extensions-and-audiences.md`.

## 8. Report what you did

After completing any task, give a clear summary. For write operations:

> "Done — created campaign '[name]' (PAUSED), 2 ad groups, 12 keywords, 2 RSAs. Budget: $50/day. Ready to activate when you are."

For reports, format numbers clearly: clicks, impressions, spend (in currency), CTR (%), CPC (currency).
