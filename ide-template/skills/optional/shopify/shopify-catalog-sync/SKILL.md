---
name: shopify-catalog-sync
description: Load a current snapshot of all products in the Shopify store. Use this when the user asks what products are in the store, needs a catalog overview, references a product by name without a GID, or when product data might be stale.
allowed-tools: mcp__shopify__get_products, mcp__shopify__get_product, mcp__memory__create_entities, mcp__memory__add_observations, mcp__memory__search_nodes, mcp__memory__open_nodes, Write, Read
requires: shopify
---

# Shopify Catalog Sync

Saves a snapshot of all store products to `~/project/shop/products.md` for fast reference without repeated API calls.

## When to run

- User asks "what products do we have", "show me the catalog", "jakie mamy produkty" etc.
- User references a product by name and you don't have its GID
- Snapshot is missing or older than 7 days (check `last_synced` on the `shopify-catalog` memory entity)
- User explicitly asks to refresh/sync the product catalog

## How to run

### Step 1 — Check if snapshot is fresh

Run `search_nodes("shopify-catalog")`. If the entity exists and `last_synced` is within the last 7 days, read `~/project/shop/products.md` directly instead of calling the API.

### Step 2 — Fetch all products

Call `get_products` with `limit: 50, status: active`. For stores with fewer than 20 products, one call is enough. If the result looks truncated, repeat with the next page cursor.

For each product, call `get_product` with its ID to get full variant and inventory details.

### Step 3 — Write snapshot

Create or overwrite `~/project/shop/products.md` with this format:

```
# Product Catalog
Last synced: YYYY-MM-DD HH:MM

---

## [Product Title]
- **Status:** active / draft
- **ID:** gid://shopify/Product/...
- **Price:** [lowest variant price] – [highest] (or single price if all equal)
- **Variants:** [list variant names — e.g. S / M / L / XL or Red / Blue]
- **Inventory:** [total units in stock across all variants]
- **SKU:** [SKU of first variant, or list if they differ]
- **Tags:** [comma-separated tags]
- **Description:** [first 200 chars of body, plain text]

---
```

Repeat a block per product. Sort: active products first, then drafts.

### Step 4 — Update memory

Create or update the `shopify-catalog` entity:
- entityType: `catalog_index`
- observations: `last_synced: YYYY-MM-DD`, `snapshot_path: ~/project/shop/products.md`, `product_count: N`

### Step 5 — Confirm

Tell the user: "Catalog synced — N products saved to shop/products.md."

---

## Reading the snapshot

When you need a product's GID for a mutation (price update, inventory change etc.), read the snapshot first instead of calling `get_products` — it's faster. The GID is in the `ID:` field of each product block.
