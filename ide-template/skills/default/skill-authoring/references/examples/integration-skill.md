# Example: integration skill

A skill that wraps a specific external integration (Shopify, Meta, Trello, etc.). Lives under `skills/optional/` in ide-template — installed conditionally by the entrypoint based on which integrations are activated in the workspace.

Key differences from project/system skills:
- Has `requires:` field (this workspace's convention) declaring needed env vars
- May have `compatibility:` field (Anthropic spec) describing environment expectations
- `allowed-tools:` scopes tightly to one MCP server
- Body assumes the matching MCP is connected (don't re-explain what the MCP is)

## Template

```markdown
---
name: shopify-restock-alert
description: Check Shopify inventory levels and alert via Telegram when any tracked SKU drops below its restock threshold. Use when user says "check stock", "low stock", "restock alert", "what's running out", or fires automatically every morning via the [DAILY_STOCK_CHECK] reminder.
allowed-tools: mcp__shopify__list_products, mcp__shopify__get_inventory, mcp__telegram__send_message
requires: SHOPIFY_STORE_DOMAIN
compatibility: Requires shopify-mcp connected and a tracked-skus.json file in project/config/ defining {sku: threshold} pairs.
metadata:
  mcp-server: shopify
  version: 1.0.0
---

# Shopify restock alert

## When to use

- User asks about stock levels, restock needs, or what's running low
- `[DAILY_STOCK_CHECK]` trigger fires (every morning via reminder)

## Pre-flight

1. Verify `project/config/tracked-skus.json` exists. If not, ask user to create it with `{ "<sku>": <restock_threshold> }` pairs and stop.
2. Verify `mcp__shopify__*` tools are available in this session. If not, tell user to run `/restart` to pick up the integration.

## Steps

### Step 1: Load tracked SKUs
Read `project/config/tracked-skus.json` → `{ sku: threshold }` map.

### Step 2: Pull current inventory
`mcp__shopify__list_products()` → for each product, `mcp__shopify__get_inventory(product_id)` → flat list of `{sku, qty}`.

### Step 3: Compare to thresholds
For each tracked SKU, compute `qty - threshold`. If negative, flag as "low stock".

### Step 4: Alert
If any SKUs are low, send Telegram message:
```
Low stock alert — 3 SKUs need restock:
- SKU-001: 5 left (threshold 20)
- SKU-042: 0 left (threshold 10) — OUT OF STOCK
- SKU-099: 12 left (threshold 25)
```
If no SKUs are low, skip the message (don't spam the user with "all good" pings).

## Examples

### User: "check stock"
Run Steps 1-4. If alerts fire, send. If not, reply on Telegram: "All tracked SKUs above threshold. Next check tomorrow morning."

### [DAILY_STOCK_CHECK] (auto-fired)
Same flow, but stay silent if nothing is low. Operator only gets pinged when something actually needs action.

## Troubleshooting

### Shopify returns 401
Token expired. Tell user to re-auth in Integrations panel, skip this run.

### tracked-skus.json missing
Offer to bootstrap an empty file. Ask which SKUs the user wants to track.

### No SKUs tracked yet
Empty `tracked-skus.json` — reply with "No SKUs tracked yet. Add some by editing project/config/tracked-skus.json." Don't infer them from Shopify (too noisy).
```

## Why this works

- `requires:` declares the env dependency — workspace-api's installer uses this to decide whether to deploy the skill on a given workspace
- `compatibility:` adds context the installer can't infer (the config file requirement)
- `allowed-tools:` lists three specific tool names, not wildcards — minimum needed
- Pre-flight section catches setup gaps cleanly before the main flow tries and fails
- Negative path explicit: skip alert message if nothing is low (avoid notification fatigue)
- Troubleshooting addresses the specific failure modes of this integration
