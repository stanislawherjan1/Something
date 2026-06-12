---
name: meta-ads-campaigns
description: Use this when the user wants to create, update, pause, resume, or manage Meta Ads campaigns, ad sets, or ads — including budget changes, targeting, and full campaign build flows.
allowed-tools: Glob, Read, mcp__meta__get_campaigns, mcp__meta__get_ad_sets, mcp__meta__get_ads, mcp__meta__create_campaign, mcp__meta__update_campaign_budget, mcp__meta__pause_campaign, mcp__meta__resume_campaign, mcp__meta__create_ad_set, mcp__meta__update_ad_set, mcp__meta__search_interests, mcp__meta__get_audiences, mcp__meta__create_ad, mcp__meta__update_ad, mcp__meta__list_media_library
requires: meta
---

# Meta Ads Campaigns Protocol

## Step 0 — Read project context first

Search for project-specific Meta files (account IDs, naming conventions, campaign structure, audience definitions, ROAS targets, brand guidelines). Adjust the globs to your project's actual layout — common locations are `marketing/meta/`, `docs/meta/`, `.claude/meta-context/`.

```
Glob: marketing/meta/**
Glob: marketing/meta-ads/**
Glob: docs/meta/**
```

If found, read all files there. They may contain:
- Account IDs and structure
- Naming conventions for campaigns/ad sets
- Existing audience IDs
- Budget rules and ROAS targets
- Pixel IDs and conversion events

If the folder doesn't exist, proceed without — but note it to the user.

---

## Core rules

**Read before writing.** Always call `get_campaigns` or `get_ad_sets` before creating anything. Verify no duplicate exists.

**Everything starts PAUSED.** `create_campaign`, `create_ad_set`, `create_ad` — all start with `status: PAUSED`. Activate only on explicit user instruction.

**Confirm before activating or increasing budget.** Any action that causes spend requires a confirmation:
> "This will activate [X] with daily budget €Y. Confirm?"

**Confirm before pausing active campaigns.** Pausing resets the learning phase. Flag it:
> "Pausing this ad set will reset its learning phase. Proceed?"

---

## Campaign creation — exact tool call order

1. **`create_campaign`**
   - Required: `name`, `objective` (ODAX — see below), `daily_budget` or `lifetime_budget`
   - `special_ad_categories: []` for standard ads
   - Starts PAUSED

2. **`search_interests`** _(if interest targeting needed)_
   - Returns `id` + `name` + `audience_size` per interest
   - Pass results directly into `create_ad_set` as `interests: [{id, name}, ...]`

3. **`get_audiences`** _(if custom/lookalike audiences exist)_
   - Returns audience IDs to pass into `create_ad_set` as `custom_audience_ids`

4. **`create_ad_set`**
   - Required: `campaign_id`, `name`, `daily_budget` or `lifetime_budget`
   - Targeting fields:
     - `countries`: ISO array e.g. `["PL", "DE"]`
     - `age_min`, `age_max`
     - `genders`: `"all"` / `"male"` / `"female"`
     - `interests`: `[{id: "...", name: "..."}]` — from `search_interests`
     - `behaviors`: `[{id: "...", name: "..."}]`
     - `custom_audience_ids`: array of audience IDs
     - `excluded_audience_ids`: array of audience IDs to exclude
   - Starts PAUSED

5. **`list_media_library`** _(before uploading any asset)_
   - Check if image/video already exists — use existing hash/ID if found

6. **`create_ad`**
   - Required: `name`, `ad_set_id`, `creative_id`
   - `creative_id` comes from a creative tool (handled separately)
   - Starts PAUSED by default

7. **`resume_campaign`** — only on explicit user confirmation

---

## ODAX objectives (v22.0)

| Value | Use case |
|---|---|
| `OUTCOME_SALES` | Ecommerce conversions |
| `OUTCOME_TRAFFIC` | Website visits |
| `OUTCOME_LEADS` | Lead forms |
| `OUTCOME_AWARENESS` | Reach / impressions |
| `OUTCOME_ENGAGEMENT` | Post engagement |
| `OUTCOME_APP_PROMOTION` | App installs |

---

## Updating campaigns / ad sets

`update_campaign_budget` — pass `campaign_id` + `daily_budget` or `lifetime_budget` (in account currency, not cents — the tool converts automatically).

`update_ad_set` — `ad_set_id` + any of: `status`, `daily_budget`, `end_time`.

`update_ad` — `ad_id` + `status` (ACTIVE / PAUSED / ARCHIVED).

`pause_campaign` / `resume_campaign` — pass `campaign_id`.

---

## API limitations

| Limitation | Notes |
|---|---|
| No campaign deletion | Set `status: ARCHIVED` — deletion is UI-only |
| Budgets in account currency | Tool accepts e.g. `50.00` and converts to cents internally |
| Ad creative is immutable | Cannot edit a live creative — create new creative + new ad, pause old ad |
| `special_ad_categories` required | Must pass `[]` even for standard ads — omitting causes API error |
| Targeting edit resets learning | Any targeting change on an active ad set resets its learning phase |
