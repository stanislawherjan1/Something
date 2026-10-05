# MCP → human-readable descriptions

Where to get the one-line description of each active integration, in order:

1. The user's project CLAUDE.md `## Context` section (always wins).
2. The installed skill for that integration under `~/project/.claude/skills/<name>/` — its `description` says what it does. This covers every integration in the catalog, including ones missing from the table below.
3. The fallback table below.

English baseline; translate to the user's working language.

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
| `workspace-api` | Workspace tools — searching what we know and what happened (`memory_search`, `memory_timeline`) |

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
More can be connected under Integrations.
```

Add at most one fitting routine suggestion after this block (see SKILL.md Step 4).

## Filter rules

Filter out infrastructure-level MCPs that aren't user-facing capabilities: `memory`, `playwright`, `reminders`, `tasks`, `web-channel`. Those are plumbing, not features.

`workspace-api` IS user-facing (`memory_search` / `memory_timeline` are how you answer "what do we know about X" and "what happened with X") — keep in the tour.
