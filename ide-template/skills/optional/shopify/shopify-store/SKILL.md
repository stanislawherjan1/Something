---
name: shopify-store
description: Use this when the user wants to manage store-level settings — collections, discounts, bulk publishing, metafield definitions, or anything that affects the whole store rather than a single product or order.
allowed-tools: mcp__shopify__get_collections, mcp__shopify__create_collection, mcp__shopify__update_collection, mcp__shopify__create_discount, mcp__shopify__get_products, mcp__shopify__publish_product, mcp__shopify__unpublish_product, mcp__shopify__get_metafield_definitions, mcp__shopify__update_metafields, mcp__shopify__get_sales_summary, mcp__shopify__get_low_inventory
requires: shopify
---

# Shopify Store Protocol

## Core rules — always apply

**Read before writing.** Before creating a collection or discount, check if one already exists with a similar name or code. Duplicate collections confuse customers; duplicate discount codes return API errors.

**Confirm before bulk operations.** Publishing or unpublishing multiple products at once, or creating store-wide discount codes, affects what customers see immediately. Confirm scope before proceeding:

> "This will publish [N] products. Proceed?"

**Ask when ambiguous.** Discount rules especially require precision — percentage vs. fixed, minimum order, usage limits, expiry. If any are missing, ask before creating.

## Operations

Step-by-step playbooks for each area:

- **Collections** — create / update flow, smart vs manual collections
- **Discounts** — `create_discount` params, code naming, conflict checks
- **Bulk publishing / unpublishing** — scope-first confirmation pattern
- **Metafields (store-level)** — `get_metafield_definitions` usage
- **Store analytics** — `get_sales_summary` + `get_low_inventory` formats

Full details → `references/operations.md`.

## What belongs in other skills

| Task | Use instead |
|---|---|
| Edit a specific product | shopify-products |
| Look up / fulfill an order | shopify-orders |
| Customer profiles | shopify-orders |
| Create a product | shopify-products |
