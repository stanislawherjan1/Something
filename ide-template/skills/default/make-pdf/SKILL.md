---
name: make-pdf
description: Use this whenever you need to produce a PDF — a proposal, report, invoice, letter, contract, summary, or any document someone asks for "as a PDF". There is a dedicated tool for it (mcp__pdf__render_pdf); NEVER write raw PDF bytes or a hand-rolled Python PDF builder. Also covers previewing a PDF to SEE it before sending, and delivering it over Telegram.
allowed-tools: mcp__pdf__render_pdf, mcp__pdf__preview_pdf, Read, Write, Bash
---

# Making a PDF

There is exactly **one correct way** to make a PDF in this workspace: the
**`render_pdf`** tool (from `pdf-mcp`). It turns markdown into a clean,
professionally typeset PDF using a real rendering engine (python-markdown →
weasyprint). Tables, headings, lists, code, blockquotes, and accented / Unicode
text (é, ñ, ł, —, …) all render correctly.

## Never hand-roll a PDF

Do **not** write raw PDF bytes, and do **not** write a Python script that builds
PDF objects/xref tables by hand (`struct`, `zlib`, manual object numbering).
That path is how you get blank pages, off-by-one page references, mangled
accents (café → cafe), and "shitty tables with no padding". If you catch
yourself reaching for `import struct` to make a PDF, **stop** and use
`render_pdf`.

## The flow

1. **Write the content as markdown.** Put it in a `.md` file in the project
   (e.g. `Documents/proposal.md`) — or pass it inline. Use normal markdown:
   `#`/`##` headings, `- ` lists, `| a | b |` tables, `**bold**`, `> quotes`.
2. **Render it — and give it a title.**
   `render_pdf({ source_path: "Documents/proposal.md", title: "Proposal for Acme" })`.
   ALWAYS pass a `title` for a real document (letter, proposal, report, invoice) —
   it renders as a prominent headline block at the top. Without it the PDF opens
   straight into body text with no title. (Alternatively, start the markdown with
   a single `# Heading` and it becomes the title automatically.) Don't rely on a
   bold first line like `**Re: …**` — that is NOT a title, it renders as ordinary
   body text. It returns the absolute PDF path, page count, and size.
3. **See it before you send it.** Call
   `preview_pdf({ pdf_path: "<the returned path>" })`, then **Read** the PNG it
   returns — actually look at the layout, tables, and spacing. Do this
   especially when asked to "check it visually" before sending. If something is
   off, fix the markdown (or the house stylesheet) and re-render.
4. **Deliver it.**
   - Over the **web / a 1:1 Telegram DM**: use the Telegram `sendDocument` tool
     with the file path.
   - In a **Telegram GROUP**: your text can't carry an attachment — emit the
     marker `[[SEND_FILE <absolute path>]]` on its own line; the system uploads
     that file to the group. **Never claim you sent a file unless you actually
     used `sendDocument` or a `[[SEND_FILE ...]]` marker.**

## Changing the look — use the `style` knobs, nothing else

When someone asks to restyle a document ("make it warmer", "bigger text",
"tighter", "put it on Letter paper", "can the headings be blue"), change the look
**only** through the `style` object on `render_pdf`. Every value is validated, so
you can't break the layout with them:

| Knob | Values | Effect |
|---|---|---|
| `accent`  | named (`slate` default, `blue`, `navy`, `teal`, `green`, `plum`, `maroon`, `orange`, `gray`) or `#rrggbb` | Heading + title colour |
| `text`    | named or `#rrggbb` | Body text colour (default near-black) |
| `muted`   | named or `#rrggbb` | Date/meta line + page numbers (default grey) |
| `link`    | named or `#rrggbb` | Hyperlink colour (default blue) |
| `font`    | `serif` (default) / `sans` | Body font (headings stay sans) |
| `size`    | number, 9–13 (default 10.5) | Base text size in pt |
| `density` | `compact` / `normal` (default) / `relaxed` | Spacing + margins |
| `rules`   | `true` / `false` (default) | Hairline under section headings |
| `title_rule` | `true` (default) / `false` | Rule under the document title |
| `justify` | `true` / `false` (default) | Justify body text vs left-align |
| `table`   | `grid` (default) / `lined` / `plain` | Table borders: full+zebra / horizontal only / borderless |
| `table_header` | `shaded` (default) / `accent` / `plain` | Header row: grey fill / accent text+underline / just bold |
| `page`    | `A4` (default) / `Letter` | Paper size |

Example: `render_pdf({ source_path: "Documents/proposal.md", title: "Proposal",
style: { accent: "navy", density: "compact", size: 11 } })`.

**Never** try to change the look by editing the document's content or structure
(stripping `---`, rewriting headings, adding raw HTML) or by hand-writing CSS —
that's how formatting gets broken. The knobs above are the whole safe surface; if
a request needs something outside them, say so rather than improvising. The base
stylesheet (`apps/pdf-mcp/house.css`) is a workspace-wide default — only an
operator changes it, never per document.

## Saving layouts (named presets)

You can remember a look and reuse it. Presets are owned by pdf-mcp — manage them
**only** through these tools, never by reading or writing files:

- **Save** — when someone dials in a look and says "save this / remember this /
  use this from now on", call `save_pdf_style({ name: "brand", style: { … } })`
  with the exact style you just rendered. Add `set_default: true` to make it the
  layout used automatically. You can save several (e.g. `brand`, `invoice`,
  `letter`).
  A saved layout pins the **whole** look (colour, font, size, spacing, page) —
  not just the one thing mentioned — so every document in it matches. You don't
  need to list all the knobs; the tool captures the full look of what you last
  rendered.
- **Use** — `render_pdf({ source_path: "…", preset: "brand" })` renders in that
  layout. With **no** preset, the saved default (if any) is applied automatically
  — so once a default is set, every PDF just looks right without asking.
- **See / offer / remove** — `list_pdf_styles()` shows what's saved (and the
  default). When more than one layout exists and it's not obvious which to use —
  or when someone asks which styles there are, or to "pick"/"choose" one — call
  it and **offer the saved layouts by name so they can choose**, then render with
  that `preset`. `delete_pdf_style({ name })` removes one.

**Don't override a saved layout by accident.** When a default or a chosen preset
is in effect, render with it and **pass NO `style` knobs of your own** — a stray
`style` (e.g. picking a colour yourself) silently overrides the saved layout and
breaks consistency (that's how a "black" default came out grey). Only add a
`style` knob when the person explicitly asks to change the look for *this*
document; if they then want that kept, save it back with `save_pdf_style`.

So the flow is: tweak with `style` → when they're happy, `save_pdf_style` →
later, render with `preset` (or just let the default apply) and add nothing on
top, so documents stay consistent.
