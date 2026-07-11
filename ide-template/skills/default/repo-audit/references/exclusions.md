# Repo-audit — never auto-execute

These paths/items are off-limits for silent action. Always classify as 🔴 and skip from the auto-execute pile; only act on explicit per-item user approval.

## Hard exclusions

- **`${BOT_NAME}/`** — bot's journal. Historical record, sacred. Never delete, move, or rename anything inside.
- **`memory/users/` and `users/` (per-user private trees — team mode)** — another teammate's private memory + files. NEVER auto-execute anything on them, never case-merge two slugs (distinct people, not typos), and **never print a path/filename under them into the shared Telegram report or the shared `Audit.md`** — that surfaces one person's private memory to everyone. If a per-user finding must be surfaced at all, do it as a count-only line ("N items in private user spaces") with zero path detail, or route it to that user's own space — never the shared channel. The audit runs as the operator (scope-guard fails open for it), so the skill is the only thing enforcing this.
- **User-named top-level folders** (e.g. `Marketing/`, `Brand/`, `Products/`, `Inbox/`, `Research/`, anything not in the bootstrap whitelist). Treat as user content. Touch only with per-file approval.
- **Anything mentioned in `.tasks.json`, `.reminders.json`, or `Pending Reminders.md`** — likely in flight. Cross-reference before flagging.

## Edge-case rules

- **Mixed pile**: if a single command finding contains both safe-pile and never-pile entries (e.g. stale files where some sit inside `${BOT_NAME}/`), split them and only auto-execute the safe ones.
- **Ambiguous root file**: prefer 🟡 (ask once) over 🟢. A misclassified auto-execute on an unknown root file is the worst case.
- **First-run uncertainty**: if `memory/concepts/repo-audit-log.md` doesn't exist yet, run in **report-only mode** for the first audit — don't auto-execute anything, list all findings for review. Creates a baseline the user can sanity-check.

## When to escalate to 🔴 mid-audit

If during the green-pile execution any command returns a permission error, write error, or unexpected count (e.g. 500+ files matched a "stale" filter), abort the rest, append an `audit-aborted` claim (with the trigger) to `memory/concepts/repo-audit-log.md`, and surface as critical to the user.
