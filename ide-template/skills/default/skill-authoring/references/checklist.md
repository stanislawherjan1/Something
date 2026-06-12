# Pre-commit checklist for a new / modified skill

Run through every box before committing. If any fails, fix before the skill ships — silent failures (especially YAML) waste days of debugging.

## Folder structure

- [ ] Folder name is kebab-case (lowercase, hyphens only — no `_`, no capitals, no leading hyphen)
- [ ] Folder name does NOT start with `claude` or `anthropic` (reserved)
- [ ] Folder contains `SKILL.md` (exact casing, not `Skill.md` / `skill.md` / `SKILL.MD`)
- [ ] Folder does NOT contain `README.md`
- [ ] If you added supporting docs, they're under `references/<topic>.md`
- [ ] If you added scripts, they're under `scripts/<name>.{sh,py}` and marked executable
- [ ] If you added templates / fonts / icons used in skill output, they're under `assets/`

## Frontmatter

- [ ] Opening `---` is exactly on line 1 (no stray characters, no BOM)
- [ ] Closing `---` is present after the last frontmatter field
- [ ] `name:` value matches the folder name exactly
- [ ] `description:` is under 1024 characters
- [ ] `description:` includes WHAT the skill does AND WHEN to use it
- [ ] `description:` lists at least 2-3 concrete trigger phrases users say
- [ ] `description:` includes negative triggers if this skill overlaps with another
- [ ] No XML angle brackets `<` or `>` anywhere in frontmatter
- [ ] `allowed-tools:` is set with the minimum scope needed

## Body

- [ ] Total body under ~5000 words (rough cap)
- [ ] Sections are clear: `## When to use`, `## Steps` (or `## Decision tree`), `## Examples`, `## Troubleshooting`
- [ ] At least one concrete example showing a user query + the action taken
- [ ] Troubleshooting section covers at least 2 known failure modes
- [ ] No ambiguous language (`"validate properly"`, `"do the right thing"`) — replace with specific verifiable steps
- [ ] Static reference data (tables, bash command lists, schemas) is in `references/`, not inline
- [ ] Scripts >10 lines are in `scripts/`, not inline

## Tool restriction

- [ ] `allowed-tools:` is set (NOT defaulting to full access unless this skill genuinely needs everything)
- [ ] Scope is minimal: if the skill only reads files, it's `Read` — not `Read, Bash, Write, WebFetch`
- [ ] If using `Bash`, scoped to specific binaries: `Bash(python:*), Bash(jq:*)` — not bare `Bash`
- [ ] MCP wildcards (`mcp__<server>__*`) used only when the skill needs most tools of that server

## Discovery + behaviour test

Skills are auto-discovered at every CC session start, and a fresh session starts on every Telegram message / web chat turn. **No bot restart needed** for the bot to see a new skill — just send the next message.

- [ ] Ask the bot in a fresh message: *"when would you use the `<skill-name>` skill?"* — answer quotes your description back
- [ ] Send a trigger phrase from your description — skill loads and acts as expected
- [ ] Send a clearly unrelated message — skill does NOT load (no over-triggering)
- [ ] If skill overlaps with another, verify each loads when its specific trigger fires (not the other)

(Bot restart IS needed for: MCP server changes, `.claude/settings.json` edits, `global-claude.md` updates — those are loaded at bot startup, not CC session start. Pure SKILL.md additions don't qualify.)

## Documentation handoff

- [ ] Told the user: skill name, trigger phrases, one example query to test
- [ ] If skill is integration-specific, noted which `requires:` env var it needs
- [ ] If skill ships in `ide-template` (system skill, not project skill), updated `skills/README.md` if relevant
