#!/usr/bin/env bash
# Populate /tmp/workspace-mock/ with realistic-ish workspace content for local
# frontend dev. Mirrors the structure of a real deploy's ~/project/ — same
# shortcuts (Tasks.md, generated/), same skill format, same reminder shape.
#
#   ./scripts/seed-mock.sh           # create / refresh
#   ./scripts/seed-mock.sh --clean   # wipe and rebuild from scratch
#
# Then in two terminals:
#   PROJECT_DIR=/tmp/workspace-mock node index.js
#   (cd ../frontend && npm run dev)
# Open http://localhost:5173/app/

set -e
MOCK="${PROJECT_DIR:-/tmp/workspace-mock}"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$MOCK"
fi

mkdir -p "$MOCK"/{Bot,generated,Products,Research,inbox,notes,.chat}
mkdir -p "$MOCK"/.claude/skills/{shopify-orders,image-generation,task-management}

# ─── Tasks.md (Kanban) ────────────────────────────────────────────────────
cat > "$MOCK/Tasks.md" <<'EOF'
# Tasks

## Backlog

### Test the storefront frontend (Hydrogen)
**Owner:** Alex · **Priority:** High · **Deadline:** 2026-05-02

Test the Hydrogen frontend locally — check product pages, collections,
navigation, responsiveness. Make sure Shopify Storefront API data loads
correctly.

### Finish store configuration
**Owner:** Alex · **Priority:** Medium · **Deadline:** TBD

Remaining items: switch the store currency, wire up Shopify Payments under
the right entity, remove the old lifestyle photo for Sample Product A in the
Shopify admin.

## In Progress

### Summer campaign brief
**Owner:** Sam · **Priority:** Medium · **Deadline:** 2026-05-06

Sam is working on the brief. Waiting on moodboard approval before starting
model and location sourcing.

## Done

### Set up workspace-api + custom frontend
**Owner:** Alex · **Priority:** High · **Completed:** 2026-04-30

Walking skeleton + iterations 2-8: file tree, image gallery, Kanban, AI Settings
dashboard, chat history + threads, drag-drop, animations.
EOF

# ─── CLAUDE.md (instructions) ─────────────────────────────────────────────
# Lives in .claude/ so the AI Settings dashboard picks it up (matches the
# real deploy layout — Claude Code reads .claude/CLAUDE.md by default).
cat > "$MOCK/.claude/CLAUDE.md" <<'EOF'
# Sample workspace

Dev / mock environment for the workspace UI. Free to break stuff — none of
this data is real.

## Conventions

- Tasks live in `Tasks.md` (rendered as a Kanban board in the workspace UI).
- Generated images go in `generated/` (rendered as a Gallery).
- Notes use plain markdown; no special folder.
- Bot's own scratch files live in `Bot/`.
EOF

# ─── Skills ───────────────────────────────────────────────────────────────
cat > "$MOCK/.claude/skills/shopify-orders/SKILL.md" <<'EOF'
---
name: shopify-orders
description: Fetch and update Shopify orders. Use when the user asks about recent orders, fulfillment, or refunds.
---

# Shopify orders

Tools available:
- `mcp__shopify__list_orders` — recent orders, optionally filtered by status
- `mcp__shopify__get_order` — full detail by order ID
- `mcp__shopify__update_order` — fulfillment / cancellation

Always confirm before cancelling or refunding.
EOF

cat > "$MOCK/.claude/skills/image-generation/SKILL.md" <<'EOF'
---
name: image-generation
description: Generate product images via Seedream or Nano Banana when the user asks for a hero, mockup, or social asset.
---

# Image generation

Tools:
- `mcp__seedream__generate` — primary
- `mcp__nano_banana__generate` — fallback

Output to `generated/`. Always name the file after the subject.
EOF

cat > "$MOCK/.claude/skills/task-management/SKILL.md" <<'EOF'
---
name: task-management
description: Add, update, move, or review tasks. Stored in Tasks.md at the project root.
---

# Tasks

`Tasks.md` has three columns: `## Backlog`, `## In Progress`, `## Done`.
Each task is `### Title` with a metadata line:

    **Owner:** Name · **Priority:** High/Medium/Low · **Deadline:** YYYY-MM-DD or TBD

Then a description paragraph.
EOF

# ─── Reminders ────────────────────────────────────────────────────────────
cat > "$MOCK/.reminders.json" <<'EOF'
[
  {"id":"r_a1b2c3","message":"Check Sam's brief approval","due":"2026-05-02T10:00:00Z","repeat":"none","created":"2026-04-30T14:00:00Z","status":"pending"},
  {"id":"r_d4e5f6","message":"Draft weekly newsletter","due":"2026-05-05T09:00:00Z","repeat":"weekly","created":"2026-04-25T09:00:00Z","status":"pending"},
  {"id":"r_g7h8i9","message":"Reply to Sam about timeline","due":"2026-04-29T15:00:00Z","repeat":"none","created":"2026-04-28T10:00:00Z","status":"sent"}
]
EOF

# ─── Realistic file content in folders ────────────────────────────────────
cat > "$MOCK/Bot/notes.md" <<'EOF'
# Bot — scratchpad

- Working on summer campaign assets
- Pending: review Sam's brief
- Done: organized product folder
EOF

cat > "$MOCK/Research/campaign-brief.md" <<'EOF'
# Campaign brief

## Timeline
6 weeks, kicking off mid-May.

## Budget
Approved by finance.

## Focus
Summer collection launch — three hero pieces (Sample Product A, Sample
Product B, Sample Product C).

## Open questions
- Photographer? Sam leaning toward an external freelancer.
- Location: two options on the shortlist.
EOF

cat > "$MOCK/Research/competitors.md" <<'EOF'
# Competitor scan — May 2026

Quick notes after browsing IG and Shopify storefronts.

## Competitor One
Strong on lifestyle imagery. Slower email cadence than us.

## Competitor Two
Cleaner product page layouts. Worth borrowing the ATC button treatment.
EOF

cat > "$MOCK/Products/sample-product-a.md" <<'EOF'
# Sample Product A

Linen blend dress, mid-length, four colorways.

## Shopify SKUs
- SP-A-S-MOSS, SP-A-M-MOSS, SP-A-L-MOSS
- SP-A-S-CREAM, SP-A-M-CREAM, SP-A-L-CREAM

## Issues
- Old lifestyle shot (the one with bad lighting) still on the PDP — needs removal
EOF

cat > "$MOCK/inbox/2026-04-30_sam-checkin.md" <<'EOF'
# From Sam — 2026-04-30 weekly check-in

Hey, quick update: brief is 80% done, will send latest version Friday for
approval. Let me know if you want any specific angle on Sample Product A.

— Sam
EOF

cat > "$MOCK/notes/ideas.md" <<'EOF'
# Idea pile

- Cross-promo with a partner brand (newsletter swap?)
- Shopify discount drop for returning customers
- Newsletter rework — A/B subject line patterns

(none of these are committed yet)
EOF

# ─── Placeholder images for Gallery ───────────────────────────────────────
echo "Fetching placeholder images from picsum.photos…"
for i in 1 2 3 4 5 6; do
  out="$MOCK/generated/sample-$i.jpg"
  if [[ ! -s "$out" ]]; then
    curl -s -L --max-time 10 "https://picsum.photos/seed/mock$i/600/400" -o "$out" || echo "  (skip sample-$i: network)"
  fi
done

# ─── Workspace icon (copied from a deploy's overrides if available) ────────
# Optional — only used by the dev frontend if you also copy it into
# ide-template/frontend/public/icon.png. The mock doesn't serve assets.
ICON_SRC="${ICON_SRC:-}"
if [[ -n "$ICON_SRC" && -f "$ICON_SRC" && ! -f "$MOCK/.icon.png" ]]; then
  cp "$ICON_SRC" "$MOCK/.icon.png"
fi

echo ""
echo "✓ Mock seeded at: $MOCK"
echo ""
tree -L 2 "$MOCK" 2>/dev/null || find "$MOCK" -maxdepth 2 -print
