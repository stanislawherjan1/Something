---
name: skill-authoring
description: Author or update a SKILL.md playbook in this workspace. Use when user says "create a skill", "add a skill", "write a SKILL.md", "make a playbook", "package this as a recipe", "automate this workflow", or asks how the skills system works / how to add a new playbook / where skills live. Covers folder structure, YAML frontmatter, references/ split, allowed-tools restriction, and pre-commit validation against Anthropic's official skill format.
allowed-tools: Read, Write, Edit, Bash(ls:*), Bash(cat:*), Bash(grep:*)
---

# Skill authoring — how to write a SKILL.md the right way

## When to use this skill

USE when the user wants to:
- Capture a repeatable workflow as a reusable skill ("automate this", "make a recipe", "package this")
- Write a brand-new SKILL.md or fix an existing one
- Understand how this workspace's skills system works ("how do I add a skill", "where do skills live")
- Validate a skill before commit ("is this skill OK", "check this skill")

DO NOT USE when:
- User wants to INVOKE an existing skill → just invoke it directly
- User asks where to save a non-skill file → use `file-placement` skill
- User wants to save a fact/preference → use `memory-router` skill
- User wants to write a markdown document → not a skill, save under `documents/`

## Mode: reference vs runnable

This skill works in two modes — pick which one fits the request:

1. **Reference mode** — user wants to understand the system or check a rule. Read the relevant `references/<file>.md` and answer. No file changes.
2. **Runnable mode** — user wants you to create or fix a skill. Follow the 6-step flow below, write the files, report what you made and the trigger phrases.

## 6-step flow (runnable mode)

### 1. Pick the destination

- **Project skill** (yours, survives container rebuilds, edit freely): `~/project/.claude/skills/<name>/`
- **System skill** (template default — RARE; only when this skill ships to every deployed bot): `/opt/ide/skills/default/<name>/` in the ide-template repo

Default to project skill unless the user explicitly asked for a system skill or you're working in the ide-template repo itself.

### 2. Folder + file naming

- Folder name MUST be kebab-case: `weekly-ads-review` ✅, `weekly_ads_review` ❌, `WeeklyAdsReview` ❌, `_weekly-ads` ❌ (no underscores, no capitals, no leading underscore)
- File MUST be exactly `SKILL.md` (case-sensitive — not `Skill.md`, `skill.md`, `SKILL.MD`)
- Name MUST NOT start with `claude` or `anthropic` (reserved by Anthropic)
- Folder MUST NOT contain a `README.md` (use `references/` for supplementary docs)

### 3. Frontmatter

Minimum required:

```yaml
---
name: <folder-name>
description: <what it does> + <when to use it> + <concrete trigger phrases user might say>
---
```

Full field reference (license, allowed-tools, requires, tags, compatibility, metadata): see [references/yaml-fields.md](references/yaml-fields.md).

**Description quality is the single biggest factor in whether the skill auto-triggers.** Verify by asking the bot afterwards: *"when would you use the <name> skill?"* — if the answer drifts from your intent, tighten the description.

### 4. Body structure

Follow this shape (adapt headings to fit):

- `## When to use` — positive + negative triggers
- `## Steps` or `## Decision tree` — flow, in order
- `## Examples` — at least one, ideally 2-3 covering different scenarios
- `## Troubleshooting` — known failure modes + recovery

Keep total body under ~5000 words. If a section grows beyond ~50 lines of static data (tables, bash commands, schemas, sample outputs), extract it to `references/<topic>.md` and replace the section with a one-line pointer. See [references/anti-patterns.md](references/anti-patterns.md) for what to extract vs keep.

### 5. Tool restriction (`allowed-tools`)

Add `allowed-tools:` to frontmatter scoping to the minimum needed. Defaults to full access if omitted — only OK for orchestration skills that genuinely need everything.

Common patterns:
- Pure reference skill: `allowed-tools: Read`
- Memory-write skill: `allowed-tools: Read, Edit, Write`
- Browser skill: `allowed-tools: mcp__playwright__*`
- Integration skill calling one MCP: `allowed-tools: mcp__shopify__*`
- Background reflect-bot: `allowed-tools: Read, mcp__memory__*`

### 6. Validate before committing

Run through [references/checklist.md](references/checklist.md). If any item fails, fix before the skill ships.

## Examples

Three working SKILL.md shapes you can copy-and-modify:

- **Pure reference** (knowledge, no actions): [references/examples/pure-reference.md](references/examples/pure-reference.md)
- **Workflow automation** (multi-step with bash + writes): [references/examples/workflow-automation.md](references/examples/workflow-automation.md)
- **Integration skill** (uses an MCP, has `requires:` + `compatibility:`): [references/examples/integration-skill.md](references/examples/integration-skill.md)

## Troubleshooting

### Skill doesn't trigger automatically

Description is too vague or missing the trigger phrases the user actually says. Debug: ask the bot *"when would you use the <name> skill?"* — it'll quote the description back. Tighten based on the gaps.

### Skill triggers on irrelevant queries

Description is too broad. Add negative triggers: *"Do NOT use for X (use other-skill instead)."*

### YAML errors / skill silently invisible

The skill discovery layer parses frontmatter quietly — if YAML is malformed, the skill **disappears with no warning**. The 2026-05-15 `d---` bug in `memory-cards/SKILL.md` is the canonical example: one stray character on line 1 killed the skill for 13 days, silently. Always verify:

- Opening delimiter is exactly `---` on line 1 (not `d---`, not `-----`, no BOM)
- Closing delimiter `---` present after frontmatter
- No XML tags `<>` anywhere in frontmatter (security restriction)
- `name:` value matches folder name exactly

Run [references/checklist.md](references/checklist.md) before committing.

### Instructions loaded but not followed

Description is good but body is ambiguous. Replace `"validate properly"` with `"CRITICAL: Before X, verify A, B, C"`. For mandatory validations, bundle a script — code is deterministic, language is not (per Anthropic guide).

## After creating

No registration step needed — skills are auto-discovered at every CC session start by walking `.claude/skills/` in the project tree, and a fresh session starts on every Telegram message / web chat turn. **No bot restart needed** for a new SKILL.md to be picked up — just send the next message. (Restart is only needed if you also changed MCPs, `settings.json`, or `global-claude.md`.)

Tell the user:
- The skill name
- The exact trigger phrases that fire it
- One example query they can paste to test
