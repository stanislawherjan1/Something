#!/usr/bin/env python3
"""markdown → HTML → PDF renderer for pdf-mcp.

The ONE supported way to make a PDF in this workspace. Uses python-markdown
(tables, fenced code, smart quotes/dashes, footnotes) → weasyprint (a real
CSS/paged-media engine). Unicode/accents are native — no latin-1 mangling,
no hand-rolled PDF objects, no off-by-one page tables.

Usage:
  render.py --in doc.md --out doc.pdf [--title "..."] [--css house.css]
  render.py --stdin      --out doc.pdf [--title "..."]     # markdown on stdin

Exits non-zero with a message on stderr if rendering fails or the output is
empty/invalid, so the Node wrapper can surface a truthful error.
"""

import argparse
import html
import os
import re
import sys


def die(msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--in", dest="infile", help="Path to a markdown file.")
    src.add_argument("--stdin", action="store_true", help="Read markdown from stdin.")
    ap.add_argument("--out", required=True, help="Output PDF path.")
    ap.add_argument("--title", default="", help="Optional document title block.")
    ap.add_argument("--css", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "house.css"))
    args = ap.parse_args()

    try:
        import markdown  # noqa
        from weasyprint import HTML  # noqa
    except Exception as e:  # pragma: no cover
        die(f"PDF toolchain not available in this container: {e}")

    if args.stdin:
        md_text = sys.stdin.read()
        base_dir = os.getcwd()
    else:
        if not os.path.isfile(args.infile):
            die(f"Markdown source not found: {args.infile}")
        with open(args.infile, "r", encoding="utf-8") as fh:
            md_text = fh.read()
        base_dir = os.path.dirname(os.path.abspath(args.infile))

    if not md_text.strip():
        die("Refusing to render an empty document — no markdown content.")

    # "extra" pulls in tables, fenced_code, footnotes, attr_list, def_list, abbr.
    # Resolve the document title. Explicit --title wins. Otherwise, if the
    # document naturally starts with a single "# H1", promote it to the title
    # block (and strip it from the body so it isn't rendered twice) — so a normal
    # markdown document with a top-level heading gets a proper headline without
    # the caller having to remember the title argument.
    title = args.title.strip()
    if not title:
        lines = md_text.split("\n")
        i = 0
        while i < len(lines) and not lines[i].strip():
            i += 1
        if i < len(lines):
            m = re.match(r"^#\s+(.+?)\s*#*\s*$", lines[i])
            if m:
                title = m.group(1).strip()
                del lines[i]
                md_text = "\n".join(lines)

    # "smarty" gives typographic quotes/dashes. NO nl2br — a business doc should
    # reflow paragraphs, not turn every source newline into a hard <br>.
    body = markdown.markdown(
        md_text,
        extensions=["extra", "sane_lists", "smarty"],
        output_format="html5",
    )

    title_block = ""
    if title:
        title_block = f'<div class="doc-title">{html.escape(title)}</div>'

    try:
        with open(args.css, "r", encoding="utf-8") as fh:
            css = fh.read()
    except Exception as e:
        die(f"House stylesheet unreadable ({args.css}): {e}")

    doc = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{html.escape(title or 'Document')}</title>"
        f"<style>{css}</style></head><body>{title_block}{body}</body></html>"
    )

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    try:
        # base_url lets relative <img> paths in the markdown resolve against the
        # source file's directory (logos, screenshots, etc.).
        HTML(string=doc, base_url=base_dir + os.sep).write_pdf(out)
    except Exception as e:
        die(f"weasyprint failed to render: {e}")

    if not os.path.isfile(out) or os.path.getsize(out) < 100:
        die("Render produced an empty or invalid PDF.")

    sys.stdout.write(out + "\n")


if __name__ == "__main__":
    main()
