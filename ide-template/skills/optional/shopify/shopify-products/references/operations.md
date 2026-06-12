# Shopify products — operation playbooks

## Creating a product

Full creation flow, in order:

1. **`create_product`** — title, body_html, vendor, product_type, tags. Optionally pass `publish: true` to go live immediately.
2. **`update_product_option`** — add Size/Color/etc. options (creates variants automatically).
3. **`update_product_price`** — set price on each variant. If all variants share the same price, you can pass `price` during create.
4. **`update_inventory`** — set stock quantities per variant per location. Get variant IDs first via `get_product`.
5. **`upload_media`** — attach images via public URL. Pass the URL as `source` — no staging needed.
6. **`update_metafields`** — set any custom fields. Use `jsonValue` for complex types (arrays, objects).
7. If not published at create time, call **`publish_product`** when ready.

Confirm with the user before creating if key info is missing (price, variants, stock).

## Updating a product

1. Call `get_product` to confirm the product exists and collect all IDs.
2. Apply exactly the requested changes.
3. Re-call `get_product` and verify each changed field.

## Changing variants / options

**Key constraint: Shopify never allows deleting the last variant.** Always add new variants before removing old ones.

**To restructure options** (e.g. rename "Custom Size" → "Size", add sizes):

1. `get_product` → note option ID and existing variant IDs.
2. `update_product_option` with full new list of values. Each new value: `{ name: "80A" }`. To keep/rename an existing value: `{ id: "gid://...", name: "80A" }`.
3. `get_product` again → collect new variant IDs.
4. `update_inventory` for each new variant.
5. `delete_product_variant` on the old variant(s).

**If `update_product_option` fails** (e.g. option is metafield-linked): use `create_product_option` with `variant_strategy: CREATE`, then delete the old option.

## Metafields

Metafields store structured custom data (fabric, care instructions, certifications, etc.).

1. `get_metafield_definitions` — lists all definitions for the store (namespace, key, type).
2. `update_metafields` — pass `owner_id` (product GID), `namespace`, `key`, `type`, `value`.
   - Use `jsonValue` for list/object types.
   - Use `value` (string) for single-value types (string, number, boolean).

**Always check definitions first** — don't invent namespaces. If a definition doesn't exist, ask the user before creating a new one.

## Media

`upload_media` attaches images or videos from a public URL. Shopify fetches the file directly — no local upload needed.

- Pass `product_id` (GID) and `source` (full public URL, e.g. `https://cdn.example.com/image.jpg`).
- Alt text is optional but recommended for SEO.
- After upload, call `get_product` and confirm the media appears in `media.edges`.

## Publishing / Unpublishing

- `publish_product` — makes the product visible on all sales channels.
- `unpublish_product` — hides the product without deleting it.

Both require the product GID. Always confirm the current status via `get_product` before acting.

## Inventory

`update_inventory` sets stock per variant per location.

- Requires: `variant_id` (GID), `location_id` (GID), `quantity`.
- Get variant IDs from `get_product`.
- `get_low_inventory` — lists products below a threshold; useful for restock checks.
