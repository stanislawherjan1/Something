# Repo-audit signal-gathering commands

Run in parallel where possible.

## Top-level inventory

```bash
find ~/project -maxdepth 1 -mindepth 1 \( -type f -o -type d \) \
  ! -name '.git' ! -name '.claude' ! -name '.integrations' ! -name '.chat' \
  ! -name '.playwright-mcp' ! -name 'node_modules' \
  -printf '%y %p\n' | sort
```

## Orphans — files in project root that aren't standard

```bash
find ~/project -maxdepth 1 -type f \
  ! -name 'CLAUDE.md' ! -name 'README.md' ! -name 'Tasks.md' \
  ! -name 'Pending Reminders.md' ! -name '.session-handoff.md' \
  ! -name '.reminders.json' ! -name '.branding.json' \
  ! -name '.allowed-emails.json' ! -name '.platform.*' \
  ! -name '.*'
```

## Stale — no modification in 30+ days

```bash
find ~/project -type f -mtime +30 \
  ! -path '*/.git/*' ! -path '*/.playwright-mcp/*' \
  ! -path '*/.chat/*' ! -path '*/.claude/sessions/*' \
  ! -path '*/inbox/*' \
  | head -50
```

## Empty folders (14+ days old, no children)

```bash
find ~/project -type d -empty -mtime +14 \
  ! -path '*/.git*' ! -path '*/.playwright-mcp*'
```

## Twin folders (case differences) — common typo source

```bash
find ~/project -maxdepth 2 -type d -printf '%f\n' | sort -f | uniq -i -d
```

## .playwright-mcp leftover screenshots (always safe to wipe weekly)

```bash
find ~/project/.playwright-mcp -type f 2>/dev/null | wc -l
```
