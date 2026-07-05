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

## Styling

Look-and-feel (fonts, margins, table borders, page numbers) lives in one place:
`/opt/ide/apps/pdf-mcp/house.css`. Every render uses it, so documents look
consistent. If a document needs a genuinely different look, adjust the markdown;
only touch the stylesheet for a deliberate, workspace-wide change.
