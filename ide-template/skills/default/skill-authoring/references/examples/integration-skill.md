# Example: integration skill

A skill that wraps a specific external integration (Shopify, Meta, Trello, etc.). Lives under `skills/optional/` in ide-template — installed conditionally by the entrypoint based on which integrations are activated in the workspace.

Key differences from project/system skills:
- Has `requires:` field (this workspace's convention) naming the integration — its catalog id or the MCP server's name
- May have `compatibility:` field (Anthropic spec) describing environment expectations
- `allowed-tools:` scopes tightly to one MCP server
- Body assumes the matching MCP is connected (don't re-explain what the MCP is)

## Template

```markdown
---
name: shopify-restock-alert
description: Check Shopify inventory levels and flag any tracked SKU below its restock threshold. Use when user says "check stock", "low stock", "restock alert", "what's running out", or when a daily stock-check routine asks for it.
allowed-tools: Read, mcp__shopify__get_low_inventory, mcp__shopify__get_products
requires: shopify
compatibility: Requires shopify-mcp connected and a tracked-skus.json file in project/config/ defining {sku: threshold} pairs.
metadata:
  mcp-server: shopify
  version: 1.0.0
---

# Shopify restock alert

## When to use

- User asks about stock levels, restock needs, or what's running low
- A daily stock-check routine runs it (recurring work is a routine — the person adds it on the Routines screen or asks you; never a custom trigger reminder)

## Pre-flight

1. Verify `project/config/tracked-skus.json` exists. If not, ask user to create it with `{ "<sku>": <restock_threshold> }` pairs and stop.
2. Verify `mcp__shopify__*` tools are available in this session. If not, say Shopify isn't connected — an admin connects it under Integrations.

## Steps

### Step 1: Load tracked SKUs
Read `project/config/tracked-skus.json` → `{ sku: threshold }` map.

### Step 2: Pull current inventory
`mcp__shopify__get_low_inventory(threshold=<highest tracked threshold>)` → variants at or below it, with `{sku, qty}`. Use `mcp__shopify__get_products(query=…)` only when you need a product's details.

### Step 3: Compare to thresholds
For each tracked SKU, compute `qty - threshold`. If negative, flag as "low stock".

### Step 4: Alert
If any SKUs are low, reply:
```
Low stock alert — 3 SKUs need restock:
- SKU-001: 5 left (threshold 20)
- SKU-042: 0 left (threshold 10) — OUT OF STOCK
- SKU-099: 12 left (threshold 25)
```
If no SKUs are low, skip the message (don't spam the user with "all good" pings).

## Examples

### User: "check stock"
Run Steps 1-4. If alerts fire, send. If not, reply: "All tracked SKUs are above threshold."

### The daily routine runs it
Same flow, but stay silent if nothing is low (`[[SILENT]]`). The person only gets pinged when something actually needs action.

## Troubleshooting

### Shopify returns 401
Token expired. Tell user to re-auth in Integrations panel, skip this run.

### tracked-skus.json missing
Offer to bootstrap an empty file. Ask which SKUs the user wants to track.

### No SKUs tracked yet
Empty `tracked-skus.json` — reply with "No SKUs tracked yet. Add some by editing project/config/tracked-skus.json." Don't infer them from Shopify (too noisy).
```

## Why this works

- `requires:` names the integration — the installer deploys the skill only on workspaces where it is connected
- `compatibility:` adds context the installer can't infer (the config file requirement)
- `allowed-tools:` lists specific tool names, not wildcards — minimum needed
- Pre-flight section catches setup gaps cleanly before the main flow tries and fails
- Negative path explicit: skip alert message if nothing is low (avoid notification fatigue)
- Troubleshooting addresses the specific failure modes of this integration
