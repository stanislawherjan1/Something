---
name: repo-audit
description: Weekly project structure review. Identifies orphans (loose files in root), stale files (no edit 30+ days), duplicate folders, empty dirs, and files missing from the memory INDEX map. Auto-executes obvious safe cleanups (empty folders, twin-folder casing, .playwright-mcp wipe), asks for approval on judgment calls. Triggered weekly by reminder `[REPO_AUDIT_TRIGGER]`, or manually via "/audit", "weekly audit", "clean up repo", "tidy up the project".
allowed-tools: Read, Bash, Write
---

# Repo Audit Protocol

Once a week, take stock of `~/project/` and propose what to fix. Default report channel: Telegram (concise, ≤30 lines). Default approval model: auto-execute obvious safe actions, ask before judgment calls.

## Step 1 — gather signals

Run the six `find` checks in `references/bash-commands.md` in parallel where possible (top-level inventory, orphans, stale, empty folders, twin folders, .playwright-mcp size).

## Step 2 — classify findings

Bucket each finding into one of three:

**🟢 Auto-execute (obvious + reversible-ish)**
- `.playwright-mcp/` content older than 7 days — `rm -rf` (screenshots, never source of truth)
- Empty folders 14+ days old — `rmdir`
- Twin folders differing only by case — pick canonical (most files wins, ties → alphabetical first), `git mv` or `mv` other into it
- Stale `*.tmp`, `*.bak`, `*~`, `.DS_Store` — `rm`

**🟡 Ask once (judgment call, multi-option)**
- Orphan file in project root → propose target folder
- Stale file 60+ days → propose archive (`Archive/` if exists, else `archived/`)
- 3+ files with similar names in one folder → propose subfolder consolidation

**🔴 Never auto-execute** — see `references/exclusions.md` for the full list and edge cases.

## Step 3 — execute the green pile silently

Run the auto-execute actions without prompting. Log each action to `~/project/${BOT_NAME}/<today>/Audit.md` so the user has a record:

```markdown
# Audit — <YYYY-MM-DD>

## Auto-cleanup (no approval needed)
- Wiped `.playwright-mcp/` (N screenshots, X MB)
- Removed empty folder `<folder>/` (created <date>, never used)
- Merged `<folder>/` → `<Folder>/` (N files moved — twin-folder case fix)
```

## Step 4 — surface the yellow pile to the user

Compose ONE message. Bullet list, numbered, scannable in 10 seconds. Match user's language.

```
Weekly audit:
🧹 Already cleaned: .playwright-mcp + N empty folders.
Need your call:
1. Loose file `<filename>` in project root — move to Inbox/ or Research/?
2. N related files in `<folder>/` — make a `<folder>/<subtopic>/` subfolder?
3. `<filename>` from <month>, no recent activity — archive or keep?

Reply with number + decision (e.g. "1 inbox, 2 yes, 3 keep") or "leave everything".
```

Wait for response. Parse, execute, append to `Audit.md`.

The audit record lives in `~/project/${BOT_NAME}/<today>/Audit.md` (Step 3) — that is the durable log. Do NOT write a run summary into `memory/concepts/` or `memory/topics/`: the memory graph is for knowledge about the user's world, not the bot's own housekeeping logs, and a self-referential audit-log node just clutters it.

## Edge cases

- **No findings** → still send a short message: "Weekly audit — clean, nothing to do 👍". Builds trust the system is alive.
- **20+ findings** → cap report at top 5 by priority (orphans > stale > clusters), mention the rest are in `Audit.md`.
- **Disk-full / permission errors** → don't auto-execute the rest; surface as critical: "Audit aborted: write error in X. Check disk space."
- **User says "leave everything"** → respect, log "all declined" to Audit.md, move on.

## Frequency

Default trigger: Monday 09:00 UTC weekly via `[REPO_AUDIT_TRIGGER]`. Manual: any time via "/audit" or natural-language phrases. Don't run unsolicited more than once per week — too noisy.
