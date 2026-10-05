# Stripe MCP — API methods reachable through `stripe_api_read` / `stripe_api_write`

Source: Stripe's MCP documentation (docs.stripe.com/mcp), "Supported API methods". The list changes; when in doubt, `stripe_api_search`.

## Read (`stripe_api_read`)

- Customers: list, retrieve; customer balance transactions; cash balance + its transactions
- Charges, PaymentIntents, SetupIntents, PaymentMethods (incl. a customer's), payment method configurations and domains
- Refunds: list (all / per charge), retrieve
- Checkout Sessions: list, retrieve, line items
- Invoices: list, retrieve, line items, payments; invoice items; credit notes (list)
- Subscriptions, subscription schedules, subscription items
- Coupons, promotion codes, products, prices, payment links (+ line items)
- Disputes: list, retrieve
- Balance, balance transactions, payouts, transfers, application fees
- Events (v1 and v2), webhook endpoints, event destinations
- Customer portal configurations
- Tax: settings, codes, registrations, calculations
- Issuing: authorizations, cardholders, cards, disputes, transactions
- Accounts (v2), money management (preview): financial accounts/addresses, inbound/outbound transfers and payments, payout methods, received credits/debits, transactions

## Write (`stripe_api_write`) — each needs a clear yes

| Area | Methods | Risk |
|---|---|---|
| Refunds | create | **money out**; may require Stripe's approval link |
| Invoices | create, update, finalize, mark uncollectible, void; create preview | finalize = customer-facing; void/uncollectible = irreversible |
| Invoice items | create, update | changes what the customer is billed |
| Subscriptions | create, update, cancel | charges / stops charging |
| Customers | create, update | |
| Coupons | create, update, **delete** | |
| Promotion codes | create | |
| Products, prices | create, update | prices can't be edited in amount — a new price is created |
| Payment links | create, update | customer-facing once shared |
| Checkout Sessions | create | creates a payable link |
| Disputes | update | submitting evidence is final for that dispute |
| Portal | create configuration, update configuration, create session | |
| Tax | update settings, create/update registration, create calculation | |
| Webhooks / event destinations | create, update | changes integrations — operator territory |
| Payment method domains | create | |
| Test clocks | create (sandbox only) | |
| Analytics (preview) | create metric query result, create query run | read-like |
