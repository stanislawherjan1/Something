---
name: image-generation-nano-banana
description: Generate or edit images using Nano Banana (Google's image model). Triggers when the user asks to generate, create, or make a fresh image without reference photos, or to perform an instruction-based edit ("add a blue hat", "change the background to a forest"). Default choice for text-to-image when no reference is needed. If the user wants reference-blending or transparent backgrounds, prefer the image-generation-seedream skill (Nano Banana doesn't support either).
requires: nano-banana
allowed-tools: Read, Bash, mcp__nano-banana__generate_image, mcp__nano-banana__edit_image
---

# Nano Banana Image Generation Protocol

Nano Banana is Google's image model exposed via the `nano-banana` MCP. Its strengths over the alternatives: **fast text-to-image with no reference**, and **instruction-following edits** (positional changes, addition/removal of objects, color swaps where the request is precise).

## When to reach for Nano Banana specifically

✅ Pure text-to-image, no reference photos
✅ "Generate 4 variations of X" — fast batch path
✅ Instruction-based edit: "add a blue hat", "remove the lamp from the corner", "change the sky to sunset"
✅ Mood/scene compositions described entirely in words

❌ User attached reference image(s) and wants the output to match their style → use `image-generation-seedream` (it accepts up to 14 references)
❌ Output needs a transparent background → use `image-generation-seedream` (`remove_background`)
❌ Style/texture/detail polish where the goal is "make it look like X" rather than "do exactly X" → Seedream handles look-and-feel better

## Output behavior — CRITICAL

### On Telegram (default)

1. Generate with the chosen Nano Banana tool → it saves to `~/project/generated/` and returns the file path
2. Send the file to Telegram immediately as an attachment
3. **Delete the file after sending:**
   ```bash
   rm "/path/to/generated/filename.jpeg"
   ```

This keeps `~/project/generated/` clean and prevents Drive sync (legacy clients) from filling up with throw-away renders.

### When the user asks to save

If the user says "save it", "keep it", "store it", "zachowaj" → skip deletion, confirm the path. Use the **file-placement** skill to decide where the kept image lives (typically `Brand/`, `Marketing/[channel]/`, or wherever `CLAUDE.md` "Where to Save" maps visual outputs).

### In the IDE / web chat

Save normally, return the file path. No deletion. The chat panel will preview the image inline.

## Prompt construction

Don't pass the user's raw message to the tool. Build the prompt using the 5-component formula:

**Subject + Action + Context + Composition + Style/Lighting**

Example — user says "a woman in a corset":
> A young woman wearing an elegant black satin corset, standing confidently, soft studio background, close-up from waist up, dramatic side lighting, fashion editorial photography, high detail

If a `brand-visuals` (or similarly-named brand-style) skill is active in this project, incorporate its color palette, mood, shot type, and "do/don't" rules into every prompt.

## Tool reference

| Task | Tool | Notes |
|---|---|---|
| Text → image (no reference) | `mcp__nano-banana__generate_image` | Pass `n: N` for batch variations |
| Edit image (instruction-based) | `mcp__nano-banana__edit_image` | Best when the change is a precise, addable/removable element |

## Common patterns

**"Generate an image of X"** (no references)
→ `nano-banana__generate_image` → send → delete (or save if asked)

**"Edit this photo, add/remove/change Y"** (precise instruction)
→ `nano-banana__edit_image` → send → delete

**"Generate 4 variations"**
→ `nano-banana__generate_image` with `n: 4` → send all → delete all

**"Change the texture / make it more painterly / shift the mood"**
→ This is style-level, not instruction-level. Seedream `edit_image` is a better fit; if Seedream isn't active, do the best you can with Nano Banana but flag the limitation.
