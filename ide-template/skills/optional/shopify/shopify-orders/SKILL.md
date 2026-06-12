---
name: shopify-orders
description: Use this when the user asks about orders, fulfillment, shipping, order status, cancellations, or anything related to customer orders in Shopify.
allowed-tools: mcp__shopify__get_orders, mcp__shopify__get_order, mcp__shopify__get_fulfillments, mcp__shopify__create_fulfillment, mcp__shopify__cancel_order, mcp__shopify__add_order_note, mcp__shopify__get_customers, mcp__shopify__get_customer, mcp__shopify__create_customer, mcp__shopify__update_customer, mcp__shopify__get_draft_orders, mcp__shopify__create_draft_order
requires: shopify
---

# Shopify Orders Protocol

## Core rules — always apply

**Look up before acting.** Before any fulfillment, cancellation, or note, call `get_order` to confirm the order exists and check its current status. Never assume order state from the user's description alone.

**Check status before mutating.** Cancellations only work on open/unfulfilled orders. Fulfillments require at least one unfulfilled line item and an open fulfillment order. Confirm status before attempting.

**Confirm destructive actions.** Cancelling an order is hard to reverse. Always confirm:
> "Order #1234 is currently [status]. Cancel it? This cannot be undone."

**Ask when ambiguous.** If the user says "fulfill order 1234" without specifying tracking, ask whether they have a tracking number. Don't invent tracking info.

---

## Looking up orders

- `get_orders` — list orders. Filter by status: `open`, `closed`, `cancelled`, `any`. Can filter by customer email or name.
- `get_order` — get full details for a single order: line items, fulfillment status, shipping address, payment status, notes, timeline.

Useful fields to surface:
- `displayFulfillmentStatus` — what the customer sees (UNFULFILLED, PARTIALLY_FULFILLED, FULFILLED)
- `financialStatus` — payment state (PAID, PENDING, REFUNDED)
- `lineItems` — what was ordered and at what price
- `shippingAddress` — delivery destination
- `note` — internal note on the order

---

## Fulfillment

`create_fulfillment` marks items as shipped. Requires an open fulfillment order (not just an order ID).

**Flow:**
1. `get_order` → check `displayFulfillmentStatus`. If already FULFILLED, stop and tell the user.
2. Call `create_fulfillment` with `order_id` (GID). The tool automatically locates the open fulfillment order.
3. Optionally pass `tracking_number`, `tracking_company`, `notify_customer: true`.
4. After creating, call `get_order` again and confirm `displayFulfillmentStatus` is now FULFILLED or PARTIALLY_FULFILLED.

Common tracking companies: `DHL`, `UPS`, `FedEx`, `USPS`, `DPD`, `GLS`, `InPost`, `Poczta Polska`.

If the order has multiple line items that ship separately, note that partial fulfillment is possible but requires specifying which items to fulfill (not yet supported in this tool — alert the user).

---

## Cancellations

`cancel_order` — cancels an open order. Only works before fulfillment.

**Flow:**
1. `get_order` → verify status is UNFULFILLED and financially PENDING or PAID.
2. Confirm with user: > "Cancel order #[number]? Payment will be refunded if applicable."
3. Call `cancel_order`.
4. `get_order` again — confirm status shows CANCELLED.

If the order is already fulfilled, cancellation is not available via API. Tell the user and suggest contacting the customer directly.

---

## Order notes

`add_order_note` — adds or replaces the internal note on an order. Useful for customer service context, special handling instructions, or manual flags.

- Call `get_order` first to check if a note already exists.
- If it does, confirm whether to replace or append before acting.

---

## Customers

- `get_customers` — search by name, email, or phone.
- `get_customer` — full customer profile: order count, total spend, addresses, tags, notes.
- `create_customer` — add a new customer (first_name, last_name, email, phone, tags).
- `update_customer` — update any customer field. Always call `get_customer` first to confirm they exist.

**Common customer use cases:**
- Look up a customer before checking their order history.
- Add a VIP tag to a high-spend customer.
- Update email or phone after a customer contacts support.

---

## Draft orders

- `get_draft_orders` — list all pending draft orders.
- `create_draft_order` — create a custom/manual order. Useful for phone orders, B2B quotes, or discount exceptions.

For draft orders, confirm all line items and pricing with the user before creating — drafts sent to customers are visible immediately.

---

## Report format for order queries

When the user asks "what's the order status" or "show me today's orders", respond clearly:

```
Order #1234 — [customer name]
Status: Unfulfilled | Paid
Items: 2x Corset Silk 85B (€850 each)
Shipping to: Warsaw, Poland
Note: [note or "none"]
```

For bulk queries, summarize totals:
> "5 open orders today — 3 unfulfilled, 1 partially fulfilled, 1 cancelled."
