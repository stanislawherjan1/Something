---
card: AGENT_TOOLS
purpose: Tools, accounts, integrations the agent can use in this workspace + per-tool gotchas learnt the hard way
write_when: An integration is activated; a tool turns out to behave non-obviously and the workaround is worth keeping
write_how: tighten per tool. New tools append a section; updates within a tool's section replace
do_not_write_here: skill recipes (`project/.claude/skills/`), rules (RULES)
conflict: per-tool — newer gotcha replaces older when superseded
---

# AGENT_TOOLS

<!--
Per-tool section shape:

## tool-name (status)
- Auth: <how it's authenticated — env var name, or "via Integrations dashboard">
- What it's good for in this workspace:
- Gotchas:
  - <one-liner per gotcha, with date if recent>
- Last verified working: YYYY-MM-DD

Cover only tools currently active in this workspace. Dormant catalog entries
don't get a section. The Integrations dashboard is the source of truth for
"what's activated" — this card is for "how to actually use it well".
-->

<!-- example of a well-shaped tool entry — DELETE this comment block after the first real write:

## shopify (active)
- Auth: via Integrations dashboard — SHOPIFY_STORE_DOMAIN + SHOPIFY_ACCESS_TOKEN
- What it's good for in this workspace: pulling orders by date / status / customer, checking inventory levels for tracked SKUs, updating product descriptions in bulk
- Gotchas:
  - `list_orders` returns max 250 per page; paginate with `cursor` for full history (2026-05-12)
  - Variant updates require the parent product_id; passing only variant_id silently no-ops (2026-04-30)
- Last verified working: 2026-05-25
-->

