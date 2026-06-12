# Shopify store — operation playbooks

## Collections

Collections group products for navigation and merchandising.

- `get_collections` — list all collections (smart and manual), with product counts.
- `create_collection` — create a new collection with title, description, and (optionally) initial products.
- `update_collection` — change title, description, image, or SEO fields.

**Flow for creating a collection:**

1. `get_collections` — check no duplicate exists.
2. `create_collection` with title and description.
3. Optionally add products: `get_products` to find GIDs, then `update_collection` with `product_ids`.
4. Confirm back: *"Collection '[name]' created with [N] products."*

**Smart vs manual collections:**

- Smart collections auto-populate based on rules (product type, tag, price). **Not yet supported via this MCP** — tell the user to set rules in the Shopify admin.
- Manual collections are fully controllable via API.

## Discounts

`create_discount` — creates a discount code for customers to apply at checkout.

**Required inputs:**

- `code` — the code customers type (e.g. `SPRING20`). Codes are case-insensitive in Shopify.
- `discount_type` — `percentage` or `fixed`.
- `value` — numeric value (e.g. `20` for 20% or `50` for €50 off).
- Optional: `minimum_order`, `usage_limit`, `starts_at`, `ends_at`.

**Before creating:**

1. Confirm code, type, and value with the user if not all specified.
2. Check there are no conflicting active promotions if the user mentions stacking.
3. Create the discount.
4. Report back: *"Discount code SPRING20 created — 20% off, no minimum, unlimited uses, active until [date or 'no expiry']."*

**Percentage example:** 20% off = `discount_type: "percentage"`, `value: 20`
**Fixed example:** €50 off = `discount_type: "fixed"`, `value: 50`

## Bulk publishing / unpublishing

Use `get_products` with a filter (tag, product_type, or status) to find the target set, then loop through calling `publish_product` or `unpublish_product` on each.

**Always confirm the scope first:**

> "Found 12 products tagged 'summer-2025'. Publish all of them?"

After bulk operations, report how many succeeded and if any failed.

## Metafields (store-level)

`get_metafield_definitions` — returns all metafield definitions across the store, organized by namespace and key.

When a user asks "what custom fields do we have on products?":

1. `get_metafield_definitions` — filter by `ownerType: PRODUCT`.
2. List namespace, key, type, and description for each.

For setting metafield values on specific resources, use the `shopify-products` skill instead (it has `update_metafields`).

## Store analytics

- `get_sales_summary` — revenue and order counts for a date range. Good for quick "how did we do last week?" checks.
- `get_low_inventory` — products below a stock threshold. Good for restock planning.

**Sales summary format:**

```
Period: [date range]
Orders: [N]
Revenue: [amount + currency]
Average order value: [amount]
```

**Low inventory format:**

```
Products below [threshold] units:
• [product name] — [variant] — [N] left
```

If the user asks for "a store report", combine both: sales summary + low inventory list.
