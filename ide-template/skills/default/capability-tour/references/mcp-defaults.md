# MCP → human-readable mappings

Default descriptions to use when the user's project CLAUDE.md `## Context` section doesn't override. English baseline; translate to the user's working language.

| MCP | Human-readable (English baseline) |
|---|---|
| `shopify` | Shopify store — products, prices, descriptions, orders, inventory |
| `meta-ads` / `meta` | Meta Ads (Facebook/Instagram) — campaigns, audiences, creative |
| `google-ads` | Google Ads — campaigns, keywords, costs, performance |
| `ga4` | Google Analytics — traffic, conversions, user behavior |
| `email` / `email-imap` | Email inboxes — read, triage, reply |
| `gemini-image` | Image generation (Imagen / Gemini) |
| `seedream` | Image generation / editing (Seedream BytePlus) |
| `nano-banana` | Image generation (Nano Banana) |
| `grok` | Search on X (Twitter) and the web via Grok |
| `signwell` | E-signature — send PDFs for signing |
| `telegram` | (you're already in it) |
| `trello` | Trello boards — cards, columns, labels, comments |
| `gdocs` | Google Docs — create, edit, comment |
| `gsheets` | Google Sheets — read, write, formulas |
| `gcalendar` | Google Calendar — events, availability |
| `gdrive` | Google Drive — file storage, sharing |
| `gslides` | Google Slides — decks, slides |
| `gtasks` | Google Tasks — todo lists |
| `x` / `x-mcp` | X (Twitter) — read tweets, search, profiles |
| `substack` | Substack — newsletter posts, subscribers |
| `workspace-api` | Workspace tools — memory search (`memory_grep`) |

## Tour message format

≤ 8 lines for the main message. One sentence per capability max. Use ✅ prefix. Match user's working language.

Example:
```
Tools currently wired up for this workspace:
✅ Shopify store — products, prices, orders, inventory
✅ Meta Ads — campaign performance, audiences
✅ GA4 — traffic and conversions
✅ Image generation (Seedream + Nano Banana)
✅ Email — reading and replying
✅ Reminders — Telegram alerts at scheduled times

Want me to demo any of these on a real example? Just say "show me X".
```

## Filter rules

Filter out infrastructure-level MCPs that aren't user-facing capabilities: `memory`, `playwright`, `reminders`. Those are plumbing, not features.

`workspace-api` IS user-facing (memory_grep is the tool the model uses for "search what we know about X") — keep in the tour.
