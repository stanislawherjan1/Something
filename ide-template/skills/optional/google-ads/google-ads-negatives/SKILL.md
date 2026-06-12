---
name: google-ads-negatives
description: Use this for the weekly negative keyword workflow — pulling search terms, identifying irrelevant or wasteful queries, and adding negative keywords to campaigns or ad groups. Invoke when the user says "check search terms", "add negatives", "clean up keywords", or "what are people searching for?".
allowed-tools: mcp__google-ads__search, mcp__google-ads__list_accounts, mcp__google-ads__create_negative_keyword
requires: google-ads
---

# Negative Keyword Workflow

A weekly maintenance pass. Pull what people actually searched for, surface irrelevant queries, propose negatives, get confirmation, add them.

## Step 1: Pull search terms report

Run the GAQL query in `references/triage.md` (search-terms section). Adjust date range if user specifies.

## Step 2: Cluster and categorise

Group search terms into the 6 categories in `references/triage.md` (categorisation table). Present as a table per category with default action.

## Step 3: Present for review — never add without confirmation

Format the proposal clearly:

```
Found 47 search terms. Here's what I recommend:

NEGATIVES TO ADD (18 terms):
• Competitors: "rival co corset", "otherbrand" (2)
• Irrelevant: "free corset pattern", "DIY corset", "shapewear" (3)
• Wrong intent: "how to make corset", "corset history" (13)

WORTH ADDING AS KEYWORDS (3 terms):
• "french silk corset" — 12 clicks, 2 conversions → suggest [EXACT]
• "made to measure corset" — 8 clicks, 1 conversion → suggest [EXACT]
• "luxury corset uk" — 6 clicks, 1 conversion → suggest [EXACT]

BORDERLINE (need your call):
• "corset training" — unclear intent. Add as negative?
• "waist cincher" — related product. Negative or keep?

Shall I add all the negatives, or do you want to review the list first?
```

**Never add negatives without explicit confirmation.**

## Step 4: Add at the right level

Campaign vs ad-group level + match-type defaults (EXACT) → `references/triage.md`.

## Step 5: Confirm what was done

After adding:

> "Added 18 negative keywords to campaign [name]:
> • 8 at campaign level (EXACT)
> • 10 at ad group level (EXACT)
>
> Also found 3 converting search terms worth adding as keywords — want me to do that now?"
