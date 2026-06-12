# Embedding SignWell text-tags in ReportLab-generated PDFs

## The trap

`reportlab.platypus.Paragraph` parses text as XML. **Curly braces `{}` get silently swallowed** — the tags vanish from the output PDF. SignWell then rejects the document:

```
{"errors":{"send":["There aren't fields in the document"]}}
```

## The fix — bypass Paragraph with a RawText Flowable

```python
from reportlab.platypus import Flowable

class RawText(Flowable):
    def __init__(self, text, font='Helvetica', size=9, color=(0,0,0), width=400, height=16):
        super().__init__()
        self.text = text; self.font = font; self.size = size
        self.color = color; self.width = width; self.height = height
    def draw(self):
        self.canv.setFont(self.font, self.size)
        r, g, b = self.color
        self.canv.setFillColorRGB(r, g, b)
        self.canv.drawString(0, 2, self.text)
        self.canv.setFillColorRGB(0, 0, 0)
```

Use it in a table cell or on its own:

```python
RawText('{{signature:1:y}}', size=9, width=half-16, height=18)
```

## Verify before sending — pdfminer, not byte-grep

PDFs encode text as character codes, the literal string `{{signature:1:y}}` won't appear in raw bytes. Use a real text extractor:

```python
from pdfminer.high_level import extract_text
buf.seek(0)
text = extract_text(buf)
assert 'signature:1' in text, "Tag not found in PDF — do NOT send"
```

If the assert fails, the tags didn't make it through. Fix the embedding, regenerate, re-verify. **Don't try to send a fieldless PDF.**

## Tag syntax

| Tag | Meaning |
|---|---|
| `{{signature:1:y}}` | Signature field for recipient `id=1`, required |
| `{{signature:1:n}}` | Same, optional |
| `{{signature:2:y}}` | Recipient `id=2`, required |
| `{{date:1:y}}` | Date field for recipient `id=1` |
| `{{text:1:y}}` | Free-text field for recipient `id=1` |

The number after `signature:` must match the recipient's `id` in the `send_document` call.

## When NOT to use text tags

For PDFs the user uploaded from outside (third-party contracts, signed-elsewhere docs), use `send_now: false` instead. SignWell returns an `editor_url`; the user places fields manually, then clicks Send in the SignWell UI. Don't try to retrofit tags into a PDF you didn't generate.
