---
name: gslides
description: How to use the Google Slides MCP — list presentations, get full deck contents, read individual slides, create new presentations, add/delete slides, find/replace text across the deck. Also fills and styles slides: text in any shape, new text boxes, images, backgrounds, raw Slides API requests.
requires: google-workspace
allowed-tools: mcp__gslides__list_presentations, mcp__gslides__get_presentation, mcp__gslides__read_slide, mcp__gslides__create_presentation, mcp__gslides__add_slide, mcp__gslides__delete_slide, mcp__gslides__replace_text, mcp__gslides__list_text_boxes, mcp__gslides__set_text, mcp__gslides__insert_text, mcp__gslides__create_textbox, mcp__gslides__style_text, mcp__gslides__create_image, mcp__gslides__set_slide_background, mcp__gslides__batch_update
---

# Google Slides Protocol

Slides are visual — most of the value is layout, not text. Treat the API as a way to read structure and do mechanical text edits, not a substitute for the user actually opening the deck.

## Pre-flight

If `mcp__gslides__*` aren't available, activate **Integrations → Google Workspace**. Token needs `presentations` scope — re-activate Google Workspace if it's missing.

## Reading

- **`list_presentations { query?, limit? }`** — Drive search by name. Omit query for most-recent.
- **`get_presentation { presentation_id }`** — title + every slide's plain text + objectId. Good for "what's in the deck about X".
- **`read_slide { presentation_id, page_object_id }`** — full Page resource with raw `pageElements` tree. Use when you need element-level info (positions, IDs of specific shapes).

For "read the deck" → `get_presentation`. For "read slide 3" → `get_presentation` first to find slide objectIds, then `read_slide` on the right one.

## Creating

`create_presentation { title }` — empty deck, single default slide. Confirm the title before creating.

## Adding slides

`add_slide { presentation_id, layout?, insertion_index? }` — `layout` is one of: `BLANK` (default), `TITLE`, `TITLE_AND_BODY`, `TITLE_AND_TWO_COLUMNS`, `TITLE_ONLY`, `SECTION_HEADER`, `SECTION_TITLE_AND_DESCRIPTION`, `ONE_COLUMN_TEXT`, `MAIN_POINT`, `BIG_NUMBER`, `CAPTION_ONLY`. `insertion_index` is 0-based; omit to append.

Returns the new slide's objectId.

## Deleting slides

`delete_slide { presentation_id, page_object_id }` — get the objectId from `get_presentation` first. Confirm before deleting.

## Find / replace

`replace_text { presentation_id, find, replace, match_case?, page_object_ids? }` — replaces every occurrence across the deck (or a specific list of slides). Returns the number of replacements.

Useful for: rebranding decks (`Old Co → New Co`), updating dates, fixing typos. **Confirm before destructive replace** — it touches every match.

## Filling and styling slides

A slide added from a layout arrives with **empty placeholders**, and `replace_text` cannot see empty text. To fill one:

1. `list_text_boxes { presentation_id, slide_object_id? }` — every shape that holds text, with its `objectId`, placeholder role (TITLE, BODY…) and current text.
2. `set_text { presentation_id, object_id, text }` replaces all text in that shape; `insert_text` adds without clearing (omit `insertion_index` to append).

For anything the layout has no place for, `create_textbox` (points from the top-left; a 16:9 slide is 720 × 405). `style_text` sets colour, size, font, bold/italic/underline and alignment on a range or the whole shape. `create_image` places an image from a **public** URL; `set_slide_background` takes a hex colour. `batch_update` sends raw Slides API requests for the rest (tables, bullets, moving or reordering) — use it only when no tool above does the job.

All of these change the deck: say what you're about to change before you do it, unless the person just asked for exactly that.

## Defensive defaults

- **Confirm writes** with the action + scope (which presentation, how many slides affected, what's being replaced).
- **API can't change layout/imagery** beyond text replace + slide-level add/delete. For visual edits the user opens the deck themselves.
- **`replace_text` is idempotent** — returns 0 if `find` doesn't appear. Safe to retry.
- **Wrong scope?** Re-activate Google Workspace to refresh the token.
