---
name: meta-ads-audiences
description: Use this when the user wants to create or manage Meta custom audiences, lookalike audiences, or research interests for ad targeting.
allowed-tools: Glob, Read, mcp__meta__get_audiences, mcp__meta__create_custom_audience, mcp__meta__create_lookalike_audience, mcp__meta__search_interests
requires: meta
---

# Meta Ads Audiences Protocol

## Step 0 — Read project context first

Search for project-specific Meta files (audience IDs, pixel IDs, customer-list location, naming conventions). Adjust the globs to your project's actual layout:

```
Glob: marketing/meta/**
Glob: marketing/meta-ads/**
Glob: docs/meta/**
```

Read any files found. If none, proceed.

## Core rules

**Check before creating.** Always call `get_audiences` first. An audience may already exist. Duplicates waste budget.

**Confirm email upload.** Before uploading a customer list, confirm with the user:

> "I'll SHA-256 hash [N] emails before sending. Plaintext emails never leave the server. Proceed?"

## Tool reference

Full request shape, params, requirements, and population timing for each tool (`get_audiences`, `create_custom_audience` for customer-list AND website types, `create_lookalike_audience`, `search_interests` including `flexible_spec` AND/OR semantics) → `references/tools.md`.

## After creating — report IDs clearly

Always report the audience ID(s) created so the user can reference them:

> "Audiences created:
> • 'Purchasers Q1 2025' — ID: 123456 | customer list, 1,247 emails
> • 'LLA 1% PL' — ID: 234567 | lookalike, populating (~1–6h)
> • 'AddToCart 14d' — ID: 345678 | pixel-based, populating
>
> Use these IDs in create_ad_set as custom_audience_ids or excluded_audience_ids."
