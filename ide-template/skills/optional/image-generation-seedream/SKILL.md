---
name: image-generation-seedream
description: Generate, edit, blend, or background-remove images using Seedream (BytePlus). Triggers when the user asks to generate, create, make, edit, change, or remove the background from an image — particularly when they reference an existing image (Seedream is the only model here that accepts up to 14 reference images), or need a transparent PNG output. If the workspace also has nano-banana active and the user wants a fresh text-to-image with no reference, prefer the image-generation-nano-banana skill (cheaper for that path).
requires: seedream
allowed-tools: Read, Bash, mcp__seedream__generate_image, mcp__seedream__edit_image, mcp__seedream__remove_background
---

# Seedream Image Generation Protocol

Seedream is BytePlus's image model exposed via the `seedream` MCP. Its strengths over generic text-to-image: **multi-reference blending** (up to 14 reference images) and **transparent-PNG background removal**. Default to it when those capabilities matter.

## When to reach for Seedream specifically

✅ User attached or referenced one or more existing images and wants something "like that" / "in this style" / "blend these"
✅ Brand work where mood/texture/style consistency matters and the user has visual references
✅ "Remove the background" — Seedream is the only image MCP here that outputs a transparent PNG
✅ Edits where look-and-feel (style, texture, detail polish) matters more than instruction-following

❌ Pure text-to-image with no reference and no transparent-output requirement → prefer `nano-banana` if active (faster, cheaper for that path)
❌ Strict instruction-following edit ("add a blue hat exactly here") → `nano-banana` follows positional/instruction edits more reliably

## Output behavior — CRITICAL

### On Telegram (default)

1. Generate with the chosen Seedream tool → it saves to `~/project/generated/` and returns the file path
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
| Text → image (with reference images) | `mcp__seedream__generate_image` | Up to 14 reference images via the `references` parameter |
| Edit image (style / texture / detail) | `mcp__seedream__edit_image` | Better at look-and-feel changes than instruction-based edits |
| Remove background → transparent PNG | `mcp__seedream__remove_background` | Only image MCP here that outputs transparent backgrounds |

## Common patterns

**"Generate something like [reference image]"**
→ `seedream__generate_image` with the reference → send → delete (or save if asked)

**"Match the style of these 3 photos"**
→ `seedream__generate_image` with all 3 as references → send → delete

**"Edit this photo, make the texture richer / colors warmer / overall mood softer"**
→ `seedream__edit_image` → send → delete

**"Remove the background"**
→ `seedream__remove_background` → result is a transparent PNG → send → delete (or save if asked)

**"Generate 4 variations"**
→ `seedream__generate_image` 4× with the same prompt + small seed/style nudges → send all → delete all

## Multi-reference workflow

When the user attaches multiple reference images:

1. Acknowledge what each reference is meant to contribute (don't guess silently): *"Got it — using image 1 for color palette, image 2 for composition, image 3 for subject pose. Right?"*
2. Wait for confirmation if the mapping isn't obvious. If it's clearly stated by the user, skip the question.
3. Build a single prompt that names each contribution explicitly. Seedream weights references better when the prompt tells it what each one is for.
4. Generate. If the result misses one reference's intent, regenerate with a clearer prompt — don't blame the model.
