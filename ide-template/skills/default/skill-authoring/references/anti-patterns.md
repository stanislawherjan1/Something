# Skill anti-patterns

Things to avoid. Each is taken from real failures (this workspace or Anthropic guide).

## Description anti-patterns

### Too vague
```
description: Helps with projects.
```
Fails trigger discovery — the model can't tell when to load this. **Fix:** specific verbs + concrete trigger phrases users say.

### Missing triggers
```
description: Creates sophisticated multi-page documentation systems.
```
Describes WHAT but not WHEN. Model has no signal for which user message should fire this. **Fix:** add `"Use when user says X, Y, Z."`

### Pure technical jargon
```
description: Implements the Project entity model with hierarchical relationships.
```
Describes implementation, not user value. Users don't say *"implement the entity model"*. **Fix:** lead with the outcome from the user's perspective.

### Missing negative triggers (when overlap exists)
If two skills could plausibly handle the same request, each must say "do NOT use for X, use Y". Example overlap pairs in this workspace:
- `memory-cards` ↔ `file-placement`
- `task-management` ↔ `reminders`

Without negative triggers, the model may load the wrong skill (or both) and the routing degrades.

## Body anti-patterns

### Ambiguous instructions
```
Make sure to validate things properly.
```
"Properly" is unverifiable. **Fix:**
```
CRITICAL: Before calling create_project, verify:
- Project name is non-empty
- At least one team member assigned
- Start date is not in the past
```

### Critical instructions buried at the bottom
The model reads top-to-bottom and weights early content more. Put hard rules under `## Important` / `## Critical` near the top. Repeat key constraints if needed.

### Verbose body that should be in references/
If a section is >50 lines of static reference data (lookup tables, bash command lists, sample outputs, schema definitions), extract it. See `## What to extract vs keep` below.

### Inline scripts that should be `scripts/`
Bash snippets >10 lines or any Python should go in `scripts/<name>.{sh,py}` with a one-line invocation in SKILL.md: `Run scripts/audit.py`. Code is deterministic; copy-pasting code through the model isn't.

## Tool restriction anti-patterns

### No `allowed-tools` field
Skill silently gets full tool access — including `Bash` and `WebFetch`. For a pure-reference skill this is a security regression. **Fix:** always declare `allowed-tools:`, even if it's just `Read`.

### Over-broad restriction
```
allowed-tools: Bash
```
Allows ANY bash command. **Fix:** scope to the binaries needed: `Bash(python:*), Bash(jq:*), Bash(grep:*)`.

## Distribution anti-patterns

### Custom `README.md` inside the skill folder
Forbidden by Anthropic spec. Use `references/` for supplementary docs. (Repo-level README for human visitors is fine — different file.)

### `_` or capital letter in folder name
```
_security/         ❌
WeeklyAuditTool/   ❌
weekly_audit/      ❌
```
CC discovery may skip these. **Fix:** strict kebab-case (`security`, `weekly-audit-tool`, `weekly-audit`).

## What to extract to `references/` vs keep in SKILL.md

Keep in SKILL.md:
- The decision tree / step-by-step flow
- When to use / when NOT to use (triggers)
- Output schema (one-line shape, not full example)
- Quick reference card / TLDR

Extract to `references/<topic>.md`:
- Static data tables (column IDs, dev names, schemas, enums)
- Long examples / sample outputs (>10 lines)
- Detailed enumerations / lists consulted occasionally
- Per-tool gotchas not needed every invocation
- Templates / boilerplates
- Multi-step procedures with bash commands

Rough size hint: if a section is over ~50 lines or contains a table with >10 rows, extract it. Reference files load on-demand → zero cost when the skill isn't fired.

## Numbers (Anthropic guide)

- Skill body cap: <5000 words (rough — past that, the body itself crowds out reasoning capacity)
- Enabled skill ceiling per workspace: 20–50 (we deploy 19 defaults + up to 20 conditionally-installed integration skills = max 39, on the upper half but in budget)
- Description max: 1024 chars
