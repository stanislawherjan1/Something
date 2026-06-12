/**
 * Shopify Admin API MCP Server
 *
 * Auth: OAuth 2 Client Credentials Grant (Dev Dashboard apps, 2026+)
 * Env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 *
 * Token is fetched on startup and refreshed automatically before expiry.
 *
 * ─────────────────────────────────────────────
 * READ tools:
 *   get_orders              — recent orders list
 *   get_order               — single order details
 *   get_products            — products with inventory
 *   get_product             — single product details
 *   get_low_inventory       — variants below threshold
 *   get_sales_summary       — revenue for today/week/month
 *   get_customers           — recent customers
 *   get_customer            — single customer by email or ID
 *   get_fulfillments        — shipment/fulfillment status for an order
 *   get_draft_orders        — list draft orders / quotes
 *
 * WRITE tools:
 *   create_product          — create a new product (auto-publish optional)
 *   update_product          — update title, status, vendor, SEO
 *   delete_product          — permanently delete a product
 *   publish_product         — publish to Online Store
 *   unpublish_product       — hide from Online Store
 *   update_product_description
 *   update_product_price
 *   add_product_tag / remove_product_tag
 *   add_product_variants    — add size/color variants
 *   delete_product_variant  — remove a variant
 *   update_inventory        — set stock quantity for a variant
 *   update_metafields       — set metafields (Fabric Care, Sizing, etc.)
 *   get_metafield_definitions — discover namespace/key for metafields
 *   upload_media            — attach image to product from URL
 *   create_collection       — create a product collection
 *   update_collection       — add/remove products, rename
 *   get_collections         — list collections
 *   create_customer         — create a new customer
 *   update_customer         — update customer details
 *   create_fulfillment      — mark order as shipped with tracking
 *   create_discount         — create a discount code
 *   cancel_order            — cancel an order
 *   add_order_note          — add a note to an order
 *   create_draft_order      — create a quote/draft order for a customer
 * ─────────────────────────────────────────────
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const DOMAIN        = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const APP_NAME      = process.env.SHOPIFY_APP_NAME ?? 'shopify-mcp';
const API_VERSION   = '2025-01';

if (!DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('[shopify-mcp] Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET');
  process.exit(1);
}

// ─── Token management ──────────────────────────────────────────────────────

let cachedToken   = null;
let tokenExpiry   = 0;
const TOKEN_BUFFER = 60 * 1000; // refresh 1 minute before expiry

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - TOKEN_BUFFER) {
    return cachedToken;
  }

  const res = await fetch(`https://${DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'client_credentials',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get Shopify token: ${res.status} ${body}`);
  }

  const { access_token, expires_in } = await res.json();
  cachedToken  = access_token;
  tokenExpiry  = Date.now() + (expires_in ?? 86400) * 1000;
  console.error(`[shopify-mcp] Token refreshed, expires in ${expires_in}s`);
  return cachedToken;
}

// ─── GraphQL helper ────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch(`https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '));
  if (!data) throw new Error('Shopify returned no data');
  return data;
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [

  // ── READ ────────────────────────────────────────────────────────────────

  {
    name: 'get_orders',
    description: 'List recent orders. Optionally filter by status (open, closed, cancelled) and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'cancelled', 'any'], description: 'Order status filter (default: any)' },
        limit:  { type: 'number', description: 'Number of orders to return (default: 20, max: 50)' },
      },
    },
  },

  {
    name: 'get_order',
    description: 'Get full details of a single order by ID or order number (e.g. #1234).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Order GID (gid://shopify/Order/123) or order number (#1234)' },
      },
      required: ['id'],
    },
  },

  {
    name: 'get_products',
    description: 'List products with variants and inventory levels.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Number of products to return (default: 20)' },
        status: { type: 'string', enum: ['active', 'draft', 'archived'], description: 'Product status filter' },
        query:  { type: 'string', description: 'Search query (e.g. "title:dress")' },
      },
    },
  },

  {
    name: 'get_product',
    description: 'Get full details of a single product including all variants, prices, and inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Product GID (gid://shopify/Product/123) or title search' },
      },
      required: ['id'],
    },
  },

  {
    name: 'get_low_inventory',
    description: 'Find product variants with inventory at or below a threshold. Useful for restocking alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Inventory threshold (default: 5)' },
      },
    },
  },

  {
    name: 'get_sales_summary',
    description: 'Get revenue summary for today, this week, or this month.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time period (default: today)' },
      },
    },
  },

  {
    name: 'get_customers',
    description: 'List recent customers with order count and total spend.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of customers to return (default: 20)' },
        query: { type: 'string', description: 'Search query (e.g. email, name)' },
      },
    },
  },

  {
    name: 'get_customer',
    description: 'Get a single customer by email address or Shopify customer ID.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Customer email address' },
        id:    { type: 'string', description: 'Customer GID (gid://shopify/Customer/123)' },
      },
    },
  },

  // ── WRITE ────────────────────────────────────────────────────────────────

  {
    name: 'update_product_description',
    description: 'Update the description of a product. Plain text or HTML accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        id:          { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        description: { type: 'string', description: 'New description (plain text or HTML)' },
      },
      required: ['id', 'description'],
    },
  },

  {
    name: 'update_product_price',
    description: 'Update the price of a specific product variant.',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: { type: 'string', description: 'Variant GID (gid://shopify/ProductVariant/123)' },
        price:      { type: 'string', description: 'New price as a string (e.g. "49.99")' },
      },
      required: ['variant_id', 'price'],
    },
  },

  {
    name: 'add_product_tag',
    description: 'Add a tag to a product.',
    inputSchema: {
      type: 'object',
      properties: {
        id:  { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        tag: { type: 'string', description: 'Tag to add' },
      },
      required: ['id', 'tag'],
    },
  },

  {
    name: 'remove_product_tag',
    description: 'Remove a tag from a product.',
    inputSchema: {
      type: 'object',
      properties: {
        id:  { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        tag: { type: 'string', description: 'Tag to remove' },
      },
      required: ['id', 'tag'],
    },
  },

  {
    name: 'add_product_variants',
    description: 'Add new variants to a product (e.g. sizes, colors). Each variant can have its own price and inventory quantity. Use this to replace a generic "Custom Size" variant with specific sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        variants: {
          type: 'array',
          description: 'List of variants to create',
          items: {
            type: 'object',
            properties: {
              option_name:  { type: 'string', description: 'Option name, e.g. "Size" or "Color"' },
              option_value: { type: 'string', description: 'Option value, e.g. "S", "M", "L"' },
              price:        { type: 'string', description: 'Price as string (e.g. "299.00"). Defaults to existing product price if omitted.' },
              inventory:    { type: 'number', description: 'Stock quantity for this variant' },
              sku:          { type: 'string', description: 'SKU code (optional)' },
            },
            required: ['option_value'],
          },
        },
      },
      required: ['product_id', 'variants'],
    },
  },

  {
    name: 'delete_product_variant',
    description: 'Delete a product variant by its GID. Use this to remove outdated variants such as a generic "Custom Size" after specific sizes have been added.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        variant_id: { type: 'string', description: 'Variant GID to delete (gid://shopify/ProductVariant/123)' },
      },
      required: ['product_id', 'variant_id'],
    },
  },

  {
    name: 'create_product_option',
    description: 'Add a new product option (e.g. Size, Color) with values. Automatically creates variants for each value. Use variantStrategy CREATE to generate variants, or LEAVE_AS_IS to only create the option.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id:      { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        option_name:     { type: 'string', description: 'Option name, e.g. "Size" or "Color"' },
        option_values:   { type: 'array', items: { type: 'string' }, description: 'List of values, e.g. ["80A", "85A", "90A"]' },
        variant_strategy: { type: 'string', enum: ['CREATE', 'LEAVE_AS_IS'], description: 'CREATE = auto-create a variant per value (default). LEAVE_AS_IS = create option only.' },
      },
      required: ['product_id', 'option_name', 'option_values'],
    },
  },

  {
    name: 'update_product_option',
    description: 'Update an existing product option — rename it or add/remove values. Use this to replace a generic "Custom Size" option with specific sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id:    { type: 'string', description: 'Product GID (gid://shopify/Product/123)' },
        option_id:     { type: 'string', description: 'Option GID (gid://shopify/ProductOption/123). Use get_product to find option IDs.' },
        new_name:      { type: 'string', description: 'New name for the option (optional)' },
        option_values: {
          type: 'array',
          description: 'Full new list of values for this option. Existing values not in this list will be removed.',
          items: {
            type: 'object',
            properties: {
              id:   { type: 'string', description: 'Existing value GID to keep/rename (omit for new values)' },
              name: { type: 'string', description: 'Value name, e.g. "80A"' },
            },
            required: ['name'],
          },
        },
      },
      required: ['product_id', 'option_id'],
    },
  },

  {
    name: 'update_inventory',
    description: 'Set the inventory quantity for a product variant at the default location.',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: { type: 'string', description: 'Variant GID (gid://shopify/ProductVariant/123)' },
        quantity:   { type: 'number', description: 'New stock quantity' },
      },
      required: ['variant_id', 'quantity'],
    },
  },

  {
    name: 'get_fulfillments',
    description: 'Get fulfillment and shipment details for an order, including tracking numbers and status.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order GID (gid://shopify/Order/123) or order number (#1234)' },
      },
      required: ['order_id'],
    },
  },

  {
    name: 'cancel_order',
    description: 'Cancel an order. Optionally specify a reason and whether to restock inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order GID (gid://shopify/Order/123)' },
        reason:   { type: 'string', enum: ['CUSTOMER', 'FRAUD', 'INVENTORY', 'DECLINED', 'OTHER'], description: 'Cancellation reason (default: OTHER)' },
        restock:  { type: 'boolean', description: 'Whether to restock inventory (default: true)' },
      },
      required: ['order_id'],
    },
  },

  {
    name: 'add_order_note',
    description: 'Add or replace the note on an order.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order GID (gid://shopify/Order/123)' },
        note:     { type: 'string', description: 'Note text to set on the order' },
      },
      required: ['order_id', 'note'],
    },
  },

  {
    name: 'get_draft_orders',
    description: 'List draft orders (quotes). Draft orders are unsent or pending orders created manually.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Number of draft orders to return (default: 20)' },
        status: { type: 'string', enum: ['open', 'invoice_sent', 'completed'], description: 'Filter by status' },
      },
    },
  },

  // ── WEEK 1 — HIGH ───────────────────────────────────────────────────────

  {
    name: 'create_product',
    description: 'Create a new product in Shopify. Automatically publishes to the Online Store after creation unless publish=false.',
    inputSchema: {
      type: 'object',
      properties: {
        title:           { type: 'string', description: 'Product title.' },
        description:     { type: 'string', description: 'Product description (plain text or HTML).' },
        vendor:          { type: 'string', description: 'Brand / vendor name.' },
        product_type:    { type: 'string', description: 'Product type (e.g. "Corset", "Lingerie").' },
        tags:            { type: 'array', items: { type: 'string' }, description: 'Product tags.' },
        status:          { type: 'string', enum: ['ACTIVE', 'DRAFT', 'ARCHIVED'], description: 'Initial status (default: DRAFT — publish separately when ready).' },
        price:           { type: 'string', description: 'Base price for the default variant (e.g. "850.00").' },
        sku:             { type: 'string', description: 'SKU for the default variant.' },
        publish:         { type: 'boolean', description: 'Whether to publish to Online Store immediately (default: false — stay as draft).' },
      },
      required: ['title'],
    },
  },

  {
    name: 'update_product',
    description: 'Update basic product fields: title, status, vendor, product type, SEO title/description.',
    inputSchema: {
      type: 'object',
      properties: {
        id:           { type: 'string', description: 'Product GID (gid://shopify/Product/123).' },
        title:        { type: 'string', description: 'New title.' },
        status:       { type: 'string', enum: ['ACTIVE', 'DRAFT', 'ARCHIVED'], description: 'New status.' },
        vendor:       { type: 'string', description: 'New vendor/brand.' },
        product_type: { type: 'string', description: 'New product type.' },
        seo_title:    { type: 'string', description: 'SEO page title.' },
        seo_description: { type: 'string', description: 'SEO meta description.' },
      },
      required: ['id'],
    },
  },

  {
    name: 'delete_product',
    description: 'Permanently delete a product and all its variants. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Product GID (gid://shopify/Product/123).' },
      },
      required: ['id'],
    },
  },

  {
    name: 'publish_product',
    description: 'Publish a product to the Online Store (make it visible to customers). Use after create_product with status=DRAFT.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Product GID (gid://shopify/Product/123).' },
      },
      required: ['id'],
    },
  },

  {
    name: 'unpublish_product',
    description: 'Remove a product from the Online Store (hide from customers without deleting it).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Product GID (gid://shopify/Product/123).' },
      },
      required: ['id'],
    },
  },

  {
    name: 'get_metafield_definitions',
    description: 'List available metafield definitions for a resource type. Use this before update_metafields to find the correct namespace and key.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_type: {
          type: 'string',
          enum: ['PRODUCT', 'PRODUCTVARIANT', 'CUSTOMER', 'COLLECTION', 'ORDER'],
          description: 'Resource type to get metafield definitions for (default: PRODUCT).',
        },
      },
    },
  },

  {
    name: 'update_metafields',
    description: 'Set metafields on a product, variant, customer, or collection. Use get_metafield_definitions first to find namespace/key/type.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string', description: 'GID of the resource to attach metafields to (product, variant, customer, etc.).' },
        metafields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              namespace: { type: 'string', description: 'Metafield namespace (e.g. "custom").' },
              key:       { type: 'string', description: 'Metafield key (e.g. "fabric_care").' },
              type:      { type: 'string', description: 'Value type: single_line_text_field, multi_line_text_field, rich_text_field, number_integer, number_decimal, boolean, url, json, etc.' },
              value:     { type: 'string', description: 'Value to set. For rich_text_field use Shopify\'s rich text JSON format.' },
            },
            required: ['namespace', 'key', 'type', 'value'],
          },
          description: 'List of metafields to set (up to 25 at once).',
        },
      },
      required: ['owner_id', 'metafields'],
    },
  },

  {
    name: 'upload_media',
    description: 'Upload an image to a product by providing a public image URL. Shopify fetches the image from the URL and attaches it to the product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product GID (gid://shopify/Product/123).' },
        image_url:  { type: 'string', description: 'Public URL of the image to upload (must be publicly accessible).' },
        alt_text:   { type: 'string', description: 'Alt text for accessibility and SEO (optional).' },
      },
      required: ['product_id', 'image_url'],
    },
  },

  // ── WEEK 2-3 — MEDIUM ────────────────────────────────────────────────────

  {
    name: 'get_collections',
    description: 'List collections in the store.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of collections to return (default: 20).' },
        query: { type: 'string', description: 'Search query (e.g. title:silk).' },
      },
    },
  },

  {
    name: 'create_collection',
    description: 'Create a new manual collection and optionally add products to it.',
    inputSchema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Collection title.' },
        description: { type: 'string', description: 'Collection description (HTML or plain text).' },
        product_ids: { type: 'array', items: { type: 'string' }, description: 'Product GIDs to add to the collection.' },
        image_url:   { type: 'string', description: 'URL of the collection hero image (optional).' },
      },
      required: ['title'],
    },
  },

  {
    name: 'update_collection',
    description: 'Update a collection — rename it, change description, add or remove products.',
    inputSchema: {
      type: 'object',
      properties: {
        id:                  { type: 'string', description: 'Collection GID (gid://shopify/Collection/123).' },
        title:               { type: 'string', description: 'New title.' },
        description:         { type: 'string', description: 'New description.' },
        add_product_ids:     { type: 'array', items: { type: 'string' }, description: 'Product GIDs to add.' },
        remove_product_ids:  { type: 'array', items: { type: 'string' }, description: 'Product GIDs to remove.' },
      },
      required: ['id'],
    },
  },

  {
    name: 'create_customer',
    description: 'Create a new customer account in Shopify.',
    inputSchema: {
      type: 'object',
      properties: {
        email:      { type: 'string', description: 'Customer email address.' },
        first_name: { type: 'string', description: 'First name.' },
        last_name:  { type: 'string', description: 'Last name.' },
        phone:      { type: 'string', description: 'Phone number (E.164 format, e.g. "+12125551234").' },
        note:       { type: 'string', description: 'Internal note about the customer.' },
        tags:       { type: 'array', items: { type: 'string' }, description: 'Customer tags.' },
        verified_email: { type: 'boolean', description: 'Mark email as verified (default: true).' },
      },
      required: ['email'],
    },
  },

  {
    name: 'update_customer',
    description: 'Update an existing customer — name, email, phone, tags, note.',
    inputSchema: {
      type: 'object',
      properties: {
        id:         { type: 'string', description: 'Customer GID (gid://shopify/Customer/123).' },
        email:      { type: 'string', description: 'New email.' },
        first_name: { type: 'string', description: 'New first name.' },
        last_name:  { type: 'string', description: 'New last name.' },
        phone:      { type: 'string', description: 'New phone.' },
        note:       { type: 'string', description: 'New note (replaces existing).' },
        tags:       { type: 'array', items: { type: 'string' }, description: 'New tags (replaces all existing tags).' },
      },
      required: ['id'],
    },
  },

  {
    name: 'create_fulfillment',
    description: 'Mark an order as shipped. Provide tracking info and optionally notify the customer.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id:        { type: 'string', description: 'Order GID (gid://shopify/Order/123) or order number (#1234).' },
        tracking_number: { type: 'string', description: 'Shipment tracking number.' },
        tracking_company:{ type: 'string', description: 'Carrier name (e.g. "DHL", "FedEx", "UPS", "DPD").' },
        tracking_url:    { type: 'string', description: 'Tracking URL (optional — auto-generated by Shopify for known carriers).' },
        notify_customer: { type: 'boolean', description: 'Send shipping confirmation email to customer (default: true).' },
      },
      required: ['order_id'],
    },
  },

  {
    name: 'create_discount',
    description: 'Create a discount code (percentage or fixed amount off the entire order).',
    inputSchema: {
      type: 'object',
      properties: {
        title:           { type: 'string', description: 'Internal name for the discount.' },
        code:            { type: 'string', description: 'Discount code customers enter at checkout (e.g. "SUMMER20").' },
        type:            { type: 'string', enum: ['PERCENTAGE', 'FIXED_AMOUNT'], description: 'Discount type.' },
        value:           { type: 'number', description: 'Discount value. For PERCENTAGE: 0–100 (e.g. 20 = 20% off). For FIXED_AMOUNT: amount in store currency.' },
        minimum_amount:  { type: 'number', description: 'Minimum order amount required to use the discount (optional).' },
        usage_limit:     { type: 'number', description: 'Maximum number of times the code can be used (optional — unlimited if omitted).' },
        starts_at:       { type: 'string', description: 'Start date ISO 8601 (default: now).' },
        ends_at:         { type: 'string', description: 'Expiry date ISO 8601 (optional).' },
      },
      required: ['title', 'code', 'type', 'value'],
    },
  },

  {
    name: 'create_draft_order',
    description: 'Create a draft order (quote) for a customer with specific products and quantities.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer GID (optional — leave blank for a guest order)' },
        email:       { type: 'string', description: 'Customer email (used if customer_id not provided)' },
        note:        { type: 'string', description: 'Note for the draft order' },
        line_items:  {
          type: 'array',
          description: 'Products to include',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string', description: 'Variant GID (gid://shopify/ProductVariant/123)' },
              quantity:   { type: 'number', description: 'Quantity' },
              price:      { type: 'string', description: 'Custom price override (optional)' },
            },
            required: ['variant_id', 'quantity'],
          },
        },
      },
      required: ['line_items'],
    },
  },

];

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    case 'get_orders': {
      const limit = Math.min(args.limit ?? 20, 50);
      const queryStr = args.status && args.status !== 'any' ? `status:${args.status}` : null;
      const { orders } = await gql(`
        query GetOrders($first: Int!, $query: String) {
          orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges { node {
              id name createdAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { displayName email }
              lineItems(first: 5) { edges { node { title quantity } } }
            }}
          }
        }`, { first: limit, query: queryStr });
      return orders.edges.map(({ node: o }) => ({
        id:          o.id,
        order:       o.name,
        date:        o.createdAt,
        status:      o.displayFinancialStatus,
        fulfillment: o.displayFulfillmentStatus,
        total:       `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`,
        customer:    o.customer ? `${o.customer.displayName} (${o.customer.email})` : 'Guest',
        items:       o.lineItems.edges.map(({ node: i }) => `${i.title} x${i.quantity}`),
      }));
    }

    case 'get_order': {
      const isGid = args.id.startsWith('gid://');
      let order;
      if (isGid) {
        const { order: o } = await gql(`
          query GetOrder($id: ID!) {
            order(id: $id) {
              id name createdAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              subtotalPriceSet { shopMoney { amount currencyCode } }
              totalShippingPriceSet { shopMoney { amount currencyCode } }
              customer { displayName email phone }
              shippingAddress { address1 city country zip }
              lineItems(first: 20) { edges { node {
                title quantity originalUnitPriceSet { shopMoney { amount currencyCode } }
              }}}
              note tags
            }
          }`, { id: args.id });
        order = o;
      } else {
        const name = args.id.startsWith('#') ? args.id : `#${args.id}`;
        const { orders } = await gql(`
          query GetOrderByName($query: String!) {
            orders(first: 1, query: $query) {
              edges { node {
                id name createdAt displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { displayName email }
                lineItems(first: 20) { edges { node { title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } }}}
              }}
            }
          }`, { query: `name:${name}` });
        order = orders.edges[0]?.node;
      }
      if (!order) return { error: 'Order not found' };
      return order;
    }

    case 'get_products': {
      const limit = args.limit ?? 20;
      const filters = [
        args.status ? `status:${args.status}` : '',
        args.query  ? args.query              : '',
      ].filter(Boolean).join(' ');
      const { products } = await gql(`
        query GetProducts($first: Int!, $query: String) {
          products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
            edges { node {
              id title status tags
              variants(first: 10) { edges { node {
                id title price inventoryQuantity sku
              }}}
            }}
          }
        }`, { first: limit, query: filters || null });
      return products.edges.map(({ node: p }) => ({
        id:       p.id,
        title:    p.title,
        status:   p.status,
        tags:     p.tags,
        variants: p.variants.edges.map(({ node: v }) => ({
          id: v.id, variant: v.title, price: v.price, sku: v.sku, inventory: v.inventoryQuantity,
        })),
      }));
    }

    case 'get_product': {
      const isGid = args.id.startsWith('gid://');
      let product;
      if (isGid) {
        const { product: p } = await gql(`
          query GetProduct($id: ID!) {
            product(id: $id) {
              id title status descriptionHtml tags
              options { id name optionValues { id name } }
              variants(first: 50) { edges { node { id title price compareAtPrice sku inventoryQuantity }}}
            }
          }`, { id: args.id });
        product = p;
      } else {
        const { products } = await gql(`
          query GetProductByTitle($query: String!) {
            products(first: 1, query: $query) {
              edges { node {
                id title status descriptionHtml tags
                options { id name optionValues { id name } }
                variants(first: 50) { edges { node { id title price compareAtPrice sku inventoryQuantity }}}
              }}
            }
          }`, { query: `title:${args.id}` });
        product = products.edges[0]?.node;
      }
      if (!product) return { error: 'Product not found' };
      return product;
    }

    case 'get_low_inventory': {
      const threshold = args.threshold ?? 5;
      const { products } = await gql(`{
        products(first: 100, query: "status:active") {
          edges { node {
            id title
            variants(first: 20) { edges { node { id title sku inventoryQuantity price }}}
          }}
        }
      }`);
      const low = [];
      for (const { node: p } of products.edges) {
        for (const { node: v } of p.variants.edges) {
          if (v.inventoryQuantity !== null && v.inventoryQuantity <= threshold) {
            low.push({ product: p.title, productId: p.id, variant: v.title, variantId: v.id, sku: v.sku, inventory: v.inventoryQuantity, price: v.price });
          }
        }
      }
      return low.sort((a, b) => a.inventory - b.inventory);
    }

    case 'get_sales_summary': {
      const period = args.period ?? 'today';
      const now = new Date();
      let since;
      if (period === 'today') {
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      } else if (period === 'week') {
        const d = new Date(now); d.setDate(d.getDate() - 7); since = d.toISOString();
      } else {
        const d = new Date(now); d.setMonth(d.getMonth() - 1); since = d.toISOString();
      }
      const { orders } = await gql(`{
        orders(first: 250, query: "created_at:>=${since} financial_status:paid") {
          edges { node { totalPriceSet { shopMoney { amount currencyCode } } }}
        }
      }`);
      const items = orders.edges.map(({ node: o }) => parseFloat(o.totalPriceSet.shopMoney.amount));
      const currency = orders.edges[0]?.node.totalPriceSet.shopMoney.currencyCode ?? 'USD';
      const total = items.reduce((s, v) => s + v, 0);
      const count = items.length;
      return {
        period, since, order_count: count,
        total_revenue: `${total.toFixed(2)} ${currency}`,
        average_order_value: count > 0 ? `${(total / count).toFixed(2)} ${currency}` : '0',
      };
    }

    case 'get_customers': {
      const limit = args.limit ?? 20;
      const { customers } = await gql(`
        query GetCustomers($first: Int!, $query: String) {
          customers(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges { node {
              id displayName email phone
              ordersCount amountSpent { amount currencyCode }
              createdAt
            }}
          }
        }`, { first: limit, query: args.query ?? null });
      return customers.edges.map(({ node: c }) => ({
        id: c.id, name: c.displayName, email: c.email, phone: c.phone,
        orders: c.ordersCount, total_spent: `${c.amountSpent.amount} ${c.amountSpent.currencyCode}`,
        customer_since: c.createdAt,
      }));
    }

    case 'get_customer': {
      if (!args.id && !args.email) throw new Error('Either id or email is required');
      let customer;
      if (args.id) {
        const { customer: c } = await gql(`
          query GetCustomer($id: ID!) {
            customer(id: $id) {
              id displayName email phone ordersCount amountSpent { amount currencyCode }
              orders(first: 5, sortKey: CREATED_AT, reverse: true) {
                edges { node { name totalPriceSet { shopMoney { amount currencyCode } } createdAt displayFinancialStatus }}
              }
            }
          }`, { id: args.id });
        customer = c;
      } else if (args.email) {
        const { customers } = await gql(`
          query GetCustomerByEmail($query: String!) {
            customers(first: 1, query: $query) {
              edges { node {
                id displayName email phone ordersCount amountSpent { amount currencyCode }
                orders(first: 5, sortKey: CREATED_AT, reverse: true) {
                  edges { node { name totalPriceSet { shopMoney { amount currencyCode } } createdAt displayFinancialStatus }}
                }
              }}
            }
          }`, { query: `email:${args.email}` });
        customer = customers.edges[0]?.node;
      }
      if (!customer) return { error: 'Customer not found' };
      return customer;
    }

    // ── WRITE ────────────────────────────────────────────────────────────

    case 'update_product_description': {
      const { productUpdate } = await gql(`
        mutation($id: ID!, $body: String!) {
          productUpdate(input: { id: $id, descriptionHtml: $body }) {
            product { id title descriptionHtml }
            userErrors { field message }
          }
        }`, { id: args.id, body: args.description });
      if (productUpdate.userErrors.length) throw new Error(productUpdate.userErrors.map(e => e.message).join('; '));
      return { updated: true, id: productUpdate.product.id, title: productUpdate.product.title };
    }

    case 'update_product_price': {
      // productVariantUpdate was removed in API 2024-10; use productVariantsBulkUpdate instead.
      // Bulk update requires productId, so we resolve it from the variant first.
      const { productVariant: pv } = await gql(`
        query GetVariantProduct($id: ID!) {
          productVariant(id: $id) { product { id } }
        }`, { id: args.variant_id });
      if (!pv) throw new Error('Variant not found');

      const { productVariantsBulkUpdate } = await gql(`
        mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id title price }
            userErrors { field message }
          }
        }`, { productId: pv.product.id, variants: [{ id: args.variant_id, price: args.price }] });
      if (productVariantsBulkUpdate.userErrors.length) throw new Error(productVariantsBulkUpdate.userErrors.map(e => e.message).join('; '));
      const v = productVariantsBulkUpdate.productVariants[0];
      return { updated: true, id: v.id, title: v.title, price: v.price };
    }

    case 'add_product_tag': {
      // Fetch existing tags first to avoid overwriting
      const { product: existing } = await gql(`query GetProductTags($id: ID!) { product(id: $id) { tags } }`, { id: args.id });
      if (!existing) throw new Error('Product not found');
      const tags = [...new Set([...existing.tags, args.tag])];
      const { productUpdate } = await gql(`
        mutation($id: ID!, $tags: [String!]!) {
          productUpdate(input: { id: $id, tags: $tags }) {
            product { id title tags }
            userErrors { field message }
          }
        }`, { id: args.id, tags });
      if (productUpdate.userErrors.length) throw new Error(productUpdate.userErrors.map(e => e.message).join('; '));
      return { updated: true, id: productUpdate.product.id, tags: productUpdate.product.tags };
    }

    case 'remove_product_tag': {
      const { product: existing } = await gql(`query GetProductTags($id: ID!) { product(id: $id) { tags } }`, { id: args.id });
      if (!existing) throw new Error('Product not found');
      const tags = existing.tags.filter(t => t !== args.tag);
      const { productUpdate } = await gql(`
        mutation($id: ID!, $tags: [String!]!) {
          productUpdate(input: { id: $id, tags: $tags }) {
            product { id title tags }
            userErrors { field message }
          }
        }`, { id: args.id, tags });
      if (productUpdate.userErrors.length) throw new Error(productUpdate.userErrors.map(e => e.message).join('; '));
      return { updated: true, id: productUpdate.product.id, tags: productUpdate.product.tags };
    }

    case 'add_product_variants': {
      // Fetch product to get existing option names and default price
      const { product } = await gql(`
        query GetProductOptions($id: ID!) {
          product(id: $id) {
            options { name values }
            variants(first: 1) { edges { node { price } } }
          }
        }`, { id: args.product_id });
      if (!product) throw new Error('Product not found');

      const defaultPrice = product.variants.edges[0]?.node.price ?? '0.00';
      const optionName = args.variants[0]?.option_name ?? product.options[0]?.name ?? 'Size';

      // Build variants input
      const variantsInput = args.variants.map(v => {
        const input = {
          optionValues: [{ optionName, name: v.option_value }],
          price: v.price ?? defaultPrice,
        };
        if (v.sku) input.inventoryItem = { sku: v.sku };
        return input;
      });

      const { productVariantsBulkCreate } = await gql(`
        mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id title price inventoryQuantity }
            userErrors { field message }
          }
        }`, { productId: args.product_id, variants: variantsInput });

      if (productVariantsBulkCreate.userErrors.length) {
        throw new Error(productVariantsBulkCreate.userErrors.map(e => e.message).join('; '));
      }

      const created = productVariantsBulkCreate.productVariants;

      // Set inventory quantities if provided.
      // Match by option_value name (not array index) to handle reordering from Shopify.
      const inventoryUpdates = args.variants
        .filter(v => v.inventory != null)
        .map(v => {
          const match = created.find(c => c.title.toLowerCase().includes(v.option_value.toLowerCase()));
          return match ? { variantId: match.id, qty: v.inventory } : null;
        })
        .filter(Boolean);

      if (inventoryUpdates.length > 0) {
        // Get inventory item IDs for the created variants
        const ids = created.map(v => v.id);
        const { nodes } = await gql(`
          query GetVariantInventoryItems($ids: [ID!]!) {
            nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } }
          }`, { ids });
        const itemMap = Object.fromEntries(nodes.map(n => [n.id, n.inventoryItem?.id]));

        // Get a location ID
        const { locations } = await gql(`{ locations(first: 1) { edges { node { id } } } }`);
        const locationId = locations.edges[0]?.node.id;

        if (locationId) {
          for (const u of inventoryUpdates) {
            const inventoryItemId = itemMap[u.variantId];
            if (!inventoryItemId) continue;
            const refUri = `app://${APP_NAME}/inventory-update`;
            await gql(`
              mutation($inventoryItemId: ID!, $locationId: ID!, $quantity: Int!, $refUri: String!) {
                inventorySetQuantities(input: {
                  name: "available",
                  reason: "correction",
                  referenceDocumentUri: $refUri,
                  ignoreCompareQuantity: true,
                  quantities: [{ inventoryItemId: $inventoryItemId, locationId: $locationId, quantity: $quantity }]
                }) { userErrors { message } }
              }`, { inventoryItemId, locationId, quantity: u.qty, refUri });
          }
        }
      }

      return {
        created: created.length,
        variants: created.map(v => ({ id: v.id, title: v.title, price: v.price })),
      };
    }

    case 'delete_product_variant': {
      const { productVariantsBulkDelete } = await gql(`
        mutation($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            product { id title }
            userErrors { field message }
          }
        }`, { productId: args.product_id, variantsIds: [args.variant_id] });
      if (productVariantsBulkDelete.userErrors.length) {
        throw new Error(productVariantsBulkDelete.userErrors.map(e => e.message).join('; '));
      }
      return { deleted: true, variant_id: args.variant_id };
    }

    case 'create_product_option': {
      const optionValues = args.option_values.map(v => ({ name: v }));
      const strategy = args.variant_strategy ?? 'CREATE';
      const { productOptionsCreate } = await gql(`
        mutation($productId: ID!, $options: [OptionCreateInput!]!, $strategy: ProductOptionUpdateStrategy!) {
          productOptionsCreate(productId: $productId, options: $options, variantStrategy: $strategy) {
            product { options { id name optionValues { id name } } }
            userErrors { field message code }
          }
        }`, {
        productId: args.product_id,
        options: [{ name: args.option_name, optionValues }],
        strategy,
      });
      if (productOptionsCreate.userErrors.length) {
        throw new Error(productOptionsCreate.userErrors.map(e => `${e.code}: ${e.message}`).join('; '));
      }
      const opt = productOptionsCreate.product.options.find(o => o.name === args.option_name);
      return { created: true, option: opt };
    }

    case 'update_product_option': {
      const optionInput = { id: args.option_id };
      if (args.option_values) {
        optionInput.optionValues = args.option_values.map(v => v.id ? { id: v.id, name: v.name } : { name: v.name });
      }
      if (args.new_name) optionInput.name = args.new_name;
      const { productOptionUpdate } = await gql(`
        mutation($productId: ID!, $option: OptionUpdateInput!) {
          productOptionUpdate(productId: $productId, option: $option, variantStrategy: MANAGE) {
            product { options { id name optionValues { id name } } }
            userErrors { field message code }
          }
        }`, {
        productId: args.product_id,
        option: optionInput,
      });
      if (productOptionUpdate.userErrors.length) {
        throw new Error(productOptionUpdate.userErrors.map(e => `${e.code}: ${e.message}`).join('; '));
      }
      return { updated: true, options: productOptionUpdate.product.options };
    }

    case 'update_inventory': {
      // Resolve inventory item ID from variant
      const { productVariant } = await gql(`
        query GetVariantInventoryItem($id: ID!) {
          productVariant(id: $id) { inventoryItem { id } }
        }`, { id: args.variant_id });
      if (!productVariant) throw new Error('Variant not found');
      const inventoryItemId = productVariant.inventoryItem.id;

      // Get default location
      const { locations } = await gql(`{ locations(first: 1) { edges { node { id name } } } }`);
      const location = locations.edges[0]?.node;
      if (!location) throw new Error('No location found');

      const refUri = `app://${APP_NAME}/inventory-update`;
      const { inventorySetQuantities } = await gql(`
        mutation($inventoryItemId: ID!, $locationId: ID!, $quantity: Int!, $refUri: String!) {
          inventorySetQuantities(input: {
            name: "available",
            reason: "correction",
            referenceDocumentUri: $refUri,
            ignoreCompareQuantity: true,
            quantities: [{ inventoryItemId: $inventoryItemId, locationId: $locationId, quantity: $quantity }]
          }) {
            inventoryAdjustmentGroup { reason }
            userErrors { field message }
          }
        }`, { inventoryItemId, locationId: location.id, quantity: args.quantity, refUri });

      if (inventorySetQuantities.userErrors.length) {
        throw new Error(inventorySetQuantities.userErrors.map(e => e.message).join('; '));
      }
      return { updated: true, variant_id: args.variant_id, quantity: args.quantity, location: location.name };
    }

    case 'get_fulfillments': {
      // Resolve order GID from number if needed
      let orderId = args.order_id;
      if (!orderId.startsWith('gid://')) {
        const name = orderId.startsWith('#') ? orderId : `#${orderId}`;
        const { orders } = await gql(`
          query GetOrderIdByName($q: String!) {
            orders(first: 1, query: $q) { edges { node { id } } }
          }`, { q: `name:${name}` });
        orderId = orders.edges[0]?.node.id;
        if (!orderId) return { error: 'Order not found' };
      }
      const { order } = await gql(`
        query GetFulfillments($id: ID!) {
          order(id: $id) {
            name
            fulfillments {
              status createdAt updatedAt
              trackingInfo { number url company }
              fulfillmentLineItems(first: 20) { edges { node { quantity lineItem { title } } } }
            }
          }
        }`, { id: orderId });
      if (!order) return { error: 'Order not found' };
      return { order: order.name, fulfillments: order.fulfillments };
    }

    case 'cancel_order': {
      const { orderCancel } = await gql(`
        mutation($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!) {
          orderCancel(orderId: $orderId, reason: $reason, restock: $restock) {
            orderCancelUserErrors { message }
            job { id }
          }
        }`, {
        orderId: args.order_id,
        reason: args.reason ?? 'OTHER',
        restock: args.restock ?? true,
      });
      if (orderCancel.orderCancelUserErrors.length) {
        throw new Error(orderCancel.orderCancelUserErrors.map(e => e.message).join('; '));
      }
      return { cancelled: true, order_id: args.order_id, reason: args.reason ?? 'OTHER' };
    }

    case 'add_order_note': {
      const { orderUpdate } = await gql(`
        mutation($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id name note }
            userErrors { field message }
          }
        }`, { input: { id: args.order_id, note: args.note } });
      if (orderUpdate.userErrors.length) {
        throw new Error(orderUpdate.userErrors.map(e => e.message).join('; '));
      }
      return { updated: true, order: orderUpdate.order.name, note: orderUpdate.order.note };
    }

    case 'get_draft_orders': {
      const limit = args.limit ?? 20;
      const q = args.status ? `status:${args.status}` : null;
      const { draftOrders } = await gql(`
        query GetDraftOrders($first: Int!, $query: String) {
          draftOrders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges { node {
              id name status createdAt
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { displayName email }
              lineItems(first: 5) { edges { node { title quantity } } }
            }}
          }
        }`, { first: limit, query: q });
      return draftOrders.edges.map(({ node: d }) => ({
        id: d.id, name: d.name, status: d.status, created: d.createdAt,
        total: `${d.totalPriceSet.shopMoney.amount} ${d.totalPriceSet.shopMoney.currencyCode}`,
        customer: d.customer ? `${d.customer.displayName} (${d.customer.email})` : 'Guest',
        items: d.lineItems.edges.map(({ node: i }) => `${i.title} x${i.quantity}`),
      }));
    }

    case 'create_draft_order': {
      const lineItems = args.line_items.map(i => {
        const item = { variantId: i.variant_id, quantity: i.quantity };
        if (i.price) item.originalUnitPrice = i.price;
        return item;
      });

      const input = { lineItems };
      if (args.customer_id) input.customerId = args.customer_id;
      if (args.email) input.email = args.email;
      if (args.note) input.note = args.note;

      const { draftOrderCreate } = await gql(`
        mutation($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id name status invoiceUrl
              totalPriceSet { shopMoney { amount currencyCode } }
            }
            userErrors { field message }
          }
        }`, { input });

      if (draftOrderCreate.userErrors.length) {
        throw new Error(draftOrderCreate.userErrors.map(e => e.message).join('; '));
      }
      const d = draftOrderCreate.draftOrder;
      return {
        created: true, id: d.id, name: d.name, status: d.status,
        total: `${d.totalPriceSet.shopMoney.amount} ${d.totalPriceSet.shopMoney.currencyCode}`,
        invoice_url: d.invoiceUrl,
      };
    }

    // ── WEEK 1 — HIGH ─────────────────────────────────────────────────────

    case 'create_product': {
      const input = { title: args.title };
      if (args.description)  input.descriptionHtml = args.description;
      if (args.vendor)       input.vendor          = args.vendor;
      if (args.product_type) input.productType     = args.product_type;
      if (args.tags)         input.tags            = args.tags;
      input.status = args.status ?? 'DRAFT';

      const variants = [];
      if (args.price || args.sku) {
        const v = {};
        if (args.price) v.price = args.price;
        if (args.sku)   v.inventoryItem = { sku: args.sku };
        variants.push(v);
      }
      if (variants.length) input.variants = variants;

      const { productCreate } = await gql(`
        mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product { id title status handle }
            userErrors { field message }
          }
        }`, { input });
      if (productCreate.userErrors.length) throw new Error(productCreate.userErrors.map(e => e.message).join('; '));
      const product = productCreate.product;

      // Auto-publish if requested
      if (args.publish) {
        const { publications } = await gql(`{ publications(first: 10) { edges { node { id name } } } }`);
        const onlineStore = publications.edges.find(({ node: p }) => p.name === 'Online Store')?.node
          ?? publications.edges[0]?.node;
        if (onlineStore) {
          await gql(`
            mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $input) { userErrors { field message } }
            }`, { id: product.id, input: [{ publicationId: onlineStore.id }] });
        }
      }

      return { created: true, id: product.id, title: product.title, status: product.status, handle: product.handle };
    }

    case 'update_product': {
      const input = { id: args.id };
      if (args.title)        input.title       = args.title;
      if (args.status)       input.status      = args.status;
      if (args.vendor)       input.vendor      = args.vendor;
      if (args.product_type) input.productType = args.product_type;
      if (args.seo_title || args.seo_description) {
        input.seo = {};
        if (args.seo_title)       input.seo.title       = args.seo_title;
        if (args.seo_description) input.seo.description = args.seo_description;
      }
      const { productUpdate } = await gql(`
        mutation($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id title status vendor }
            userErrors { field message }
          }
        }`, { input });
      if (productUpdate.userErrors.length) throw new Error(productUpdate.userErrors.map(e => e.message).join('; '));
      return { updated: true, ...productUpdate.product };
    }

    case 'delete_product': {
      const { productDelete } = await gql(`
        mutation($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors { field message }
          }
        }`, { input: { id: args.id } });
      if (productDelete.userErrors.length) throw new Error(productDelete.userErrors.map(e => e.message).join('; '));
      return { deleted: true, id: productDelete.deletedProductId };
    }

    case 'publish_product': {
      const { publications } = await gql(`{ publications(first: 10) { edges { node { id name } } } }`);
      const onlineStore = publications.edges.find(({ node: p }) => p.name === 'Online Store')?.node
        ?? publications.edges[0]?.node;
      if (!onlineStore) throw new Error('No publications found');
      const { publishablePublish } = await gql(`
        mutation($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            publishable { availablePublicationsCount { count } }
            userErrors { field message }
          }
        }`, { id: args.id, input: [{ publicationId: onlineStore.id }] });
      if (publishablePublish.userErrors.length) throw new Error(publishablePublish.userErrors.map(e => e.message).join('; '));
      return { published: true, product_id: args.id, channel: onlineStore.name };
    }

    case 'unpublish_product': {
      const { publications } = await gql(`{ publications(first: 10) { edges { node { id name } } } }`);
      const onlineStore = publications.edges.find(({ node: p }) => p.name === 'Online Store')?.node
        ?? publications.edges[0]?.node;
      if (!onlineStore) throw new Error('No publications found');
      const { publishableUnpublish } = await gql(`
        mutation($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) {
            publishable { availablePublicationsCount { count } }
            userErrors { field message }
          }
        }`, { id: args.id, input: [{ publicationId: onlineStore.id }] });
      if (publishableUnpublish.userErrors.length) throw new Error(publishableUnpublish.userErrors.map(e => e.message).join('; '));
      return { unpublished: true, product_id: args.id, channel: onlineStore.name };
    }

    case 'get_metafield_definitions': {
      const ownerType = args.owner_type ?? 'PRODUCT';
      const { metafieldDefinitions } = await gql(`
        query($ownerType: MetafieldOwnerType!) {
          metafieldDefinitions(ownerType: $ownerType, first: 50) {
            edges { node {
              id namespace key name
              type { name }
              description
            }}
          }
        }`, { ownerType });
      return metafieldDefinitions.edges.map(({ node: d }) => ({
        id: d.id, namespace: d.namespace, key: d.key, name: d.name,
        type: d.type.name, description: d.description,
      }));
    }

    case 'update_metafields': {
      const metafields = args.metafields.map(m => ({
        ownerId:   args.owner_id,
        namespace: m.namespace,
        key:       m.key,
        type:      m.type,
        value:     String(m.value),
      }));
      const { metafieldsSet } = await gql(`
        mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key value }
            userErrors { field message code }
          }
        }`, { metafields });
      if (metafieldsSet.userErrors.length) throw new Error(metafieldsSet.userErrors.map(e => `${e.code}: ${e.message}`).join('; '));
      return { updated: metafieldsSet.metafields.length, metafields: metafieldsSet.metafields };
    }

    case 'upload_media': {
      // Shopify productCreateMedia accepts a mediaContentType + originalSource (public URL)
      // No staged upload needed when source is a public URL
      const { productCreateMedia } = await gql(`
        mutation($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { id mediaContentType status }
            mediaUserErrors { field message code }
          }
        }`, {
        productId: args.product_id,
        media: [{ mediaContentType: 'IMAGE', originalSource: args.image_url, alt: args.alt_text ?? '' }],
      });
      if (productCreateMedia.mediaUserErrors.length) {
        throw new Error(productCreateMedia.mediaUserErrors.map(e => `${e.code}: ${e.message}`).join('; '));
      }
      return { uploaded: true, media: productCreateMedia.media };
    }

    // ── WEEK 2-3 — MEDIUM ─────────────────────────────────────────────────

    case 'get_collections': {
      const limit = args.limit ?? 20;
      const { collections } = await gql(`
        query($first: Int!, $query: String) {
          collections(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
            edges { node {
              id title handle updatedAt
              productsCount { count }
            }}
          }
        }`, { first: limit, query: args.query ?? null });
      return collections.edges.map(({ node: c }) => ({
        id: c.id, title: c.title, handle: c.handle,
        product_count: c.productsCount.count, updated: c.updatedAt,
      }));
    }

    case 'create_collection': {
      const input = { title: args.title };
      if (args.description) input.descriptionHtml = args.description;
      if (args.image_url)   input.image = { src: args.image_url };

      const { collectionCreate } = await gql(`
        mutation($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id title handle }
            userErrors { field message }
          }
        }`, { input });
      if (collectionCreate.userErrors.length) throw new Error(collectionCreate.userErrors.map(e => e.message).join('; '));
      const collection = collectionCreate.collection;

      // Add products if provided
      if (args.product_ids?.length) {
        await gql(`
          mutation($id: ID!, $productIds: [ID!]!) {
            collectionAddProducts(id: $id, productIds: $productIds) {
              userErrors { field message }
            }
          }`, { id: collection.id, productIds: args.product_ids });
      }

      return { created: true, id: collection.id, title: collection.title, handle: collection.handle, products_added: args.product_ids?.length ?? 0 };
    }

    case 'update_collection': {
      const results = {};

      // Update title/description
      if (args.title || args.description) {
        const input = { id: args.id };
        if (args.title)       input.title           = args.title;
        if (args.description) input.descriptionHtml = args.description;
        const { collectionUpdate } = await gql(`
          mutation($input: CollectionInput!) {
            collectionUpdate(input: $input) {
              collection { id title }
              userErrors { field message }
            }
          }`, { input });
        if (collectionUpdate.userErrors.length) throw new Error(collectionUpdate.userErrors.map(e => e.message).join('; '));
        results.updated = collectionUpdate.collection;
      }

      // Add products
      if (args.add_product_ids?.length) {
        const { collectionAddProducts } = await gql(`
          mutation($id: ID!, $productIds: [ID!]!) {
            collectionAddProducts(id: $id, productIds: $productIds) {
              collection { productsCount { count } }
              userErrors { field message }
            }
          }`, { id: args.id, productIds: args.add_product_ids });
        if (collectionAddProducts.userErrors.length) throw new Error(collectionAddProducts.userErrors.map(e => e.message).join('; '));
        results.added = args.add_product_ids.length;
      }

      // Remove products
      if (args.remove_product_ids?.length) {
        const { collectionRemoveProducts } = await gql(`
          mutation($id: ID!, $productIds: [ID!]!) {
            collectionRemoveProducts(id: $id, productIds: $productIds) {
              userErrors { field message }
            }
          }`, { id: args.id, productIds: args.remove_product_ids });
        if (collectionRemoveProducts.userErrors.length) throw new Error(collectionRemoveProducts.userErrors.map(e => e.message).join('; '));
        results.removed = args.remove_product_ids.length;
      }

      return { success: true, ...results };
    }

    case 'create_customer': {
      const input = { email: args.email };
      if (args.first_name) input.firstName      = args.first_name;
      if (args.last_name)  input.lastName       = args.last_name;
      if (args.phone)      input.phone          = args.phone;
      if (args.note)       input.note           = args.note;
      if (args.tags)       input.tags           = args.tags;
      input.emailMarketingConsent = { marketingState: 'NOT_SUBSCRIBED' };
      if (args.verified_email !== false) input.verifiedEmail = true;

      const { customerCreate } = await gql(`
        mutation($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id displayName email }
            userErrors { field message }
          }
        }`, { input });
      if (customerCreate.userErrors.length) throw new Error(customerCreate.userErrors.map(e => e.message).join('; '));
      return { created: true, ...customerCreate.customer };
    }

    case 'update_customer': {
      const input = { id: args.id };
      if (args.email)      input.email     = args.email;
      if (args.first_name) input.firstName = args.first_name;
      if (args.last_name)  input.lastName  = args.last_name;
      if (args.phone)      input.phone     = args.phone;
      if (args.note)       input.note      = args.note;
      if (args.tags)       input.tags      = args.tags;

      const { customerUpdate } = await gql(`
        mutation($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id displayName email }
            userErrors { field message }
          }
        }`, { input });
      if (customerUpdate.userErrors.length) throw new Error(customerUpdate.userErrors.map(e => e.message).join('; '));
      return { updated: true, ...customerUpdate.customer };
    }

    case 'create_fulfillment': {
      // Resolve order GID if needed
      let orderId = args.order_id;
      if (!orderId.startsWith('gid://')) {
        const n = orderId.startsWith('#') ? orderId : `#${orderId}`;
        const { orders } = await gql(`query($q: String!) { orders(first:1,query:$q) { edges { node { id } } } }`, { q: `name:${n}` });
        orderId = orders.edges[0]?.node.id;
        if (!orderId) throw new Error('Order not found');
      }

      // Get fulfillment order ID (required by fulfillmentCreateV2)
      const { order } = await gql(`
        query($id: ID!) {
          order(id: $id) {
            fulfillmentOrders(first: 5) {
              edges { node { id status } }
            }
          }
        }`, { id: orderId });

      const openFO = order.fulfillmentOrders.edges.find(({ node: fo }) => fo.status === 'OPEN')?.node;
      if (!openFO) throw new Error('No open fulfillment order found for this order');

      const fulfillmentInput = {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFO.id }],
        notifyCustomer: args.notify_customer ?? true,
      };
      if (args.tracking_number || args.tracking_company) {
        fulfillmentInput.trackingInfo = {};
        if (args.tracking_number)  fulfillmentInput.trackingInfo.number  = args.tracking_number;
        if (args.tracking_company) fulfillmentInput.trackingInfo.company = args.tracking_company;
        if (args.tracking_url)     fulfillmentInput.trackingInfo.url     = args.tracking_url;
      }

      const { fulfillmentCreateV2 } = await gql(`
        mutation($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment {
              id status
              trackingInfo { number url company }
            }
            userErrors { field message }
          }
        }`, { fulfillment: fulfillmentInput });
      if (fulfillmentCreateV2.userErrors.length) throw new Error(fulfillmentCreateV2.userErrors.map(e => e.message).join('; '));
      return { created: true, ...fulfillmentCreateV2.fulfillment };
    }

    case 'create_discount': {
      const isPercent = args.type === 'PERCENTAGE';
      const customerGets = {
        value: isPercent
          ? { percentage: args.value / 100 }
          : { discountAmount: { amount: String(args.value), appliesOnEachItem: false } },
        items: { all: true },
      };
      const minimumRequirement = args.minimum_amount
        ? { subtotal: { greaterThanOrEqualToSubtotal: String(args.minimum_amount) } }
        : null;

      const discountInput = {
        title:        args.title,
        code:         args.code,
        customerGets,
        startsAt:     args.starts_at ?? new Date().toISOString(),
        appliesOncePerCustomer: false,
      };
      if (minimumRequirement) discountInput.minimumRequirement = minimumRequirement;
      if (args.usage_limit)   discountInput.usageLimit         = args.usage_limit;
      if (args.ends_at)       discountInput.endsAt             = args.ends_at;

      const { discountCodeBasicCreate } = await gql(`
        mutation($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode {
              id
              codeDiscount { ... on DiscountCodeBasic {
                title
                codes(first: 1) { edges { node { code } } }
                startsAt endsAt usageLimit
              }}
            }
            userErrors { field message code }
          }
        }`, { basicCodeDiscount: discountInput });
      if (discountCodeBasicCreate.userErrors.length) throw new Error(discountCodeBasicCreate.userErrors.map(e => `${e.code}: ${e.message}`).join('; '));
      const d = discountCodeBasicCreate.codeDiscountNode;
      const cd = d.codeDiscount;
      return {
        created: true,
        id: d.id,
        title: cd.title,
        code: cd.codes.edges[0]?.node.code,
        starts_at: cd.startsAt,
        ends_at: cd.endsAt,
        usage_limit: cd.usageLimit,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server setup ──────────────────────────────────────────────────────

const server = new Server(
  { name: 'shopify-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await handleTool(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// Pre-fetch token on startup to catch auth errors early
await getToken();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[shopify-mcp] Running — store: ${DOMAIN}`);
