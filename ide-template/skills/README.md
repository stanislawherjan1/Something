# Skills

Skills are instruction files (`SKILL.md`) that tell Claude how to handle specific tasks.

## default/

**Deployed automatically** on every container build. Copy these to `~/.claude/skills/` or `project/.claude/skills/` once — they work out of the box with no extra credentials.

- `playwright-protocol` — safe browser automation with Playwright
- `reminders` — timed reminders via Telegram (pairs with the reminders MCP)
- `project-backup` — create and send project archives via Telegram

## optional/

**Not deployed automatically.** Install after adding the corresponding `.env` keys.

Copy the skill folder (the inner one, not the category folder) to `~/.claude/skills/` or `project/.claude/skills/`, then restart the bot.

| Skill | Requires |
|---|---|
| `image-generation` | `BYTEPLUS_API_KEY` or `GEMINI_API_KEY` |
| `google-ads/*` | `GOOGLE_ADS_DEVELOPER_TOKEN` |
| `meta/*` | `META_ACCESS_TOKEN` |
| `shopify/*` | `SHOPIFY_STORE_DOMAIN` |

See [docs/SKILLS.md](../../docs/SKILLS.md) for full install instructions.
