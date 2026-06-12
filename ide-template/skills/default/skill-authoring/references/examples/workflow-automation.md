# Example: workflow-automation skill

A skill that orchestrates a multi-step process. Reads context, calls tools in sequence, writes outputs, validates each step. The model executes the skill from start to finish on the user's command.

Example: a weekly report generator, a content audit, a deployment runbook.

## Template

```markdown
---
name: weekly-ads-report
description: Pull last 7 days of Meta + Google Ads, compare to prior week, flag campaigns with ROAS drop >20%, save a 1-page report to documents/reports/. Use when user says "weekly ads report", "ads recap", "campaign review", or fires automatically every Monday via the [WEEKLY_ADS_TRIGGER] reminder.
allowed-tools: Read, Write, Edit, Bash(jq:*), mcp__meta-ads__*, mcp__google-ads__*
---

# Weekly ads report

## When to use

- User says "weekly ads report" / "ads recap" / "campaign review for last week"
- Monday morning trigger phrase `[WEEKLY_ADS_TRIGGER]` arrives (system-injected via reminder)

## Steps

### Step 1: Pull this week's data
Call `mcp__meta-ads__get_campaigns(date_range="last_7_days")` and `mcp__google-ads__get_campaigns(date_range="last_7_days")`.
Expected: arrays of campaigns with spend, conversions, ROAS.

### Step 2: Pull prior week for comparison
Same calls with `date_range="prior_7_days"`.

### Step 3: Calculate deltas
For each campaign present in both weeks:
- ROAS change: `(this_week_roas - prior_week_roas) / prior_week_roas`
- Spend change: same formula on spend
- Flag campaigns where ROAS drop > 20% as "needs review"

Detailed calculation rules: [references/metrics.md](references/metrics.md)

### Step 4: Draft report
Use the template at [references/report-template.md](references/report-template.md). Sections:
- TL;DR (3 bullets max)
- Top 5 performers (by ROAS)
- Flagged campaigns (>20% drop)
- 2-3 recommended budget moves

### Step 5: Save + notify
Write to `documents/reports/YYYY-MM-DD_weekly-ads-report.md`. Notify user on Telegram with the file path + TL;DR section pasted inline.

## Examples

### User: "weekly ads report"
1. Fetch this week + prior week (Steps 1-2)
2. Calculate deltas (Step 3) → 2 campaigns flagged
3. Draft report (Step 4)
4. Save to `documents/reports/2026-05-25_weekly-ads-report.md`
5. Telegram: "Report saved → documents/reports/2026-05-25_weekly-ads-report.md. TL;DR: ROAS down 18% week-over-week, 2 campaigns flagged (Spring Sale, Brand Awareness), recommended cuts in flagged section."

### [WEEKLY_ADS_TRIGGER] (auto-fired Monday)
Same flow. User gets the report unprompted.

## Troubleshooting

### Meta API rate-limited (429)
Wait 60s, retry once. If still 429, post the partial report with a note "Meta data partial — rate-limited, retry tomorrow".

### Google Ads token expired
Notify user: "Google Ads token expired — please re-auth via Integrations panel. Skipping Google Ads section for this report."

### No prior-week data (first run)
Skip the deltas section. Report only this week's absolute numbers. Note "first run — week-over-week comparison starts next week".
```

## Why this works

- `description:` has WHAT (pull → compare → flag → save) + WHEN (manual + scheduled) + concrete triggers
- `allowed-tools:` scopes to exactly what's needed (Read/Write/Edit for the report file, jq for parsing, specific MCPs only)
- Each step has a verifiable output ("Expected: arrays...")
- Calculation rules and templates extracted to `references/` — body stays focused on flow
- Examples include both manual and auto-triggered scenarios
- Troubleshooting covers 3 known failure modes with concrete recovery actions
