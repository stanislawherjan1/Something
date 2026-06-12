# SKILL.md frontmatter — all fields

Anthropic's official spec lets you set 7 fields. This workspace adds one project-specific field (`requires:`) for integration skills.

## Required

### `name`
- kebab-case only (`weekly-ads-review`)
- No spaces, no underscores, no capitals
- MUST match the folder name exactly
- MUST NOT start with `claude` or `anthropic` (reserved)

### `description`
- Under 1024 characters
- MUST include BOTH: what the skill does AND when to use it (trigger conditions)
- Include specific phrases users actually say (`"reset my password"`, `"create a sprint"`)
- Mention file types if relevant (`.fig`, `.csv`, `.pdf`)
- No XML angle brackets `<` or `>` (security restriction — Anthropic spec)
- Lead with the value, not the implementation: *"Generate weekly ads report from Meta + Google"* not *"Calls Meta API and Google Ads API"*

## Optional

### `allowed-tools`
Restrict tool access per principle of least privilege. Comma-separated. Default if omitted: full access.

Examples:
```yaml
allowed-tools: Read
allowed-tools: Read, Edit, Write
allowed-tools: Bash(python:*), Bash(npm:*), WebFetch
allowed-tools: mcp__playwright__*
allowed-tools: mcp__shopify__list_orders, mcp__shopify__get_product
```

Wildcards (`mcp__<server>__*`) are legit per Anthropic spec. Use them when the skill needs most of a server's tools; list explicit names when it needs only 2-3.

### `requires` (project-specific, this workspace only)
For integration skills — declare which environment variables / integrations must be active for the skill to work. workspace-api's optional-skill installer uses this to decide whether to deploy the skill.

```yaml
requires: SHOPIFY_STORE_DOMAIN
requires: [META_ACCESS_TOKEN, META_AD_ACCOUNT_ID]
```

### `tags` (project-specific, this workspace only)
Lowercase short labels powering the **Skills dashboard chip-filter bar**. Multi-select OR — clicking `marketing` and `comms` shows skills tagged with either. Project-level skills only (`.claude/skills/<your-skill>/`); global/system skills ignore the field.

```yaml
# Array form (preferred when >1 tag)
tags: [marketing, comms, weekly]

# Scalar form (single tag)
tags: marketing
```

Server normalisation (you can rely on it, don't fight it): lowercased, deduped, capped at 8 — extras silently dropped. Stick to `[a-z0-9-]`.

When to add tags:
- Skill is one of many in a workflow group (e.g. all weekly-report skills get `weekly`)
- A campaign/client/domain repeats across multiple skills (`acme`, `q3-launch`)
- Operator has 10+ project skills and wants to filter the dashboard

When NOT:
- One-off skill — tags exist for grouping, not labeling
- The word is already in `name` or `description` (no `tags: [shopify]` if `name` is `shopify-weekly-orders`)
- You're tempted to use it as a category — no category system exists; pick the most-specific common word your skill shares with others

`tags:` controls dashboard filtering only. Claude's skill auto-discovery reads `description`, not `tags:` — tagging a skill does not change when it triggers. Conversely, mentioning a tag-word in the description text does nothing for the chip filter; both fields exist for different consumers.

Gotcha: YAML array forms — `tags: [a, b]` (flow) and the block-style `tags:` + `  - a` / `  - b` both work. `tags: a, b` (unquoted CSV) parses as the single string `"a, b"` and you'll get one weird tag.

### `compatibility` (Anthropic spec)
1–500 chars. Free-form description of environment requirements (intended product, system packages, network access). For our integration skills, prefer the workspace-specific `requires:` field above for env vars and use `compatibility:` for narrative context.

```yaml
compatibility: Requires Chromium installed in the container; network access to *.shopify.com.
```

### `metadata` (Anthropic spec)
Arbitrary key-value pairs for auditing / versioning. Suggested keys for this workspace:

```yaml
metadata:
  author: ide-template
  version: 1.0.0
  mcp-server: shopify
```

### `license` (Anthropic spec)
For open-source skills. Common: `MIT`, `Apache-2.0`. Skip if the skill ships only inside this workspace.

## What's forbidden

- XML angle brackets `<>` anywhere in frontmatter (security — could inject instructions into the system prompt)
- `claude` or `anthropic` as a prefix in `name`
- Multi-document YAML (`---` appearing more than as opening + closing delimiter)
- Missing closing `---` (silently breaks frontmatter parsing → skill invisible)

## Format gotchas (silent killers)

- **Opening delimiter must be exactly `---` on line 1.** A stray character (`d---`, `-` `-` `-`, BOM bytes) breaks YAML parsing → skill is invisible to CC's auto-discovery with no error. The 2026-05-15 `memory-cards/SKILL.md` outage was caused by `d---`.
- **Don't quote the description** unless it contains special YAML characters. `description: "Helps with X"` is fine but unnecessary; just `description: Helps with X` works.
- **Long descriptions on one line** are OK. YAML folds whitespace but DON'T put line breaks inside the description value — break the parse.
