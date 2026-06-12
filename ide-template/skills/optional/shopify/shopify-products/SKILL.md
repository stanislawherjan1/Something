---
name: shopify-products
description: Use this when the user wants to create, update, delete, publish, or manage any product in Shopify — including descriptions, prices, tags, variants, options, inventory, metafields, and media. Also handles product visibility (publish/unpublish).
allowed-tools: mcp__shopify__get_product, mcp__shopify__get_products, mcp__shopify__create_product, mcp__shopify__update_product, mcp__shopify__delete_product, mcp__shopify__update_product_description, mcp__shopify__update_product_price, mcp__shopify__add_product_tag, mcp__shopify__remove_product_tag, mcp__shopify__add_product_variants, mcp__shopify__delete_product_variant, mcp__shopify__create_product_option, mcp__shopify__update_product_option, mcp__shopify__update_inventory, mcp__shopify__publish_product, mcp__shopify__unpublish_product, mcp__shopify__get_metafield_definitions, mcp__shopify__update_metafields, mcp__shopify__upload_media, mcp__shopify__get_low_inventory
requires: shopify
---

# Shopify Products Protocol

## Core rules — always apply

**Search before writing.** Before any create, update, or delete, call `get_product` or `get_products` to confirm the product exists and get its exact GIDs. Never guess IDs.

**Change only what was asked.** Make exactly the change requested — nothing more. If you notice something else that looks wrong, mention it after completing the task:

> "I also noticed [X]. Should I fix that too?"

**Ask when ambiguous.** If the request is unclear (e.g. "update the description" without new content), ask first:

> "What should the new [description / price / ...] be?"

**Verify every change.** After every mutation, call `get_product` again and check each changed field explicitly. Do not trust that a mutation succeeded because it returned no errors. If any change is missing, retry immediately.

**Confirm before destructive actions.** Deleting a product or variant is irreversible. Always confirm:

> "This will permanently delete [product name]. Proceed?"

## Operations

Step-by-step playbooks for create / update / variants / metafields / media / publish / inventory → `references/operations.md`. Read the relevant section before acting.

## After every change — report clearly

> "Done — [what changed] on [product name]. Verified via API."

If any change could not be verified after retry, say which field failed and why.
